from __future__ import annotations

import sys
import types
from typing import Any

import numpy as np
import pytest

import app.vision.detector as detector_mod
from app.config import EngineSettings
from app.rules.context import RuleContext
from app.schemas.qc import ClassDefinition, QCAnalyzeRequest, RuleProfile
from app.vision.blur_bokeh import BokehScorer
from app.vision.detector import (
    ObjectDetector,
    infer_shape_from_ontology_title,
    map_detector_label_to_ontology,
    strip_ontology_tool_suffix,
)
from app.vision.model_manager import ModelManager
from app.vision.occlusion_depth import compute_depth_occlusion_ordering
from app.vision.pipeline import VisionPipeline
from app.vision.pose_auditor import PoseAuditor
from app.vision.scene_simulator import SceneSimulator
from app.vision.tightness_auditor import (
    TightnessAuditor,
    extract_mask_contours_as_polygons,
)
from app.vision.tiling import DetectionCandidate
from tests.backend.conftest import encode_mask_to_sly_bitmap, make_analyze_request


class _FakeTensor:
    def __init__(self, arr: np.ndarray) -> None:
        self._arr = arr

    def detach(self) -> _FakeTensor:
        return self

    def cpu(self) -> _FakeTensor:
        return self

    def numpy(self) -> np.ndarray:
        return self._arr


def test_tool_suffix_stripping_and_ontology_mapping(
    test_settings: EngineSettings,
    default_profile: RuleProfile,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert strip_ontology_tool_suffix("Biscuit_B") == "Biscuit"
    assert strip_ontology_tool_suffix("Apple_P") == "Apple"
    assert strip_ontology_tool_suffix("Lane_L") == "Lane"
    assert strip_ontology_tool_suffix("Human_K") == "Human"
    assert strip_ontology_tool_suffix("Cup") == "Cup"

    assert infer_shape_from_ontology_title("Biscuit_B") == "bitmap"
    assert infer_shape_from_ontology_title("Apple_P") == "polygon"
    assert infer_shape_from_ontology_title("Lane_L") == "polyline"
    assert infer_shape_from_ontology_title("Human_K") == "graph"
    assert infer_shape_from_ontology_title("Box_R") == "rectangle"
    assert infer_shape_from_ontology_title("Cup") is None

    titles = ["Apple_B", "Biscuit_B", "Bowl_B", "Cup", "Sofa_B", "Spoon_B"]
    assert map_detector_label_to_ontology("apple", titles) == "Apple_B"
    assert map_detector_label_to_ontology("bowl", titles) == "Bowl_B"
    assert map_detector_label_to_ontology("couch", titles) == "Sofa_B"
    assert map_detector_label_to_ontology("spoon", titles) == "Spoon_B"
    assert map_detector_label_to_ontology("cup", titles) == "Cup"
    assert map_detector_label_to_ontology("cookie", titles) == "Biscuit_B"

    # Verify open-vocab YOLO-World receives clean prompts ("biscuit", "cookie") and maps back to "Biscuit_B"
    test_settings.models_dir.mkdir(parents=True, exist_ok=True)
    (test_settings.models_dir / "yolo11s.pt").write_bytes(b"stub-yolo")
    (test_settings.models_dir / "yolov8s-worldv2.pt").write_bytes(b"stub-ov")

    req = make_analyze_request(width=1000, height=800, figures=[], mode="deep")
    req.ontology.classes = [
        ClassDefinition.model_validate(
            {"classId": 201, "title": "Biscuit_B", "shape": "bitmap", "color": "#f97316"}
        ),
        ClassDefinition.model_validate(
            {"classId": 202, "title": "Cup", "shape": "bitmap", "color": "#ec4899"}
        ),
    ]
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)
    rgb = np.full((800, 1000, 3), 240, dtype=np.uint8)

    captured_prompts: list[str] = []

    class _FakeOvModel:
        def set_classes(self, prompts: list[str]) -> None:
            captured_prompts[:] = list(prompts)

    yolo_stub = object()
    ov_stub = _FakeOvModel()
    manager = ModelManager(test_settings)
    detector = ObjectDetector(manager)
    monkeypatch.setattr(
        detector,
        "_load_yolo",
        lambda name, heavy=False: ov_stub if name == "yolov8s-worldv2" else yolo_stub,
    )

    def _fake_infer(model: Any, crop: np.ndarray, device: str, conf: float, imgsz: int = 1280):
        del crop, device, conf, imgsz
        if model is ov_stub:
            return [("cookie", 0.88, (100.0, 120.0, 320.0, 340.0))]
        return []

    monkeypatch.setattr(detector_mod, "_run_ultralytics_on_crop", _fake_infer)

    dets, used, _ = detector.detect(ctx=ctx, rgb=rgb, device="cpu", use_open_vocab=True)
    assert "yolov8s-worldv2" in used
    assert "biscuit" in captured_prompts
    assert "cookie" in captured_prompts
    assert "biscuit_b" not in captured_prompts
    assert len(dets) == 1
    assert dets[0].class_title == "Biscuit_B"


