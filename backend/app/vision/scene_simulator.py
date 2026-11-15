from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

import numpy as np

from app.rules.bbox_rules import (
    estimate_bbox_foreground_score,
    is_bbox_touching_frame_edge,
    is_truncation_tag_name,
    resolve_truncation_tag_name,
)
from app.rules.context import (
    NormalizedFigure,
    RuleContext,
    bbox_iou_and_ios,
    clamp_focus_rect,
    compute_viewport_status,
)
from app.schemas.qc import (
    BoundingBoxTuple,
    GeometryType,
    QCFinding,
    QuickFixAction,
    SceneSimulationPlan,
    SimulatedClassSummary,
    SimulatedObjectCandidate,
    SimulatedTagRecommendation,
)
from app.vision.detector import (
    infer_shape_from_ontology_title,
    strip_ontology_tool_suffix,
)
from app.vision.occlusion_depth import compute_depth_delta, resolve_pair_depth_order
from app.vision.tiling import DetectionCandidate

if TYPE_CHECKING:
    from app.vision.blur_bokeh import BokehScorer


_SUPERCLASS_TO_SUBCLASSES: dict[str, set[str]] = {
    "animal": {
        "horse",
        "dog",
        "cat",
        "bird",
        "sheep",
        "cow",
        "cattle",
        "goat",
        "deer",
        "bear",
        "elephant",
        "zebra",
        "giraffe",
    },
    "vehicle": {
        "car",
        "car1",
        "bus",
        "truck",
        "van",
        "bicycle",
        "motorbike",
        "motorcycle",
        "boat",
        "train",
        "airplane",
        "scooter",
    },
    "person": {"human", "pedestrian", "rider", "cyclist"},
    "human": {"person", "pedestrian", "rider"},
    "food": {"fruit", "apple", "banana", "orange", "pizza"},
}

_SHAPE_TOOL_ALIASES: dict[GeometryType, set[str]] = {
    "rectangle": {"rect", "rectangle", "bbox", "box"},
    "polygon": {"poly", "polygon"},
    "bitmap": {"bitmap", "brush", "mask", "eraser"},
    "polyline": {"line", "polyline", "path"},
    "point": {"point", "dot"},
    "graph": {"graph", "skeleton", "keypoint", "keypoints"},
}


@dataclass
class _FilteredCandidate:
    class_title: str
    raw_label: str
    bbox: BoundingBoxTuple
    confidence: float
    sharpness_score: float
    detector_model: str
    from_tile: bool


def _is_superclass_of(superclass_title: str, subclass_title: str) -> bool:
    sup = strip_ontology_tool_suffix(superclass_title).strip().lower()
    sub = strip_ontology_tool_suffix(subclass_title).strip().lower()
    return sup != sub and sub in _SUPERCLASS_TO_SUBCLASSES.get(sup, set())


def _resolve_recommended_shape(ctx: RuleContext, class_title: str) -> GeometryType:
    cls_def = ctx.classes_by_title.get(class_title)
    if cls_def and cls_def.shape != "any":
        return cls_def.shape
    inferred = infer_shape_from_ontology_title(class_title)
    if inferred is not None:
        return inferred
    return cls_def.shape if cls_def else "rectangle"


def _tokenize_filename(file_name: str) -> set[str]:
    stem = Path(file_name).stem.lower()
    raw_tokens = re.findall(r"[a-z0-9]+", stem)
    tokens: set[str] = set(raw_tokens)
    for tok in raw_tokens:
        if len(tok) > 3 and tok.endswith("es"):
            tokens.add(tok[:-2])
        if len(tok) > 2 and tok.endswith("s"):
            tokens.add(tok[:-1])
    return tokens


def _canonical_ontology_title(ctx: RuleContext, title: str) -> str:
    if title in ctx.classes_by_title:
        return title
    lower = title.strip().lower()
    for ont_title in ctx.classes_by_title:
        if ont_title.lower() == lower:
            return ont_title
    return title


