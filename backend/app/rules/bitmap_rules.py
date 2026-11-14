from __future__ import annotations

import math

import cv2
import numpy as np
from scipy.ndimage import binary_fill_holes

from app.rules.context import NormalizedFigure, RuleContext, bbox_iou_and_ios
from app.schemas.qc import BoundingBoxTuple, QCFinding, QuickFixAction


def _has_occluding_overlap(
    target: NormalizedFigure,
    all_2d: list[NormalizedFigure],
) -> bool:
    for other in all_2d:
        if other.figure.figure_id == target.figure.figure_id:
            continue
        iou, ios_t, ios_o, _ = bbox_iou_and_ios(target.bbox, other.bbox)
        if iou >= 0.05 or ios_t >= 0.08 or ios_o >= 0.08:
            return True
    return False


def evaluate_bitmap_rules(ctx: RuleContext) -> list[QCFinding]:
    """Evaluate Brush / Bitmap decode safety, stray islands, pinholes, jagged edges & spill."""
    if ctx.is_partial_geometry:
        return []

    findings: list[QCFinding] = []
    profile = ctx.profile
    tunables = ctx.tunables

    two_d_figs = [
        nf
        for nf in ctx.normalized_figures
        if nf.figure.geometry_type in {"rectangle", "polygon", "bitmap"} and nf.bbox_area > 0.0
    ]

    for nf in ctx.normalized_figures:
        if nf.figure.geometry_type != "bitmap":
            continue
        fig = nf.figure
        label = ctx.figure_display_label(fig)
        bm = nf.decoded_bitmap

        if bm is None or bm.error_code is not None or bm.mask is None:
            rule_id = bm.error_code if (bm and bm.error_code) else "BITMAP_DECODE_ERROR"
            msg = bm.error_message if (bm and bm.error_message) else f"Failed to decode bitmap mask for {label}."
            findings.append(
                ctx.make_finding(
                    rule_id=rule_id,
                    severity="blocker",
                    category="geometry",
                    title="Invalid or Unsafe Brush Bitmap",
                    message=msg,
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"{rule_id}:{fig.figure_id}",
                )
            )
            continue

        if bm.fg_pixels == 0:
            findings.append(
                ctx.make_finding(
                    rule_id="BITMAP_DECODE_ERROR",
                    severity="blocker",
                    category="geometry",
                    title="Empty Brush Bitmap Mask",
                    message=f"{label} bitmap contains zero foreground pixels.",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"BITMAP_DECODE_ERROR:empty:{fig.figure_id}",
                )
            )
            continue

        mask = bm.mask
        mask_u8 = mask.astype(np.uint8)
        ox, oy = bm.origin_x, bm.origin_y

        # 1. BITMAP_DISCONNECTED_ISLANDS
        num_labels, _, stats, centroids = cv2.connectedComponentsWithStats(
            mask_u8, connectivity=8
        )
        num_components = max(0, num_labels - 1)
        if num_components > 1:
            comp_areas = [int(stats[k, cv2.CC_STAT_AREA]) for k in range(1, num_labels)]
            largest_idx = 1 + int(np.argmax(comp_areas))
            largest_area = comp_areas[largest_idx - 1]
            stray_thresh = max(float(tunables.bitmap_min_island_px), 0.005 * float(bm.fg_pixels))

            stray_indices = [
                k for k in range(1, num_labels) if float(stats[k, cv2.CC_STAT_AREA]) < stray_thresh
            ]
            large_indices = [
                k for k in range(1, num_labels) if int(stats[k, cv2.CC_STAT_AREA]) >= 100
            ]
            has_occluder = _has_occluding_overlap(nf, two_d_figs)

            if stray_indices or num_components > profile.geometry_rules.max_disconnected_mask_components or (
                len(large_indices) >= 2 and not has_occluder
            ):
                focus_idx = (
                    max(stray_indices, key=lambda k: int(stats[k, cv2.CC_STAT_AREA]))
                    if stray_indices
                    else 1 + int(np.argmin(comp_areas))
                )
                fx = float(ox + stats[focus_idx, cv2.CC_STAT_LEFT])
                fy = float(oy + stats[focus_idx, cv2.CC_STAT_TOP])
                fw = float(stats[focus_idx, cv2.CC_STAT_WIDTH])
                fh = float(stats[focus_idx, cv2.CC_STAT_HEIGHT])
                island_rect: BoundingBoxTuple = (fx - 12.0, fy - 12.0, fx + fw + 12.0, fy + fh + 12.0)

                coords_preview = ", ".join(
                    f"({int(round(ox + centroids[k][0]))}, {int(round(oy + centroids[k][1]))})"
                    for k in stray_indices[:5]
                )
                detail = (
                    f"{len(stray_indices)} stray dot island(s) at {coords_preview}"
                    if stray_indices
                    else f"{num_components} disconnected components ({len(large_indices)} >= 100px²) without an occluding figure"
                )
                findings.append(
                    ctx.make_finding(
                        rule_id="BITMAP_DISCONNECTED_ISLANDS",
                        severity="warning",
                        category="geometry",
                        title="Disconnected Brush Mask Islands",
                        message=f"{label} contains {detail}.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=island_rect,
                        fingerprint=f"BITMAP_DISCONNECTED_ISLANDS:{fig.figure_id}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_focus_island_{fig.figure_id}",
                                label="Focus Stray Brush Island",
                                action_type="focus_viewport",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=island_rect,
                            )
                        ],
                    )
                )

            # Scattered mask spill check (islands far from primary body or very low tight fill)
            primary_cx, primary_cy = float(centroids[largest_idx][0]), float(centroids[largest_idx][1])
            primary_radius = math.sqrt(float(largest_area) / math.pi)
            max_dist = max(
                math.hypot(float(centroids[k][0]) - primary_cx, float(centroids[k][1]) - primary_cy)
                for k in range(1, num_labels)
                if k != largest_idx
            )
            ys, xs = np.nonzero(mask)
            tight_w = int(xs.max() - xs.min() + 1)
            tight_h = int(ys.max() - ys.min() + 1)
            fill_ratio = float(bm.fg_pixels) / max(float(tight_w * tight_h), 1.0)
            if (fill_ratio < 0.04 and max(tight_w, tight_h) > 150) or (
                primary_radius > 0.0 and max_dist > 1.5 * primary_radius and len(stray_indices) > 0
            ):
                findings.append(
                    ctx.make_finding(
                        rule_id="BITMAP_SPILLED_MASK",
                        severity="warning",
                        category="geometry",
                        title="Scattered / Spilled Brush Mask",
                        message=f"{label} has brush pixels scattered {max_dist:.0f}px from the main body (fill {fill_ratio * 100:.1f}%).",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"BITMAP_SPILLED_MASK:scatter:{fig.figure_id}",
                    )
                )

        # 2. BITMAP_UNEXPECTED_INTERNAL_HOLES (1px padded fill_holes so border-touching open shapes don't false trigger!)
        padded = np.pad(mask, pad_width=1, mode="constant", constant_values=False)
        filled = binary_fill_holes(padded)[1:-1, 1:-1]
        holes_mask = filled & (~mask)
        if np.any(holes_mask):
            h_num, _, h_stats, _ = cv2.connectedComponentsWithStats(
                holes_mask.astype(np.uint8), connectivity=8
            )
            pinholes: list[tuple[int, BoundingBoxTuple]] = []
            large_holes: list[tuple[int, BoundingBoxTuple]] = []
            for hk in range(1, h_num):
                h_area = int(h_stats[hk, cv2.CC_STAT_AREA])
                hx = float(ox + h_stats[hk, cv2.CC_STAT_LEFT])
                hy = float(oy + h_stats[hk, cv2.CC_STAT_TOP])
                hw = float(h_stats[hk, cv2.CC_STAT_WIDTH])
                hh = float(h_stats[hk, cv2.CC_STAT_HEIGHT])
                h_rect = (hx - 8.0, hy - 8.0, hx + hw + 8.0, hy + hh + 8.0)
                if h_area >= 4 and (h_area <= tunables.bitmap_max_pinhole_px or h_area <= 0.02 * bm.fg_pixels):
                    pinholes.append((h_area, h_rect))
                elif h_area > tunables.bitmap_max_pinhole_px:
                    large_holes.append((h_area, h_rect))

            if pinholes:
                min_a = min(a for a, _ in pinholes)
                max_a = max(a for a, _ in pinholes)
                findings.append(
                    ctx.make_finding(
                        rule_id="BITMAP_UNEXPECTED_INTERNAL_HOLES",
                        severity="warning",
                        category="geometry",
                        title="Unfilled Pinholes Inside Brush Mask",
                        message=f"{len(pinholes)} unfilled pinhole(s) ({min_a}–{max_a}px²) detected inside {label} mask.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=pinholes[0][1],
                        fingerprint=f"BITMAP_UNEXPECTED_INTERNAL_HOLES:pinhole:{fig.figure_id}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_focus_pinhole_{fig.figure_id}",
                                label="Focus Pinhole",
                                action_type="focus_viewport",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=pinholes[0][1],
                            )
                        ],
                    )
                )
            elif large_holes:
                findings.append(
                    ctx.make_finding(
                        rule_id="BITMAP_UNEXPECTED_INTERNAL_HOLES",
                        severity="info",
                        category="geometry",
                        title="Large Unfilled Interior Region in Brush Mask",
                        message=f"{label} mask contains {len(large_holes)} large interior hole(s) (largest {max(a for a, _ in large_holes)}px²).",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=large_holes[0][1],
                        fingerprint=f"BITMAP_UNEXPECTED_INTERNAL_HOLES:large:{fig.figure_id}",
                    )
                )

        # 3. BITMAP_JAGGED_BOUNDARY
        contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        worst_roughness = 1.0
        for cnt in contours:
            p_raw = float(cv2.arcLength(cnt, True))
            if p_raw <= 120.0:
                continue
            approx = cv2.approxPolyDP(cnt, 2.0, True)
            p_smooth = float(cv2.arcLength(approx, True))
            roughness = p_raw / max(p_smooth, 1.0)
            if roughness > worst_roughness:
                worst_roughness = roughness
        if worst_roughness > tunables.bitmap_max_roughness_ratio:
            findings.append(
                ctx.make_finding(
                    rule_id="BITMAP_JAGGED_BOUNDARY",
                    severity="warning",
                    category="geometry",
                    title="Sawtooth / Jagged Brush Mask Boundary",
                    message=f"Sawtooth/jittered brush edge detected on {label} (roughness {worst_roughness:.2f}x > {tunables.bitmap_max_roughness_ratio:.2f}x).",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"BITMAP_JAGGED_BOUNDARY:{fig.figure_id}",
                )
            )

        # 4. Cross-figure shallow bleed check (BITMAP_SPILLED_MASK)
        for other in two_d_figs:
            if other.figure.figure_id == fig.figure_id:
                continue
            _, ios_bm_in_other, _, inter_area = bbox_iou_and_ios(nf.bbox, other.bbox)
            if 50.0 < inter_area and 0.0 < ios_bm_in_other < 0.15:
                # Compute exact pixel bleed if other is also a bitmap, or Shapely/rect overlap
                bleed_px = inter_area
                if other.decoded_bitmap and other.decoded_bitmap.mask is not None:
                    ob = other.decoded_bitmap
                    ix1 = max(ox, ob.origin_x)
                    iy1 = max(oy, ob.origin_y)
                    ix2 = min(ox + bm.width, ob.origin_x + ob.width)
                    iy2 = min(oy + bm.height, ob.origin_y + ob.height)
                    if ix2 <= ix1 or iy2 <= iy1:
                        continue
                    sa = mask[iy1 - oy : iy2 - oy, ix1 - ox : ix2 - ox]
                    ob_mask = ob.mask
                    assert ob_mask is not None
                    sb = ob_mask[iy1 - ob.origin_y : iy2 - ob.origin_y, ix1 - ob.origin_x : ix2 - ob.origin_x]
                    bleed_px = float(np.count_nonzero(sa & sb))
                if 50.0 < bleed_px < 0.15 * float(bm.fg_pixels):
                    other_label = ctx.figure_display_label(other.figure)
                    findings.append(
                        ctx.make_finding(
                            rule_id="BITMAP_SPILLED_MASK",
                            severity="info",
                            category="geometry",
                            title="Brush Mask Edge Bleed Hint",
                            message=f"{label} bleeds ~{bleed_px:.0f}px² onto adjacent {other_label} boundary.",
                            figure_ids=[fig.figure_id, other.figure.figure_id],
                            outside_viewport=nf.outside_viewport,
                            focus_rect=nf.bbox,
                            fingerprint=f"BITMAP_SPILLED_MASK:bleed:{fig.figure_id}:{other.figure.figure_id}",
                        )
                    )
                    break

    return findings
