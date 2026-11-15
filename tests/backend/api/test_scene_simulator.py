from __future__ import annotations

import cv2
import numpy as np

from app.rules.context import RuleContext
from app.schemas.qc import ClassDefinition, RuleProfile, TagValue
from app.vision.blur_bokeh import BokehScorer
from app.vision.scene_simulator import SceneSimulator
from app.vision.tiling import DetectionCandidate
from tests.backend.conftest import make_analyze_request


def _make_ten_horse_herd_image(width: int = 3840, height: int = 2160) -> tuple[np.ndarray, list[DetectionCandidate]]:
    """Build a crisp textured 4K canvas for 10 foreground/herd horses plus 1 blurry background horse."""
    rgb = np.full((height, width, 3), 110, dtype=np.uint8)
    # 10 horse boxes arranged left-to-right; pairs (1,2), (3,4), (5,6), (8,9) overlap significantly
    specs: list[tuple[tuple[float, float, float, float], float]] = [
        ((120.0, 900.0, 560.0, 1750.0), 0.94),   # #1 foreground clear (bigger, yMax=1750)
        ((390.0, 820.0, 740.0, 1460.0), 0.90),   # #2 rear occluded behind #1
        ((780.0, 880.0, 1180.0, 1680.0), 0.93),  # #3 foreground clear (yMax=1680)
        ((1010.0, 810.0, 1340.0, 1420.0), 0.89), # #4 rear occluded behind #3
        ((1380.0, 860.0, 1800.0, 1710.0), 0.95), # #5 foreground clear (yMax=1710)
        ((1630.0, 800.0, 1980.0, 1450.0), 0.88), # #6 rear occluded behind #5
        ((2060.0, 910.0, 2440.0, 1720.0), 0.92), # #7 standalone clear
        ((2500.0, 890.0, 2940.0, 1760.0), 0.93), # #8 foreground clear (yMax=1760)
        ((2760.0, 820.0, 3140.0, 1460.0), 0.87), # #9 rear occluded behind #8
        ((3220.0, 870.0, 3660.0, 1700.0), 0.91), # #10 standalone clear
    ]

    candidates: list[DetectionCandidate] = []
    # Paint sharp alternating checkerboard texture inside the 10 real horses so BokehScorer passes them
    for idx, (bbox, conf) in enumerate(specs):
        x1, y1, x2, y2 = [int(v) for v in bbox]
        patch = np.zeros((y2 - y1, x2 - x1, 3), dtype=np.uint8)
        yy, xx = np.indices((y2 - y1, x2 - x1))
        checker = ((xx // 6) + (yy // 6)) % 2 == 0
        patch[checker] = (230, 190, 140)
        patch[~checker] = (35, 30, 25)
        rgb[y1:y2, x1:x2] = patch
        candidates.append(
            DetectionCandidate(
                class_title="Horse",
                bbox=bbox,
                confidence=conf,
                detector_model="yolo11s",
                from_tile=False,
                raw_label="horse",
            )
        )
        # Add superclass duplicate 'Animal' on first 3 horses to verify disambiguation
        if idx < 3:
            candidates.append(
                DetectionCandidate(
                    class_title="Animal",
                    bbox=(bbox[0] + 4.0, bbox[1] + 4.0, bbox[2] - 4.0, bbox[3] - 4.0),
                    confidence=conf - 0.05,
                    detector_model="yolov8s-worldv2",
                    from_tile=False,
                    raw_label="animal",
                )
            )

    # Smooth flat background bokeh region at (1850, 220, 2150, 520) -> should be rejected by Bokeh gate
    cv2.rectangle(rgb, (1850, 220), (2150, 520), (112, 114, 110), -1)
    candidates.append(
        DetectionCandidate(
            class_title="Horse",
            bbox=(1850.0, 220.0, 2150.0, 520.0),
            confidence=0.81,
            detector_model="yolo11s",
            from_tile=False,
            raw_label="horse",
        )
    )
    # Shuffle candidate order to confirm deterministic left-to-right re-indexing
    candidates.reverse()
    return rgb, candidates


def _build_horse_ontology_request(
    *,
    figures: list[dict] | None = None,
    active_class_title: str | None = "Boat",
    active_tool: str | None = "rectangle",
    image_tags: list[TagValue] | None = None,
):
    req = make_analyze_request(
        width=3840,
        height=2160,
        figures=figures or [],
        mode="standard",
    )
    req.image.file_name = "Group_of_Horses_4K_Image.jpg"
    req.ui_state.active_class_title = active_class_title
    req.ui_state.active_tool = active_tool
    if image_tags is not None:
        req.image_tags = image_tags
    req.ontology.classes.extend(
        [
            ClassDefinition(class_id=201, title="Animal", shape="rectangle", color="#f59e0b"),
            ClassDefinition(class_id=202, title="Boat", shape="rectangle", color="#06b6d4"),
            ClassDefinition(class_id=203, title="Horse", shape="rectangle", color="#10b981"),
            ClassDefinition(class_id=204, title="Sofa", shape="rectangle", color="#8b5cf6"),
        ]
    )
    return req


def test_case_a_fresh_10_horse_scene_simulation_disambiguation_and_workflow(
    default_profile: RuleProfile,
    test_settings,
) -> None:
    req = _build_horse_ontology_request(
        figures=[],
        active_class_title="Boat",
        image_tags=[TagValue(tag_id=501, name="Occlusion", value=None)],
    )
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)
    rgb, candidates = _make_ten_horse_herd_image()
    scorer = BokehScorer(rgb)

    plan, sim_findings = SceneSimulator().simulate(ctx, candidates, scorer, depth_map=None)

    assert plan.primary_target_classes == ["Horse"]
    assert "Animal" in plan.ignored_ontology_classes
    assert "Boat" in plan.ignored_ontology_classes
    assert any("using specific class 'Horse'" in note for note in plan.disambiguation_notes)
    assert any("matches target class 'Horse'" in note for note in plan.disambiguation_notes)

    assert plan.total_target_objects == 10
    assert plan.completed_target_objects == 0
    assert len(plan.candidates) == 10
    assert [c.sim_index for c in plan.candidates] == list(range(1, 11))
    assert all(
        plan.candidates[i].bbox[0] <= plan.candidates[i + 1].bbox[0]
        for i in range(len(plan.candidates) - 1)
    )
    assert all(c.class_title == "Horse" for c in plan.candidates)
    assert all(c.matched_figure_id is None for c in plan.candidates)

    # Rear horses #2, #4, #6, #9 should be marked occluded behind foreground #1, #3, #5, #8
    by_idx = {c.sim_index: c for c in plan.candidates}
    for occ_idx, fg_idx in [(2, 1), (4, 3), (6, 5), (9, 8)]:
        assert by_idx[occ_idx].visibility_status == "occluded"
        assert fg_idx in by_idx[occ_idx].occluded_by_sim_indices
        assert [t.tag_name for t in by_idx[occ_idx].recommended_object_tags] == ["Occlusion"]

    for fg_idx in (1, 3, 5, 7, 8, 10):
        assert by_idx[fg_idx].visibility_status == "foreground_clear"
        assert by_idx[fg_idx].recommended_object_tags == []

    assert plan.misplaced_image_tags == ["Occlusion"]
    assert plan.active_sidebar_class_warning is not None
    assert "Boat" in plan.active_sidebar_class_warning
    assert any(
        f.rule_id == "WORKFLOW_WRONG_ACTIVE_CLASS_OR_TOOL"
        and f.suggested_fixes
        and f.suggested_fixes[0].action_type == "select_sidebar_class"
        and f.suggested_fixes[0].class_title == "Horse"
        for f in sim_findings
    )


def test_case_b_partial_progress_hungarian_completion_matching(
    default_profile: RuleProfile,
    test_settings,
) -> None:
    rgb, candidates = _make_ten_horse_herd_image()
    scorer = BokehScorer(rgb)

    # Annotate 4 of the 10 horses (#1, #2, #7, #10) with slight jitter still well above IoU >= 0.50
    drawn_boxes = [
        ("fig_h1", [128.0, 908.0, 552.0, 1742.0]),
        ("fig_h2", [395.0, 825.0, 735.0, 1455.0]),
        ("fig_h7", [2066.0, 915.0, 2435.0, 1712.0]),
        ("fig_h10", [3225.0, 875.0, 3655.0, 1692.0]),
    ]
    figures = [
        {
            "figureId": fid,
            "classId": 203,
            "classTitle": "Horse",
            "geometryType": "rectangle",
            "points": {"exterior": [[b[0], b[1]], [b[2], b[3]]], "interior": []},
            "tags": [],
        }
        for fid, b in drawn_boxes
    ]
    req = _build_horse_ontology_request(
        figures=figures,
        active_class_title="Horse",
        active_tool="rectangle",
        image_tags=[],
    )
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)

    plan, sim_findings = SceneSimulator().simulate(ctx, candidates, scorer, depth_map=None)

    assert plan.total_target_objects == 10
    assert plan.completed_target_objects == 4
    assert len(plan.class_summaries) == 1
    assert plan.class_summaries[0].completed_count == 4
    assert plan.class_summaries[0].remaining_count == 6
    matched_ids = {c.matched_figure_id for c in plan.candidates if c.matched_figure_id}
    assert matched_ids == {"fig_h1", "fig_h2", "fig_h7", "fig_h10"}
    assert plan.active_sidebar_class_warning is None
    assert sim_findings == []


