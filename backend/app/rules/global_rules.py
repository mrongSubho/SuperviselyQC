from __future__ import annotations

import math

import numpy as np
from shapely.geometry import LineString, Point

from app.rules.context import NormalizedFigure, RuleContext, bbox_iou_and_ios
from app.schemas.qc import QCFinding, QuickFixAction, TagDefinition

_SCENE_EXEMPT_CLASSES = {"sky", "road", "ground", "background"}


def _is_numeric_value(val: object) -> bool:
    if isinstance(val, bool) or val is None:
        return False
    if isinstance(val, (int, float)):
        return math.isfinite(float(val))
    if isinstance(val, str):
        try:
            return math.isfinite(float(val.strip()))
        except ValueError:
            return False
    return False


def _bitmap_mask_iou(nf_a: NormalizedFigure, nf_b: NormalizedFigure) -> float:
    bm_a = nf_a.decoded_bitmap
    bm_b = nf_b.decoded_bitmap
    if not bm_a or not bm_b or bm_a.mask is None or bm_b.mask is None:
        return 0.0
    if bm_a.fg_pixels == 0 or bm_b.fg_pixels == 0:
        return 0.0
    ax1, ay1 = bm_a.origin_x, bm_a.origin_y
    ax2, ay2 = ax1 + bm_a.width, ay1 + bm_a.height
    bx1, by1 = bm_b.origin_x, bm_b.origin_y
    bx2, by2 = bx1 + bm_b.width, by1 + bm_b.height

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0

    slice_a = bm_a.mask[iy1 - ay1 : iy2 - ay1, ix1 - ax1 : ix2 - ax1]
    slice_b = bm_b.mask[iy1 - by1 : iy2 - by1, ix1 - bx1 : ix2 - bx1]
    inter = int(np.count_nonzero(slice_a & slice_b))
    if inter == 0:
        return 0.0
    union = bm_a.fg_pixels + bm_b.fg_pixels - inter
    return float(inter / max(union, 1))


def _sample_polyline_points(pts: list[tuple[float, float]], step: float = 4.0) -> list[tuple[float, float]]:
    if len(pts) < 2:
        return pts
    sampled: list[tuple[float, float]] = [pts[0]]
    for i in range(len(pts) - 1):
        p0, p1 = pts[i], pts[i + 1]
        seg_len = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        if seg_len > step:
            n_steps = min(64, int(seg_len // step))
            for k in range(1, n_steps + 1):
                t = k / (n_steps + 1)
                sampled.append((p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])))
        sampled.append(p1)
    return sampled


def _polyline_duplicate(nf_a: NormalizedFigure, nf_b: NormalizedFigure) -> bool:
    if not isinstance(nf_a.shapely_geom, LineString) or not isinstance(nf_b.shapely_geom, LineString):
        return False
    len_a = float(nf_a.shapely_geom.length)
    len_b = float(nf_b.shapely_geom.length)
    if max(len_a, len_b) <= 0.0:
        return False
    if min(len_a, len_b) / max(len_a, len_b) < 0.90:
        return False
    pts_a = [(float(p[0]), float(p[1])) for p in nf_a.shapely_geom.coords]
    pts_b = [(float(p[0]), float(p[1])) for p in nf_b.shapely_geom.coords]
    samp_a = _sample_polyline_points(pts_a)
    samp_b = _sample_polyline_points(pts_b)
    d_ab = sum(nf_b.shapely_geom.distance(Point(p)) for p in samp_a) / max(len(samp_a), 1)
    d_ba = sum(nf_a.shapely_geom.distance(Point(p)) for p in samp_b) / max(len(samp_b), 1)
    return bool(0.5 * (d_ab + d_ba) <= 4.0)


def _point_or_graph_duplicate(nf_a: NormalizedFigure, nf_b: NormalizedFigure) -> bool:
    gt_a = nf_a.figure.geometry_type
    gt_b = nf_b.figure.geometry_type
    if gt_a == "point" and gt_b == "point":
        pa = nf_a.vertices_for_bounds[0]
        pb = nf_b.vertices_for_bounds[0]
        return math.hypot(pa[0] - pb[0], pa[1] - pb[1]) <= 6.0
    if gt_a == "graph" and gt_b == "graph":
        nodes_a = nf_a.figure.nodes or {}
        nodes_b = nf_b.figure.nodes or {}
        common = [
            k
            for k in nodes_a
            if k in nodes_b and not nodes_a[k].disabled and not nodes_b[k].disabled
        ]
        if not common:
            return False
        mean_dist = sum(
            math.hypot(nodes_a[k].loc[0] - nodes_b[k].loc[0], nodes_a[k].loc[1] - nodes_b[k].loc[1])
            for k in common
        ) / len(common)
        return mean_dist <= 6.0
    return False


