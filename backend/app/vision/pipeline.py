from __future__ import annotations

import hashlib
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, cast

import numpy as np

from app.config import EngineSettings
from app.rules.context import (
    NormalizedFigure,
    RuleContext,
    bbox_iou_and_ios,
    compute_viewport_status,
)
from app.schemas.qc import (
    BoundingBoxTuple,
    MissedObjectOverlay,
    QCFinding,
    QCMode,
    SceneSimulationPlan,
)
from app.vision.detector import infer_shape_from_ontology_title, strip_ontology_tool_suffix
from app.vision.model_manager import ModelManager

if TYPE_CHECKING:
    from app.vision.blur_bokeh import BokehScorer
    from app.vision.detector import ObjectDetector
    from app.vision.pose_auditor import PoseAuditor
    from app.vision.scene_simulator import SceneSimulator
    from app.vision.tightness_auditor import TightnessAuditor
    from app.vision.tiling import DetectionCandidate


@dataclass
class VisionOutput:
    """Aggregated Layer 2 vision pipeline results."""

    device: str = "none"
    models_used: list[str] = field(default_factory=list)
    degraded_reason: str | None = None
    missed_objects: list[MissedObjectOverlay] = field(default_factory=list)
    findings: list[QCFinding] = field(default_factory=list)
    depth_ordering: dict[tuple[str, str], str] = field(default_factory=dict)
    foreground_occluders: dict[str, list[NormalizedFigure]] = field(default_factory=dict)
    scene_simulation: SceneSimulationPlan | None = None


def filter_and_build_missed_objects(
    ctx: RuleContext,
    candidates: list[DetectionCandidate],
    bokeh_scorer: BokehScorer,
    suppress_missed_findings: bool = False,
) -> tuple[list[MissedObjectOverlay], list[QCFinding]]:
    """Match CV detections against user figures, apply Bokeh Blur Gate, and emit overlays + findings."""
    if suppress_missed_findings:
        return [], []
    vr = ctx.profile.vision_rules
    vp = ctx.request.viewport
    img_area = float(ctx.width) * float(ctx.height)
    min_area = max(16.0, float(ctx.tunables.min_relative_area) * img_area)
    user_2d = [nf for nf in ctx.normalized_figures if nf.bbox_area > 0.0]

    missed: list[MissedObjectOverlay] = []
    findings: list[QCFinding] = []

    for idx, det in enumerate(candidates):
        dx1, dy1, dx2, dy2 = det.bbox
        det_area = max(0.0, dx2 - dx1) * max(0.0, dy2 - dy1)
        if det_area < min_area:
            continue

        override = ctx.class_override(det.class_title)
        if override is not None and (
            not override.enabled or override.suppress_missed_object_prompts
        ):
            continue

        conf_floor = max(
            vr.missed_object_min_confidence,
            override.detector_confidence
            if (override and override.detector_confidence is not None)
            else 0.0,
        )
        if det.confidence < conf_floor:
            continue

        already_labeled = False
        det_stem = strip_ontology_tool_suffix(det.class_title).lower()
        for nf in user_2d:
            iou, _, ios_det, _ = bbox_iou_and_ios(nf.bbox, det.bbox)
            fig_stem = strip_ontology_tool_suffix(nf.figure.class_title).lower()
            same_cls = (
                nf.figure.class_title.lower() == det.class_title.lower()
                or fig_stem == det_stem
            )
            iou_floor = 0.28 if nf.figure.geometry_type in {"bitmap", "polygon"} else 0.35
            ios_floor = 0.55 if nf.figure.geometry_type in {"bitmap", "polygon"} else 0.65
            if same_cls and (iou >= iou_floor or ios_det >= ios_floor):
                already_labeled = True
                break
            if iou >= 0.60:
                already_labeled = True
                break
        if already_labeled:
            continue

        metrics = bokeh_scorer.score_roi(det.bbox)
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

        outside_vp, direction = compute_viewport_status(
            det.bbox,
            vp.visible_pixel_rect,
            vp.visible_norm_rect,
            vp.zoom_percent,
        )

        clamped_bbox = (
            round(max(0.0, min(float(ctx.width), dx1)), 2),
            round(max(0.0, min(float(ctx.height), dy1)), 2),
            round(max(0.0, min(float(ctx.width), dx2)), 2),
            round(max(0.0, min(float(ctx.height), dy2)), 2),
        )
        sig = f"{ctx.request.image.image_id}:{det.class_title}:{round(dx1, 1)}:{round(dy1, 1)}:{idx}"
        missed_id = f"miss_{hashlib.sha1(sig.encode('utf-8')).hexdigest()[:10]}"
        cls_def = ctx.classes_by_title.get(det.class_title)
        raw_shape = (
            cls_def.shape
            if (cls_def and cls_def.shape != "any")
            else infer_shape_from_ontology_title(det.class_title)
        )
        missed_geom: Literal["rectangle", "polygon", "bitmap"] = (
            cast(Literal["rectangle", "polygon", "bitmap"], raw_shape)
            if raw_shape in {"rectangle", "polygon", "bitmap"}
            else "rectangle"
        )
        missed.append(
            MissedObjectOverlay(
                missed_id=missed_id,
                class_title=det.class_title,
                geometry_type=missed_geom,
                bbox=clamped_bbox,
                polygon_points=None,
                confidence=round(det.confidence, 3),
                sharpness_score=metrics.sharpness_score,
                outside_viewport=outside_vp,
                viewport_edge_direction=direction if outside_vp else None,
                detector_model=det.detector_model,
            )
        )

        loc_hint = (
            f" Outside zoomed viewport ({direction} edge)."
            if outside_vp and direction
            else ""
        )
        findings.append(
            ctx.make_finding(
                rule_id="VISION_MISSED_OBJECT",
                severity="warning",
                category="missed_objects",
                title=f"Possible Missed {det.class_title}",
                message=(
                    f"Detected sharp unannotated '{det.class_title}' (conf {det.confidence:.2f}, "
                    f"S_rel={metrics.relative_sharpness:.2f}).{loc_hint}"
                ),
                missed_object_ids=[missed_id],
                outside_viewport=outside_vp,
                focus_rect=clamped_bbox,
                confidence=round(det.confidence, 3),
                fingerprint=(
                    f"VISION_MISSED_OBJECT:{det.class_title}:"
                    f"{int(round(clamped_bbox[0] / 16.0))}_{int(round(clamped_bbox[1] / 16.0))}"
                ),
            )
        )

    return missed, findings