def test_tightness_auditor_skips_failed_bitmap_and_avoids_bbox_rules_on_bitmap(
    test_settings: EngineSettings,
    default_profile: RuleProfile,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_settings.models_dir.mkdir(parents=True, exist_ok=True)
    (test_settings.models_dir / "sam2.1_t.pt").write_bytes(b"stub-sam")

    # Case 1: oversized invalid bitmap PNG (600x500 inside 400x300 canvas) -> decoded_bitmap.mask is None
    oversized_mask = np.zeros((500, 600), dtype=bool)
    oversized_mask[50:150, 50:150] = True
    bad_req = make_analyze_request(
        width=400,
        height=300,
        mode="deep",
        figures=[
            {
                "figureId": "fig_bad_bm",
                "classId": 105,
                "classTitle": "Car1",
                "geometryType": "bitmap",
                "bitmap": {"origin": [0, 0], "data": encode_mask_to_sly_bitmap(oversized_mask)},
                "tags": [],
            }
        ],
    )
    bad_ctx = RuleContext.build(bad_req, default_profile, test_settings.tunables)
    assert bad_ctx.normalized_figures[0].decoded_bitmap is not None
    assert bad_ctx.normalized_figures[0].decoded_bitmap.mask is None

    sam_called = False

    class _FakeSam:
        def predict(self, **kwargs: Any) -> list[Any]:
            nonlocal sam_called
            sam_called = True
            return []

    manager = ModelManager(test_settings)
    manager.register_model("sam2.1_t", _FakeSam(), heavy=True)
    monkeypatch.setitem(sys.modules, "ultralytics", types.SimpleNamespace(SAM=lambda p: _FakeSam()))

    auditor = TightnessAuditor(manager)
    rgb_bad = np.zeros((300, 400, 3), dtype=np.uint8)
    bad_findings, model_used = auditor.audit(bad_ctx, rgb_bad, device="cpu")
    assert bad_findings == []
    assert model_used is None
    assert sam_called is False

    # Case 2: valid bitmap with drifted SAM mask on downscaled preview rgb (500x400 vs 2000x1600 ctx)
    valid_mask = np.zeros((400, 400), dtype=bool)
    valid_mask[:, :] = True
    good_req = make_analyze_request(
        width=2000,
        height=1600,
        mode="deep",
        figures=[
            {
                "figureId": "fig_good_bm",
                "classId": 105,
                "classTitle": "Car1",
                "geometryType": "bitmap",
                "bitmap": {"origin": [200, 200], "data": encode_mask_to_sly_bitmap(valid_mask)},
                "tags": [],
            }
        ],
    )
    good_ctx = RuleContext.build(good_req, default_profile, test_settings.tunables)
    captured_prompts: list[list[float]] = []

    class _FakeScaledSam:
        def predict(self, **kwargs: Any) -> list[Any]:
            captured_prompts.extend(kwargs["bboxes"])
            # Shifted right significantly inside 400x500 preview tensor
            m = np.zeros((1, 400, 500), dtype=np.float32)
            m[0, 50:150, 120:260] = 1.0
            return [types.SimpleNamespace(masks=types.SimpleNamespace(data=_FakeTensor(m)))]

    manager2 = ModelManager(test_settings)
    manager2.register_model("sam2.1_t", _FakeScaledSam(), heavy=True)
    monkeypatch.setitem(
        sys.modules, "ultralytics", types.SimpleNamespace(SAM=lambda p: _FakeScaledSam())
    )

    auditor2 = TightnessAuditor(manager2)
    preview_rgb = np.zeros((400, 500, 3), dtype=np.uint8)
    bm_findings, used2 = auditor2.audit(good_ctx, preview_rgb, device="cpu")
    assert used2 == "sam2.1-hiera-tiny"
    # Prompt scaled down 4x from [200,200,600,600] (+6% padding) into 500x400 preview coordinates
    assert len(captured_prompts) == 1
    assert captured_prompts[0][0] < 60.0
    assert captured_prompts[0][2] <= 170.0

    rule_ids = {f.rule_id for f in bm_findings}
    assert "GEOM_MASK_BOUNDARY_DRIFT" in rule_ids
    assert "GEOM_BOX_CLIPPED" not in rule_ids
    assert "GEOM_BOX_LOOSE" not in rule_ids

    # Direct check of contour extraction and segment_bboxes_to_polygons
    sam_circle = np.zeros((200, 200), dtype=bool)
    sam_circle[40:140, 50:150] = True
    rings = extract_mask_contours_as_polygons(sam_circle)
    assert len(rings) == 1
    assert len(rings[0]) >= 4

    polys_out, seg_model = auditor2.segment_bboxes_to_polygons(
        good_ctx, preview_rgb, [(200.0, 200.0, 600.0, 600.0)], device="cpu"
    )
    assert seg_model == "sam2.1-hiera-tiny"
    assert len(polys_out) == 1
    assert len(polys_out[0]) == 1
    assert len(polys_out[0][0]) >= 4
    # Contours are scaled back to native 2000x1600 canvas coords (x in ~480..1040)
    xs = [p[0] for p in polys_out[0][0]]
    assert min(xs) >= 400.0


def test_deep_pipeline_generates_bitmap_contours_and_scales_preview_rgb(
    test_settings: EngineSettings,
    default_profile: RuleProfile,
) -> None:
    test_settings.models_dir.mkdir(parents=True, exist_ok=True)
    (test_settings.models_dir / "yolo11s.pt").write_bytes(b"stub-yolo")
    (test_settings.models_dir / "sam2.1_t.pt").write_bytes(b"stub-sam")

    # User annotated 1 Biscuit_B on the left and missed 1 Biscuit_B on the right
    brushed_mask = np.zeros((560, 560), dtype=bool)
    brushed_mask[20:540, 20:540] = True
    req: QCAnalyzeRequest = make_analyze_request(
        width=2000,
        height=1600,
        figures=[
            {
                "figureId": "fig_biscuit_1",
                "classId": 301,
                "classTitle": "Biscuit_B",
                "geometryType": "bitmap",
                "bitmap": {"origin": [200, 160], "data": encode_mask_to_sly_bitmap(brushed_mask)},
                "tags": [],
            }
        ],
        mode="deep",
    )
    req.image.file_name = "Two_Biscuits.jpg"
    req.ontology.classes = [
        ClassDefinition.model_validate(
            {"classId": 301, "title": "Biscuit_B", "shape": "bitmap", "color": "#f97316"}
        )
    ]
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)

    # Preview rgb is 500x400 (0.25x of 2000x1600) with sharp checkerboard texture so Bokeh gate passes
    preview_rgb = np.full((400, 500, 3), 100, dtype=np.uint8)
    yy, xx = np.indices((140, 140))
    patch = np.zeros((140, 140, 3), dtype=np.uint8)
    patch[((xx // 4) + (yy // 4)) % 2 == 0] = 240
    preview_rgb[40:180, 50:190] = patch
    preview_rgb[40:180, 260:400] = patch

    class _FakeDetector:
        def detect(self, *, ctx: RuleContext, rgb: np.ndarray, device: str, use_open_vocab: bool):
            del ctx, rgb, device, use_open_vocab
            # Detector returns coordinates in 500x400 preview space; pipeline must scale 4x
            return (
                [
                    DetectionCandidate(
                        class_title="Biscuit_B",
                        bbox=(50.0, 40.0, 190.0, 180.0),  # -> (200, 160, 760, 720) matched
                        confidence=0.95,
                        detector_model="yolov8s-worldv2",
                        from_tile=False,
                        raw_label="biscuit",
                    ),
                    DetectionCandidate(
                        class_title="Biscuit_B",
                        bbox=(260.0, 40.0, 400.0, 180.0),  # -> (1040, 160, 1600, 720) missed
                        confidence=0.92,
                        detector_model="yolov8s-worldv2",
                        from_tile=False,
                        raw_label="cookie",
                    ),
                ],
                ["yolo11s", "yolov8s-worldv2"],
                None,
            )

    class _FakeTightness:
        def audit(self, ctx: RuleContext, rgb: np.ndarray, device: str):
            del ctx, rgb, device
            return [], "sam2.1-hiera-tiny"

        def segment_bboxes_to_polygons(self, ctx: RuleContext, rgb: np.ndarray, bboxes, device: str):
            del ctx, rgb, device
            rings = [
                [[(b[0] + 20.0, b[1] + 20.0), (b[2] - 20.0, b[1] + 20.0), (b[2] - 20.0, b[3] - 20.0), (b[0] + 20.0, b[3] - 20.0)]]
                for b in bboxes
            ]
            return rings, "sam2.1-hiera-tiny"

    class _NoOpPose:
        def audit(self, *args: Any, **kwargs: Any):
            del args, kwargs
            return [], None

    pipeline = VisionPipeline(test_settings)
    pipeline._ensure_components = lambda: (  # type: ignore[method-assign]
        BokehScorer,
        _FakeDetector(),
        _FakeTightness(),
        _NoOpPose(),
        SceneSimulator(),
        lambda img, mgr, dev: (None, None),
        compute_depth_occlusion_ordering,
    )

    out = pipeline.run(ctx, preview_rgb, mode="deep")
    assert out.scene_simulation is not None
    assert out.scene_simulation.total_target_objects == 2
    assert out.scene_simulation.completed_target_objects == 1
    matched = next(c for c in out.scene_simulation.candidates if c.matched_figure_id == "fig_biscuit_1")
    unmatched = next(c for c in out.scene_simulation.candidates if c.matched_figure_id is None)
    assert matched.recommended_shape == "bitmap"
    assert unmatched.class_title == "Biscuit_B"
    assert unmatched.recommended_shape == "bitmap"
    assert unmatched.bbox == (1040.0, 160.0, 1600.0, 720.0)
    assert unmatched.polygon_points is not None and len(unmatched.polygon_points) == 1

    assert len(out.missed_objects) == 1
    assert out.missed_objects[0].geometry_type == "bitmap"
    assert out.missed_objects[0].bbox == (1040.0, 160.0, 1600.0, 720.0)
    assert out.missed_objects[0].polygon_points is not None


def test_pose_auditor_scales_preview_predictions_to_ctx_dimensions(
    test_settings: EngineSettings,
    default_profile: RuleProfile,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_settings.models_dir.mkdir(parents=True, exist_ok=True)
    (test_settings.models_dir / "yolo11s-pose.pt").write_bytes(b"stub-pose")

    # User graph keypoints match 4x scaled preview pose prediction -> zero drift / L-R swap
    req = make_analyze_request(
        width=2000,
        height=1600,
        mode="standard",
        figures=[
            {
                "figureId": "fig_skel",
                "classId": 109,
                "classTitle": "HumanSkeleton",
                "geometryType": "graph",
                "nodes": {
                    "l_sh": {"loc": [840, 440]},
                    "r_sh": {"loc": [720, 440]},
                    "l_hip": {"loc": [820, 680]},
                    "r_hip": {"loc": [740, 680]},
                },
                "tags": [],
            }
        ],
    )
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)

    # Preview pose prediction at 0.25x scale (500x400): l_sh=(210,110), r_sh=(180,110)
    kxy = np.zeros((1, 17, 2), dtype=np.float32)
    kconf = np.zeros((1, 17), dtype=np.float32)
    kxy[0, 5] = [210.0, 110.0]  # left_shoulder -> (840, 440)
    kxy[0, 6] = [180.0, 110.0]  # right_shoulder -> (720, 440)
    kxy[0, 11] = [205.0, 170.0]  # left_hip -> (820, 680)
    kxy[0, 12] = [185.0, 170.0]  # right_hip -> (740, 680)
    kconf[0, [5, 6, 11, 12]] = 0.95
    boxes = np.array([[160.0, 80.0, 240.0, 240.0]], dtype=np.float32)  # -> [640,320,960,960]

    class _FakePoseModel:
        def predict(self, **kwargs: Any) -> list[Any]:
            del kwargs
            return [
                types.SimpleNamespace(
                    boxes=types.SimpleNamespace(xyxy=_FakeTensor(boxes)),
                    keypoints=types.SimpleNamespace(
                        xy=_FakeTensor(kxy),
                        conf=_FakeTensor(kconf),
                    ),
                )
            ]

    manager = ModelManager(test_settings)
    manager.register_model("yolo11s-pose", _FakePoseModel(), heavy=False)
    monkeypatch.setitem(sys.modules, "ultralytics", types.SimpleNamespace(YOLO=lambda p: _FakePoseModel()))

    pose_auditor = PoseAuditor(manager)
    preview_rgb = np.zeros((400, 500, 3), dtype=np.uint8)
    findings, used = pose_auditor.audit(ctx, preview_rgb, device="cpu")
    assert used == "yolo11s-pose"
    assert not any(f.rule_id in {"KP_AI_KEYPOINT_DRIFT", "KP_AI_LR_SWAP_CONFIRMED"} for f in findings)