def test_border_truncated_detection_marks_visibility_status(
    default_profile: RuleProfile,
    test_settings,
) -> None:
    req = _build_horse_ontology_request(figures=[], active_class_title="Horse")
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)
    rgb = np.zeros((2160, 3840, 3), dtype=np.uint8)
    # Crisp edge pattern along left border
    yy, xx = np.indices((600, 350))
    patch = np.zeros((600, 350, 3), dtype=np.uint8)
    patch[((xx // 5) + (yy // 5)) % 2 == 0] = 240
    rgb[800:1400, 0:350] = patch
    scorer = BokehScorer(rgb)

    candidates = [
        DetectionCandidate(
            class_title="Horse",
            bbox=(1.0, 800.0, 350.0, 1400.0),
            confidence=0.9,
            detector_model="yolo11s",
            raw_label="horse",
        )
    ]
    plan, _ = SceneSimulator().simulate(ctx, candidates, scorer, depth_map=None)
    assert plan.total_target_objects == 1
    assert plan.candidates[0].visibility_status == "border_truncated"
    assert [t.tag_name for t in plan.candidates[0].recommended_object_tags] == ["Truncation"]
    assert plan.class_summaries[0].tag_counts.get("Truncation") == 1


def test_combined_occluded_and_edge_truncated_candidate_recommends_both_tags_at_high_res(
    default_profile: RuleProfile,
    test_settings,
) -> None:
    req = _build_horse_ontology_request(figures=[], active_class_title="Horse")
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)
    rgb = np.full((2160, 3840, 3), 100, dtype=np.uint8)
    for x1, y1, x2, y2 in ((8, 920, 480, 1520), (220, 880, 760, 1780)):
        yy, xx = np.indices((y2 - y1, x2 - x1))
        patch = np.zeros((y2 - y1, x2 - x1, 3), dtype=np.uint8)
        patch[((xx // 5) + (yy // 5)) % 2 == 0] = 240
        rgb[y1:y2, x1:x2] = patch
    scorer = BokehScorer(rgb)

    candidates = [
        # #1 is occluded behind #2 AND stops 8px from left edge (<= 0.005 * 2160 = 10.8px on 4K)
        DetectionCandidate(
            class_title="Horse",
            bbox=(8.0, 920.0, 480.0, 1520.0),
            confidence=0.91,
            detector_model="yolo11s",
            raw_label="horse",
        ),
        DetectionCandidate(
            class_title="Horse",
            bbox=(220.0, 880.0, 760.0, 1780.0),
            confidence=0.95,
            detector_model="yolo11s",
            raw_label="horse",
        ),
    ]
    plan, _ = SceneSimulator().simulate(ctx, candidates, scorer, depth_map=None)
    by_idx = {c.sim_index: c for c in plan.candidates}
    assert by_idx[1].visibility_status == "occluded"
    assert [t.tag_name for t in by_idx[1].recommended_object_tags] == ["Occlusion", "Truncation"]
    assert by_idx[2].recommended_object_tags == []
    assert plan.class_summaries[0].tag_counts == {"Occlusion": 1, "Truncation": 1}
    assert plan.class_summaries[0].border_truncated_count == 1


def test_unknown_class_figure_matches_at_high_iou_while_wrong_class_is_rejected(
    default_profile: RuleProfile,
    test_settings,
) -> None:
    rgb = np.full((2160, 3840, 3), 110, dtype=np.uint8)
    for x1, y1, x2, y2 in ((100, 200, 500, 1200), (800, 200, 1200, 1200)):
        yy, xx = np.indices((y2 - y1, x2 - x1))
        patch = np.zeros((y2 - y1, x2 - x1, 3), dtype=np.uint8)
        patch[((xx // 6) + (yy // 6)) % 2 == 0] = (230, 190, 140)
        rgb[y1:y2, x1:x2] = patch
    scorer = BokehScorer(rgb)

    candidates = [
        DetectionCandidate(
            class_title="Horse",
            bbox=(100.0, 200.0, 500.0, 1200.0),
            confidence=0.92,
            detector_model="yolo11s",
            raw_label="horse",
        ),
        DetectionCandidate(
            class_title="Horse",
            bbox=(800.0, 200.0, 1200.0, 1200.0),
            confidence=0.91,
            detector_model="yolo11s",
            raw_label="horse",
        ),
    ]
    figures = [
        # Missing/Unknown class name mapped with high overlap (IoU >= 0.65) -> matched
        {
            "figureId": "fig_unknown_ok",
            "classId": 0,
            "classTitle": "Unknown",
            "geometryType": "rectangle",
            "points": {"exterior": [[105.0, 205.0], [495.0, 1195.0]], "interior": []},
            "tags": [],
        },
        # Incompatible explicit class ("Sofa") at high IoU -> NOT matched as Horse
        {
            "figureId": "fig_wrong_cls",
            "classId": 204,
            "classTitle": "Sofa",
            "geometryType": "rectangle",
            "points": {"exterior": [[802.0, 202.0], [1198.0, 1198.0]], "interior": []},
            "tags": [],
        },
    ]
    req = _build_horse_ontology_request(figures=figures, active_class_title="Horse")
    ctx = RuleContext.build(req, default_profile, test_settings.tunables)
    plan, _ = SceneSimulator().simulate(ctx, candidates, scorer, depth_map=None)

    assert plan.candidates[0].matched_figure_id == "fig_unknown_ok"
    assert plan.candidates[1].matched_figure_id is None
