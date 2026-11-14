from __future__ import annotations

import math
import re
from collections.abc import Iterable

from app.rules.context import NormalizedFigure, RuleContext
from app.schemas.qc import BoundingBoxTuple, ClassDefinition, QCFinding, QuickFixAction

_BILATERAL_RE = re.compile(
    r"^(?:(l|left|r|right)[_-]?)?(eye|ear|shoulder|elbow|wrist|hip|knee|ankle|hand|foot)$",
    re.IGNORECASE,
)
_ALT_BILATERAL_RE = re.compile(
    r"^(eye|ear|shoulder|elbow|wrist|hip|knee|ankle|hand|foot)[_-]?(l|left|r|right)$",
    re.IGNORECASE,
)


def parse_bilateral_label(label: str) -> tuple[str, str] | None:
    """Return ('L'|'R', canonical_part) for bilateral joint labels, else None."""
    norm = label.strip().lower().replace(" ", "_")
    m = _BILATERAL_RE.match(norm)
    if m and m.group(1):
        side = "L" if m.group(1).startswith("l") else "R"
        return side, m.group(2).lower()
    m2 = _ALT_BILATERAL_RE.match(norm)
    if m2:
        side = "L" if m2.group(2).startswith("l") else "R"
        return side, m2.group(1).lower()
    return None


def _resolve_class_def(ctx: RuleContext, nf: NormalizedFigure) -> ClassDefinition | None:
    return ctx.classes_by_id.get(str(nf.figure.class_id)) or ctx.classes_by_title.get(
        nf.figure.class_title
    )


def _best_parent_container(
    active_pts: list[tuple[float, float]],
    containers: list[NormalizedFigure],
) -> NormalizedFigure | None:
    if not active_pts or not containers:
        return None
    best: NormalizedFigure | None = None
    best_frac = 0.0
    best_area = float("inf")
    for cont in containers:
        x1, y1, x2, y2 = cont.bbox
        inside = sum(
            1
            for px, py in active_pts
            if (x1 - 8.0) <= px <= (x2 + 8.0) and (y1 - 8.0) <= py <= (y2 + 8.0)
        )
        frac = inside / len(active_pts)
        if frac >= 0.50 and (
            frac > best_frac or (abs(frac - best_frac) < 1e-6 and cont.bbox_area < best_area)
        ):
            best = cont
            best_frac = frac
            best_area = cont.bbox_area
    return best


def _point_inside_bbox(pt: tuple[float, float], bbox: BoundingBoxTuple, margin: float = 0.0) -> bool:
    return (bbox[0] - margin) <= pt[0] <= (bbox[2] + margin) and (bbox[1] - margin) <= pt[1] <= (
        bbox[3] + margin
    )


def _median(vals: Iterable[float]) -> float:
    s = sorted(vals)
    if not s:
        return 0.0
    mid = len(s) // 2
    if len(s) % 2 == 1:
        return s[mid]
    return 0.5 * (s[mid - 1] + s[mid])


