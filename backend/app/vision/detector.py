from __future__ import annotations

from typing import Any

import numpy as np

from app.rules.context import RuleContext
from app.vision.model_manager import ModelManager
from app.vision.tiling import (
    DetectionCandidate,
    generate_overlapping_tiles,
    merge_detections_cpu,
    prepare_letterbox,
)

# Canonical alias mapping from COCO / YOLO labels to common Quantigo ontology titles
_COCO_TO_ONTOLOGY_ALIASES: dict[str, tuple[str, ...]] = {
    "person": ("Human", "Person", "Pedestrian"),
    "car": ("Car", "Car1", "Vehicle", "Automobile"),
    "bus": ("Bus",),
    "truck": ("Truck", "Car"),
    "bicycle": ("Bicycle", "Bike"),
    "motorcycle": ("Motorcycle", "Motorbike"),
    "boat": ("Boat", "Ship"),
    "couch": ("Sofa", "Couch"),
    "chair": ("Chair",),
    "dog": ("Animal", "Dog"),
    "cat": ("Animal", "Cat"),
    "bird": ("Animal", "Bird"),
    "horse": ("Horse", "Animal"),
    "sheep": ("Animal",),
    "cow": ("Animal",),
    "apple": ("Fruit",),
    "orange": ("Fruit",),
    "banana": ("Fruit",),
}


def map_detector_label_to_ontology(
    raw_label: str,
    allowed_ontology_titles: list[str],
) -> str | None:
    """Map detector class label to an active Supervisely ontology class title."""
    norm = raw_label.strip().lower()
    lower_map = {t.lower(): t for t in allowed_ontology_titles}
    if norm in lower_map:
        return lower_map[norm]

    for candidate in _COCO_TO_ONTOLOGY_ALIASES.get(norm, ()):
        if candidate.lower() in lower_map:
            return lower_map[candidate.lower()]

    return None


def _run_ultralytics_on_crop(
    model: Any,
    crop_rgb: np.ndarray,
    device: str,
    conf_thresh: float,
    imgsz: int,
) -> list[tuple[str, float, tuple[float, float, float, float]]]:
    """Execute Ultralytics inference safely with FP16 on MPS (or FP32 on CPU) and CPU postproc."""
    half = device == "mps"
    results = model.predict(
        source=crop_rgb,
        conf=conf_thresh,
        imgsz=imgsz,
        device=device,
        half=half,
        verbose=False,
    )
    out: list[tuple[str, float, tuple[float, float, float, float]]] = []
    if not results:
        return out
    res = results[0]
    names = getattr(res, "names", {})
    boxes = getattr(res, "boxes", None)
    if boxes is None or len(boxes) == 0:
        return out

    xyxy = boxes.xyxy.detach().cpu().numpy()
    confs = boxes.conf.detach().cpu().numpy()
    clss = boxes.cls.detach().cpu().numpy()
    for (x1, y1, x2, y2), score, cls_idx in zip(xyxy, confs, clss, strict=False):
        label = str(names.get(int(cls_idx), cls_idx)) if isinstance(names, dict) else str(names[int(cls_idx)])
        out.append((label, float(score), (float(x1), float(y1), float(x2), float(y2))))
    return out


