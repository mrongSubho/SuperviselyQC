from __future__ import annotations

import math
import re

from shapely.geometry import LinearRing, Polygon
from shapely.validation import explain_validity

from app.rules.context import RuleContext
from app.schemas.qc import BoundingBoxTuple, Point2D, QCFinding, QuickFixAction

_LOW_DENSITY_EXEMPT_CLASSES = {
    "building",
    "box",
    "wall",
    "window",
    "door",
    "sign",
    "screen",
    "billboard",
}

_WITNESS_RE = re.compile(r"\[(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\]")


def _dedup_ring(pts: list[Point2D], tol: float = 0.5) -> list[tuple[float, float]]:
    if not pts:
        return []
    cleaned: list[tuple[float, float]] = [(float(pts[0][0]), float(pts[0][1]))]
    for pt in pts[1:]:
        px, py = float(pt[0]), float(pt[1])
        if math.hypot(px - cleaned[-1][0], py - cleaned[-1][1]) >= tol:
            cleaned.append((px, py))
    if len(cleaned) > 1 and math.hypot(cleaned[-1][0] - cleaned[0][0], cleaned[-1][1] - cleaned[0][1]) < tol:
        cleaned.pop()
    return cleaned


def _shoelace_signed_area(pts: list[tuple[float, float]]) -> float:
    if len(pts) < 3:
        return 0.0
    total = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        total += x1 * y2 - x2 * y1
    return 0.5 * total


def _point_to_segment_dist(
    p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> float:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    len_sq = dx * dx + dy * dy
    if len_sq <= 1e-9:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len_sq))
    proj_x = a[0] + t * dx
    proj_y = a[1] + t * dy
    return math.hypot(p[0] - proj_x, p[1] - proj_y)


def _interior_angle_deg(
    prev_pt: tuple[float, float],
    curr_pt: tuple[float, float],
    next_pt: tuple[float, float],
) -> tuple[float, float, float]:
    ux, uy = prev_pt[0] - curr_pt[0], prev_pt[1] - curr_pt[1]
    vx, vy = next_pt[0] - curr_pt[0], next_pt[1] - curr_pt[1]
    lu = math.hypot(ux, uy)
    lv = math.hypot(vx, vy)
    if lu <= 1e-6 or lv <= 1e-6:
        return 180.0, lu, lv
    cos_theta = max(-1.0, min(1.0, (ux * vx + uy * vy) / (lu * lv)))
    return math.degrees(math.acos(cos_theta)), lu, lv


def _witness_focus_rect(poly: Polygon, fallback_bbox: BoundingBoxTuple) -> BoundingBoxTuple:
    reason = explain_validity(poly)
    match = _WITNESS_RE.search(reason)
    if match:
        wx = float(match.group(1))
        wy = float(match.group(2))
        return (wx - 40.0, wy - 40.0, wx + 40.0, wy + 40.0)
    return fallback_bbox


