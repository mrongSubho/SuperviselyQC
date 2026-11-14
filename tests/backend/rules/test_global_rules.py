from __future__ import annotations

import numpy as np

from app.config import EngineSettings
from app.rules.context import RuleContext
from app.rules.global_rules import evaluate_global_rules
from app.schemas.qc import ClassRuleOverride, RuleProfile
from tests.backend.conftest import encode_mask_to_sly_bitmap, make_analyze_request


def _run_global(req, profile: RuleProfile):
    ctx = RuleContext.build(req, profile, EngineSettings().tunables)
    return evaluate_global_rules(ctx)


def test_workflow_unsaved_sync_and_empty_unconfirmed(default_profile: RuleProfile) -> None:
    req = make_analyze_request(synchronize_dirty=True, is_confirmed=False, figures=[])
    findings = _run_global(req, default_profile)
    rule_ids = {f.rule_id for f in findings}
    assert "WORKFLOW_UNSAVED_SYNC" in rule_ids
    assert "WORKFLOW_EMPTY_UNCONFIRMED" in rule_ids

    # dom_fallback with objects present must NOT emit WORKFLOW_EMPTY_UNCONFIRMED
    req_dom = make_analyze_request(
        synchronize_dirty=False,
        is_confirmed=False,
        state_source="dom_fallback",
        partial_geometry=True,
        figures=[],
        dom_summaries=[{"classTitle": "Human", "figureCount": 3, "taggedCount": 0, "visible": True}],
    )
    findings_dom = _run_global(req_dom, default_profile)
    assert "WORKFLOW_EMPTY_UNCONFIRMED" not in {f.rule_id for f in findings_dom}


def test_tag_scoping_compatibility_values_and_required(default_profile: RuleProfile) -> None:
    profile = default_profile.model_copy(
        update={
            "class_overrides": {
                "Human": ClassRuleOverride(
                    enabled=True,
                    required_tags=["Pose"],
                    forbidden_tags=["CarOnly"],
                )
            }
        }
    )
    req = make_analyze_request(
        image_tags=[{"tagId": 501, "name": "Occlusion", "value": None}],
        figures=[
            {
                "figureId": "fig_1",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[200, 200], [500, 900]], "interior": []},
                "tags": [
                    {"tagId": 502, "name": "Night", "value": None},
                    {"tagId": 503, "name": "Age", "value": "not-a-number"},
                    {"tagId": 999, "name": "CarOnly", "value": None},
                ],
            },
            {
                "figureId": "fig_2",
                "classId": 104,
                "classTitle": "Car",
                "geometryType": "polygon",
                "points": {"exterior": [[600, 200], [900, 200], [900, 500], [600, 500]], "interior": []},
                "tags": [{"tagId": 504, "name": "Pose", "value": "flying"}],
            },
        ],
    )
    findings = _run_global(req, profile)
    rules = {f.rule_id for f in findings}
    assert {
        "TAG_SCOPE_IMAGE_MISPLACED",
        "TAG_SCOPE_OBJECT_MISPLACED",
        "TAG_CLASS_INCOMPATIBLE",
        "TAG_VALUE_INVALID",
        "TAG_REQUIRED_MISSING",
    }.issubset(rules)


def test_class_disabled_or_off_job_in_normal_and_dom_fallback(default_profile: RuleProfile) -> None:
    req = make_analyze_request(
        job_classes_to_label=["Human"],
        figures=[
            {
                "figureId": "fig_bus",
                "classId": 103,
                "classTitle": "Bus",
                "geometryType": "rectangle",
                "points": {"exterior": [[200, 200], [900, 600]], "interior": []},
                "tags": [],
            }
        ],
    )
    assert "CLASS_DISABLED_OR_OFF_JOB" in {f.rule_id for f in _run_global(req, default_profile)}

    req_dom = make_analyze_request(
        job_classes_to_label=["Human"],
        state_source="dom_fallback",
        partial_geometry=True,
        dom_summaries=[{"classTitle": "Bus", "figureCount": 1, "taggedCount": 0, "visible": True}],
    )
    assert "CLASS_DISABLED_OR_OFF_JOB" in {f.rule_id for f in _run_global(req_dom, default_profile)}


