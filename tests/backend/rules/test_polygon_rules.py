from __future__ import annotations

from app.config import EngineSettings
from app.rules.context import RuleContext
from app.rules.polygon_rules import evaluate_polygon_rules
from app.schemas.qc import RuleProfile
from tests.backend.conftest import make_analyze_request


def test_cw_and_ccw_polygons_and_valid_hole(default_profile: RuleProfile) -> None:
    cw = [[100, 100], [400, 100], [400, 300], [100, 300]]
    ccw = [[100, 100], [100, 300], [400, 300], [400, 100]]
    hole = [[160, 150], [240, 150], [240, 230], [160, 230]]

    req = make_analyze_request(
        width=1000,
        height=1000,
        figures=[
            {
                "figureId": "poly_cw",
                "classId": 102,
                "classTitle": "Building",
                "geometryType": "polygon",
                "points": {"exterior": cw, "interior": [hole]},
                "tags": [],
            },
            {
                "figureId": "poly_ccw",
                "classId": 102,
                "classTitle": "Building",
                "geometryType": "polygon",
                "points": {"exterior": ccw, "interior": [hole]},
                "tags": [],
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    findings = evaluate_polygon_rules(ctx)
    assert findings == []


def test_bowtie_witness_collinear_spike_and_invalid_holes(default_profile: RuleProfile) -> None:
    req = make_analyze_request(
        width=2000,
        height=2000,
        figures=[
            # Bowtie self-intersection crossing at (200, 200)
            {
                "figureId": "bowtie",
                "classId": 104,
                "classTitle": "Car",
                "geometryType": "polygon",
                "points": {
                    "exterior": [[100, 100], [300, 300], [300, 100], [100, 300]],
                    "interior": [],
                },
                "tags": [],
            },
            # Acute spike < 10 deg + collinear vertices
            {
                "figureId": "spike_collinear",
                "classId": 104,
                "classTitle": "Car",
                "geometryType": "polygon",
                "points": {
                    "exterior": [
                        [500, 500],
                        [600, 500],
                        [700, 500],
                        [800, 500],
                        [900, 500],
                        [900, 700],
                        [700, 700],
                        [704, 880],
                        [698, 700],
                        [500, 700],
                    ],
                    "interior": [],
                },
                "tags": [],
            },
            # Invalid hole outside exterior + micro-hole
            {
                "figureId": "bad_holes",
                "classId": 104,
                "classTitle": "Car",
                "geometryType": "polygon",
                "points": {
                    "exterior": [[1000, 1000], [1400, 1000], [1400, 1400], [1000, 1400]],
                    "interior": [
                        [[1350, 1100], [1500, 1100], [1500, 1200], [1350, 1200]],
                        [[1100, 1100], [1103, 1100], [1103, 1103], [1100, 1103]],
                    ],
                },
                "tags": [],
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    findings = evaluate_polygon_rules(ctx)
    by_rule = {f.rule_id: f for f in findings}
    assert "POLY_SELF_INTERSECTION" in by_rule
    f_bow = by_rule["POLY_SELF_INTERSECTION"]
    assert f_bow.focus_rect is not None
    # Witness around (200, 200)
    assert f_bow.focus_rect[0] <= 200.0 <= f_bow.focus_rect[2]
    assert f_bow.focus_rect[1] <= 200.0 <= f_bow.focus_rect[3]
    assert "POLY_COLLINEAR_REDUNDANT_VERTICES" in by_rule
    assert "POLY_ACUTE_NEEDLE_SPIKE" in by_rule
    assert "POLY_HOLE_INVALID" in by_rule
    assert "POLY_MICRO_HOLE" in by_rule