def audit_user_bokeh_figures(
    ctx: RuleContext,
    bokeh_scorer: BokehScorer,
) -> list[QCFinding]:
    """Flag blurry user annotations when class profile enforces strict sharpness floor."""
    vr = ctx.profile.vision_rules
    if not vr.ignore_background_bokeh:
        return []

    findings: list[QCFinding] = []
    for nf in ctx.normalized_figures:
        if nf.bbox_area < 400.0:
            continue
        fig = nf.figure
        override = ctx.class_override(fig.class_title)
        if override is None or override.min_sharpness is None:
            continue

        metrics = bokeh_scorer.score_roi(nf.bbox)
        if (
            metrics.relative_sharpness < 0.32
            and metrics.interior_lap_var < override.min_sharpness
        ):
            label = ctx.figure_display_label(fig)
            findings.append(
                ctx.make_finding(
                    rule_id="VISION_BOKEH_OUT_OF_FOCUS",
                    severity="warning",
                    category="classification",
                    title="Out-of-Focus / Bokeh Annotation",
                    message=(
                        f"{label} appears out of focus (S_raw={metrics.sharpness_score:.1f}, "
                        f"S_rel={metrics.relative_sharpness:.2f}, lapVar={metrics.interior_lap_var:.1f} < "
                        f"{override.min_sharpness:.1f})."
                    ),
                    figure_ids=[fig.figure_id],
                    outside_viewport=nf.outside_viewport,
                    focus_rect=nf.bbox,
                    confidence=0.85,
                    fingerprint=f"VISION_BOKEH_OUT_OF_FOCUS:{fig.figure_id}",
                )
            )
    return findings