def _shape_iou(nf_a: NormalizedFigure, nf_b: NormalizedFigure) -> float:
    gt_a = nf_a.figure.geometry_type
    gt_b = nf_b.figure.geometry_type
    if gt_a == "bitmap" and gt_b == "bitmap":
        return _bitmap_mask_iou(nf_a, nf_b)
    if gt_a in {"rectangle", "polygon"} and gt_b in {"rectangle", "polygon"}:
        iou_bb, _, _, inter_bb = bbox_iou_and_ios(nf_a.bbox, nf_b.bbox)
        if inter_bb <= 0.0:
            return 0.0
        if gt_a == "rectangle" and gt_b == "rectangle":
            return iou_bb
        ga, gb = nf_a.shapely_geom, nf_b.shapely_geom
        if ga is None or gb is None:
            return 0.0
        try:
            if not ga.is_valid:
                ga = ga.buffer(0)
            if not gb.is_valid:
                gb = gb.buffer(0)
            inter = float(ga.intersection(gb).area)
            union = float(ga.union(gb).area)
            return inter / union if union > 0 else 0.0
        except Exception:
            return iou_bb
    return 0.0


def evaluate_global_rules(ctx: RuleContext) -> list[QCFinding]:
    """Run workflow, tag scope/value/required, class allowlist, and global geometry checks."""
    findings: list[QCFinding] = []
    req = ctx.request
    profile = ctx.profile
    img_id = req.image.image_id

    # 1. WORKFLOW_UNSAVED_SYNC
    if profile.workflow_rules.block_on_unsaved_sync and req.ui_state.synchronize_dirty:
        findings.append(
            ctx.make_finding(
                rule_id="WORKFLOW_UNSAVED_SYNC",
                severity="blocker",
                category="workflow",
                title="Unsaved Annotations (Yellow Synchronize)",
                message="Unsaved edits exist in the editor. Click Synchronize before confirming this image.",
                fingerprint=f"WORKFLOW_UNSAVED_SYNC:{img_id}",
                suggested_fixes=[
                    QuickFixAction(
                        action_id="fix_sync",
                        label="Highlight Synchronize Button",
                        action_type="highlight_synchronize",
                    )
                ],
            )
        )

    # 2. WORKFLOW_EMPTY_UNCONFIRMED
    if req.ui_state.state_source == "dom_fallback":
        effective_obj_count = sum(s.figure_count for s in req.dom_figure_summaries)
    else:
        effective_obj_count = len(req.figures)

    if (
        profile.workflow_rules.warn_on_empty_image_without_confirm
        and not req.ui_state.is_confirmed
        and effective_obj_count == 0
    ):
        findings.append(
            ctx.make_finding(
                rule_id="WORKFLOW_EMPTY_UNCONFIRMED",
                severity="warning",
                category="workflow",
                title="Unconfirmed Empty Image",
                message="No annotated figures detected on this unconfirmed image. Add annotations or verify empty status before confirming.",
                fingerprint=f"WORKFLOW_EMPTY_UNCONFIRMED:{img_id}",
            )
        )

    # 3. TAG_SCOPE_IMAGE_MISPLACED & TAG_VALUE_INVALID on imageTags
    object_only_set = set(profile.tag_rules.object_only_tags)
    image_only_set = set(profile.tag_rules.image_only_tags)

    candidate_fig_ids = [f.figure_id for f in req.figures[:5]]
    for tag in req.image_tags:
        tag_def = ctx.tags_by_name.get(tag.name)
        is_object_only = (tag.name in object_only_set) or (
            tag_def is not None and tag_def.applicable_type == "objectsOnly"
        )
        if is_object_only:
            fixes = [
                QuickFixAction(
                    action_id=f"fix_rm_img_tag_{tag.name}",
                    label=f"Remove '{tag.name}' from Image Tags",
                    action_type="remove_image_tag",
                    tag_name=tag.name,
                )
            ]
            if candidate_fig_ids:
                fixes.insert(
                    0,
                    QuickFixAction(
                        action_id=f"fix_mv_img_tag_{tag.name}",
                        label=f"Move '{tag.name}' to Occluded Object",
                        action_type="move_tag_image_to_object",
                        target_figure_ids=candidate_fig_ids,
                        tag_name=tag.name,
                        tag_value=tag.value,
                    ),
                )
            findings.append(
                ctx.make_finding(
                    rule_id="TAG_SCOPE_IMAGE_MISPLACED",
                    severity="blocker",
                    category="tags",
                    title="Object Tag Attached to Image",
                    message=f'"{tag.name}" is attached to CURRENT IMAGE TAGS instead of occluded object figure(s).',
                    image_tag_names=[tag.name],
                    figure_ids=candidate_fig_ids[:1],
                    fingerprint=f"TAG_SCOPE_IMAGE_MISPLACED:{tag.name}:{img_id}",
                    suggested_fixes=fixes,
                )
            )
        if tag_def is not None:
            _check_tag_value(ctx, findings, tag.name, tag.value, tag_def, fig=None)

    # 4. CLASS_DISABLED_OR_OFF_JOB
    allowed_job_classes = (
        set(req.ontology.job_classes_to_label)
        if req.ontology.job_classes_to_label
        else None
    )

    if req.ui_state.state_source == "dom_fallback":
        for summary in req.dom_figure_summaries:
            if summary.figure_count <= 0:
                continue
            ov = ctx.class_override(summary.class_title)
            disabled = (ov is not None and not ov.enabled) or (
                allowed_job_classes is not None and summary.class_title not in allowed_job_classes
            )
            if disabled:
                findings.append(
                    ctx.make_finding(
                        rule_id="CLASS_DISABLED_OR_OFF_JOB",
                        severity="warning",
                        category="classification",
                        title=f"Disabled or Off-Job Class '{summary.class_title}'",
                        message=f"Class '{summary.class_title}' has {summary.figure_count} figure(s) but is disabled in profile or excluded from job scope.",
                        fingerprint=f"CLASS_DISABLED_OR_OFF_JOB:{summary.class_title}:{img_id}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_toggle_{summary.class_title}",
                                label=f"Toggle {summary.class_title} Visibility",
                                action_type="toggle_class_visibility",
                                tag_name=summary.class_title,
                            )
                        ],
                    )
                )
        return findings

    # 5. Per-figure tag & classification rules (works in store and network_interceptor)
    for nf in ctx.normalized_figures:
        fig = nf.figure
        label = ctx.figure_display_label(fig)
        ov = ctx.class_override(fig.class_title)

        disabled = (ov is not None and not ov.enabled) or (
            allowed_job_classes is not None and fig.class_title not in allowed_job_classes
        )
        if disabled:
            findings.append(
                ctx.make_finding(
                    rule_id="CLASS_DISABLED_OR_OFF_JOB",
                    severity="warning",
                    category="classification",
                    title=f"Disabled or Off-Job Class '{fig.class_title}'",
                    message=f"{label} uses class '{fig.class_title}', which is disabled in the active profile or excluded from this labeling job.",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"CLASS_DISABLED_OR_OFF_JOB:{fig.figure_id}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_inspect_{fig.figure_id}",
                            label=f"Inspect {label}",
                            action_type="inspect_figure",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=nf.bbox,
                        ),
                        QuickFixAction(
                            action_id=f"fix_del_{fig.figure_id}",
                            label=f"Delete {label}",
                            action_type="confirm_delete_figure",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=nf.bbox,
                        ),
                    ],
                )
            )

        for tag in fig.tags:
            tag_def = ctx.tags_by_name.get(tag.name)
            is_image_only = (tag.name in image_only_set) or (
                tag_def is not None and tag_def.applicable_type == "imagesOnly"
            )
            if is_image_only:
                findings.append(
                    ctx.make_finding(
                        rule_id="TAG_SCOPE_OBJECT_MISPLACED",
                        severity="blocker",
                        category="tags",
                        title="Image-Only Tag Attached to Object",
                        message=f'"{tag.name}" is an image-level tag and should not be attached to {label}.',
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"TAG_SCOPE_OBJECT_MISPLACED:{fig.figure_id}:{tag.name}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_rm_obj_tag_{fig.figure_id}_{tag.name}",
                                label=f"Remove '{tag.name}' from {label}",
                                action_type="remove_object_tag",
                                target_figure_ids=[fig.figure_id],
                                tag_name=tag.name,
                            ),
                            QuickFixAction(
                                action_id=f"fix_inspect_{fig.figure_id}",
                                label=f"Inspect {label}",
                                action_type="inspect_figure",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=nf.bbox,
                            ),
                        ],
                    )
                )

            incompatible = (
                tag_def is not None
                and len(tag_def.classes) > 0
                and fig.class_title not in tag_def.classes
            ) or (ov is not None and ov.forbidden_tags is not None and tag.name in ov.forbidden_tags)
            if incompatible:
                findings.append(
                    ctx.make_finding(
                        rule_id="TAG_CLASS_INCOMPATIBLE",
                        severity="blocker",
                        category="tags",
                        title=f"Tag '{tag.name}' Incompatible with '{fig.class_title}'",
                        message=f'Tag "{tag.name}" is forbidden or not applicable to class "{fig.class_title}" on {label}.',
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"TAG_CLASS_INCOMPATIBLE:{fig.figure_id}:{tag.name}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_rm_incompat_{fig.figure_id}_{tag.name}",
                                label=f"Remove '{tag.name}'",
                                action_type="remove_object_tag",
                                target_figure_ids=[fig.figure_id],
                                tag_name=tag.name,
                            ),
                            QuickFixAction(
                                action_id=f"fix_inspect_{fig.figure_id}",
                                label=f"Inspect {label}",
                                action_type="inspect_figure",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=nf.bbox,
                            ),
                        ],
                    )
                )

            if tag_def is not None:
                _check_tag_value(ctx, findings, tag.name, tag.value, tag_def, fig=nf)

        if ov and ov.required_tags:
            for req_tag in ov.required_tags:
                if req_tag not in nf.tag_map:
                    findings.append(
                        ctx.make_finding(
                            rule_id="TAG_REQUIRED_MISSING",
                            severity="warning",
                            category="tags",
                            title=f"Missing Required Tag '{req_tag}'",
                            message=f"{label} is missing required tag '{req_tag}' configured for class '{fig.class_title}'.",
                            figure_ids=[fig.figure_id],
                            outside_viewport=nf.outside_viewport,
                            focus_rect=nf.bbox,
                            fingerprint=f"TAG_REQUIRED_MISSING:{fig.figure_id}:{req_tag}",
                            suggested_fixes=[
                                QuickFixAction(
                                    action_id=f"fix_add_req_{fig.figure_id}_{req_tag}",
                                    label=f"Add '{req_tag}' to {label}",
                                    action_type="add_object_tag",
                                    target_figure_ids=[fig.figure_id],
                                    tag_name=req_tag,
                                ),
                                QuickFixAction(
                                    action_id=f"fix_inspect_{fig.figure_id}",
                                    label=f"Inspect {label}",
                                    action_type="inspect_figure",
                                    target_figure_ids=[fig.figure_id],
                                    focus_rect=nf.bbox,
                                ),
                            ],
                        )
                    )

    if ctx.is_partial_geometry:
        return findings

    # 6. Global Geometry Rules (OOB, micro-click, canvas-wide outlier, duplicates)
    w, h = float(ctx.width), float(ctx.height)
    canvas_area = w * h

    for nf in ctx.normalized_figures:
        fig = nf.figure
        label = ctx.figure_display_label(fig)

        # GEOM_OUT_OF_BOUNDS: [-1.0, W+1.0] x [-1.0, H+1.0]
        oob = any(
            x < -1.0 or x > w + 1.0 or y < -1.0 or y > h + 1.0
            for x, y in nf.vertices_for_bounds
        )
        if oob:
            findings.append(
                ctx.make_finding(
                    rule_id="GEOM_OUT_OF_BOUNDS",
                    severity="blocker",
                    category="geometry",
                    title="Annotation Out of Image Bounds",
                    message=f"{label} has coordinates outside valid image canvas [-1, {ctx.width + 1}] x [-1, {ctx.height + 1}].",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"GEOM_OUT_OF_BOUNDS:{fig.figure_id}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_focus_oob_{fig.figure_id}",
                            label=f"Focus {label}",
                            action_type="focus_viewport",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=nf.bbox,
                        ),
                        QuickFixAction(
                            action_id=f"fix_inspect_oob_{fig.figure_id}",
                            label=f"Inspect {label}",
                            action_type="inspect_figure",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=nf.bbox,
                        ),
                    ],
                )
            )

        # GEOM_EXTREME_MICRO_CLICK
        bw = nf.bbox[2] - nf.bbox[0]
        bh = nf.bbox[3] - nf.bbox[1]
        if fig.geometry_type in {"rectangle", "polygon", "bitmap"}:
            base_min = (
                profile.geometry_rules.min_mask_area_px
                if fig.geometry_type == "bitmap"
                else profile.geometry_rules.min_box_area_px
            )
            a_min = ctx.effective_min_area(fig.class_title, base_min)
            # Only run bitmap micro-click if bitmap decoded cleanly
            skip_bm_area = fig.geometry_type == "bitmap" and (
                nf.decoded_bitmap is None or nf.decoded_bitmap.mask is None
            )
            if not skip_bm_area and (bw < ctx.s_min or bh < ctx.s_min or nf.geom_area < a_min):
                findings.append(
                    ctx.make_finding(
                        rule_id="GEOM_EXTREME_MICRO_CLICK",
                        severity="blocker",
                        category="geometry",
                        title="Micro-Click / Tiny Annotation Artifact",
                        message=f"{label} is abnormally small ({bw:.1f}x{bh:.1f}px, area {nf.geom_area:.1f}px² < {a_min:.0f}px²).",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"GEOM_EXTREME_MICRO_CLICK:{fig.figure_id}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_focus_micro_{fig.figure_id}",
                                label=f"Locate {label}",
                                action_type="focus_viewport",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=nf.bbox,
                            ),
                            QuickFixAction(
                                action_id=f"fix_del_micro_{fig.figure_id}",
                                label=f"Delete Artifact {label}",
                                action_type="confirm_delete_figure",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=nf.bbox,
                            ),
                        ],
                    )
                )
        elif fig.geometry_type == "graph" and len(nf.vertices_for_bounds) > 1:
            if max(bw, bh) < ctx.s_min:
                findings.append(
                    ctx.make_finding(
                        rule_id="GEOM_EXTREME_MICRO_CLICK",
                        severity="blocker",
                        category="geometry",
                        title="Collapsed Skeleton Graph",
                        message=f"{label} skeleton span ({bw:.1f}x{bh:.1f}px) is smaller than minimum side {ctx.s_min:.1f}px.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"GEOM_EXTREME_MICRO_CLICK:{fig.figure_id}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_focus_micro_{fig.figure_id}",
                                label=f"Locate {label}",
                                action_type="focus_viewport",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=nf.bbox,
                            )
                        ],
                    )
                )

        # GEOM_CANVAS_WIDE_OUTLIER
        if fig.geometry_type in {"rectangle", "polygon", "bitmap"}:
            if fig.class_title.lower() not in _SCENE_EXEMPT_CLASSES:
                ratio = (
                    nf.geom_area if fig.geometry_type == "bitmap" else nf.bbox_area
                ) / max(canvas_area, 1.0)
                if ratio > ctx.tunables.canvas_wide_area_ratio:
                    findings.append(
                        ctx.make_finding(
                            rule_id="GEOM_CANVAS_WIDE_OUTLIER",
                            severity="warning",
                            category="geometry",
                            title="Canvas-Wide Annotation Outlier",
                            message=f"{label} covers {ratio * 100:.1f}% of the full image canvas (> {ctx.tunables.canvas_wide_area_ratio * 100:.0f}%).",
                            figure_ids=[fig.figure_id],
                            outside_viewport=nf.outside_viewport,
                            focus_rect=nf.bbox,
                            fingerprint=f"GEOM_CANVAS_WIDE_OUTLIER:{fig.figure_id}",
                            suggested_fixes=[
                                QuickFixAction(
                                    action_id=f"fix_inspect_wide_{fig.figure_id}",
                                    label=f"Inspect {label}",
                                    action_type="inspect_figure",
                                    target_figure_ids=[fig.figure_id],
                                    focus_rect=nf.bbox,
                                )
                            ],
                        )
                    )

    # GEOM_DUPLICATE_FIGURE pairwise check
    figs = ctx.normalized_figures
    n = len(figs)
    dup_thresh = ctx.tunables.duplicate_iou_threshold
    for i in range(n):
        fa = figs[i]
        for j in range(i + 1, n):
            fb = figs[j]
            gt_a, gt_b = fa.figure.geometry_type, fb.figure.geometry_type
            is_dup = False
            if (gt_a in {"rectangle", "polygon"} and gt_b in {"rectangle", "polygon"}) or (
                gt_a == "bitmap" and gt_b == "bitmap"
            ):
                is_dup = _shape_iou(fa, fb) >= dup_thresh
            elif gt_a == "polyline" and gt_b == "polyline":
                is_dup = _polyline_duplicate(fa, fb)
            elif (gt_a == "point" and gt_b == "point") or (gt_a == "graph" and gt_b == "graph"):
                is_dup = _point_or_graph_duplicate(fa, fb)

            if not is_dup:
                continue

            same_class = fa.figure.class_title == fb.figure.class_title
            sev = "blocker" if same_class else "warning"
            pair_ids = sorted([fa.figure.figure_id, fb.figure.figure_id])
            la = ctx.figure_display_label(fa.figure)
            lb = ctx.figure_display_label(fb.figure)
            findings.append(
                ctx.make_finding(
                    rule_id="GEOM_DUPLICATE_FIGURE",
                    severity=sev,
                    category="geometry",
                    title="Duplicate Overlapping Figure" if same_class else "Cross-Class Overlapping Duplicate",
                    message=f"{la} and {lb} represent nearly identical geometry.",
                    figure_ids=[fa.figure.figure_id, fb.figure.figure_id],
                    outside_viewport=fa.outside_viewport and fb.outside_viewport,
                    focus_rect=fa.bbox,
                    fingerprint=f"GEOM_DUPLICATE_FIGURE:{'_'.join(pair_ids)}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_inspect_dup_{fb.figure.figure_id}",
                            label=f"Inspect {lb}",
                            action_type="inspect_figure",
                            target_figure_ids=[fb.figure.figure_id],
                            focus_rect=fb.bbox,
                        ),
                        QuickFixAction(
                            action_id=f"fix_del_dup_{fb.figure.figure_id}",
                            label=f"Delete Duplicate {lb}",
                            action_type="confirm_delete_figure",
                            target_figure_ids=[fb.figure.figure_id],
                            focus_rect=fb.bbox,
                        ),
                    ],
                )
            )

    return findings


