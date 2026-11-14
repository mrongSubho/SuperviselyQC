from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import cv2
import numpy as np

from app.rules.context import NormalizedFigure
from app.schemas.qc import BoundingBoxTuple


@dataclass
class DepthOrderingResult:
    """Pairwise occlusion ordering and per-figure occluder mapping."""

    pair_ordering: dict[tuple[str, str], str]
    foreground_occluders: dict[str, list[NormalizedFigure]]
    model_used: str | None = None


def infer_depth_map(
    rgb: np.ndarray,
    model_manager: Any,
    device: str,
) -> tuple[np.ndarray | None, str | None]:
    """Compute normalized relative inverse depth map (higher = closer) via Depth Anything V2 Small."""
    weight_dir = model_manager.models_dir / "depth-anything-v2-small"
    if not weight_dir.exists():
        return None, None

    cached = model_manager.get_model("depth-anything-v2-small")
    try:
        import torch  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415

        if cached is None:
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation  # noqa: PLC0415

            processor = AutoImageProcessor.from_pretrained(str(weight_dir), local_files_only=True)
            model = AutoModelForDepthEstimation.from_pretrained(
                str(weight_dir), local_files_only=True
            )
            dtype = torch.float16 if device == "mps" else torch.float32
            model = model.to(device=device, dtype=dtype).eval()
            cached = (processor, model, dtype)
            model_manager.register_model("depth-anything-v2-small", cached, heavy=False)
        else:
            processor, model, dtype = cached

        # Resize to 518x518 preserve aspect on CPU prep, cast float32 -> float16 on MPS
        pil_img = Image.fromarray(rgb)
        inputs = processor(images=pil_img, return_tensors="pt")
        pixel_values = inputs["pixel_values"].to(dtype=torch.float32)
        if dtype == torch.float16:
            pixel_values = pixel_values.to(dtype=torch.float16)
        pixel_values = pixel_values.to(device)

        with torch.no_grad():
            outputs = model(pixel_values=pixel_values)
            predicted = outputs.predicted_depth
            if predicted.ndim == 2:
                predicted = predicted.unsqueeze(0)
            depth_np = predicted[0].detach().to(dtype=torch.float32).cpu().numpy()

        # Resize inverse depth back cleanly to compact 518-scaled resolution (fast median sampling)
        return depth_np, "depth-anything-v2-small"
    except Exception:
        return None, None


def compute_depth_delta(depth_map: np.ndarray) -> float:
    """Compute robust inverse-depth margin from interquartile range."""
    q75, q25 = np.percentile(depth_map, [75, 25])
    return max(1e-4, 0.08 * float(q75 - q25))


def resolve_pair_depth_order(
    depth_map: np.ndarray,
    img_w: int,
    img_h: int,
    bbox_a: BoundingBoxTuple,
    bbox_b: BoundingBoxTuple,
    delta_depth: float,
) -> Literal["a_foreground", "b_foreground", "ambiguous"]:
    """Compare median inverse depth in exclusive cores vs intersection of two bboxes."""
    dh, dw = depth_map.shape[:2]
    sx = dw / max(float(img_w), 1.0)
    sy = dh / max(float(img_h), 1.0)

    def _bbox_slice(bbox: BoundingBoxTuple) -> tuple[int, int, int, int]:
        x1 = max(0, min(dw - 1, int(round(bbox[0] * sx))))
        y1 = max(0, min(dh - 1, int(round(bbox[1] * sy))))
        x2 = max(x1 + 1, min(dw, int(round(bbox[2] * sx))))
        y2 = max(y1 + 1, min(dh, int(round(bbox[3] * sy))))
        return x1, y1, x2, y2

    ax1, ay1, ax2, ay2 = _bbox_slice(bbox_a)
    bx1, by1, bx2, by2 = _bbox_slice(bbox_b)

    mask_a = np.zeros((dh, dw), dtype=bool)
    mask_a[ay1:ay2, ax1:ax2] = True
    mask_b = np.zeros((dh, dw), dtype=bool)
    mask_b[by1:by2, bx1:bx2] = True

    excl_a = mask_a & (~mask_b)
    excl_b = mask_b & (~mask_a)
    inter = mask_a & mask_b
    if not np.any(excl_a) or not np.any(excl_b) or not np.any(inter):
        return "ambiguous"

    d_a = float(np.median(depth_map[excl_a]))
    d_b = float(np.median(depth_map[excl_b]))
    d_inter = float(np.median(depth_map[inter]))

    if abs(d_a - d_b) <= delta_depth:
        return "ambiguous"

    # Higher inverse depth == closer to camera == foreground occluder
    if d_b > d_a and abs(d_inter - d_b) <= abs(d_inter - d_a) + delta_depth * 0.5:
        return "b_foreground"
    if d_a > d_b and abs(d_inter - d_a) <= abs(d_inter - d_b) + delta_depth * 0.5:
        return "a_foreground"
    return "ambiguous"


def compute_depth_occlusion_ordering(
    depth_map: np.ndarray,
    img_w: int,
    img_h: int,
    two_d_figs: list[NormalizedFigure],
    iou_thresh: float,
    cover_thresh: float,
) -> DepthOrderingResult:
    """Resolve foreground vs occluded using median inverse depth in exclusive cores."""
    from app.rules.context import bbox_iou_and_ios

    delta_depth = compute_depth_delta(depth_map)

    pair_ordering: dict[tuple[str, str], str] = {}
    foreground_occluders: dict[str, list[NormalizedFigure]] = {}

    for i in range(len(two_d_figs)):
        fa = two_d_figs[i]
        for j in range(i + 1, len(two_d_figs)):
            fb = two_d_figs[j]
            iou, ios_a, ios_b, _ = bbox_iou_and_ios(fa.bbox, fb.bbox)
            if iou < iou_thresh and max(ios_a, ios_b) < cover_thresh:
                continue

            verdict = resolve_pair_depth_order(
                depth_map=depth_map,
                img_w=img_w,
                img_h=img_h,
                bbox_a=fa.bbox,
                bbox_b=fb.bbox,
                delta_depth=delta_depth,
            )
            if verdict == "b_foreground":
                pair_ordering[(fa.figure.figure_id, fb.figure.figure_id)] = "b_foreground"
                foreground_occluders.setdefault(fa.figure.figure_id, []).append(fb)
            elif verdict == "a_foreground":
                pair_ordering[(fa.figure.figure_id, fb.figure.figure_id)] = "a_foreground"
                foreground_occluders.setdefault(fb.figure.figure_id, []).append(fa)

    return DepthOrderingResult(
        pair_ordering=pair_ordering,
        foreground_occluders=foreground_occluders,
        model_used="depth-anything-v2-small",
    )


def resize_depth_to_image(depth_map: np.ndarray, width: int, height: int) -> np.ndarray:
    return cv2.resize(depth_map.astype(np.float32), (width, height), interpolation=cv2.INTER_LINEAR)