def test_bounds_tolerance_micro_click_and_canvas_wide(default_profile: RuleProfile) -> None:
    # Sub-pixel -0.5 and W+0.5 must PASS; -1.5 must FAIL
    req_ok = make_analyze_request(
        width=540,
        height=360,
        figures=[
            {
                "figureId": "edge_ok",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[-0.5, 10.0], [120.0, 360.5]], "interior": []},
                "tags": [],
            }
        ],
    )
    assert "GEOM_OUT_OF_BOUNDS" not in {f.rule_id for f in _run_global(req_ok, default_profile)}

    req_bad = make_analyze_request(
        width=540,
        height=360,
        figures=[
            {
                "figureId": "edge_bad",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[-1.5, 10.0], [120.0, 200.0]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "micro_540",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[200, 200], [206, 206]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "wide_box",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[0, 0], [535, 355]], "interior": []},
                "tags": [],
            },
        ],
    )
    rules = {f.rule_id for f in _run_global(req_bad, default_profile)}
    assert {"GEOM_OUT_OF_BOUNDS", "GEOM_EXTREME_MICRO_CLICK", "GEOM_CANVAS_WIDE_OUTLIER"}.issubset(rules)

    # Scale-invariant 5472x3648 micro-click threshold (>= 15px side & >= ~200px^2 area)
    req_5k = make_analyze_request(
        width=5472,
        height=3648,
        figures=[
            {
                "figureId": "micro_5k",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[1000, 1000], [1012, 1014]], "interior": []},
                "tags": [],
            }
        ],
    )
    assert "GEOM_EXTREME_MICRO_CLICK" in {f.rule_id for f in _run_global(req_5k, default_profile)}


def test_duplicate_detection_across_all_five_primitives(default_profile: RuleProfile) -> None:
    mask = np.zeros((40, 40), dtype=bool)
    mask[5:35, 5:35] = True
    bm_b64 = encode_mask_to_sly_bitmap(mask)

    req = make_analyze_request(
        figures=[
            # Same-class rect duplicate -> blocker
            {
                "figureId": "r1",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[100, 100], [300, 400]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "r2",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[102, 101], [301, 400]], "interior": []},
                "tags": [],
            },
            # Cross-class poly duplicate -> warning
            {
                "figureId": "p1",
                "classId": 104,
                "classTitle": "Car",
                "geometryType": "polygon",
                "points": {"exterior": [[600, 100], [800, 100], [800, 300], [600, 300]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "p2",
                "classId": 102,
                "classTitle": "Building",
                "geometryType": "polygon",
                "points": {"exterior": [[601, 101], [800, 100], [800, 300], [600, 300]], "interior": []},
                "tags": [],
            },
            # Bitmap duplicate
            {
                "figureId": "b1",
                "classId": 105,
                "classTitle": "Car1",
                "geometryType": "bitmap",
                "bitmap": {"data": bm_b64, "origin": [1000, 100]},
                "tags": [],
            },
            {
                "figureId": "b2",
                "classId": 105,
                "classTitle": "Car1",
                "geometryType": "bitmap",
                "bitmap": {"data": bm_b64, "origin": [1001, 100]},
                "tags": [],
            },
            # Polyline duplicate
            {
                "figureId": "l1",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {"exterior": [[100, 1000], [500, 1000], [900, 1000]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "l2",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {"exterior": [[101, 1002], [500, 1001], [900, 1001]], "interior": []},
                "tags": [],
            },
            # Graph duplicate
            {
                "figureId": "g1",
                "classId": 108,
                "classTitle": "Fruit",
                "geometryType": "graph",
                "nodes": {
                    "n_stem": {"loc": [1500, 500], "disabled": False},
                    "n_center": {"loc": [1520, 560], "disabled": False},
                },
                "tags": [],
            },
            {
                "figureId": "g2",
                "classId": 108,
                "classTitle": "Fruit",
                "geometryType": "graph",
                "nodes": {
                    "n_stem": {"loc": [1502, 501], "disabled": False},
                    "n_center": {"loc": [1521, 562], "disabled": False},
                },
                "tags": [],
            },
        ]
    )
    dups = [f for f in _run_global(req, default_profile) if f.rule_id == "GEOM_DUPLICATE_FIGURE"]
    assert len(dups) == 5
    severities = {tuple(sorted(f.figure_ids)): f.severity for f in dups}
    assert severities[("r1", "r2")] == "blocker"
    assert severities[("p1", "p2")] == "warning"
