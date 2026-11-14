from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING

import psutil

from app.config import EngineSettings
from app.rules.bbox_rules import evaluate_bbox_rules
from app.rules.bitmap_rules import evaluate_bitmap_rules
from app.rules.context import RuleContext
from app.rules.global_rules import evaluate_global_rules
from app.rules.keypoint_rules import evaluate_keypoint_rules
from app.rules.polygon_rules import evaluate_polygon_rules
from app.rules.polyline_rules import evaluate_polyline_rules
from app.schemas.qc import (
    EngineCapabilities,
    MissedObjectOverlay,
    QCAnalyzeRequest,
    QCFinding,
    QCMode,
    QCResponse,
    RuleProfile,
    SceneSimulationPlan,
    SummaryCounts,
)

if TYPE_CHECKING:
    from app.services.image_cache import ImageCacheService
    from app.vision.pipeline import VisionPipeline


_SEVERITY_RANK = {"blocker": 0, "warning": 1, "info": 2}


def compute_score_and_readiness(
    findings: list[QCFinding],
    missed_objects: list[MissedObjectOverlay],
) -> tuple[int, str, SummaryCounts]:
    """Compute canonical overallScore (0..100), readiness, and summaryCounts."""
    blocker = sum(1 for f in findings if f.severity == "blocker")
    warning = sum(1 for f in findings if f.severity == "warning")
    info = sum(1 for f in findings if f.severity == "info")

    score = 100 - (25 * blocker) - min(45, 8 * warning) - min(10, 2 * info)
    overall_score = max(0, min(100, round(score)))

    if blocker > 0:
        readiness = "blocked"
    elif warning > 0 or len(missed_objects) > 0:
        readiness = "needs_review"
    else:
        readiness = "ready"

    return overall_score, readiness, SummaryCounts(blocker=blocker, warning=warning, info=info)


