from __future__ import annotations

import asyncio
import time
from typing import Any

import cv2
import numpy as np
import psutil
import pytest
from fastapi.testclient import TestClient

from app.rules.context import RuleContext
from app.schemas.qc import ClassDefinition, RuleProfile
from app.services.qc_orchestrator import QCOrchestrator
from app.vision.blur_bokeh import BokehScorer
from app.vision.occlusion_depth import compute_depth_occlusion_ordering
from app.vision.pipeline import VisionPipeline, filter_and_build_missed_objects
from app.vision.pose_auditor import PredictedPoseInstance, audit_pose_instances
from app.vision.tightness_auditor import evaluate_sam_mask_against_figure
from app.vision.tiling import (
    DetectionCandidate,
    generate_overlapping_tiles,
    merge_detections_cpu,
)
from tests.backend.conftest import make_analyze_request, make_jpeg_bytes


def test_tiling_nms_and_edge_clipped_containment() -> None:
    high_res = np.zeros((3000, 4000, 3), dtype=np.uint8)
    tiles = generate_overlapping_tiles(high_res, min_Trigger_edge=2400)
    assert len(tiles) == 4
    # Verify tiles overlap by ~20% along interior boundaries
    assert tiles[1].offset_x < tiles[0].offset_x + 2400

    pass1 = [
        DetectionCandidate(
            class_title="Car",
            bbox=(1800.0, 400.0, 2200.0, 700.0),
            confidence=0.82,
            detector_model="yolo11s",
            from_tile=False,
        )
    ]
    # Clipped tile fragment completely inside Pass-1 full-frame box (>=75% IoS) plus a genuine edge object
    pass2 = [
        DetectionCandidate(
            class_title="Car",
            bbox=(1820.0, 410.0, 2100.0, 680.0),
            confidence=0.95,
            detector_model="yolo11s",
            from_tile=True,
        ),
        DetectionCandidate(
            class_title="Human",
            bbox=(3700.0, 2600.0, 3850.0, 2900.0),
            confidence=0.77,
            detector_model="yolo11s",
            from_tile=True,
        ),
    ]
    merged = merge_detections_cpu(pass1, pass2, iou_thresh=0.55)
    # Clipped fragment must be suppressed in favor of full Pass-1 box; edge Human kept
    assert len(merged) == 2
    car_det = next(d for d in merged if d.class_title == "Car")
    assert car_det.from_tile is False
    assert any(d.class_title == "Human" and d.from_tile for d in merged)


