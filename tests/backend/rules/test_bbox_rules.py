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


def test_border_touching_figure_requires_truncation_tag(default_profile: RuleProfile) -> None:
    req = make_analyze_request(
        width=1000,
        height=800,
        figures=[
            {
                "figureId": "fig_edge_untagged",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[0, 100], [180, 400]], "interior": []},
                "tags": [],
                "labelIndex": 1,
            },
            {
                "figureId": "fig_edge_tagged",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[820, 100], [1000, 400]], "interior": []},
                "tags": [{"tagId": 502, "name": "Truncation", "value": None}],
                "labelIndex": 2,
            },
        ],
    )
    req.ontology.tags.append(
        type(req.ontology.tags[0])(
            tag_id=502,
            name="Truncation",
            value_type="none",
            applicable_type="objectsOnly",
            classes=[],
            values=[],
        )
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    findings = evaluate_bbox_rules(ctx)
    trunc_findings = [f for f in findings if f.rule_id == "BBOX_TRUNCATION_MISSING_TAG"]
    assert len(trunc_findings) == 1
    assert trunc_findings[0].figure_ids == ["fig_edge_untagged"]
    assert trunc_findings[0].suggested_fixes[0].tag_name == "Truncation"


def test_truncation_profile_fallback_and_interior_false_positive(
    default_profile: RuleProfile,
) -> None:
    # default.yaml includes Truncation in objectOnlyTags:
    # 1) Edge box with no tag -> BBOX_TRUNCATION_MISSING_TAG suggesting 'Truncation'
    # 2) Edge box carrying Occlusion (when ontology omits Truncation) -> respected without duplicate warning
    # 3) Interior box wrongly carrying Truncated -> BBOX_TRUNCATION_FP with remove_object_tag
    req = make_analyze_request(
        width=1000,
        height=800,
        figures=[
            {
                "figureId": "fig_edge_none",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[0, 120], [160, 420]], "interior": []},
                "tags": [],
                "labelIndex": 1,
            },
            {
                "figureId": "fig_edge_occ_fallback",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[840, 120], [1000, 420]], "interior": []},
                "tags": [{"tagId": 501, "name": "Occlusion", "value": None}],
                "labelIndex": 2,
            },
            {
                "figureId": "fig_interior_fp",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[300, 200], [480, 520]], "interior": []},
                "tags": [{"tagId": 502, "name": "Truncated", "value": None}],
                "labelIndex": 3,
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    findings = evaluate_bbox_rules(ctx)

    missing = [f for f in findings if f.rule_id == "BBOX_TRUNCATION_MISSING_TAG"]
    assert [f.figure_ids for f in missing] == [["fig_edge_none"]]
    assert missing[0].suggested_fixes[0].tag_name == "Truncation"

    fps = [f for f in findings if f.rule_id == "BBOX_TRUNCATION_FP"]
    assert len(fps) == 1
    assert fps[0].figure_ids == ["fig_interior_fp"]
    assert fps[0].suggested_fixes[0].action_type == "remove_object_tag"
    assert fps[0].suggested_fixes[0].tag_name == "Truncated"
