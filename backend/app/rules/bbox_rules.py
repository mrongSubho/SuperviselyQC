from __future__ import annotations

import math

from app.rules.context import NormalizedFigure, RuleContext, bbox_iou_and_ios
from app.schemas.qc import BoundingBoxTuple, QCFinding, QuickFixAction

_SLIVER_EXEMPT_CLASSES = {
    "pole",
    "trafficlight",
    "traffic_light",
    "laneline",
    "lane_line",
    "signpost",
    "wire",
    "streetlight",
}


def estimate_bbox_foreground_score(
    bbox_a: BoundingBoxTuple,
    bbox_b: BoundingBoxTuple,
    img_h: int,
    ios_a_in_b: float,
    ios_b_in_a: float,
    same_class: bool,
    area_a: float | None = None,
    area_b: float | None = None,
) -> float:
    """Return > 0 when bbox_b is presumed foreground over bbox_a, < 0 when bbox_a is foreground."""
    delta_y = (bbox_b[3] - bbox_a[3]) / max(float(img_h), 1.0)
    if same_class:
        eff_a = area_a if area_a is not None else max(0.0, bbox_a[2] - bbox_a[0]) * max(0.0, bbox_a[3] - bbox_a[1])
        eff_b = area_b if area_b is not None else max(0.0, bbox_b[2] - bbox_b[0]) * max(0.0, bbox_b[3] - bbox_b[1])
        delta_s = max(-1.0, min(1.0, math.log(max(eff_b, 1.0) / max(eff_a, 1.0))))
    else:
        delta_s = 0.0
    ios_asym = ios_a_in_b - ios_b_in_a
    return 0.55 * delta_y + 0.35 * delta_s + 0.10 * ios_asym


def _estimate_foreground_score(
    nf_a: NormalizedFigure,
    nf_b: NormalizedFigure,
    img_w: int,
    img_h: int,
    ios_a_in_b: float,
    ios_b_in_a: float,
) -> float:
    """Return > 0 when B is presumed foreground over A, < 0 when A is foreground over B."""
    del img_w
    return estimate_bbox_foreground_score(
        bbox_a=nf_a.bbox,
        bbox_b=nf_b.bbox,
        img_h=img_h,
        ios_a_in_b=ios_a_in_b,
        ios_b_in_a=ios_b_in_a,
        same_class=nf_a.figure.class_title == nf_b.figure.class_title,
        area_a=nf_a.bbox_area,
        area_b=nf_b.bbox_area,
    )


def _has_occlusion_tag(nf: NormalizedFigure) -> bool:
    return any(name.lower() == "occlusion" for name in nf.tag_map)