def _check_tag_value(
    ctx: RuleContext,
    findings: list[QCFinding],
    tag_name: str,
    tag_value: str | int | float | bool | None,
    tag_def: TagDefinition,
    fig: NormalizedFigure | None,
) -> None:
    invalid = False
    reason = ""
    if tag_def.value_type == "oneof_string":
        if tag_value is None or str(tag_value) not in tag_def.values:
            invalid = True
            reason = f'value "{tag_value}" is not in allowed options {tag_def.values}'
    elif tag_def.value_type == "any_number":
        if not _is_numeric_value(tag_value):
            invalid = True
            reason = f'value "{tag_value}" must be a valid finite number'
    elif tag_def.value_type == "any_string":
        if not isinstance(tag_value, str) or tag_value.strip() == "":
            invalid = True
            reason = "expected non-empty string value"

    if not invalid:
        return

    if fig is None:
        img_id = ctx.request.image.image_id
        findings.append(
            ctx.make_finding(
                rule_id="TAG_VALUE_INVALID",
                severity="blocker",
                category="tags",
                title=f"Invalid Value on Image Tag '{tag_name}'",
                message=f'Image tag "{tag_name}" has invalid value: {reason}.',
                image_tag_names=[tag_name],
                fingerprint=f"TAG_VALUE_INVALID:image:{tag_name}:{img_id}",
            )
        )
    else:
        label = ctx.figure_display_label(fig.figure)
        findings.append(
            ctx.make_finding(
                rule_id="TAG_VALUE_INVALID",
                severity="blocker",
                category="tags",
                title=f"Invalid Value on Tag '{tag_name}'",
                message=f'Tag "{tag_name}" on {label} has invalid value: {reason}.',
                figure_ids=[fig.figure.figure_id],
                outside_viewport=fig.outside_viewport,
                focus_rect=fig.bbox,
                fingerprint=f"TAG_VALUE_INVALID:{fig.figure.figure_id}:{tag_name}",
                suggested_fixes=[
                    QuickFixAction(
                        action_id=f"fix_inspect_tagval_{fig.figure.figure_id}",
                        label=f"Inspect {label}",
                        action_type="inspect_figure",
                        target_figure_ids=[fig.figure.figure_id],
                        focus_rect=fig.bbox,
                    )
                ],
            )
        )
