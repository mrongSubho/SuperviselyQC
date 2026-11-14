from __future__ import annotations

import cv2
import numpy as np

from app.rules.context import NormalizedFigure, RuleContext, bbox_iou_and_ios
from app.schemas.qc import BoundingBoxTuple, QCFinding, QuickFixAction
from app.vision.model_manager import ModelManager


def expand_prompt_bbox(
    bbox: BoundingBoxTuple,
    img_w: int,
    img_h: int,
    margin_ratio: float = 0.08,
    max_pad_px: float = 48.0,
) -> BoundingBoxTuple:
    """Expand user bounding box by +8% (capped at 48px) so SAM sees clipped limbs/edges."""
    x1, y1, x2, y2 = bbox
    pad_x = min(max_pad_px, max(4.0, (x2 - x1) * margin_ratio))
    pad_y = min(max_pad_px, max(4.0, (y2 - y1) * margin_ratio))
    return (
        max(0.0, x1 - pad_x),
        max(0.0, y1 - pad_y),
        min(float(img_w), x2 + pad_x),
        min(float(img_h), y2 + pad_y),
    )


def evaluate_sam_mask_against_figure(
    ctx: RuleContext,
    nf: NormalizedFigure,
    sam_mask: np.ndarray,
) -> list[QCFinding]:
    """Evaluate GEOM_BOX_LOOSE, GEOM_BOX_CLIPPED, and GEOM_MASK_BOUNDARY_DRIFT from a SAM mask."""
    if sam_mask is None or not np.any(sam_mask):
        return []

    # Remove tiny isolated specks (< 1% of mask area)
    fg_total = int(np.count_nonzero(sam_mask))
    if fg_total < 16:
        return []

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
        sam_mask.astype(np.uint8), connectivity=8
    )
    clean_mask = np.zeros_like(sam_mask, dtype=bool)
    min_speck = max(4.0, 0.01 * float(fg_total))
    for k in range(1, num_labels):
        if float(stats[k, cv2.CC_STAT_AREA]) >= min_speck:
            clean_mask |= labels == k
    if not np.any(clean_mask):
        clean_mask = sam_mask

    ys, xs = np.nonzero(clean_mask)
    sam_bbox: BoundingBoxTuple = (
        float(xs.min()),
        float(ys.min()),
        float(xs.max() + 1),
        float(ys.max() + 1),
    )

    fig = nf.figure
    label = ctx.figure_display_label(fig)
    ux1, uy1, ux2, uy2 = nf.bbox
    findings: list[QCFinding] = []

    # 1. GEOM_BOX_CLIPPED: Recall = Area(M_sam ∩ B_user) / Area(M_sam) < 0.88 + >10px protrusion
    ix1 = max(0, int(round(ux1)))
    iy1 = max(0, int(round(uy1)))
    ix2 = min(ctx.width, int(round(ux2)))
    iy2 = min(ctx.height, int(round(uy2)))
    sam_area = max(int(np.count_nonzero(clean_mask)), 1)
    inside_area = (
        int(np.count_nonzero(clean_mask[iy1:iy2, ix1:ix2]))
        if (ix2 > ix1 and iy2 > iy1)
        else 0
    )
    recall = inside_area / float(sam_area)
    max_protrusion = max(
        ux1 - sam_bbox[0],
        uy1 - sam_bbox[1],
        sam_bbox[2] - ux2,
        sam_bbox[3] - uy2,
        0.0,
    )
    if recall < ctx.tunables.sam_clipped_recall_min and max_protrusion > 10.0:
        merged_rect: BoundingBoxTuple = (
            min(ux1, sam_bbox[0]),
            min(uy1, sam_bbox[1]),
            max(ux2, sam_bbox[2]),
            max(uy2, sam_bbox[3]),
        )
        findings.append(
            ctx.make_finding(
                rule_id="GEOM_BOX_CLIPPED",
                severity="warning",
                category="geometry",
                title="Box Clips Object Boundary",
                message=f"{label} cuts off ~{(1.0 - recall) * 100:.0f}% of object pixels ({max_protrusion:.0f}px protrusion outside box).",
                figure_ids=[fig.figure_id],
                outside_viewport=nf.outside_viewport,
                focus_rect=merged_rect,
                confidence=0.86,
                fingerprint=f"GEOM_BOX_CLIPPED:{fig.figure_id}",
                suggested_fixes=[
                    QuickFixAction(
                        action_id=f"fix_focus_clip_{fig.figure_id}",
                        label=f"Inspect Clipped {label}",
                        action_type="focus_viewport",
                        target_figure_ids=[fig.figure_id],
                        focus_rect=merged_rect,
                    )
                ],
            )
        )

    # 2. GEOM_BOX_LOOSE
    iou, _, _, _ = bbox_iou_and_ios(nf.bbox, sam_bbox)
    bw = max(ux2 - ux1, 1.0)
    bh = max(uy2 - uy1, 1.0)
    slack_left = max(0.0, sam_bbox[0] - ux1)
    slack_top = max(0.0, sam_bbox[1] - uy1)
    slack_right = max(0.0, ux2 - sam_bbox[2])
    slack_bottom = max(0.0, uy2 - sam_bbox[3])
    thresh_x = max(ctx.tunables.sam_loose_slack_px, 0.07 * bw)
    thresh_y = max(ctx.tunables.sam_loose_slack_px, 0.07 * bh)
    loose_sides = []
    if slack_left > thresh_x:
        loose_sides.append(f"left (~{slack_left:.0f}px)")
    if slack_right > thresh_x:
        loose_sides.append(f"right (~{slack_right:.0f}px)")
    if slack_top > thresh_y:
        loose_sides.append(f"top (~{slack_top:.0f}px)")
    if slack_bottom > thresh_y:
        loose_sides.append(f"bottom (~{slack_bottom:.0f}px)")

    if iou < ctx.profile.geometry_rules.min_box_iou_tightness or loose_sides:
        side_note = f" on {', '.join(loose_sides)}" if loose_sides else ""
        findings.append(
            ctx.make_finding(
                rule_id="GEOM_BOX_LOOSE",
                severity="warning",
                category="geometry",
                title="Loose Bounding Box Margin",
                message=f"{label} appears loose (IoU {iou * 100:.0f}% vs SAM tightness threshold {ctx.profile.geometry_rules.min_box_iou_tightness * 100:.0f}%){side_note}.",
                figure_ids=[fig.figure_id],
                outside_viewport=nf.outside_viewport,
                focus_rect=nf.bbox,
                confidence=0.85,
                fingerprint=f"GEOM_BOX_LOOSE:{fig.figure_id}",
                suggested_fixes=[
                    QuickFixAction(
                        action_id=f"fix_inspect_loose_{fig.figure_id}",
                        label=f"Tighten {label}",
                        action_type="inspect_figure",
                        target_figure_ids=[fig.figure_id],
                        focus_rect=nf.bbox,
                    )
                ],
            )
        )

    # 3. GEOM_MASK_BOUNDARY_DRIFT for polygon / bitmap
    if fig.geometry_type in {"polygon", "bitmap"}:
        user_mask = _rasterize_user_figure(ctx, nf)
        if user_mask is not None:
            inter = int(np.count_nonzero(user_mask & clean_mask))
            union = int(np.count_nonzero(user_mask | clean_mask))
            mask_iou = inter / max(union, 1)
            if mask_iou < ctx.profile.geometry_rules.min_box_iou_tightness:
                findings.append(
                    ctx.make_finding(
                        rule_id="GEOM_MASK_BOUNDARY_DRIFT",
                        severity="warning",
                        category="geometry",
                        title="Mask / Polygon Boundary Drift",
                        message=f"{label} boundary IoU ({mask_iou * 100:.0f}%) drifts from SAM foreground contour.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        confidence=0.82,
                        fingerprint=f"GEOM_MASK_BOUNDARY_DRIFT:{fig.figure_id}",
                    )
                )

    return findings