def _has_overlapping_pair(candidates: list[DetectionCandidate], ctx: RuleContext) -> bool:
    """Return True when >=2 non-tiny detections overlap enough for occlusion ordering."""
    if len(candidates) < 2:
        return False
    iou_thresh = ctx.profile.tag_rules.occlusion_overlap_iou_threshold
    cover_thresh = ctx.profile.tag_rules.occlusion_cover_ratio_threshold
    min_area = max(16.0, float(ctx.tunables.min_relative_area) * float(ctx.width) * float(ctx.height))
    valid = [
        c
        for c in candidates
        if max(0.0, c.bbox[2] - c.bbox[0]) * max(0.0, c.bbox[3] - c.bbox[1]) >= min_area
    ]
    for i in range(len(valid)):
        for j in range(i + 1, len(valid)):
            iou, ios_a, ios_b, _ = bbox_iou_and_ios(valid[i].bbox, valid[j].bbox)
            if iou >= iou_thresh or max(ios_a, ios_b) >= cover_thresh:
                return True
    return False


def _drop_suppressed_superclass_candidates(
    candidates: list[DetectionCandidate],
    plan: SceneSimulationPlan,
) -> list[DetectionCandidate]:
    """Exclude duplicate superclass detections suppressed in favor of specific subclasses."""
    if not plan.candidates or not plan.ignored_ontology_classes:
        return candidates
    ignored = {c.lower() for c in plan.ignored_ontology_classes}
    kept: list[DetectionCandidate] = []
    for det in candidates:
        if det.class_title.lower() in ignored and any(
            bbox_iou_and_ios(det.bbox, sc.bbox)[0] >= 0.65 for sc in plan.candidates
        ):
            continue
        kept.append(det)
    return kept