def test_bokeh_gate_suppresses_blurry_background_and_keeps_crisp_offscreen(
    default_profile: RuleProfile,
) -> None:
    img = np.full((1200, 1800, 3), 120, dtype=np.uint8)
    # Crisp checkered pattern on the right (outside zoomed left viewport)
    for y in range(200, 520, 4):
        for x in range(1300, 1520, 4):
            val = 240 if ((x // 4 + y // 4) % 2 == 0) else 15
            img[y : y + 4, x : x + 4] = val

    # Smooth heavily Gaussian-blurred background blob on the left
    cv2.rectangle(img, (100, 200), (450, 600), (80, 95, 110), -1)
    img[180:620, 80:470] = cv2.GaussianBlur(img[180:620, 80:470], (51, 51), 15.0)

    req = make_analyze_request(
        width=1800,
        height=1200,
        figures=[],
        zoom_percent=200.0,
        visible_norm_rect=[0.0, 0.0, 0.5, 0.8],
        visible_pixel_rect=[0.0, 0.0, 900.0, 960.0],
        mode="standard",
    )
    ctx = RuleContext.build(req, default_profile, default_profile_tunables(req))
    scorer = BokehScorer(img)

    candidates = [
        DetectionCandidate(
            class_title="Building",
            bbox=(100.0, 200.0, 450.0, 600.0),
            confidence=0.80,
            detector_model="yolo11s",
        ),
        DetectionCandidate(
            class_title="Human",
            bbox=(1300.0, 200.0, 1520.0, 520.0),
            confidence=0.88,
            detector_model="yolo11s",
        ),
    ]
    missed, findings = filter_and_build_missed_objects(ctx, candidates, scorer)
    assert len(missed) == 1
    assert missed[0].class_title == "Human"
    assert missed[0].outside_viewport is True
    assert missed[0].viewport_edge_direction == "right"
    assert len(findings) == 1
    assert findings[0].rule_id == "VISION_MISSED_OBJECT"
    assert findings[0].severity == "warning"
    assert findings[0].outside_viewport is True
    assert findings[0].missed_object_ids == [missed[0].missed_id]


def default_profile_tunables(req: Any):
    from app.config import EngineTunables

    del req
    return EngineTunables()


def test_depth_ordering_overrides_occlusion_direction(
    default_profile: RuleProfile,
    tmp_path: Any,
) -> None:
    req = make_analyze_request(
        width=1000,
        height=800,
        figures=[
            {
                "figureId": "fig_back",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[200, 150], [450, 600]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "fig_front",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[320, 180], [580, 620]], "interior": []},
                "tags": [{"tagId": 501, "name": "Occlusion", "value": None}],
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, default_profile_tunables(req))
    # Higher inverse depth == closer to camera. Make fig_front closer (0.9) than fig_back (0.2).
    depth = np.full((200, 250), 0.1, dtype=np.float32)
    depth[38:150, 50:112] = 0.2
    depth[45:155, 80:145] = 0.9

    res = compute_depth_occlusion_ordering(
        depth_map=depth,
        img_w=1000,
        img_h=800,
        two_d_figs=ctx.normalized_figures,
        iou_thresh=0.10,
        cover_thresh=0.15,
    )
    assert res.pair_ordering[("fig_back", "fig_front")] == "b_foreground"

    from app.config import EngineSettings
    from app.services.image_cache import ImageCacheService

    settings = EngineSettings(cache_dir=tmp_path / "cache")
    orch = QCOrchestrator(settings, ImageCacheService(settings))
    _, findings_back = orch.run_layer1(req, default_profile, depth_ordering=res.pair_ordering)
    assert any(
        f.rule_id == "BBOX_OCCLUSION_MISSING_TAG" and "fig_back" in f.figure_ids
        for f in findings_back
    )
    assert any(
        f.rule_id == "BBOX_FOREGROUND_OCCLUSION_FP" and "fig_front" in f.figure_ids
        for f in findings_back
    )


def test_sam_tightness_clipped_loose_and_drift(default_profile: RuleProfile) -> None:
    req = make_analyze_request(
        width=1000,
        height=800,
        figures=[
            {
                "figureId": "fig_loose",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[100, 100], [400, 400]], "interior": []},
            },
            {
                "figureId": "fig_poly_drift",
                "classId": 104,
                "classTitle": "Car",
                "geometryType": "polygon",
                "points": {
                    "exterior": [[500, 400], [700, 400], [700, 550], [500, 550]],
                    "interior": [],
                },
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, default_profile_tunables(req))

    # SAM mask smaller inside fig_loose -> triggers GEOM_BOX_LOOSE
    loose_mask = np.zeros((800, 1000), dtype=bool)
    loose_mask[150:350, 150:350] = True
    loose_findings = evaluate_sam_mask_against_figure(
        ctx, ctx.figures_by_id["fig_loose"], loose_mask
    )
    assert any(f.rule_id == "GEOM_BOX_LOOSE" for f in loose_findings)

    # SAM mask shifts right past user box on a polygon -> triggers GEOM_MASK_BOUNDARY_DRIFT,
    # without firing bounding-box-only rules (GEOM_BOX_CLIPPED / GEOM_BOX_LOOSE).
    drift_mask = np.zeros((800, 1000), dtype=bool)
    drift_mask[410:560, 560:820] = True
    drift_findings = evaluate_sam_mask_against_figure(
        ctx, ctx.figures_by_id["fig_poly_drift"], drift_mask
    )
    rule_ids = {f.rule_id for f in drift_findings}
    assert "GEOM_MASK_BOUNDARY_DRIFT" in rule_ids
    assert "GEOM_BOX_CLIPPED" not in rule_ids
    assert "GEOM_BOX_LOOSE" not in rule_ids


def test_pose_auditor_semantic_swap_and_drift(default_profile: RuleProfile) -> None:
    req = make_analyze_request(
        width=1000,
        height=800,
        figures=[
            {
                "figureId": "fig_pose_1",
                "classId": 109,
                "classTitle": "HumanSkeleton",
                "geometryType": "graph",
                "nodes": {
                    "l_sh": {"loc": [340, 200]},
                    "r_sh": {"loc": [260, 200]},
                    # Left hip shifted by >0.10*diag to trigger KP_AI_KEYPOINT_DRIFT too
                    "l_hip": {"loc": [200, 410]},
                    "r_hip": {"loc": [330, 350]},
                },
            }
        ],
    )
    ctx = RuleContext.build(req, default_profile, default_profile_tunables(req))
    pred = PredictedPoseInstance(
        bbox=(230.0, 160.0, 370.0, 520.0),
        keypoints={
            ("L", "shoulder"): (260.0, 200.0, 0.92),
            ("R", "shoulder"): (340.0, 200.0, 0.91),
            ("L", "hip"): (270.0, 350.0, 0.89),
            ("R", "hip"): (330.0, 350.0, 0.88),
        },
    )
    findings = audit_pose_instances(ctx, [pred])
    rule_ids = {f.rule_id for f in findings}
    assert "KP_AI_LR_SWAP_CONFIRMED" in rule_ids
    assert "KP_AI_KEYPOINT_DRIFT" in rule_ids


def test_models_not_downloaded_and_low_memory_downgrade(
    api_client: TestClient,
    test_settings: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = {"X-QC-Bridge-Token": test_settings.bridge_token}
    raw = make_jpeg_bytes(640, 480)
    up = api_client.put(
        "/api/v1/qc/images/img_100",
        content=raw,
        headers={**headers, "X-Image-Hash": "sly:abc123", "Content-Type": "image/jpeg"},
    )
    assert up.status_code == 201

    # 1. Standard mode without weights cleanly degrades with MODELS_NOT_DOWNLOADED (no crash)
    payload = make_analyze_request(width=640, height=480, mode="standard").model_dump(
        by_alias=True, mode="json"
    )
    res = api_client.post("/api/v1/qc/analyze", json=payload, headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["engineCapabilities"]["degradedReason"] == "MODELS_NOT_DOWNLOADED"

    # 2. Simulated low RAM forces LOW_SYSTEM_MEMORY_DOWNGRADE -> rules mode
    class _LowMem:
        available = 300 * 1024 * 1024

    monkeypatch.setattr(psutil, "virtual_memory", lambda: _LowMem())
    res_low = api_client.post("/api/v1/qc/analyze", json=payload, headers=headers)
    assert res_low.status_code == 200
    low_body = res_low.json()
    assert low_body["mode"] == "rules"
    assert low_body["engineCapabilities"]["degradedReason"] == "LOW_SYSTEM_MEMORY_DOWNGRADE"


@pytest.mark.asyncio
async def test_job_manager_coalesces_stale_snapshot_seq(
    test_settings: Any,
    default_profile: RuleProfile,
) -> None:
    from app.services.image_cache import ImageCacheService
    from app.services.job_manager import JobManager

    image_cache = ImageCacheService(test_settings)
    image_cache.put("img_100", "sly:abc123", make_jpeg_bytes(640, 480))

    class SlowVisionPipeline(VisionPipeline):
        def run(self, ctx, rgb, mode, cancel_event=None, progress_cb=None):
            del ctx, rgb, mode, progress_cb
            deadline = time.monotonic() + 0.35
            while time.monotonic() < deadline:
                if cancel_event and cancel_event.is_set():
                    break
                time.sleep(0.02)
            return super().run(
                RuleContext.build(make_analyze_request(width=640, height=480), default_profile, test_settings.tunables),
                np.zeros((64, 64, 3), dtype=np.uint8),
                "rules",
            )

    orch = QCOrchestrator(test_settings, image_cache, SlowVisionPipeline(test_settings))
    jm = JobManager(test_settings, orch)
    jm.bind_loop(asyncio.get_running_loop())
    try:
        req1 = make_analyze_request(width=640, height=480, mode="deep")
        req1.snapshot_seq = 1
        req2 = make_analyze_request(width=640, height=480, mode="deep")
        req2.snapshot_seq = 2

        job1 = await jm.submit_async_job(req1, default_profile, effective_mode="deep")
        await asyncio.sleep(0.05)
        job2 = await jm.submit_async_job(req2, default_profile, effective_mode="deep")

        assert job1.cancel_event.is_set()
        for _ in range(40):
            r2 = jm.get_job_response(job2.job_id)
            if r2 and r2.status == "completed":
                break
            await asyncio.sleep(0.03)
        r2 = jm.get_job_response(job2.job_id)
        assert r2 is not None and r2.status == "completed"
        assert r2.snapshot_seq == 2
    finally:
        jm.shutdown()


def test_case_c_pipeline_triggers_depth_ordering_on_zero_figure_overlapping_candidates(
    test_settings: Any,
    default_profile: RuleProfile,
) -> None:
    req = make_analyze_request(width=1280, height=720, figures=[], mode="standard")
    req.image.file_name = "Group_of_Horses.jpg"
    req.ontology.classes.append(
        ClassDefinition(class_id=203, title="Horse", shape="rectangle", color="#10b981")
    )
    req.ui_state.active_class_title = "Human"
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)

    rgb = np.full((720, 1280, 3), 100, dtype=np.uint8)
    yy, xx = np.indices((320, 420))
    patch = np.zeros((320, 420, 3), dtype=np.uint8)
    patch[((xx // 4) + (yy // 4)) % 2 == 0] = 225
    rgb[200:520, 200:620] = patch
    rgb[180:500, 460:880] = patch

    # Construct synthetic inverse depth map where left box (200..620) is closer (0.9) than right box (460..880, 0.2)
    depth_map = np.full((180, 320), 0.2, dtype=np.float32)
    depth_map[45:130, 50:155] = 0.90  # left horse closer even though both share same yMax range
    depth_calls: list[str] = []

    class _FakeDetector:
        def detect(self, **kwargs):
            del kwargs
            return (
                [
                    DetectionCandidate(
                        class_title="Horse",
                        bbox=(200.0, 200.0, 620.0, 520.0),
                        confidence=0.92,
                        detector_model="yolo11s",
                        raw_label="horse",
                    ),
                    DetectionCandidate(
                        class_title="Horse",
                        bbox=(460.0, 180.0, 880.0, 500.0),
                        confidence=0.90,
                        detector_model="yolo11s",
                        raw_label="horse",
                    ),
                ],
                ["yolo11s.pt"],
                "cpu",
            )

    class _NoOpAuditor:
        def audit(self, *args, **kwargs):
            del args, kwargs
            return [], None

    def _fake_infer_depth(img, manager, device):
        del img, manager, device
        depth_calls.append("called")
        return depth_map, "depth-anything-v2-small"

    pipeline = VisionPipeline(test_settings)
    pipeline._ensure_components = lambda: (  # type: ignore[method-assign]
        BokehScorer,
        _FakeDetector(),
        _NoOpAuditor(),
        _NoOpAuditor(),
        __import__("app.vision.scene_simulator", fromlist=["SceneSimulator"]).SceneSimulator(),
        _fake_infer_depth,
        compute_depth_occlusion_ordering,
    )

    out = pipeline.run(ctx, rgb, mode="standard")

    # Stage 3 depth ordering MUST run despite len(figures) == 0 because overlapping candidates exist
    assert depth_calls == ["called"]
    assert "depth-anything-v2-small" in out.models_used
    assert out.scene_simulation is not None
    assert out.scene_simulation.total_target_objects == 2
    by_idx = {c.sim_index: c for c in out.scene_simulation.candidates}
    assert by_idx[1].visibility_status == "foreground_clear"
    assert by_idx[2].visibility_status == "occluded"
    assert 1 in by_idx[2].occluded_by_sim_indices
    # Suppress redundant VISION_MISSED_OBJECT overlays/cards on fresh 0-figure image
    assert out.missed_objects == []
    assert not any(f.rule_id == "VISION_MISSED_OBJECT" for f in out.findings)
    assert any(f.rule_id == "WORKFLOW_WRONG_ACTIVE_CLASS_OR_TOOL" for f in out.findings)


def test_empty_ontology_falls_back_to_open_coco_labels_and_scene_simulation(
    test_settings: Any,
    default_profile: RuleProfile,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.vision.detector as detector_mod  # noqa: PLC0415
    from app.vision.detector import ObjectDetector  # noqa: PLC0415
    from app.vision.model_manager import ModelManager  # noqa: PLC0415
    from app.vision.scene_simulator import SceneSimulator  # noqa: PLC0415

    test_settings.models_dir.mkdir(parents=True, exist_ok=True)
    (test_settings.models_dir / "yolo11s.pt").write_bytes(b"stub-weights")
    req = make_analyze_request(width=1280, height=720, figures=[], mode="standard")
    req.image.file_name = "Group_of_Horses.jpg"
    req.ontology.classes = []
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)

    rgb = np.full((720, 1280, 3), 100, dtype=np.uint8)
    yy, xx = np.indices((220, 320))
    patch = np.zeros((220, 320, 3), dtype=np.uint8)
    patch[((xx // 4) + (yy // 4)) % 2 == 0] = 225
    rgb[200:420, 300:620] = patch

    manager = ModelManager(test_settings)
    detector = ObjectDetector(manager)
    monkeypatch.setattr(detector, "_load_yolo", lambda name, heavy=False: object())
    monkeypatch.setattr(
        detector_mod,
        "_run_ultralytics_on_crop",
        lambda model, crop, device, conf, imgsz=1280: [("horse", 0.91, (300.0, 200.0, 620.0, 420.0))],
    )

    cands, models_used, _ = detector.detect(ctx=ctx, rgb=rgb, device="cpu", use_open_vocab=False)
    assert models_used == ["yolo11s"]
    assert len(cands) == 1
    assert cands[0].class_title == "Horse"

    pipeline = VisionPipeline(test_settings)

    class _NoOpAuditor:
        def audit(self, *args, **kwargs):
            del args, kwargs
            return [], None

    pipeline._ensure_components = lambda: (  # type: ignore[method-assign]
        BokehScorer,
        detector,
        _NoOpAuditor(),
        _NoOpAuditor(),
        SceneSimulator(),
        lambda img, mgr, dev: (None, None),
        compute_depth_occlusion_ordering,
    )
    out = pipeline.run(ctx, rgb, mode="standard")
    assert out.degraded_reason is None
    assert "yolo11s" in out.models_used
    assert out.scene_simulation is not None
    assert out.scene_simulation.total_target_objects == 1
    assert out.scene_simulation.candidates[0].class_title == "Horse"