def evaluate_bbox_rules(
    ctx: RuleContext,
    depth_ordering: dict[tuple[str, str], str] | None = None,
) -> list[QCFinding]:
    """Evaluate bounding box rules and pairwise 2D occlusion tag consistency."""
    if ctx.is_partial_geometry:
        return []

    findings: list[QCFinding] = []
    profile = ctx.profile
    w, h = float(ctx.width), float(ctx.height)
    edge = float(profile.geometry_rules.edge_snap_margin_px)
    near_miss_max = max(12.0, 0.005 * min(w, h))

    # 1. Per-rectangle checks: inverted corners, border truncation / near-miss, aspect ratio
    for nf in ctx.normalized_figures:
        if nf.figure.geometry_type != "rectangle":
            continue
        fig = nf.figure
        label = ctx.figure_display_label(fig)
        x1, y1, x2, y2 = nf.bbox
        bw = x2 - x1
        bh = y2 - y1

        if nf.inverted_box_coords:
            findings.append(
                ctx.make_finding(
                    rule_id="BBOX_NON_CANONICAL_CORNERS",
                    severity="info",
                    category="geometry",
                    title="Non-Canonical Corner Ordering",
                    message=f"{label} corners were stored inverted and automatically normalized for analysis.",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"BBOX_NON_CANONICAL_CORNERS:{fig.figure_id}",
                )
            )

        # Border truncation & near-miss border gaps
        side_gaps = [
            ("left", x1),
            ("top", y1),
            ("right", w - x2),
            ("bottom", h - y2),
        ]
        near_misses = [(side, gap) for side, gap in side_gaps if edge < gap <= near_miss_max]
        near_edges = [(side, gap) for side, gap in side_gaps if 0.0 < gap <= edge]
        if near_misses:
            side, gap = min(near_misses, key=lambda item: item[1])
            findings.append(
                ctx.make_finding(
                    rule_id="BBOX_BORDER_TRUNCATION",
                    severity="warning",
                    category="geometry",
                    title="Near-Miss Image Border Gap",
                    message=f"{label} stops {gap:.0f}px short of {side} image boundary — snap to edge if object is truncated.",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"BBOX_BORDER_TRUNCATION:{fig.figure_id}:{side}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_focus_edge_{fig.figure_id}",
                            label=f"Zoom to {label}",
                            action_type="focus_viewport",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=nf.bbox,
                        )
                    ],
                )
            )
        elif near_edges:
            side, gap = min(near_edges, key=lambda item: item[1])
            findings.append(
                ctx.make_finding(
                    rule_id="BBOX_BORDER_TRUNCATION",
                    severity="info",
                    category="geometry",
                    title="Box Near Image Border",
                    message=f"{label} is {gap:.1f}px from {side} image edge — verify truncation snap.",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"BBOX_BORDER_TRUNCATION:{fig.figure_id}:{side}",
                )
            )

        # Aspect ratio outlier
        cls_norm = fig.class_title.lower().replace(" ", "_")
        if cls_norm not in _SLIVER_EXEMPT_CLASSES and bw > 0.0 and bh > 0.0:
            aspect = max(bw / bh, bh / bw)
            if aspect > ctx.tunables.bbox_max_aspect_ratio:
                findings.append(
                    ctx.make_finding(
                        rule_id="BBOX_ASPECT_RATIO_OUTLIER",
                        severity="warning",
                        category="geometry",
                        title="Extreme Bounding Box Aspect Ratio",
                        message=f"{label} has extreme aspect ratio {aspect:.1f}:1 (>{ctx.tunables.bbox_max_aspect_ratio:.0f}:1).",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"BBOX_ASPECT_RATIO_OUTLIER:{fig.figure_id}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_inspect_ar_{fig.figure_id}",
                                label=f"Inspect {label}",
                                action_type="inspect_figure",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=nf.bbox,
                            )
                        ],
                    )
                )

    # 2. Pairwise Occlusion Checks across 2D boxes/figures (rect + derived bbox of poly/bitmap)
    two_d_figs = [
        nf
        for nf in ctx.normalized_figures
        if nf.figure.geometry_type in {"rectangle", "polygon", "bitmap"} and nf.bbox_area > 0.0
    ]
    iou_thresh = profile.tag_rules.occlusion_overlap_iou_threshold
    cover_thresh = profile.tag_rules.occlusion_cover_ratio_threshold

    overlaps_by_id: dict[str, list[tuple[NormalizedFigure, str, float, float]]] = {
        nf.figure.figure_id: [] for nf in two_d_figs
    }

    for i in range(len(two_d_figs)):
        fa = two_d_figs[i]
        for j in range(i + 1, len(two_d_figs)):
            fb = two_d_figs[j]
            iou, ios_a_in_b, ios_b_in_a, _ = bbox_iou_and_ios(fa.bbox, fb.bbox)
            if iou < iou_thresh and max(ios_a_in_b, ios_b_in_a) < cover_thresh:
                continue

            # Determine foreground vs occluded
            relation_a = "ambiguous"
            relation_b = "ambiguous"
            confidence = 0.78

            pair_key_ab = (fa.figure.figure_id, fb.figure.figure_id)
            pair_key_ba = (fb.figure.figure_id, fa.figure.figure_id)
            if depth_ordering and pair_key_ab in depth_ordering:
                verdict = depth_ordering[pair_key_ab]
                if verdict == "b_foreground":
                    relation_a, relation_b = "occluded", "foreground"
                elif verdict == "a_foreground":
                    relation_a, relation_b = "foreground", "occluded"
                confidence = 0.92
            elif depth_ordering and pair_key_ba in depth_ordering:
                verdict = depth_ordering[pair_key_ba]
                if verdict == "a_foreground":
                    relation_a, relation_b = "occluded", "foreground"
                elif verdict == "b_foreground":
                    relation_a, relation_b = "foreground", "occluded"
                confidence = 0.92
            else:
                score = _estimate_foreground_score(
                    fa, fb, ctx.width, ctx.height, ios_a_in_b, ios_b_in_a
                )
                if score >= 0.12:
                    relation_a, relation_b = "occluded", "foreground"
                elif score <= -0.12:
                    relation_a, relation_b = "foreground", "occluded"

            overlaps_by_id[fa.figure.figure_id].append((fb, relation_a, iou, ios_a_in_b))
            overlaps_by_id[fb.figure.figure_id].append((fa, relation_b, iou, ios_b_in_a))

            # Emit BBOX_OCCLUSION_MISSING_TAG if presumed occluded box lacks Occlusion tag
            for occ_nf, fg_nf, rel, cover_pct in (
                (fa, fb, relation_a, ios_a_in_b),
                (fb, fa, relation_b, ios_b_in_a),
            ):
                if rel != "occluded" or _has_occlusion_tag(occ_nf):
                    continue
                occ_label = ctx.figure_display_label(occ_nf.figure)
                fg_label = ctx.figure_display_label(fg_nf.figure)
                findings.append(
                    ctx.make_finding(
                        rule_id="BBOX_OCCLUSION_MISSING_TAG",
                        severity="warning",
                        category="tags",
                        title="Overlapping Figure Missing Occlusion Tag",
                        message=(
                            f"{occ_label} appears occluded behind {fg_label} "
                            f"({iou * 100:.0f}% IoU, {cover_pct * 100:.0f}% covered) — add Occlusion tag if occluded."
                        ),
                        figure_ids=[occ_nf.figure.figure_id, fg_nf.figure.figure_id],
                        outside_viewport=occ_nf.outside_viewport,
                        focus_rect=occ_nf.bbox,
                        confidence=confidence,
                        fingerprint=f"BBOX_OCCLUSION_MISSING_TAG:{occ_nf.figure.figure_id}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_add_occ_{occ_nf.figure.figure_id}",
                                label=f"Add Occlusion to {occ_label}",
                                action_type="add_object_tag",
                                target_figure_ids=[occ_nf.figure.figure_id],
                                tag_name="Occlusion",
                            ),
                            QuickFixAction(
                                action_id=f"fix_inspect_occ_{occ_nf.figure.figure_id}",
                                label=f"Inspect {occ_label}",
                                action_type="inspect_figure",
                                target_figure_ids=[occ_nf.figure.figure_id],
                                focus_rect=occ_nf.bbox,
                            ),
                        ],
                    )
                )

    # 3. BBOX_FOREGROUND_OCCLUSION_FP
    if profile.tag_rules.flag_foreground_occlusion_false_positive:
        for nf in two_d_figs:
            if not _has_occlusion_tag(nf):
                continue
            ov_list = overlaps_by_id.get(nf.figure.figure_id, [])
            x1, y1, x2, y2 = nf.bbox
            touches_border = (
                x1 <= edge or y1 <= edge or x2 >= w - edge or y2 >= h - edge
            )
            label = ctx.figure_display_label(nf.figure)

            is_isolated_fp = len(ov_list) == 0 and not touches_border
            is_foreground_fp = len(ov_list) > 0 and all(rel == "foreground" for _, rel, _, _ in ov_list)

            if is_isolated_fp or is_foreground_fp:
                reason = (
                    "does not overlap any other figure or image boundary"
                    if is_isolated_fp
                    else "sits in the foreground ahead of every overlapping figure"
                )
                findings.append(
                    ctx.make_finding(
                        rule_id="BBOX_FOREGROUND_OCCLUSION_FP",
                        severity="warning",
                        category="tags",
                        title="False-Positive Occlusion Tag on Foreground Object",
                        message=f'{label} carries "Occlusion" tag, yet {reason}.',
                        figure_ids=[nf.figure.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        confidence=0.90 if depth_ordering else 0.78,
                        fingerprint=f"BBOX_FOREGROUND_OCCLUSION_FP:{nf.figure.figure_id}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_rm_occ_{nf.figure.figure_id}",
                                label=f"Remove Occlusion from {label}",
                                action_type="remove_object_tag",
                                target_figure_ids=[nf.figure.figure_id],
                                tag_name="Occlusion",
                            ),
                            QuickFixAction(
                                action_id=f"fix_inspect_occ_fp_{nf.figure.figure_id}",
                                label=f"Inspect {label}",
                                action_type="inspect_figure",
                                target_figure_ids=[nf.figure.figure_id],
                                focus_rect=nf.bbox,
                            ),
                        ],
                    )
                )

    return findings