class ObjectDetector:
    """Standard (YOLO11s) and Deep open-vocab (YOLO-Worldv2-s) multi-scale detector."""

    def __init__(self, model_manager: ModelManager) -> None:
        self.model_manager = model_manager

    def _load_yolo(self, weight_name: str, heavy: bool = False) -> Any | None:
        cached = self.model_manager.get_model(weight_name)
        if cached is not None:
            return cached
        path = self.model_manager.has_weight_file(f"{weight_name}.pt")
        if path is None:
            return None
        try:
            from ultralytics import YOLO  # noqa: PLC0415

            model = YOLO(str(path))
            self.model_manager.register_model(weight_name, model, heavy=heavy)
            return model
        except Exception:
            return None

    def detect(
        self,
        ctx: RuleContext,
        rgb: np.ndarray,
        device: str,
        use_open_vocab: bool = False,
    ) -> tuple[list[DetectionCandidate], list[str], str]:
        """Run Pass 1 (1280px) + Pass 2 (2x2 overlapping tiles if W/H >= 2400) and CPU NMS."""
        raw_ontology_present = bool(ctx.request.ontology.classes)
        ontology_titles = [c.title for c in ctx.request.ontology.classes]
        if ctx.request.ontology.job_classes_to_label:
            allowed_set = set(ctx.request.ontology.job_classes_to_label)
            ontology_titles = [t for t in ontology_titles if t in allowed_set]
        ontology_titles = [
            t
            for t in ontology_titles
            if (ctx.class_override(t) is None or ctx.class_override(t).enabled)  # type: ignore[union-attr]
        ]
        # Only abort detection if an explicit host ontology was supplied and all classes are disabled.
        # When ontology.classes is empty (host metadata unavailable), still run yolo11s open COCO labels.
        if raw_ontology_present and not ontology_titles:
            return [], [], device

        def _resolve_label(raw_label: str) -> str | None:
            if ontology_titles:
                return map_detector_label_to_ontology(raw_label, ontology_titles)
            clean = raw_label.strip()
            if not clean:
                return None
            title = clean.title()
            override = ctx.class_override(title)
            if override is not None and not override.enabled:
                return None
            return title

        base_conf = min(0.30, ctx.profile.vision_rules.missed_object_min_confidence)
        models_used: list[str] = []
        active_device = device

        yolo_name = "yolo11s"
        yolo = self._load_yolo(yolo_name, heavy=False)
        if yolo is None:
            return [], [], "none"

        models_used.append(yolo_name)
        pass1_dets: list[DetectionCandidate] = []
        pass2_dets: list[DetectionCandidate] = []

        # Pass 1: 1280px letterbox full-frame
        img_1280, scale1 = prepare_letterbox(rgb, target_long_edge=1280)
        try:
            raw1 = _run_ultralytics_on_crop(yolo, img_1280, active_device, base_conf, imgsz=1280)
        except Exception:
            active_device = "cpu"
            raw1 = _run_ultralytics_on_crop(yolo, img_1280, "cpu", base_conf, imgsz=1280)

        for raw_label, score, (x1, y1, x2, y2) in raw1:
            mapped = _resolve_label(raw_label)
            if not mapped:
                continue
            pass1_dets.append(
                DetectionCandidate(
                    class_title=mapped,
                    bbox=(x1 / scale1, y1 / scale1, x2 / scale1, y2 / scale1),
                    confidence=score,
                    detector_model=yolo_name,
                    from_tile=False,
                    raw_label=raw_label,
                )
            )

        # Pass 2: 2x2 20%-overlap tiles for high-res edge/distant objects
        tiles = generate_overlapping_tiles(rgb, min_Trigger_edge=2400, tile_target_edge=1024, overlap=0.20)
        for tile in tiles:
            raw_t = _run_ultralytics_on_crop(
                yolo, tile.tile_rgb, active_device, base_conf, imgsz=1024
            )
            for raw_label, score, (tx1, ty1, tx2, ty2) in raw_t:
                mapped = _resolve_label(raw_label)
                if not mapped:
                    continue
                pass2_dets.append(
                    DetectionCandidate(
                        class_title=mapped,
                        bbox=(
                            tx1 / tile.scale + tile.offset_x,
                            ty1 / tile.scale + tile.offset_y,
                            tx2 / tile.scale + tile.offset_x,
                            ty2 / tile.scale + tile.offset_y,
                        ),
                        confidence=score,
                        detector_model=yolo_name,
                        from_tile=True,
                        raw_label=raw_label,
                    )
                )

        # Optional Deep open-vocab detector for non-COCO classes (e.g. Fruit, Building, custom)
        if use_open_vocab and ontology_titles:
            ov_name = "yolov8s-worldv2"
            ov_model = self._load_yolo(ov_name, heavy=True)
            if ov_model is not None:
                try:
                    ov_model.set_classes(ontology_titles)
                    raw_ov = _run_ultralytics_on_crop(
                        ov_model, img_1280, active_device, base_conf, imgsz=1280
                    )
                    models_used.append(ov_name)
                    for raw_label, score, (x1, y1, x2, y2) in raw_ov:
                        mapped = _resolve_label(raw_label)
                        if not mapped:
                            continue
                        pass1_dets.append(
                            DetectionCandidate(
                                class_title=mapped,
                                bbox=(x1 / scale1, y1 / scale1, x2 / scale1, y2 / scale1),
                                confidence=score,
                                detector_model=ov_name,
                                from_tile=False,
                                raw_label=raw_label,
                            )
                        )
                except Exception:
                    pass
                finally:
                    self.model_manager.unload_model(ov_name)

        merged = merge_detections_cpu(pass1_dets, pass2_dets, iou_thresh=0.55)
        return merged, models_used, active_device
