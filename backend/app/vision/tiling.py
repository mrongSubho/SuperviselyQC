from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from app.rules.context import bbox_iou_and_ios
from app.schemas.qc import BoundingBoxTuple


@dataclass
class DetectionCandidate:
    class_title: str
    bbox: BoundingBoxTuple
    confidence: float
    detector_model: str
    from_tile: bool = False
    raw_label: str = ""


@dataclass
class TileCrop:
    tile_rgb: np.ndarray
    offset_x: int
    offset_y: int
    scale: float


def prepare_letterbox(rgb: np.ndarray, target_long_edge: int = 1280) -> tuple[np.ndarray, float]:
    """Resize preserving aspect ratio so long edge == target_long_edge (without upscaling tiny images)."""
    h, w = rgb.shape[:2]
    long_edge = max(h, w)
    if long_edge <= target_long_edge:
        return rgb, 1.0
    scale = target_long_edge / float(long_edge)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = cv2.resize(rgb, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized, scale


def generate_overlapping_tiles(
    rgb: np.ndarray,
    *,
    min_Trigger_edge: int = 2400,
    tile_target_edge: int = 1024,
    overlap: float = 0.20,
) -> list[TileCrop]:
    """Generate 2x2 overlapping tiles when max(W, H) >= 2400 for high-res edge recall."""
    h, w = rgb.shape[:2]
    if max(w, h) < min_Trigger_edge:
        return []

    # Each tile covers (1 + overlap) / 2 of width & height -> 0.60 of W x H when overlap=0.20
    frac = 0.5 * (1.0 + overlap)
    tile_w = max(64, int(round(w * frac)))
    tile_h = max(64, int(round(h * frac)))
    x_starts = [0, max(0, w - tile_w)]
    y_starts = [0, max(0, h - tile_h)]

    crops: list[TileCrop] = []
    for y0 in y_starts:
        for x0 in x_starts:
            patch = rgb[y0 : y0 + tile_h, x0 : x0 + tile_w]
            resized, scale = prepare_letterbox(patch, target_long_edge=tile_target_edge)
            crops.append(TileCrop(tile_rgb=resized, offset_x=x0, offset_y=y0, scale=scale))
    return crops


def merge_detections_cpu(
    pass1_dets: list[DetectionCandidate],
    pass2_dets: list[DetectionCandidate],
    iou_thresh: float = 0.55,
) -> list[DetectionCandidate]:
    """Class-aware CPU NMS plus edge-clipped tile containment suppression."""
    # Step 1: Suppress tile-clipped fragments >= 75% contained in an intact Pass-1 full-frame box
    kept_pass2: list[DetectionCandidate] = []
    for t_det in pass2_dets:
        contained = False
        for f_det in pass1_dets:
            if f_det.class_title != t_det.class_title:
                continue
            _, ios_t_in_f, _, _ = bbox_iou_and_ios(t_det.bbox, f_det.bbox)
            if ios_t_in_f >= 0.75:
                contained = True
                break
        if not contained:
            kept_pass2.append(t_det)

    combined = list(pass1_dets) + kept_pass2
    if not combined:
        return []

    # Step 2: Class-aware greedy NMS on CPU
    by_class: dict[str, list[DetectionCandidate]] = {}
    for det in combined:
        by_class.setdefault(det.class_title, []).append(det)

    final: list[DetectionCandidate] = []
    for dets in by_class.values():
        dets_sorted = sorted(dets, key=lambda d: (d.confidence, not d.from_tile), reverse=True)
        selected: list[DetectionCandidate] = []
        for cand in dets_sorted:
            suppressed = False
            for prev in selected:
                iou, _, _, _ = bbox_iou_and_ios(cand.bbox, prev.bbox)
                if iou >= iou_thresh:
                    suppressed = True
                    break
            if not suppressed:
                selected.append(cand)
        final.extend(selected)

    final.sort(key=lambda d: d.confidence, reverse=True)
    return final