def _resolve_object_tag_name(ctx: RuleContext, class_title: str, preferred: str) -> str | None:
    pref_lower = preferred.strip().lower()
    for tag_def in ctx.request.ontology.tags:
        if tag_def.name.strip().lower() != pref_lower:
            continue
        if tag_def.applicable_type not in {"objectsOnly", "all"}:
            return None
        if tag_def.classes and all(c.lower() != class_title.lower() for c in tag_def.classes):
            return None
        return tag_def.name
    if pref_lower in {t.strip().lower() for t in ctx.profile.tag_rules.object_only_tags}:
        return preferred
    return None


def _tool_matches_shape(active_tool: str, expected_shape: GeometryType) -> bool:
    norm = active_tool.strip().lower().replace("-", "").replace("_", "")
    aliases = _SHAPE_TOOL_ALIASES.get(expected_shape, {expected_shape})
    return any(alias == norm or alias in norm for alias in aliases)


class SceneSimulator:
    """Synthesizes an ordered pre-annotation blueprint from raw detections and scene context."""

    def prepare_candidates(
        self,
        ctx: RuleContext,
        candidates: list[DetectionCandidate],
        bokeh_scorer: BokehScorer,
    ) -> tuple[list[_FilteredCandidate], list[str], list[str]]:
        """Filter raw detections by quality/bokeh and resolve superclass vs subclass ambiguity."""
        vr = ctx.profile.vision_rules
        img_area = float(ctx.width) * float(ctx.height)
        min_area = max(16.0, float(ctx.tunables.min_relative_area) * img_area)
        filename_tokens = _tokenize_filename(ctx.request.image.file_name)

        has_ontology = bool(ctx.classes_by_title)
        quality_kept: list[_FilteredCandidate] = []
        for det in candidates:
            canonical_cls = _canonical_ontology_title(ctx, det.class_title)
            if has_ontology and canonical_cls not in ctx.classes_by_title:
                continue

            # If raw_label directly names a more specific ontology subclass, upgrade superclass hits
            if has_ontology and det.raw_label:
                raw_canonical = _canonical_ontology_title(ctx, det.raw_label)
                if raw_canonical in ctx.classes_by_title and _is_superclass_of(
                    canonical_cls, raw_canonical
                ):
                    canonical_cls = raw_canonical

            clamped = clamp_focus_rect(det.bbox, ctx.width, ctx.height)
            det_area = max(0.0, clamped[2] - clamped[0]) * max(0.0, clamped[3] - clamped[1])
            if det_area < min_area:
                continue

            override = ctx.class_override(canonical_cls)
            if override is not None and not override.enabled:
                continue

            conf_floor = max(
                vr.missed_object_min_confidence,
                override.detector_confidence
                if (override and override.detector_confidence is not None)
                else 0.0,
            )
            if det.confidence < conf_floor:
                continue

            metrics = bokeh_scorer.score_roi(clamped)
            is_bokeh_blur = (
                metrics.relative_sharpness < 0.32 and metrics.sharpness_score < 8.0
            )
            below_class_sharp = (
                override is not None
                and override.min_sharpness is not None
                and metrics.interior_lap_var < override.min_sharpness
                and metrics.relative_sharpness < 0.32
            )
            if vr.ignore_background_bokeh and (is_bokeh_blur or below_class_sharp):
                continue

            quality_kept.append(
                _FilteredCandidate(
                    class_title=canonical_cls,
                    raw_label=det.raw_label,
                    bbox=clamped,
                    confidence=det.confidence,
                    sharpness_score=metrics.sharpness_score,
                    detector_model=det.detector_model,
                    from_tile=det.from_tile,
                )
            )

        # Same-class NMS guard + superclass vs subclass cross-class NMS
        ordered = sorted(quality_kept, key=lambda c: c.confidence, reverse=True)
        suppressed: set[int] = set()
        disambiguation_notes: list[str] = []
        seen_notes: set[str] = set()

        def _add_note(note: str) -> None:
            if note not in seen_notes:
                seen_notes.add(note)
                disambiguation_notes.append(note)

        # Pass A: Resolve superclass vs subclass overlaps (IoU >= 0.65)
        for i in range(len(ordered)):
            if i in suppressed:
                continue
            ci = ordered[i]
            for j in range(i + 1, len(ordered)):
                if j in suppressed:
                    continue
                cj = ordered[j]
                if ci.class_title == cj.class_title:
                    continue
                iou, _, _, _ = bbox_iou_and_ios(ci.bbox, cj.bbox)
                if iou < 0.65:
                    continue
                if _is_superclass_of(ci.class_title, cj.class_title):
                    suppressed.add(i)
                    _add_note(
                        f"Ontology has both '{cj.class_title}' and '{ci.class_title}' — "
                        f"using specific class '{cj.class_title}'."
                    )
                    break
                if _is_superclass_of(cj.class_title, ci.class_title):
                    suppressed.add(j)
                    _add_note(
                        f"Ontology has both '{ci.class_title}' and '{cj.class_title}' — "
                        f"using specific class '{ci.class_title}'."
                    )

        # Pass B: Same-class NMS (IoU >= 0.55)
        surviving: list[_FilteredCandidate] = []
        for i, ci in enumerate(ordered):
            if i in suppressed:
                continue
            duplicate = False
            for kept in surviving:
                if kept.class_title != ci.class_title:
                    continue
                iou, _, _, _ = bbox_iou_and_ios(kept.bbox, ci.bbox)
                if iou >= 0.55:
                    duplicate = True
                    break
            if not duplicate:
                surviving.append(ci)

        # Record filename keyword hint when it reinforces a surviving ontology class
        surviving_classes = {c.class_title for c in surviving}
        for cls_title in sorted(surviving_classes):
            stem_lower = strip_ontology_tool_suffix(cls_title).lower()
            if cls_title.lower() in filename_tokens or stem_lower in filename_tokens:
                _add_note(
                    f"Filename '{ctx.request.image.file_name}' matches target class '{cls_title}'."
                )

        # Deterministic left-to-right visual ordering (#1 .. #N)
        surviving.sort(key=lambda c: (c.bbox[0], c.bbox[1], c.bbox[2], c.bbox[3]))

        counts = Counter(c.class_title for c in surviving)
        primary_target_classes = [
            cls for cls, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ]
        return surviving, primary_target_classes, disambiguation_notes

    @staticmethod
    def _match_existing_figures(
        surviving: list[_FilteredCandidate],
        two_d_figs: list[NormalizedFigure],
    ) -> dict[int, str]:
        """Use Hungarian assignment (IoU >= 0.50) to match existing figures to targets."""
        if not surviving or not two_d_figs:
            return {}

        from scipy.optimize import linear_sum_assignment  # noqa: PLC0415

        n_cands = len(surviving)
        n_figs = len(two_d_figs)
        cost = np.full((n_cands, n_figs), 1e6, dtype=np.float64)
        ious = np.zeros((n_cands, n_figs), dtype=np.float64)

        for i, cand in enumerate(surviving):
            cand_stem = strip_ontology_tool_suffix(cand.class_title).lower()
            for j, nf in enumerate(two_d_figs):
                fig_cls = nf.figure.class_title
                fig_stem = strip_ontology_tool_suffix(fig_cls).lower()
                fig_unknown = fig_cls.strip().lower() in {"", "unknown"}
                compatible = (
                    fig_cls.lower() == cand.class_title.lower()
                    or fig_stem == cand_stem
                    or _is_superclass_of(fig_cls, cand.class_title)
                    or _is_superclass_of(cand.class_title, fig_cls)
                )
                min_iou = (
                    0.42
                    if nf.figure.geometry_type in {"bitmap", "polygon"}
                    else 0.50
                )
                iou, _, _, _ = bbox_iou_and_ios(cand.bbox, nf.bbox)
                if not compatible and not (fig_unknown and iou >= 0.65):
                    continue
                ious[i, j] = iou
                if iou >= min_iou:
                    cost[i, j] = 1.0 - iou
                else:
                    cost[i, j] = 1e3

        row_ind, col_ind = linear_sum_assignment(cost)
        matches: dict[int, str] = {}
        for r, c in zip(row_ind, col_ind, strict=True):
            nf = two_d_figs[int(c)]
            min_iou = 0.42 if nf.figure.geometry_type in {"bitmap", "polygon"} else 0.50
            if ious[r, c] >= min_iou:
                matches[int(r)] = nf.figure.figure_id
        return matches

    def simulate(
        self,
        ctx: RuleContext,
        candidates: list[DetectionCandidate],
        bokeh_scorer: BokehScorer,
        depth_map: np.ndarray | None,
    ) -> tuple[SceneSimulationPlan, list[QCFinding]]:
        """Build SceneSimulationPlan and workflow/disambiguation QCFindings."""
        surviving, primary_target_classes, disambiguation_notes = self.prepare_candidates(
            ctx, candidates, bokeh_scorer
        )
        primary_set = set(primary_target_classes)
        ignored_ontology_classes = sorted(
            {
                c.title
                for c in ctx.request.ontology.classes
                if c.title not in primary_set
            }
        )

        # Check misplaced object-only tags on image_tags (e.g. 'Occlusion')
        object_only_lower = {t.strip().lower() for t in ctx.profile.tag_rules.object_only_tags}
        misplaced_image_tags: list[str] = []
        seen_misplaced: set[str] = set()
        for img_tag in ctx.request.image_tags:
            tag_lower = img_tag.name.strip().lower()
            tag_def = next(
                (t for t in ctx.request.ontology.tags if t.name.strip().lower() == tag_lower),
                None,
            )
            is_obj_only = tag_lower in object_only_lower or (
                tag_def is not None and tag_def.applicable_type == "objectsOnly"
            )
            if is_obj_only and tag_lower not in seen_misplaced:
                seen_misplaced.add(tag_lower)
                misplaced_image_tags.append(img_tag.name)

        n = len(surviving)
        iou_max = [0.0] * n
        cover_max = [0.0] * n
        occluders_by_idx: dict[int, list[tuple[int, float]]] = {i: [] for i in range(n)}

        iou_thresh = ctx.profile.tag_rules.occlusion_overlap_iou_threshold
        cover_thresh = ctx.profile.tag_rules.occlusion_cover_ratio_threshold
        delta_depth = compute_depth_delta(depth_map) if depth_map is not None else 0.0

        for i in range(n):
            ci = surviving[i]
            for j in range(i + 1, n):
                cj = surviving[j]
                iou, ios_i, ios_j, _ = bbox_iou_and_ios(ci.bbox, cj.bbox)
                if iou < iou_thresh and max(ios_i, ios_j) < cover_thresh:
                    continue

                iou_max[i] = max(iou_max[i], iou)
                iou_max[j] = max(iou_max[j], iou)
                cover_max[i] = max(cover_max[i], ios_i)
                cover_max[j] = max(cover_max[j], ios_j)

                verdict: Literal["a_foreground", "b_foreground", "ambiguous"] = "ambiguous"
                pair_conf = 0.78
                if depth_map is not None:
                    verdict = resolve_pair_depth_order(
                        depth_map=depth_map,
                        img_w=ctx.width,
                        img_h=ctx.height,
                        bbox_a=ci.bbox,
                        bbox_b=cj.bbox,
                        delta_depth=delta_depth,
                    )
                    if verdict != "ambiguous":
                        pair_conf = 0.90

                if verdict == "ambiguous":
                    score = estimate_bbox_foreground_score(
                        bbox_a=ci.bbox,
                        bbox_b=cj.bbox,
                        img_h=ctx.height,
                        ios_a_in_b=ios_i,
                        ios_b_in_a=ios_j,
                        same_class=(ci.class_title == cj.class_title),
                    )
                    if score >= 0.05:
                        verdict = "b_foreground"
                    elif score <= -0.05:
                        verdict = "a_foreground"
                    elif not math.isclose(ios_i, ios_j, abs_tol=1e-4) and abs(ios_i - ios_j) >= 0.08:
                        verdict = "b_foreground" if ios_i > ios_j else "a_foreground"

                if verdict == "b_foreground":
                    # j+1 (1-based sim_index) is foreground over i
                    occluders_by_idx[i].append((j + 1, pair_conf))
                elif verdict == "a_foreground":
                    occluders_by_idx[j].append((i + 1, pair_conf))

        two_d_figs = [
            nf
            for nf in ctx.normalized_figures
            if nf.figure.geometry_type in {"rectangle", "polygon", "bitmap"} and nf.bbox_area > 0.0
        ]
        matched_map = self._match_existing_figures(surviving, two_d_figs)

        vp = ctx.request.viewport
        w_f, h_f = float(ctx.width), float(ctx.height)
        sim_margin = max(
            float(ctx.profile.geometry_rules.edge_snap_margin_px),
            0.005 * min(w_f, h_f),
        )
        sim_candidates: list[SimulatedObjectCandidate] = []

        for idx, cand in enumerate(surviving):
            sim_index = idx + 1
            sim_id = f"sim_{sim_index:02d}"
            rec_shape: GeometryType = _resolve_recommended_shape(ctx, cand.class_title)

            occ_pairs = occluders_by_idx.get(idx, [])
            occ_indices = sorted({sim_i for sim_i, _ in occ_pairs})
            rec_tags: list[SimulatedTagRecommendation] = []

            bx1, by1, bx2, by2 = cand.bbox
            touches_edge = is_bbox_touching_frame_edge(cand.bbox, w_f, h_f, sim_margin)

            if occ_indices:
                occ_tag_name = _resolve_object_tag_name(ctx, cand.class_title, "Occlusion")
                if occ_tag_name:
                    fg_refs = ", ".join(f"#{fg_idx}" for fg_idx in occ_indices)
                    max_pair_conf = max(c for _, c in occ_pairs)
                    rec_tags.append(
                        SimulatedTagRecommendation(
                            tag_name=occ_tag_name,
                            value=None,
                            reason=f"Occluded behind foreground {cand.class_title} ({fg_refs})",
                            confidence=round(max_pair_conf, 3),
                        )
                    )

            if touches_edge:
                trunc_tag_name, _ = resolve_truncation_tag_name(
                    ctx,
                    cand.class_title,
                    fallback_to_profile=True,
                    default_advisory="Truncation",
                )
                if trunc_tag_name and all(
                    t.tag_name.lower() != trunc_tag_name.lower() for t in rec_tags
                ):
                    rec_tags.append(
                        SimulatedTagRecommendation(
                            tag_name=trunc_tag_name,
                            value=None,
                            reason=f"Cut off at image frame edge; apply {trunc_tag_name} tag.",
                            confidence=0.88,
                        )
                    )

            visibility_status: Literal["foreground_clear", "occluded", "border_truncated"]
            if occ_indices:
                visibility_status = "occluded"
            elif touches_edge:
                visibility_status = "border_truncated"
            else:
                visibility_status = "foreground_clear"

            outside_vp, direction = compute_viewport_status(
                cand.bbox,
                vp.visible_pixel_rect,
                vp.visible_norm_rect,
                vp.zoom_percent,
            )

            sim_candidates.append(
                SimulatedObjectCandidate(
                    sim_id=sim_id,
                    sim_index=sim_index,
                    class_title=cand.class_title,
                    recommended_shape=rec_shape,
                    bbox=(
                        round(bx1, 2),
                        round(by1, 2),
                        round(bx2, 2),
                        round(by2, 2),
                    ),
                    polygon_points=None,
                    confidence=round(cand.confidence, 3),
                    sharpness_score=round(cand.sharpness_score, 2),
                    visibility_status=visibility_status,
                    occluded_by_sim_indices=occ_indices,
                    overlap_iou_max=round(min(1.0, iou_max[idx]), 4),
                    overlap_cover_ratio=round(min(1.0, cover_max[idx]), 4),
                    recommended_object_tags=rec_tags,
                    outside_viewport=outside_vp,
                    viewport_edge_direction=direction if outside_vp else None,
                    matched_figure_id=matched_map.get(idx),
                )
            )

        # Aggregate per-class blueprint summaries following primary_target_classes order
        class_summaries: list[SimulatedClassSummary] = []
        by_class: dict[str, list[SimulatedObjectCandidate]] = {}
        for sc in sim_candidates:
            by_class.setdefault(sc.class_title, []).append(sc)

        for cls_title in primary_target_classes:
            group = by_class.get(cls_title, [])
            rec_shape = _resolve_recommended_shape(ctx, cls_title)
            tag_counts: dict[str, int] = {}
            for sc in group:
                for rec in sc.recommended_object_tags:
                    tag_counts[rec.tag_name] = tag_counts.get(rec.tag_name, 0) + 1
            completed_cnt = sum(1 for sc in group if sc.matched_figure_id is not None)
            class_summaries.append(
                SimulatedClassSummary(
                    class_title=cls_title,
                    recommended_shape=rec_shape,
                    total_count=len(group),
                    completed_count=completed_cnt,
                    remaining_count=len(group) - completed_cnt,
                    foreground_clear_count=sum(
                        1 for sc in group if sc.visibility_status == "foreground_clear"
                    ),
                    occluded_count=sum(1 for sc in group if sc.visibility_status == "occluded"),
                    border_truncated_count=sum(
                        1
                        for sc in group
                        if sc.visibility_status == "border_truncated"
                        or any(is_truncation_tag_name(t.tag_name) for t in sc.recommended_object_tags)
                    ),
                    tag_counts=tag_counts,
                )
            )

        completed_total = sum(1 for sc in sim_candidates if sc.matched_figure_id is not None)

        # Check active sidebar class / drawing tool mismatch
        findings: list[QCFinding] = []
        active_sidebar_warning: str | None = None
        active_cls = ctx.request.ui_state.active_class_title
        active_tool = ctx.request.ui_state.active_tool

        if sim_candidates and primary_target_classes:
            primary_cls = primary_target_classes[0]
            primary_shape = class_summaries[0].recommended_shape
            wrong_cls = bool(
                active_cls and all(active_cls.lower() != c.lower() for c in primary_target_classes)
            )
            wrong_tool = bool(active_tool and not _tool_matches_shape(active_tool, primary_shape))

            if wrong_cls or wrong_tool:
                if wrong_cls and wrong_tool:
                    active_sidebar_warning = (
                        f"Active sidebar class '{active_cls}' and tool '{active_tool}' "
                        f"do not match detected target '{primary_cls}' ({primary_shape})."
                    )
                elif wrong_cls:
                    active_sidebar_warning = (
                        f"Active sidebar class is '{active_cls}', expected '{primary_cls}' ({primary_shape})."
                    )
                else:
                    active_sidebar_warning = (
                        f"Active tool is '{active_tool}', expected '{primary_shape}' for '{primary_cls}'."
                    )

                findings.append(
                    ctx.make_finding(
                        rule_id="WORKFLOW_WRONG_ACTIVE_CLASS_OR_TOOL",
                        severity="warning",
                        category="workflow",
                        title=f"Switch Sidebar to {primary_cls}",
                        message=active_sidebar_warning,
                        confidence=0.95,
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_select_class_{re.sub(r'[^a-z0-9]+', '_', primary_cls.lower())}",
                                label=f"Switch Sidebar to {primary_cls}",
                                action_type="select_sidebar_class",
                                class_title=primary_cls,
                            )
                        ],
                        fingerprint=(
                            f"WORKFLOW_WRONG_ACTIVE_CLASS_OR_TOOL:{primary_cls}:"
                            f"{active_cls or 'none'}:{active_tool or 'none'}"
                        ),
                    )
                )

        plan = SceneSimulationPlan(
            total_target_objects=len(sim_candidates),
            completed_target_objects=completed_total,
            primary_target_classes=primary_target_classes,
            class_summaries=class_summaries,
            candidates=sim_candidates,
            recommended_image_tags=[],
            misplaced_image_tags=misplaced_image_tags,
            ignored_ontology_classes=ignored_ontology_classes,
            disambiguation_notes=disambiguation_notes,
            active_sidebar_class_warning=active_sidebar_warning,
        )
        return plan, findings
