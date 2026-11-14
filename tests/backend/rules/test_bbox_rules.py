from __future__ import annotations

from app.config import EngineSettings
from app.rules.bbox_rules import evaluate_bbox_rules
from app.rules.context import RuleContext
from app.schemas.qc import RuleProfile
from tests.backend.conftest import make_analyze_request


def test_asymmetric_occlusion_and_foreground_false_positive(default_profile: RuleProfile) -> None:
    # Simulates #5 occluded pedestrian behind large foreground #6 wrongly tagged Occlusion
    req = make_analyze_request(
        width=5472,
        height=3648,
        figures=[
            {
                "figureId": "fig_5",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[3310, 1280], [3780, 2940]], "interior": []},
                "tags": [],
                "labelIndex": 5,
            },
            {
                "figureId": "fig_6",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[3420, 1100], [4500, 3400]], "interior": []},
                "tags": [{"tagId": 501, "name": "Occlusion", "value": None}],
                "labelIndex": 6,
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    findings = evaluate_bbox_rules(ctx)
    by_rule = {f.rule_id: f for f in findings}
    assert "BBOX_OCCLUSION_MISSING_TAG" in by_rule
    assert "fig_5" in by_rule["BBOX_OCCLUSION_MISSING_TAG"].figure_ids
    assert "BBOX_FOREGROUND_OCCLUSION_FP" in by_rule
    assert "fig_6" in by_rule["BBOX_FOREGROUND_OCCLUSION_FP"].figure_ids


def test_near_miss_border_gap_and_inverted_corners(default_profile: RuleProfile) -> None:
    # Box stops 7px short of right edge (W=1000) and uses inverted corner coordinates
    req = make_analyze_request(
        width=1000,
        height=800,
        figures=[
            {
                "figureId": "fig_inv",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[993, 600], [800, 200]], "interior": []},
                "tags": [],
            }
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    assert ctx.normalized_figures[0].bbox == (800.0, 200.0, 993.0, 600.0)
    findings = evaluate_bbox_rules(ctx)
    rules = {f.rule_id: f for f in findings}
    assert "BBOX_NON_CANONICAL_CORNERS" in rules
    assert rules["BBOX_NON_CANONICAL_CORNERS"].severity == "info"
    assert "BBOX_BORDER_TRUNCATION" in rules
    assert rules["BBOX_BORDER_TRUNCATION"].severity == "warning"
    assert "7px" in rules["BBOX_BORDER_TRUNCATION"].message