def evaluate_polygon_rules(ctx: RuleContext) -> list[QCFinding]:
    """Evaluate Shapely polygon topology, winding-independent area, spikes, and holes."""
    if ctx.is_partial_geometry:
        return []

    findings: list[QCFinding] = []
    profile = ctx.profile
    min_verts = max(3, profile.geometry_rules.min_polygon_vertices)

    for nf in ctx.normalized_figures:
        if nf.figure.geometry_type != "polygon":
            continue
        fig = nf.figure
        geom = fig.to_geometry()
        assert geom.geometry_type == "polygon"
        label = ctx.figure_display_label(fig)

        ext = _dedup_ring(geom.points.exterior)
        if len(ext) < min_verts:
            findings.append(
                ctx.make_finding(
                    rule_id="POLY_INSUFFICIENT_VERTICES",
                    severity="blocker",
                    category="geometry",
                    title="Polygon Has Insufficient Distinct Vertices",
                    message=f"{label} has {len(ext)} distinct vertices (minimum {min_verts} required).",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"POLY_INSUFFICIENT_VERTICES:{fig.figure_id}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_inspect_poly_{fig.figure_id}",
                            label=f"Inspect {label}",
                            action_type="inspect_figure",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=nf.bbox,
                        )
                    ],
                )
            )
            continue

        ext_ring = LinearRing(ext)
        ext_poly = Polygon(ext)
        ext_area = abs(_shoelace_signed_area(ext))
        a_min = ctx.effective_min_area(fig.class_title, profile.geometry_rules.min_box_area_px)

        if not ext_ring.is_valid or not ext_poly.is_valid:
            witness_rect = _witness_focus_rect(ext_poly, nf.bbox)
            findings.append(
                ctx.make_finding(
                    rule_id="POLY_SELF_INTERSECTION",
                    severity="blocker",
                    category="geometry",
                    title="Self-Intersecting Polygon Boundary",
                    message=f"{label} boundary crosses itself ({explain_validity(ext_poly)}).",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=witness_rect,
                    fingerprint=f"POLY_SELF_INTERSECTION:{fig.figure_id}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_focus_poly_cross_{fig.figure_id}",
                            label=f"Focus Crossing on {label}",
                            action_type="focus_viewport",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=witness_rect,
                        )
                    ],
                )
            )

        # Winding-independent area check
        hole_polys: list[Polygon] = []
        valid_hole_area = 0.0
        hole_invalid_found = False

        for h_idx, raw_hole in enumerate(geom.points.interior):
            hole_pts = _dedup_ring(raw_hole)
            if len(hole_pts) < 3:
                hole_invalid_found = True
                findings.append(
                    ctx.make_finding(
                        rule_id="POLY_HOLE_INVALID",
                        severity="blocker",
                        category="geometry",
                        title="Invalid Polygon Interior Hole",
                        message=f"Hole #{h_idx + 1} inside {label} has fewer than 3 distinct vertices.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"POLY_HOLE_INVALID:{fig.figure_id}:{h_idx}",
                    )
                )
                continue

            h_ring = LinearRing(hole_pts)
            h_poly = Polygon(hole_pts)
            if not h_ring.is_valid or not h_poly.is_valid:
                hole_invalid_found = True
                w_rect = _witness_focus_rect(h_poly, nf.bbox)
                findings.append(
                    ctx.make_finding(
                        rule_id="POLY_HOLE_INVALID",
                        severity="blocker",
                        category="geometry",
                        title="Self-Intersecting Polygon Hole",
                        message=f"Hole #{h_idx + 1} inside {label} self-intersects.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=w_rect,
                        fingerprint=f"POLY_HOLE_INVALID:{fig.figure_id}:{h_idx}",
                    )
                )
                continue

            if ext_poly.is_valid and (not ext_poly.covers(h_poly) or ext_ring.crosses(h_ring)):
                hole_invalid_found = True
                hb = h_poly.bounds
                h_rect: BoundingBoxTuple = (hb[0], hb[1], hb[2], hb[3])
                findings.append(
                    ctx.make_finding(
                        rule_id="POLY_HOLE_INVALID",
                        severity="blocker",
                        category="geometry",
                        title="Polygon Hole Outside Exterior Ring",
                        message=f"Hole #{h_idx + 1} extends outside or crosses the outer boundary of {label}.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=h_rect,
                        fingerprint=f"POLY_HOLE_INVALID:{fig.figure_id}:{h_idx}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_focus_hole_{fig.figure_id}_{h_idx}",
                                label="Focus Invalid Hole",
                                action_type="focus_viewport",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=h_rect,
                            )
                        ],
                    )
                )
                continue

            h_area = abs(_shoelace_signed_area(hole_pts))
            if h_area < ctx.tunables.poly_micro_hole_px:
                hb = h_poly.bounds
                findings.append(
                    ctx.make_finding(
                        rule_id="POLY_MICRO_HOLE",
                        severity="warning",
                        category="geometry",
                        title="Tiny Micro-Hole Inside Polygon",
                        message=f"Hole #{h_idx + 1} inside {label} is only {h_area:.1f}px² (< {ctx.tunables.poly_micro_hole_px:.0f}px²).",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=(hb[0], hb[1], hb[2], hb[3]),
                        fingerprint=f"POLY_MICRO_HOLE:{fig.figure_id}:{h_idx}",
                    )
                )

            for prev_idx, prev_h in enumerate(hole_polys):
                if h_poly.intersects(prev_h):
                    hole_invalid_found = True
                    hb = h_poly.bounds
                    findings.append(
                        ctx.make_finding(
                            rule_id="POLY_HOLE_INVALID",
                            severity="blocker",
                            category="geometry",
                            title="Overlapping or Nested Polygon Holes",
                            message=f"Hole #{h_idx + 1} intersects/nests with Hole #{prev_idx + 1} inside {label}.",
                            figure_ids=[fig.figure_id],
                            outside_viewport=nf.outside_viewport,
                            focus_rect=(hb[0], hb[1], hb[2], hb[3]),
                            fingerprint=f"POLY_HOLE_INVALID:{fig.figure_id}:{prev_idx}_{h_idx}",
                        )
                    )
                    break

            hole_polys.append(h_poly)
            valid_hole_area += h_area

        net_area = max(0.0, ext_area - valid_hole_area) if not hole_invalid_found else ext_area
        if net_area < a_min:
            findings.append(
                ctx.make_finding(
                    rule_id="POLY_DEGENERATE_AREA",
                    severity="blocker",
                    category="geometry",
                    title="Degenerate / Zero-Area Polygon",
                    message=f"{label} area ({net_area:.1f}px²) is below minimum {a_min:.0f}px².",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"POLY_DEGENERATE_AREA:{fig.figure_id}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_del_poly_{fig.figure_id}",
                            label=f"Delete Degenerate {label}",
                            action_type="confirm_delete_figure",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=nf.bbox,
                        )
                    ],
                )
            )

        # Low vertex density on large organic shapes
        perimeter = float(ext_ring.length)
        if fig.class_title.lower() not in _LOW_DENSITY_EXEMPT_CLASSES:
            low_count = perimeter > 250.0 and len(ext) < 6
            convex_gap = float(ext_poly.convex_hull.area - ext_poly.area) if ext_poly.is_valid else 1.0
            sparse_convex = (
                perimeter > 400.0
                and (len(ext) / (perimeter / 100.0)) < 0.8
                and convex_gap <= 1.0
            )
            if low_count or sparse_convex:
                findings.append(
                    ctx.make_finding(
                        rule_id="POLY_LOW_VERTEX_DENSITY",
                        severity="warning",
                        category="geometry",
                        title="Coarse / Low-Vertex-Density Polygon",
                        message=f"{label} uses only {len(ext)} vertices across a {perimeter:.0f}px perimeter — refine contour fit.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=nf.outside_viewport,
                        focus_rect=nf.bbox,
                        fingerprint=f"POLY_LOW_VERTEX_DENSITY:{fig.figure_id}",
                    )
                )

        # Collinear redundant vertices & acute needle spikes
        n = len(ext)
        collinear_count = 0
        spike_pt: tuple[float, float] | None = None
        spike_angle = 180.0
        for idx in range(n):
            p_prev = ext[(idx - 1) % n]
            p_curr = ext[idx]
            p_next = ext[(idx + 1) % n]
            d_perp = _point_to_segment_dist(p_curr, p_prev, p_next)
            if d_perp < ctx.tunables.poly_collinear_tol_px:
                collinear_count += 1
            angle, lu, lv = _interior_angle_deg(p_prev, p_curr, p_next)
            if lu > 6.0 and lv > 6.0 and angle < ctx.tunables.poly_acute_spike_deg:
                if spike_pt is None or angle < spike_angle:
                    spike_pt = p_curr
                    spike_angle = angle

        if n >= 5 and (collinear_count >= 3 or (collinear_count / n) > 0.30):
            findings.append(
                ctx.make_finding(
                    rule_id="POLY_COLLINEAR_REDUNDANT_VERTICES",
                    severity="info",
                    category="geometry",
                    title="Redundant Collinear Polygon Vertices",
                    message=f"{label} has {collinear_count} nearly collinear vertices (<{ctx.tunables.poly_collinear_tol_px}px offset); consider simplifying.",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    fingerprint=f"POLY_COLLINEAR_REDUNDANT_VERTICES:{fig.figure_id}",
                )
            )

        if spike_pt is not None:
            s_rect: BoundingBoxTuple = (
                spike_pt[0] - 32.0,
                spike_pt[1] - 32.0,
                spike_pt[0] + 32.0,
                spike_pt[1] + 32.0,
            )
            findings.append(
                ctx.make_finding(
                    rule_id="POLY_ACUTE_NEEDLE_SPIKE",
                    severity="warning",
                    category="geometry",
                    title="Acute Needle Spike on Polygon",
                    message=f"{label} contains an acute {spike_angle:.1f}° vertex spike (<{ctx.tunables.poly_acute_spike_deg:.0f}°).",
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=s_rect,
                    fingerprint=f"POLY_ACUTE_NEEDLE_SPIKE:{fig.figure_id}",
                    suggested_fixes=[
                        QuickFixAction(
                            action_id=f"fix_focus_spike_{fig.figure_id}",
                            label="Focus Needle Spike",
                            action_type="focus_viewport",
                            target_figure_ids=[fig.figure_id],
                            focus_rect=s_rect,
                        )
                    ],
                )
            )

    return findings