def evaluate_keypoint_rules(
    ctx: RuleContext,
    foreground_occluders_by_fig: dict[str, list[NormalizedFigure]] | None = None,
) -> list[QCFinding]:
    """Evaluate graph skeleton completeness, parent containment, L/R symmetry, bones & occlusion."""
    if ctx.is_partial_geometry:
        return []

    findings: list[QCFinding] = []
    containers = [
        nf
        for nf in ctx.normalized_figures
        if nf.figure.geometry_type in {"rectangle", "polygon", "bitmap"} and nf.bbox_area > 0.0
    ]

    for nf in ctx.normalized_figures:
        if nf.figure.geometry_type != "graph":
            continue
        fig = nf.figure
        label = ctx.figure_display_label(fig)
        geom = fig.to_geometry()
        assert geom.geometry_type == "graph"
        nodes = geom.nodes
        cls_def = _resolve_class_def(ctx, nf)

        active_pts = [(n.loc[0], n.loc[1]) for n in nodes.values() if not n.disabled]
        non_origin_pts = [pt for pt in active_pts if math.hypot(pt[0], pt[1]) > 50.0]

        template_nodes = (
            cls_def.geometry_config.nodes
            if cls_def and cls_def.geometry_config and cls_def.geometry_config.nodes
            else {}
        )
        template_edges = (
            cls_def.geometry_config.edges
            if cls_def and cls_def.geometry_config and cls_def.geometry_config.edges
            else []
        )

        # 1. KP_UNKNOWN_TEMPLATE_NODE & KP_MISSING_REQUIRED_NODES
        if template_nodes:
            unknown_keys = [k for k in nodes if k not in template_nodes]
            if unknown_keys:
                findings.append(
                    ctx.make_finding(
                        rule_id="KP_UNKNOWN_TEMPLATE_NODE",
                        severity="blocker",
                        category="keypoints",
                        title="Unknown Skeleton Template Node(s)",
                        message=f"{label} contains unknown template node key(s): {', '.join(unknown_keys[:5])}.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"KP_UNKNOWN_TEMPLATE_NODE:{fig.figure_id}",
                    )
                )

            if ctx.profile.geometry_rules.require_required_graph_nodes:
                required_ids = [
                    nid for nid, tmpl in template_nodes.items() if not tmpl.disabled
                ]
                missing_labels: list[str] = []
                for nid in required_ids:
                    nval = nodes.get(nid)
                    if nval is None:
                        missing_labels.append(template_nodes[nid].label)
                    elif (
                        not nval.disabled
                        and abs(nval.loc[0]) < 1e-6
                        and abs(nval.loc[1]) < 1e-6
                        and len(non_origin_pts) > 0
                    ):
                        missing_labels.append(f"{template_nodes[nid].label} (sentinel [0,0])")

                if missing_labels:
                    frac_missing = len(missing_labels) / max(len(required_ids), 1)
                    sev = "blocker" if (len(missing_labels) == len(required_ids) or frac_missing > 0.5) else "warning"
                    findings.append(
                        ctx.make_finding(
                            rule_id="KP_MISSING_REQUIRED_NODES",
                            severity=sev,
                            category="keypoints",
                            title="Missing Required Skeleton Keypoint(s)",
                            message=f"{label} is missing required node(s): {', '.join(missing_labels[:6])}.",
                            figure_ids=[fig.figure_id],
                            outside_viewport=nf.outside_viewport,
                            focus_rect=nf.bbox if active_pts else None,
                            fingerprint=f"KP_MISSING_REQUIRED_NODES:{fig.figure_id}",
                            suggested_fixes=[
                                QuickFixAction(
                                    action_id=f"fix_inspect_kp_{fig.figure_id}",
                                    label=f"Inspect {label}",
                                    action_type="inspect_figure",
                                    target_figure_ids=[fig.figure_id],
                                    focus_rect=nf.bbox if active_pts else None,
                                )
                            ],
                        )
                    )

        # 2. KP_OUTSIDE_PARENT_BOX
        parent = _best_parent_container(active_pts, containers)
        if parent is not None:
            px1, py1, px2, py2 = parent.bbox
            parent_label = ctx.figure_display_label(parent.figure)
            for nid, nval in nodes.items():
                if nval.disabled:
                    continue
                kx, ky = nval.loc
                if not ((px1 - 5.0) <= kx <= (px2 + 5.0) and (py1 - 5.0) <= ky <= (py2 + 5.0)):
                    dx = max(0.0, px1 - kx, kx - px2)
                    dy = max(0.0, py1 - ky, ky - py2)
                    out_dist = math.hypot(dx, dy)
                    n_label = template_nodes[nid].label if nid in template_nodes else nid
                    k_rect: BoundingBoxTuple = (kx - 30.0, ky - 30.0, kx + 30.0, ky + 30.0)
                    findings.append(
                        ctx.make_finding(
                            rule_id="KP_OUTSIDE_PARENT_BOX",
                            severity="warning",
                            category="keypoints",
                            title="Keypoint Outside Parent Bounding Box",
                            message=f"Keypoint '{n_label}' lies {out_dist:.0f}px outside parent {parent_label} box.",
                            figure_ids=[fig.figure_id, parent.figure.figure_id],
                            outside_viewport=nf.outside_viewport,
                            focus_rect=k_rect,
                            fingerprint=f"KP_OUTSIDE_PARENT_BOX:{fig.figure_id}:{n_label}",
                            suggested_fixes=[
                                QuickFixAction(
                                    action_id=f"fix_focus_kp_{fig.figure_id}_{nid}",
                                    label=f"Focus '{n_label}'",
                                    action_type="focus_viewport",
                                    target_figure_ids=[fig.figure_id],
                                    focus_rect=k_rect,
                                )
                            ],
                        )
                    )

        # 3. KP_ANATOMICAL_LR_INVERSION (facing-direction-aware, skipping non-bilateral templates)
        if template_nodes:
            bilateral_pairs: dict[str, dict[str, tuple[str, tuple[float, float]]]] = {}
            for nid, tmpl in template_nodes.items():
                nval = nodes.get(nid)
                if nval is None or nval.disabled:
                    continue
                parsed = parse_bilateral_label(tmpl.label)
                if parsed is None:
                    continue
                side, part = parsed
                bilateral_pairs.setdefault(part, {})[side] = (tmpl.label, (nval.loc[0], nval.loc[1]))

            paired = {part: sides for part, sides in bilateral_pairs.items() if "L" in sides and "R" in sides}
            if len(paired) >= 2:
                skel_w = max(nf.bbox[2] - nf.bbox[0], 1.0)
                if parent is not None:
                    skel_w = max(parent.bbox[2] - parent.bbox[0], skel_w)

                # Determine facing sign s_face (+1 facing camera: x_L > x_R; -1 facing away: x_L < x_R)
                s_face = 0
                if "eye" in paired:
                    lx = paired["eye"]["L"][1][0]
                    rx = paired["eye"]["R"][1][0]
                    if abs(lx - rx) > 6.0:
                        s_face = 1 if lx > rx else -1

                if s_face == 0:
                    votes = 0
                    for torso_part in ("shoulder", "hip", "knee", "ankle", "ear"):
                        if torso_part in paired:
                            lx = paired[torso_part]["L"][1][0]
                            rx = paired[torso_part]["R"][1][0]
                            if abs(lx - rx) > 0.08 * skel_w:
                                votes += 1 if lx > rx else -1
                    if votes != 0:
                        s_face = 1 if votes > 0 else -1

                if s_face != 0:
                    for part, sides in paired.items():
                        l_label, l_pt = sides["L"]
                        r_label, r_pt = sides["R"]
                        diff_x = l_pt[0] - r_pt[0]
                        if abs(diff_x) <= 0.12 * skel_w:
                            continue
                        pair_sign = 1 if diff_x > 0 else -1
                        if pair_sign != s_face:
                            # Crossed-ankle gait guard: skip ankle if knees are NOT also inverted
                            if part == "ankle" and "knee" in paired:
                                klx = paired["knee"]["L"][1][0]
                                krx = paired["knee"]["R"][1][0]
                                knee_sign = 1 if (klx - krx) > 0 else -1
                                if knee_sign == s_face and abs(diff_x) < 0.35 * skel_w:
                                    continue
                            findings.append(
                                ctx.make_finding(
                                    rule_id="KP_ANATOMICAL_LR_INVERSION",
                                    severity="warning",
                                    category="keypoints",
                                    title="Possible Left/Right Keypoint Inversion",
                                    message=f"Possible Left/Right inversion on ({l_label}, {r_label}) in {label}.",
                                    figure_ids=[fig.figure_id],
                                    outside_viewport=nf.outside_viewport,
                                    focus_rect=nf.bbox,
                                    fingerprint=f"KP_ANATOMICAL_LR_INVERSION:{fig.figure_id}:{part}",
                                )
                            )

        # 4. KP_BONE_PROPORTION_OUTLIER
        if template_edges:
            bone_lengths: list[tuple[str, str, float, tuple[float, float]]] = []
            for edge in template_edges:
                na = nodes.get(edge.src)
                nb = nodes.get(edge.dst)
                if na is None or nb is None or na.disabled or nb.disabled:
                    continue
                blen = math.hypot(na.loc[0] - nb.loc[0], na.loc[1] - nb.loc[1])
                la = template_nodes[edge.src].label if edge.src in template_nodes else edge.src
                lb = template_nodes[edge.dst].label if edge.dst in template_nodes else edge.dst
                mid = (0.5 * (na.loc[0] + nb.loc[0]), 0.5 * (na.loc[1] + nb.loc[1]))
                bone_lengths.append((la, lb, blen, mid))

            skel_span = math.hypot(nf.bbox[2] - nf.bbox[0], nf.bbox[3] - nf.bbox[1])
            nonzero_lens = [b[2] for b in bone_lengths if b[2] > 0.0]
            med_bone = _median(nonzero_lens)
            for la, lb, blen, mid in bone_lengths:
                b_rect: BoundingBoxTuple = (mid[0] - 32.0, mid[1] - 32.0, mid[0] + 32.0, mid[1] + 32.0)
                if skel_span > 60.0 and blen < 3.0:
                    findings.append(
                        ctx.make_finding(
                            rule_id="KP_BONE_PROPORTION_OUTLIER",
                            severity="warning",
                            category="keypoints",
                            title="Collapsed Zero-Length Skeleton Bone",
                            message=f"Bone ({la} -> {lb}) in {label} is collapsed ({blen:.1f}px).",
                            figure_ids=[fig.figure_id],
                            outside_viewport=nf.outside_viewport,
                            focus_rect=b_rect,
                            fingerprint=f"KP_BONE_PROPORTION_OUTLIER:collapsed:{fig.figure_id}:{la}_{lb}",
                        )
                    )
                elif med_bone > 5.0 and blen > 2.8 * max(med_bone, skel_span * 0.25):
                    findings.append(
                        ctx.make_finding(
                            rule_id="KP_BONE_PROPORTION_OUTLIER",
                            severity="warning",
                            category="keypoints",
                            title="Extreme Skeleton Bone Proportion Outlier",
                            message=f"Bone ({la} -> {lb}) length {blen:.0f}px is unusually long relative to {label} skeleton.",
                            figure_ids=[fig.figure_id],
                            outside_viewport=nf.outside_viewport,
                            focus_rect=b_rect,
                            fingerprint=f"KP_BONE_PROPORTION_OUTLIER:ratio:{fig.figure_id}:{la}_{lb}",
                        )
                    )

        # 5. KP_OCCLUSION_VISIBILITY_MISMATCH
        occluders: list[NormalizedFigure] = []
        if foreground_occluders_by_fig and parent is not None:
            occluders = foreground_occluders_by_fig.get(parent.figure.figure_id, [])
        for nid, nval in nodes.items():
            n_label = template_nodes[nid].label if nid in template_nodes else nid
            pt = (nval.loc[0], nval.loc[1])
            if not nval.disabled and occluders:
                for occ in occluders:
                    if _point_inside_bbox(pt, occ.bbox):
                        k_rect = (pt[0] - 28.0, pt[1] - 28.0, pt[0] + 28.0, pt[1] + 28.0)
                        findings.append(
                            ctx.make_finding(
                                rule_id="KP_OCCLUSION_VISIBILITY_MISMATCH",
                                severity="warning",
                                category="keypoints",
                                title="Visible Keypoint Inside Foreground Occluder",
                                message=f"Keypoint '{n_label}' in {label} is marked visible inside foreground occluder {ctx.figure_display_label(occ.figure)}.",
                                figure_ids=[fig.figure_id, occ.figure.figure_id],
                                outside_viewport=nf.outside_viewport,
                                focus_rect=k_rect,
                                fingerprint=f"KP_OCCLUSION_VISIBILITY_MISMATCH:vis:{fig.figure_id}:{n_label}",
                            )
                        )
                        break

    return findings
