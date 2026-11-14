from __future__ import annotations

from app.config import EngineSettings
from app.rules.context import RuleContext
from app.rules.keypoint_rules import evaluate_keypoint_rules
from app.schemas.qc import RuleProfile
from tests.backend.conftest import make_analyze_request


def test_fruit_non_bilateral_skips_lr_inversion(default_profile: RuleProfile) -> None:
    req = make_analyze_request(
        width=2000,
        height=2000,
        figures=[
            {
                "figureId": "fruit_1",
                "classId": 108,
                "classTitle": "Fruit",
                "geometryType": "graph",
                "nodes": {
                    "n_stem": {"loc": [500, 400], "disabled": False},
                    "n_center": {"loc": [510, 480], "disabled": False},
                },
                "tags": [],
            }
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    assert evaluate_keypoint_rules(ctx) == []


def test_facing_camera_vs_away_and_ankle_inversion(default_profile: RuleProfile) -> None:
    # Person facing camera (x_left_eye > x_right_eye), all L/R consistent EXCEPT ankles inverted!
    req = make_analyze_request(
        width=2000,
        height=2000,
        figures=[
            {
                "figureId": "human_box",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[400, 200], [800, 1200]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "skel_1",
                "classId": 109,
                "classTitle": "HumanSkeleton",
                "geometryType": "graph",
                "nodes": {
                    "l_eye": {"loc": [630, 260], "disabled": False},
                    "r_eye": {"loc": [570, 260], "disabled": False},
                    "l_sh": {"loc": [680, 380], "disabled": False},
                    "r_sh": {"loc": [520, 380], "disabled": False},
                    "l_hip": {"loc": [660, 680], "disabled": False},
                    "r_hip": {"loc": [540, 680], "disabled": False},
                    "l_knee": {"loc": [540, 900], "disabled": False},
                    "r_knee": {"loc": [660, 900], "disabled": False},
                    "l_ank": {"loc": [530, 1140], "disabled": False},
                    "r_ank": {"loc": [670, 1140], "disabled": False},
                },
                "tags": [],
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    findings = evaluate_keypoint_rules(ctx)
    rules = {f.rule_id for f in findings}
    assert "KP_ANATOMICAL_LR_INVERSION" in rules
    assert "KP_OUTSIDE_PARENT_BOX" not in rules

    # Now test facing away (all lefts on viewer's left, rights on viewer's right) -> NO false positive
    req_away = make_analyze_request(
        width=2000,
        height=2000,
        figures=[
            {
                "figureId": "human_box",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[400, 200], [800, 1200]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "skel_away",
                "classId": 109,
                "classTitle": "HumanSkeleton",
                "geometryType": "graph",
                "nodes": {
                    "l_eye": {"loc": [570, 260], "disabled": False},
                    "r_eye": {"loc": [630, 260], "disabled": False},
                    "l_sh": {"loc": [520, 380], "disabled": False},
                    "r_sh": {"loc": [680, 380], "disabled": False},
                    "l_hip": {"loc": [540, 680], "disabled": False},
                    "r_hip": {"loc": [660, 680], "disabled": False},
                    "l_knee": {"loc": [545, 900], "disabled": False},
                    "r_knee": {"loc": [655, 900], "disabled": False},
                    "l_ank": {"loc": [545, 1140], "disabled": False},
                    "r_ank": {"loc": [655, 1140], "disabled": False},
                },
                "tags": [],
            },
        ],
    )
    ctx_away = RuleContext.build(req_away, default_profile, EngineSettings().tunables)
    assert "KP_ANATOMICAL_LR_INVERSION" not in {f.rule_id for f in evaluate_keypoint_rules(ctx_away)}


def test_missing_sentinel_unknown_outside_parent_and_collapsed_bone(
    default_profile: RuleProfile,
) -> None:
    req = make_analyze_request(
        width=2000,
        height=2000,
        figures=[
            {
                "figureId": "human_box",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[400, 200], [800, 1200]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "skel_bad",
                "classId": 109,
                "classTitle": "HumanSkeleton",
                "geometryType": "graph",
                "nodes": {
                    "l_eye": {"loc": [630, 260], "disabled": False},
                    "r_eye": {"loc": [0, 0], "disabled": False},  # sentinel [0,0]
                    "l_sh": {"loc": [680, 380], "disabled": False},
                    "r_sh": {"loc": [520, 380], "disabled": False},
                    "l_hip": {"loc": [680, 381], "disabled": False},  # collapsed bone l_sh -> l_hip
                    "r_hip": {"loc": [540, 680], "disabled": False},
                    "l_knee": {"loc": [650, 900], "disabled": False},
                    "r_knee": {"loc": [550, 900], "disabled": False},
                    "l_ank": {"loc": [920, 1140], "disabled": False},  # outside parent box
                    "unknown_extra": {"loc": [600, 500], "disabled": False},
                },
                "tags": [],
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    rules = {f.rule_id for f in evaluate_keypoint_rules(ctx)}
    assert {
        "KP_MISSING_REQUIRED_NODES",
        "KP_UNKNOWN_TEMPLATE_NODE",
        "KP_OUTSIDE_PARENT_BOX",
        "KP_BONE_PROPORTION_OUTLIER",
    }.issubset(rules)
