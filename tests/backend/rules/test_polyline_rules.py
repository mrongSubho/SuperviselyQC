from __future__ import annotations

from app.config import EngineSettings
from app.rules.context import RuleContext
from app.rules.polyline_rules import evaluate_polyline_rules
from app.schemas.qc import RuleProfile
from tests.backend.conftest import make_analyze_request


def test_polyline_spikes_self_cross_and_endpoint_gaps(default_profile: RuleProfile) -> None:
    req = make_analyze_request(
        width=2000,
        height=1000,
        figures=[
            # Micro-line
            {
                "figureId": "line_micro",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {"exterior": [[10, 10], [14, 12]], "interior": []},
                "tags": [],
            },
            # Acute backtrack spike (< 25 deg)
            {
                "figureId": "line_spike",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {"exterior": [[100, 200], [300, 200], [120, 205]], "interior": []},
                "tags": [],
            },
            # Self-intersecting loop
            {
                "figureId": "line_cross",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {
                    "exterior": [[500, 100], [650, 250], [650, 100], [500, 250]],
                    "interior": [],
                },
                "tags": [],
            },
            # Collinear disconnected pair (14px gap)
            {
                "figureId": "line_a",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {"exterior": [[100, 600], [400, 600]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "line_b",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {"exterior": [[414, 600], [700, 600]], "interior": []},
                "tags": [],
            },
            # Near-closed single polyline loop
            {
                "figureId": "line_loop",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {
                    "exterior": [[900, 500], [1050, 500], [1050, 650], [900, 650], [902, 506]],
                    "interior": [],
                },
                "tags": [],
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    findings = evaluate_polyline_rules(ctx)
    rules = {f.rule_id for f in findings}
    assert {
        "LINE_ZERO_LENGTH_SEGMENT",
        "LINE_ACUTE_BACKTRACK_SPIKE",
        "LINE_SELF_INTERSECTION",
        "LINE_DISCONNECTED_ENDPOINT_GAP",
    }.issubset(rules)
