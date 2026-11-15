from __future__ import annotations

import re
from typing import Any

import numpy as np

from app.rules.context import RuleContext
from app.schemas.qc import GeometryType
from app.vision.model_manager import ModelManager
from app.vision.tiling import (
    DetectionCandidate,
    generate_overlapping_tiles,
    merge_detections_cpu,
    prepare_letterbox,
)

_ONTOLOGY_TOOL_SUFFIX_RE = re.compile(
    r"(?:[_\-\s]+)(b|brush|bitmap|mask|p|poly|polygon|seg|l|line|polyline|k|kp|kpt|keypoint|keypoints|pose|graph|r|rect|rectangle|box|bbox)$",
    re.IGNORECASE,
)

# Canonical alias mapping from COCO / YOLO labels to common Quantigo ontology titles
_COCO_TO_ONTOLOGY_ALIASES: dict[str, tuple[str, ...]] = {
    "person": ("Human", "Person", "Pedestrian"),
    "car": ("Car", "Car1", "Vehicle", "Automobile"),
    "bus": ("Bus",),
    "truck": ("Truck",),
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
    "apple": ("Apple", "Fruit"),
    "orange": ("Orange", "Fruit"),
    "banana": ("Banana", "Fruit"),
    "cookie": ("Biscuit", "Cookie"),
    "biscuit": ("Biscuit", "Cookie"),
}


def strip_ontology_tool_suffix(title: str) -> str:
    """Strip trailing delimited tool suffixes like _B, _P, _L, _K for semantic matching."""
    cleaned = title.strip()
    match = _ONTOLOGY_TOOL_SUFFIX_RE.search(cleaned)
    if match:
        stem = cleaned[: match.start()].strip(" _-")
        if stem:
            return stem
    return cleaned


def infer_shape_from_ontology_title(title: str) -> GeometryType | None:
    """Infer expected annotation primitive from naming convention suffixes (_B, _P, _L, _K)."""
    match = _ONTOLOGY_TOOL_SUFFIX_RE.search(title.strip())
    if not match:
        return None
    token = match.group(1).lower()
    if token in {"b", "brush", "bitmap", "mask"}:
        return "bitmap"
    if token in {"p", "poly", "polygon", "seg"}:
        return "polygon"
    if token in {"l", "line", "polyline"}:
        return "polyline"
    if token in {"k", "kp", "kpt", "keypoint", "keypoints", "pose", "graph"}:
        return "graph"
    if token in {"r", "rect", "rectangle", "box", "bbox"}:
        return "rectangle"
    return None


def _normalize_label_variants(label: str) -> list[str]:
    norm = re.sub(r"\s+", " ", label.strip().lower().replace("_", " ").replace("-", " ")).strip()
    if not norm:
        return []
    variants = [norm]
    if norm.endswith("s") and len(norm) > 3 and not norm.endswith("ss"):
        variants.append(norm[:-1])
    elif not norm.endswith("s"):
        variants.append(f"{norm}s")
    return variants


def map_detector_label_to_ontology(
    raw_label: str,
    allowed_ontology_titles: list[str],
    custom_aliases: dict[str, list[str]] | None = None,
) -> str | None:
    """Map detector class label to an active Supervisely ontology class title."""
    norm = raw_label.strip().lower()
    lower_map = {t.lower(): t for t in allowed_ontology_titles}
    if norm in lower_map:
        return lower_map[norm]

    stem_map: dict[str, str] = {}
    for title in allowed_ontology_titles:
        stem = strip_ontology_tool_suffix(title).lower()
        for variant in _normalize_label_variants(stem):
            stem_map.setdefault(variant, title)

    for variant in _normalize_label_variants(norm):
        if variant in lower_map:
            return lower_map[variant]
        if variant in stem_map:
            return stem_map[variant]

    if custom_aliases:
        for key, candidates in custom_aliases.items():
            if key.strip().lower() == norm:
                for candidate in candidates:
                    c_low = candidate.lower()
                    if c_low in lower_map:
                        return lower_map[c_low]
                    if c_low in stem_map:
                        return stem_map[c_low]

    for candidate in _COCO_TO_ONTOLOGY_ALIASES.get(norm, ()):
        c_low = candidate.lower()
        if c_low in lower_map:
            return lower_map[c_low]
        if c_low in stem_map:
            return stem_map[c_low]

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
                return map_detector_label_to_ontology(
                    raw_label, ontology_titles, ctx.profile.detector_aliases
                )
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

        # Optional Deep open-vocab detector for non-COCO classes (e.g. Biscuit_B, Fruit, custom)
        if use_open_vocab and ontology_titles:
            ov_name = "yolov8s-worldv2"
            ov_model = self._load_yolo(ov_name, heavy=True)
            if ov_model is not None:
                try:
                    prompt_to_ontology: dict[str, str] = {}
                    ov_prompts: list[str] = []
                    seen_prompts: set[str] = set()
                    for title in ontology_titles:
                        stem = strip_ontology_tool_suffix(title).replace("_", " ").replace("-", " ").strip()
                        prompt = (stem or title).lower()
                        if prompt not in seen_prompts:
                            seen_prompts.add(prompt)
                            ov_prompts.append(prompt)
                            prompt_to_ontology[prompt] = title
                        # Add close baked-good synonym so CLIP matches biscuit/cookie reliably
                        if prompt == "biscuit" and "cookie" not in seen_prompts and not any(
                            strip_ontology_tool_suffix(t).lower() == "cookie" for t in ontology_titles
                        ):
                            seen_prompts.add("cookie")
                            ov_prompts.append("cookie")
                            prompt_to_ontology["cookie"] = title

                    ov_model.set_classes(ov_prompts or ontology_titles)
                    raw_ov = _run_ultralytics_on_crop(
                        ov_model, img_1280, active_device, base_conf, imgsz=1280
                    )
                    models_used.append(ov_name)
                    for raw_label, score, (x1, y1, x2, y2) in raw_ov:
                        mapped = prompt_to_ontology.get(raw_label.strip().lower()) or _resolve_label(
                            raw_label
                        )
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