class VisionPipeline:
    """Coordinates Layer 2 detection, bokeh gate, depth ordering, SAM tightness & pose checks."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.model_manager = ModelManager(settings)
        # Defer importing heavy scipy/CV submodules until Layer 2 vision mode executes so idle/rules RSS < 120 MB
        self._detector: ObjectDetector | None = None
        self._tightness_auditor: TightnessAuditor | None = None
        self._pose_auditor: PoseAuditor | None = None
        self._scene_simulator: SceneSimulator | None = None

    def _ensure_components(
        self,
    ) -> tuple[Any, ObjectDetector, TightnessAuditor, PoseAuditor, SceneSimulator, Any, Any]:
        from app.vision.blur_bokeh import BokehScorer as _BokehScorer  # noqa: PLC0415
        from app.vision.detector import ObjectDetector as _ObjectDetector  # noqa: PLC0415
        from app.vision.occlusion_depth import (  # noqa: PLC0415
            compute_depth_occlusion_ordering,
            infer_depth_map,
        )
        from app.vision.pose_auditor import PoseAuditor as _PoseAuditor  # noqa: PLC0415
        from app.vision.scene_simulator import SceneSimulator as _SceneSimulator  # noqa: PLC0415
        from app.vision.tightness_auditor import TightnessAuditor as _TightnessAuditor  # noqa: PLC0415

        if self._detector is None:
            self._detector = _ObjectDetector(self.model_manager)
        if self._tightness_auditor is None:
            self._tightness_auditor = _TightnessAuditor(self.model_manager)
        if self._pose_auditor is None:
            self._pose_auditor = _PoseAuditor(self.model_manager)
        if self._scene_simulator is None:
            self._scene_simulator = _SceneSimulator()
        return (
            _BokehScorer,
            self._detector,
            self._tightness_auditor,
            self._pose_auditor,
            self._scene_simulator,
            infer_depth_map,
            compute_depth_occlusion_ordering,
        )

    def probe_device_name(self) -> str:
        """Report 'mps' vs 'cpu' without importing heavy torch into RSS at startup."""
        return self.model_manager.probe_device_lightweight()

    def loaded_models(self) -> list[str]:
        return self.model_manager.loaded_model_names()

    def run(
        self,
        ctx: RuleContext,
        rgb: np.ndarray,
        mode: QCMode,
        cancel_event: threading.Event | None = None,
        progress_cb: Callable[[str, float], None] | None = None,
    ) -> VisionOutput:
        if mode == "rules":
            return VisionOutput(device="none", models_used=[])

        def _cancelled() -> bool:
            return cancel_event is not None and cancel_event.is_set()

        if progress_cb:
            progress_cb("vision_init", 0.1)

        (
            bokeh_cls,
            detector,
            tightness_auditor,
            pose_auditor,
            scene_simulator,
            infer_depth_fn,
            depth_order_fn,
        ) = self._ensure_components()

        device = self.model_manager.resolve_device()
        models_used: list[str] = []
        findings: list[QCFinding] = []
        missed_objects: list[MissedObjectOverlay] = []
        depth_ordering: dict[tuple[str, str], str] = {}
        foreground_occluders: dict[str, list[NormalizedFigure]] = {}
        scene_simulation: SceneSimulationPlan | None = None

        if _cancelled():
            return VisionOutput(device=device, models_used=models_used)

        # Stage 1: Bokeh scorer (native 1:1, or coordinate-scaled if preview rgb) + user blur audit
        rgb_h, rgb_w = rgb.shape[:2]
        coord_sx = float(ctx.width) / float(max(rgb_w, 1))
        coord_sy = float(ctx.height) / float(max(rgb_h, 1))
        needs_coord_scale = abs(coord_sx - 1.0) > 0.015 or abs(coord_sy - 1.0) > 0.015
        bokeh_scorer = (
            bokeh_cls(rgb, coord_width=float(ctx.width), coord_height=float(ctx.height))
            if needs_coord_scale
            else bokeh_cls(rgb)
        )
        if progress_cb:
            progress_cb("bokeh_gate", 0.25)
        findings.extend(audit_user_bokeh_figures(ctx, bokeh_scorer))

        if _cancelled():
            return VisionOutput(device=device, models_used=models_used, findings=findings)

        # Stage 2: Object Detection (YOLO11s + 2x2 high-res tiling; optional YOLO-Worldv2 in deep)
        if progress_cb:
            progress_cb("detection", 0.40)
        candidates, det_models, det_device = detector.detect(
            ctx=ctx,
            rgb=rgb,
            device=device,
            use_open_vocab=(mode == "deep"),
        )
        if needs_coord_scale and candidates:
            for cand in candidates:
                bx1, by1, bx2, by2 = cand.bbox
                cand.bbox = (
                    bx1 * coord_sx,
                    by1 * coord_sy,
                    bx2 * coord_sx,
                    by2 * coord_sy,
                )
        models_used.extend(det_models)
        if det_device in {"mps", "cpu"}:
            device = det_device

        if _cancelled():
            return VisionOutput(
                device=device,
                models_used=models_used,
                findings=findings,
            )

        # Stage 3: Monocular Depth Ordering (Depth Anything V2 Small) for overlapping 2D figs or candidates
        two_d_figs = [
            nf
            for nf in ctx.normalized_figures
            if nf.figure.geometry_type in {"rectangle", "polygon", "bitmap"} and nf.bbox_area > 0.0
        ]
        has_overlapping_candidates = _has_overlapping_pair(candidates, ctx)
        depth_map: np.ndarray | None = None
        if (
            ctx.profile.vision_rules.enable_depth_occlusion_ordering
            and (len(two_d_figs) >= 2 or has_overlapping_candidates)
        ):
            if progress_cb:
                progress_cb("depth_ordering", 0.60)
            depth_map, depth_model = infer_depth_fn(rgb, self.model_manager, device)
            if depth_map is not None and depth_model is not None:
                models_used.append(depth_model)
                if len(two_d_figs) >= 2:
                    res = depth_order_fn(
                        depth_map=depth_map,
                        img_w=ctx.width,
                        img_h=ctx.height,
                        two_d_figs=two_d_figs,
                        iou_thresh=ctx.profile.tag_rules.occlusion_overlap_iou_threshold,
                        cover_thresh=ctx.profile.tag_rules.occlusion_cover_ratio_threshold,
                    )
                    depth_ordering = res.pair_ordering
                    foreground_occluders = res.foreground_occluders

        if _cancelled():
            return VisionOutput(
                device=device,
                models_used=models_used,
                findings=findings,
                depth_ordering=depth_ordering,
                foreground_occluders=foreground_occluders,
            )

        # Stage 3.5: Pre-Annotation Scene Simulation & Annotation Blueprint
        if candidates or models_used:
            if progress_cb:
                progress_cb("scene_simulation", 0.70)
            scene_simulation, sim_findings = scene_simulator.simulate(
                ctx=ctx,
                candidates=candidates,
                bokeh_scorer=bokeh_scorer,
                depth_map=depth_map,
            )
            findings.extend(sim_findings)

        if candidates:
            disambiguated_candidates = (
                _drop_suppressed_superclass_candidates(candidates, scene_simulation)
                if scene_simulation is not None
                else candidates
            )
            suppress_fresh_missed = (
                scene_simulation is not None
                and len(ctx.normalized_figures) == 0
                and scene_simulation.total_target_objects > 0
            )
            missed_objects, missed_findings = filter_and_build_missed_objects(
                ctx,
                disambiguated_candidates,
                bokeh_scorer,
                suppress_missed_findings=suppress_fresh_missed,
            )
            findings.extend(missed_findings)

        # Stage 4: Deep-mode SAM 2.1 Hiera-Tiny boundary & tightness audit + contour guides
        if mode == "deep":
            if progress_cb:
                progress_cb("sam_tightness", 0.80)
            sam_findings, sam_model = tightness_auditor.audit(ctx, rgb, device)
            findings.extend(sam_findings)
            if sam_model and sam_model not in models_used:
                models_used.append(sam_model)

            seg_fn = getattr(tightness_auditor, "segment_bboxes_to_polygons", None)
            if callable(seg_fn):
                contour_targets: list[tuple[str, int, BoundingBoxTuple]] = []
                if scene_simulation is not None:
                    for idx, sc in enumerate(scene_simulation.candidates):
                        if (
                            sc.recommended_shape in {"bitmap", "polygon"}
                            and sc.matched_figure_id is None
                            and len(contour_targets) < 12
                        ):
                            contour_targets.append(("sim", idx, sc.bbox))
                for idx, mo in enumerate(missed_objects):
                    if mo.geometry_type in {"bitmap", "polygon"} and len(contour_targets) < 16:
                        contour_targets.append(("miss", idx, mo.bbox))
                if contour_targets:
                    polys_out, poly_model = seg_fn(
                        ctx,
                        rgb,
                        [t[2] for t in contour_targets],
                        device,
                    )
                    if poly_model and poly_model not in models_used:
                        models_used.append(poly_model)
                    for (kind, target_idx, _), rings in zip(
                        contour_targets, polys_out, strict=False
                    ):
                        if not rings:
                            continue
                        if kind == "sim" and scene_simulation is not None:
                            scene_simulation.candidates[target_idx].polygon_points = rings
                        elif kind == "miss":
                            missed_objects[target_idx].polygon_points = rings

        if _cancelled():
            return VisionOutput(
                device=device,
                models_used=models_used,
                missed_objects=missed_objects,
                findings=findings,
                depth_ordering=depth_ordering,
                foreground_occluders=foreground_occluders,
                scene_simulation=scene_simulation,
            )

        # Stage 5: Conditional Keypoint Pose Audit (only if graph skeletons exist)
        if progress_cb:
            progress_cb("pose_audit", 0.92)
        pose_findings, pose_model = pose_auditor.audit(ctx, rgb, device)
        findings.extend(pose_findings)
        if pose_model:
            models_used.append(pose_model)

        self.model_manager.release_device_cache()

        degraded_reason: str | None = None
        core_yolo_present = self.model_manager.has_weight_file("yolo11s.pt") is not None
        if not models_used and not core_yolo_present:
            degraded_reason = "MODELS_NOT_DOWNLOADED"
            device = "none"

        return VisionOutput(
            device=device,
            models_used=models_used,
            degraded_reason=degraded_reason,
            missed_objects=missed_objects,
            findings=findings,
            depth_ordering=depth_ordering,
            foreground_occluders=foreground_occluders,
            scene_simulation=scene_simulation,
        )