class QCOrchestrator:
    """Coordinates Layer 1 deterministic rules and Layer 2 MPS/CPU vision checks."""

    def __init__(
        self,
        settings: EngineSettings,
        image_cache: ImageCacheService,
        vision_pipeline: VisionPipeline | None = None,
    ) -> None:
        self.settings = settings
        self.image_cache = image_cache
        self.vision_pipeline = vision_pipeline

    def check_memory_mode(self, requested_mode: QCMode) -> tuple[QCMode, str | None]:
        """Downgrade vision mode when free system memory falls below safe 8 GB Mac ceilings."""
        if requested_mode == "rules":
            return "rules", None

        avail_mb = psutil.virtual_memory().available / (1024 * 1024)
        if avail_mb < float(self.settings.low_ram_rules_mb):
            return "rules", "LOW_SYSTEM_MEMORY_DOWNGRADE"
        if requested_mode == "deep" and avail_mb < float(self.settings.low_ram_standard_mb):
            return "standard", "LOW_SYSTEM_MEMORY_DOWNGRADE"
        return requested_mode, None

    def run_layer1(
        self,
        request: QCAnalyzeRequest,
        profile: RuleProfile,
        depth_ordering: dict[tuple[str, str], str] | None = None,
        foreground_occluders_by_fig: dict | None = None,
    ) -> tuple[RuleContext, list[QCFinding]]:
        ctx = RuleContext.build(request, profile, self.settings.tunables)
        findings: list[QCFinding] = []
        findings.extend(evaluate_global_rules(ctx))
        findings.extend(evaluate_bbox_rules(ctx, depth_ordering=depth_ordering))
        findings.extend(evaluate_polygon_rules(ctx))
        findings.extend(evaluate_bitmap_rules(ctx))
        findings.extend(evaluate_polyline_rules(ctx))
        findings.extend(
            evaluate_keypoint_rules(ctx, foreground_occluders_by_fig=foreground_occluders_by_fig)
        )
        return ctx, findings

    def analyze_sync(
        self,
        request: QCAnalyzeRequest,
        profile: RuleProfile,
        effective_mode: QCMode | None = None,
        degraded_reason: str | None = None,
        cancel_event: threading.Event | None = None,
        progress_cb: Callable[[str, float], None] | None = None,
        job_id: str | None = None,
    ) -> QCResponse:
        t_start = time.perf_counter()
        mode_to_run = effective_mode or request.mode

        t_rules_start = time.perf_counter()
        ctx, base_findings = self.run_layer1(request, profile)
        t_rules_ms = (time.perf_counter() - t_rules_start) * 1000.0

        missed_objects: list[MissedObjectOverlay] = []
        scene_simulation: SceneSimulationPlan | None = None
        vision_findings: list[QCFinding] = []
        models_used: list[str] = []
        device = "none"
        t_vision_ms = 0.0
        final_findings = list(base_findings)

        if mode_to_run in {"standard", "deep"} and self.vision_pipeline is not None:
            rgb = self.image_cache.get_decoded_rgb(
                request.image.image_id, request.image.image_hash
            )
            if rgb is None:
                raise RuntimeError("IMAGE_CACHE_MISS")

            t_vis_start = time.perf_counter()
            vis_out = self.vision_pipeline.run(
                ctx=ctx,
                rgb=rgb,
                mode=mode_to_run,
                cancel_event=cancel_event,
                progress_cb=progress_cb,
            )
            t_vision_ms = (time.perf_counter() - t_vis_start) * 1000.0
            device = vis_out.device
            models_used = vis_out.models_used
            if vis_out.degraded_reason and not degraded_reason:
                degraded_reason = vis_out.degraded_reason
            missed_objects = vis_out.missed_objects
            scene_simulation = vis_out.scene_simulation
            vision_findings = vis_out.findings

            # If Layer 2 Depth Anything V2 produced authoritative occlusion ordering,
            # re-evaluate bbox/keypoint occlusion findings using depth ordering override.
            if vis_out.depth_ordering:
                non_occlusion_findings = [
                    f
                    for f in final_findings
                    if f.rule_id
                    not in {
                        "BBOX_OCCLUSION_MISSING_TAG",
                        "BBOX_FOREGROUND_OCCLUSION_FP",
                        "BBOX_NON_CANONICAL_CORNERS",
                        "BBOX_BORDER_TRUNCATION",
                        "BBOX_ASPECT_RATIO_OUTLIER",
                        "KP_OCCLUSION_VISIBILITY_MISMATCH",
                        "KP_UNKNOWN_TEMPLATE_NODE",
                        "KP_MISSING_REQUIRED_NODES",
                        "KP_OUTSIDE_PARENT_BOX",
                        "KP_ANATOMICAL_LR_INVERSION",
                        "KP_BONE_PROPORTION_OUTLIER",
                    }
                ]
                non_occlusion_findings.extend(
                    evaluate_bbox_rules(ctx, depth_ordering=vis_out.depth_ordering)
                )
                non_occlusion_findings.extend(
                    evaluate_keypoint_rules(
                        ctx, foreground_occluders_by_fig=vis_out.foreground_occluders
                    )
                )
                final_findings = non_occlusion_findings

            final_findings.extend(vision_findings)

        # Deduplicate by fingerprint & sort deterministically (severity then ruleId then findingId)
        deduped: dict[str, QCFinding] = {}
        for f in final_findings:
            deduped[f.fingerprint] = f
        sorted_findings = sorted(
            deduped.values(),
            key=lambda f: (_SEVERITY_RANK.get(f.severity, 9), f.rule_id, f.fingerprint),
        )

        overall_score, readiness, summary_counts = compute_score_and_readiness(
            sorted_findings, missed_objects
        )
        t_total_ms = (time.perf_counter() - t_start) * 1000.0

        return QCResponse(
            analysis_id=f"qc_{uuid.uuid4().hex[:10]}",
            request_id=request.request_id,
            job_id=job_id,
            status="completed",
            image_id=request.image.image_id,
            snapshot_seq=request.snapshot_seq,
            mode=mode_to_run,
            profile_id=profile.profile_id,
            overall_score=overall_score,
            readiness=readiness,  # type: ignore[arg-type]
            summary_counts=summary_counts,
            findings=sorted_findings,
            missed_objects=missed_objects,
            scene_simulation=scene_simulation,
            timing_ms={
                "rules": round(t_rules_ms, 2),
                "vision": round(t_vision_ms, 2),
                "total": round(t_total_ms, 2),
            },
            engine_capabilities=EngineCapabilities(
                device=device,  # type: ignore[arg-type]
                models_used=models_used,
                degraded_reason=degraded_reason,
            ),
            error=None,
        )
