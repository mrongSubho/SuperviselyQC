from __future__ import annotations

import math

from shapely.geometry import LineString, Point

from app.rules.context import NormalizedFigure, RuleContext
from app.schemas.qc import BoundingBoxTuple, QCFinding, QuickFixAction


def _unit_vec(dx: float, dy: float) -> tuple[float, float] | None:
    norm = math.hypot(dx, dy)
    if norm <= 1e-6:
        return None
    return (dx / norm, dy / norm)


def _polyline_endpoints_and_tangents(
    pts: list[tuple[float, float]],
) -> list[tuple[tuple[float, float], tuple[float, float] | None]]:
    """Return [(start_pt, outward_tangent), (end_pt, outward_tangent)]."""
    if len(pts) < 2:
        return []
    t_start = _unit_vec(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1])
    t_end = _unit_vec(pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1])
    return [(pts[0], t_start), (pts[-1], t_end)]


def evaluate_polyline_rules(ctx: RuleContext) -> list[QCFinding]:
    """Evaluate polyline point counts, zero-length segments, backtrack spikes, and endpoint gaps."""
    if ctx.is_partial_geometry:
        return []

    findings: list[QCFinding] = []
    profile = ctx.profile
    tunables = ctx.tunables
    min_pts = max(2, profile.geometry_rules.min_polyline_vertices)
    min_arc = max(15.0, 0.004 * float(min(ctx.width, ctx.height)))
    max_gap = min(50.0, tunables.line_endpoint_gap_px * max(1.0, min(ctx.width, ctx.height) / 1000.0))

    line_figs: list[tuple[NormalizedFigure, list[tuple[float, float]], LineString]] = []

    for nf in ctx.normalized_figures:
        if nf.figure.geometry_type != "polyline":
            continue
        fig = nf.figure
        geom = fig.to_geometry()
        assert geom.geometry_type == "polyline"
        label = ctx.figure_display_label(fig)
        pts = [(float(p[0]), float(p[1])) for p in geom.points.exterior]

        if len(pts) < min_pts:
            findings.append(
                ctx.make_finding(
                    rule_id="LINE_INSUFFICIENT_POINTS",
                    severity="blocker",
                    category="geometry",
                    title="Polyline Has Too Few Vertices",
                    message=f"{label} has {len(pts)} vertices (minimum {min_pts} required).",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"LINE_INSUFFICIENT_POINTS:{fig.figure_id}",
                )
            )
            continue

        # Segment lengths and duplicate consecutive points
        seg_lens = [
            math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            for i in range(len(pts) - 1)
        ]
        arc_length = sum(seg_lens)
        zero_segs = [idx for idx, s in enumerate(seg_lens) if s < 1.0]

        if arc_length < min_arc:
            findings.append(
                ctx.make_finding(
                    rule_id="LINE_ZERO_LENGTH_SEGMENT",
                    severity="blocker",
                    category="geometry",
                    title="Micro / Zero-Length Polyline",
                    message=f"{label} total length is {arc_length:.1f}px (< {min_arc:.1f}px minimum).",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"LINE_ZERO_LENGTH_SEGMENT:micro:{fig.figure_id}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_del_line_{fig.figure_id}",
                            label=f"Delete Micro-Line {label}",
                            action_type="confirm_delete_figure",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=nf.bbox,
                        )
                    ],
                )
            )
        elif zero_segs:
            p0 = pts[zero_segs[0]]
            findings.append(
                ctx.make_finding(
                    rule_id="LINE_ZERO_LENGTH_SEGMENT",
                    severity="warning",
                    category="geometry",
                    title="Duplicate Consecutive Polyline Point",
                    message=f"{label} contains {len(zero_segs)} zero-length (<1px) segment(s).",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=(p0[0] - 20.0, p0[1] - 20.0, p0[0] + 20.0, p0[1] + 20.0),
                    fingerprint=f"LINE_ZERO_LENGTH_SEGMENT:dup:{fig.figure_id}",
                )
            )

        # Acute backtrack spike check: folding angle between -u and v < 25 deg
        spike_pt: tuple[float, float] | None = None
        min_fold_deg = 180.0
        for i in range(1, len(pts) - 1):
            ux, uy = pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]
            vx, vy = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
            lu, lv = math.hypot(ux, uy), math.hypot(vx, vy)
            if lu <= 4.0 or lv <= 4.0:
                continue
            cos_alpha = max(-1.0, min(1.0, ((-ux) * vx + (-uy) * vy) / (lu * lv)))
            alpha_deg = math.degrees(math.acos(cos_alpha))
            if alpha_deg < tunables.line_acute_backtrack_deg and alpha_deg < min_fold_deg:
                min_fold_deg = alpha_deg
                spike_pt = pts[i]

        if spike_pt is not None:
            s_rect: BoundingBoxTuple = (
                spike_pt[0] - 32.0,
                spike_pt[1] - 32.0,
                spike_pt[0] + 32.0,
                spike_pt[1] + 32.0,
            )
            findings.append(
                ctx.make_finding(
                    rule_id="LINE_ACUTE_BACKTRACK_SPIKE",
                    severity="warning",
                    category="geometry",
                    title="Acute Backtrack Spike on Polyline",
                    message=f"{label} folds back sharply ({min_fold_deg:.1f}° < {tunables.line_acute_backtrack_deg:.0f}°).",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=s_rect,
                    fingerprint=f"LINE_ACUTE_BACKTRACK_SPIKE:{fig.figure_id}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_focus_linespike_{fig.figure_id}",
                            label="Focus Backtrack Spike",
                            action_type="focus_viewport",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=s_rect,
                        )
                    ],
                )
            )

        ls = nf.shapely_geom if isinstance(nf.shapely_geom, LineString) else LineString(pts)
        if not ls.is_simple:
            findings.append(
                ctx.make_finding(
                    rule_id="LINE_SELF_INTERSECTION",
                    severity="warning",
                    category="geometry",
                    title="Self-Intersecting Polyline",
                    message=f"{label} crosses itself forming an unintended loop.",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"LINE_SELF_INTERSECTION:{fig.figure_id}",
                )
            )

        # Near-closed single polyline hint
        end_dist = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1])
        if arc_length > 80.0 and end_dist < 12.0:
            findings.append(
                ctx.make_finding(
                    rule_id="LINE_DISCONNECTED_ENDPOINT_GAP",
                    severity="info",
                    category="geometry",
                    title="Near-Closed Polyline Loop",
                    message=f"{label} endpoints are {end_dist:.1f}px apart — verify whether a Polygon or closed loop was intended.",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=(pts[0][0] - 25.0, pts[0][1] - 25.0, pts[0][0] + 25.0, pts[0][1] + 25.0),
                    fingerprint=f"LINE_DISCONNECTED_ENDPOINT_GAP:loop:{fig.figure_id}",
                )
            )

        line_figs.append((nf, pts, ls))

    # Pairwise collinear / T-junction endpoint gap check across same-class polylines
    emitted_pairs: set[tuple[str, str]] = set()
    for i in range(len(line_figs)):
        nf_a, pts_a, ls_a = line_figs[i]
        ends_a = _polyline_endpoints_and_tangents(pts_a)
        for j in range(i + 1, len(line_figs)):
            nf_b, pts_b, ls_b = line_figs[j]
            if nf_a.figure.class_title != nf_b.figure.class_title:
                continue
            id_a = nf_a.figure.figure_id
            id_b = nf_b.figure.figure_id
            pair_key = (id_a, id_b) if id_a <= id_b else (id_b, id_a)
            if pair_key in emitted_pairs:
                continue
            ends_b = _polyline_endpoints_and_tangents(pts_b)

            gap_found: tuple[float, tuple[float, float]] | None = None

            # Endpoint-to-endpoint collinear continuation check
            for ea, ta in ends_a:
                for eb, tb in ends_b:
                    d = math.hypot(ea[0] - eb[0], ea[1] - eb[1])
                    if 3.0 <= d <= max_gap and ta is not None and tb is not None:
                        cos_ang = max(-1.0, min(1.0, ta[0] * (-tb[0]) + ta[1] * (-tb[1])))
                        ang_deg = math.degrees(math.acos(cos_ang))
                        if ang_deg <= 30.0:
                            gap_found = (d, (0.5 * (ea[0] + eb[0]), 0.5 * (ea[1] + eb[1])))
                            break
                if gap_found is not None:
                    break

            # T-junction endpoint-to-interior segment check
            if gap_found is None:
                for ea, _ in ends_a:
                    d = float(Point(ea).distance(ls_b))
                    if 3.0 <= d <= max_gap:
                        gap_found = (d, ea)
                        break
            if gap_found is None:
                for eb, _ in ends_b:
                    d = float(Point(eb).distance(ls_a))
                    if 3.0 <= d <= max_gap:
                        gap_found = (d, eb)
                        break

            if gap_found is not None:
                emitted_pairs.add(pair_key)
                dist_px, mid = gap_found
                gap_rect: BoundingBoxTuple = (mid[0] - 36.0, mid[1] - 36.0, mid[0] + 36.0, mid[1] + 36.0)
                la = ctx.figure_display_label(nf_a.figure)
                lb = ctx.figure_display_label(nf_b.figure)
                findings.append(
                    ctx.make_finding(
                        rule_id="LINE_DISCONNECTED_ENDPOINT_GAP",
                        severity="warning",
                        category="geometry",
                        title="Disconnected Polyline Gap",
                        message=f"Disconnected gap ({dist_px:.0f}px) between {la} and {lb} — join or snap endpoints.",
                        figure_ids=[nf_a.figure.figure_id, nf_b.figure.figure_id],
                        outside_viewport=nf_a.outside_viewport and nf_b.outside_viewport,
                        focus_rect=gap_rect,
                        fingerprint=f"LINE_DISCONNECTED_ENDPOINT_GAP:{'_'.join(pair_key)}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_focus_gap_{'_'.join(pair_key)}",
                                label="Focus Endpoint Gap",
                                action_type="focus_viewport",
                                target_figure_ids=[nf_a.figure.figure_id, nf_b.figure.figure_id],
                                focus_rect=gap_rect,
                            )
                        ],
                    )
                )

    return findings