def _rasterize_user_figure(ctx: RuleContext, nf: NormalizedFigure) -> np.ndarray | None:
    mask = np.zeros((ctx.height, ctx.width), dtype=bool)
    if nf.figure.geometry_type == "bitmap" and nf.decoded_bitmap and nf.decoded_bitmap.mask is not None:
        bm = nf.decoded_bitmap
        x1 = max(0, bm.origin_x)
        y1 = max(0, bm.origin_y)
        x2 = min(ctx.width, bm.origin_x + bm.width)
        y2 = min(ctx.height, bm.origin_y + bm.height)
        if x2 > x1 and y2 > y1:
            bm_mask = bm.mask
            assert bm_mask is not None
            mask[y1:y2, x1:x2] = bm_mask[
                y1 - bm.origin_y : y2 - bm.origin_y, x1 - bm.origin_x : x2 - bm.origin_x
            ]
        return mask

    if nf.figure.geometry_type == "polygon":
        geom = nf.figure.to_geometry()
        assert geom.geometry_type == "polygon"
        u8 = np.zeros((ctx.height, ctx.width), dtype=np.uint8)
        ext = np.round(np.array(geom.points.exterior, dtype=np.float32)).astype(np.int32)
        cv2.fillPoly(u8, [ext], (1,))
        for hole in geom.points.interior:
            h_arr = np.round(np.array(hole, dtype=np.float32)).astype(np.int32)
            cv2.fillPoly(u8, [h_arr], (0,))
        return u8 > 0

    return None


class TightnessAuditor:
    """SAM 2.1 Hiera-Tiny deep-mode tightness auditor (exclusive heavy model slot)."""

    def __init__(self, model_manager: ModelManager) -> None:
        self.model_manager = model_manager

    def audit(
        self,
        ctx: RuleContext,
        rgb: np.ndarray,
        device: str,
    ) -> tuple[list[QCFinding], str | None]:
        weight_path = self.model_manager.has_weight_file("sam2.1_t.pt")
        if weight_path is None:
            return [], None

        target_figs = [
            nf
            for nf in ctx.normalized_figures
            if nf.figure.geometry_type in {"rectangle", "polygon", "bitmap"} and nf.bbox_area > 0.0
        ]
        if not target_figs:
            return [], None

        try:
            from ultralytics import SAM  # noqa: PLC0415

            model = self.model_manager.get_model("sam2.1_t")
            if model is None:
                model = SAM(str(weight_path))
                self.model_manager.register_model("sam2.1_t", model, heavy=True)

            prompts = [
                list(expand_prompt_bbox(nf.bbox, ctx.width, ctx.height))
                for nf in target_figs
            ]
            results = model.predict(
                source=rgb,
                bboxes=prompts,
                device=device,
                half=(device == "mps"),
                verbose=False,
            )
            findings: list[QCFinding] = []
            if results and getattr(results[0], "masks", None) is not None:
                masks_data = results[0].masks.data.detach().cpu().numpy()
                for idx, nf in enumerate(target_figs):
                    if idx >= len(masks_data):
                        break
                    m_resized = cv2.resize(
                        masks_data[idx].astype(np.float32),
                        (ctx.width, ctx.height),
                        interpolation=cv2.INTER_NEAREST,
                    )
                    findings.extend(evaluate_sam_mask_against_figure(ctx, nf, m_resized > 0.5))
            return findings, "sam2.1-hiera-tiny"
        except Exception:
            return [], None
        finally:
            self.model_manager.unload_model("sam2.1_t")
