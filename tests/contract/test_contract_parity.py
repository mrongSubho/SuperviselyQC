from __future__ import annotations

import base64
import io
import json
import subprocess
import zlib
from pathlib import Path

import pytest
import yaml
from PIL import Image
from pydantic import ValidationError

from app.schemas.qc import (
    AnnotationFigure,
    QCAnalyzeRequest,
    QCResponse,
    RuleProfile,
)
from scripts.sync_contracts import (
    SCHEMA_PATH,
    build_schema_bundle,
    verify_ts_parity,
)

ROOT_DIR = Path(__file__).resolve().parents[2]
PROFILES_DIR = ROOT_DIR / "backend" / "profiles"


def _make_sample_bitmap_data(width: int = 16, height: int = 16) -> str:
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for y in range(2, height - 2):
        for x in range(2, width - 2):
            img.putpixel((x, y), (255, 0, 0, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    compressed = zlib.compress(buf.getvalue())
    return base64.b64encode(compressed).decode("ascii")


def _base_request_dict() -> dict:
    return {
        "requestId": "req_001",
        "snapshotSeq": 1,
        "mode": "standard",
        "profileId": "quantigo-street-bbox-v1",
        "asyncIfHeavy": True,
        "image": {
            "imageId": "21672930",
            "entityId": "21672930",
            "datasetId": "38357",
            "jobId": "95492",
            "jobTitle": "Bounding Box_Task1_Nov 12",
            "fileName": "a1bc2acd631e394d2fd0141131b7edfe.jpg",
            "width": 5472,
            "height": 3648,
            "imageHash": "sly:81b2f3d9a4c0e1",
        },
        "ontology": {
            "projectId": "11402",
            "classes": [
                {"classId": 101, "title": "Human", "shape": "rectangle", "color": "#2ce1b4"},
                {"classId": 102, "title": "Car", "shape": "polygon", "color": "#ff0000"},
                {"classId": 104, "title": "Car1", "shape": "bitmap", "color": "#ec4899"},
                {"classId": 106, "title": "LaneLine", "shape": "polyline", "color": "#fbbf24"},
                {"classId": 107, "title": "AnchorPt", "shape": "point", "color": "#38bdf8"},
                {
                    "classId": 105,
                    "title": "Fruit",
                    "shape": "graph",
                    "color": "#4ade80",
                    "geometryConfig": {
                        "nodes": {
                            "n_stem": {"label": "stem"},
                            "n_center": {"label": "center"},
                        },
                        "edges": [{"src": "n_stem", "dst": "n_center"}],
                    },
                },
            ],
            "tags": [
                {
                    "tagId": 501,
                    "name": "Occlusion",
                    "valueType": "none",
                    "applicableType": "all",
                    "classes": [],
                    "values": [],
                }
            ],
        },
        "imageTags": [{"tagId": 501, "name": "Occlusion", "value": None}],
        "figures": [
            {
                "figureId": "fig_rect",
                "classId": 101,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "points": {"exterior": [[3310, 1280], [3780, 2940]], "interior": []},
                "tags": [],
                "labelIndex": 5,
            },
            {
                "figureId": "fig_poly",
                "classId": 102,
                "classTitle": "Car",
                "geometryType": "polygon",
                "points": {
                    "exterior": [[100, 100], [400, 100], [400, 300], [100, 300]],
                    "interior": [[[150, 140], [220, 140], [220, 200], [150, 200]]],
                },
                "tags": [],
            },
            {
                "figureId": "fig_bitmap",
                "classId": 104,
                "classTitle": "Car1",
                "geometryType": "bitmap",
                "bitmap": {"data": _make_sample_bitmap_data(), "origin": [620, 1180]},
                "tags": [],
            },
            {
                "figureId": "fig_line",
                "classId": 106,
                "classTitle": "LaneLine",
                "geometryType": "polyline",
                "points": {"exterior": [[120, 3200], [1450, 2800], [2800, 2500]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "fig_point",
                "classId": 107,
                "classTitle": "AnchorPt",
                "geometryType": "point",
                "points": {"exterior": [[500, 500]], "interior": []},
                "tags": [],
            },
            {
                "figureId": "fig_graph",
                "classId": 105,
                "classTitle": "Fruit",
                "geometryType": "graph",
                "nodes": {
                    "n_stem": {"loc": [810, 420], "disabled": False},
                    "n_center": {"loc": [835, 480], "disabled": False},
                },
                "tags": [],
            },
        ],
        "viewport": {
            "zoomPercent": 16,
            "visibleNormRect": [0.0, 0.0, 1.0, 1.0],
            "visiblePixelRect": [0, 0, 5472, 3648],
            "canvasSize": {"width": 980, "height": 653},
            "source": "minimap",
        },
        "uiState": {
            "synchronizeDirty": True,
            "confirmButtonEnabled": True,
            "isConfirmed": False,
            "activeTool": "rectangle",
            "activeClassTitle": "Human",
            "stateSource": "store",
            "partialGeometry": False,
        },
    }


def test_schema_snapshot_and_typescript_parity() -> None:
    assert SCHEMA_PATH.exists(), "Run scripts/sync_contracts.py to generate schema snapshot"
    bundle = build_schema_bundle()
    disk_schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert disk_schema == bundle
    errors = verify_ts_parity(bundle)
    assert errors == []


def test_all_six_geometry_variants_round_trip() -> None:
    payload = _base_request_dict()
    req = QCAnalyzeRequest.model_validate(payload)
    assert len(req.figures) == 6
    for fig in req.figures:
        geom = fig.to_geometry()
        assert geom.geometry_type == fig.geometry_type
    dumped = req.model_dump(by_alias=True, exclude_none=True)
    req2 = QCAnalyzeRequest.model_validate(dumped)
    assert [f.geometry_type for f in req2.figures] == [
        "rectangle",
        "polygon",
        "bitmap",
        "polyline",
        "point",
        "graph",
    ]


def test_dom_fallback_accepts_summaries_and_rejects_figures() -> None:
    payload = _base_request_dict()
    payload["uiState"]["stateSource"] = "dom_fallback"
    payload["uiState"]["partialGeometry"] = True
    payload["figures"] = []
    payload["domFigureSummaries"] = [
        {"classTitle": "Human", "figureCount": 6, "taggedCount": 0, "visible": True}
    ]
    req = QCAnalyzeRequest.model_validate(payload)
    assert req.dom_figure_summaries[0].figure_count == 6

    bad = _base_request_dict()
    bad["uiState"]["stateSource"] = "dom_fallback"
    with pytest.raises(ValidationError):
        QCAnalyzeRequest.model_validate(bad)


def test_strict_extra_forbid_and_geometry_union_guards() -> None:
    payload = _base_request_dict()
    payload["unknownExtraField"] = 123
    with pytest.raises(ValidationError):
        QCAnalyzeRequest.model_validate(payload)

    with pytest.raises(ValidationError):
        AnnotationFigure.model_validate(
            {
                "figureId": "bad_rect",
                "classId": 1,
                "classTitle": "Human",
                "geometryType": "rectangle",
                "bitmap": {"data": "abc", "origin": [0, 0]},
                "tags": [],
            }
        )

    with pytest.raises(ValidationError):
        QCResponse.model_validate(
            {
                "analysisId": "a1",
                "requestId": "r1",
                "jobId": None,
                "status": "completed",
                "imageId": "1",
                "snapshotSeq": 1,
                "mode": "rules",
                "profileId": "default",
                "overallScore": 100,
                "readiness": "ready",
                "summaryCounts": {"blocker": 0, "warning": 0, "info": 0},
                "findings": [],
                "missedObjects": [],
                "timingMs": {},
                "engineCapabilities": {"device": "none", "modelsUsed": []},
                "unexpectedKey": True,
            }
        )

    sim_resp = QCResponse.model_validate(
        {
            "analysisId": "a2",
            "requestId": "r2",
            "jobId": None,
            "status": "completed",
            "imageId": "1",
            "snapshotSeq": 1,
            "mode": "standard",
            "profileId": "default",
            "overallScore": 85,
            "readiness": "needs_review",
            "summaryCounts": {"blocker": 0, "warning": 1, "info": 0},
            "findings": [
                {
                    "findingId": "f_sidebar",
                    "ruleId": "WORKFLOW_WRONG_ACTIVE_CLASS_OR_TOOL",
                    "severity": "warning",
                    "category": "workflow",
                    "title": "Select Horse",
                    "message": "Switch sidebar class from Boat to Horse",
                    "confidence": 1.0,
                    "suggestedFixes": [
                        {
                            "actionId": "fix_sel",
                            "label": "Switch Sidebar to Horse",
                            "actionType": "select_sidebar_class",
                            "classTitle": "Horse",
                        }
                    ],
                    "fingerprint": "fp_sidebar_1",
                }
            ],
            "missedObjects": [],
            "sceneSimulation": {
                "totalTargetObjects": 1,
                "completedTargetObjects": 0,
                "primaryTargetClasses": ["Horse"],
                "classSummaries": [
                    {
                        "classTitle": "Horse",
                        "recommendedShape": "rectangle",
                        "totalCount": 1,
                        "completedCount": 0,
                        "remainingCount": 1,
                        "foregroundClearCount": 0,
                        "occludedCount": 1,
                        "borderTruncatedCount": 0,
                        "tagCounts": {"Occlusion": 1},
                    }
                ],
                "candidates": [
                    {
                        "simId": "sim_01",
                        "simIndex": 1,
                        "classTitle": "Horse",
                        "recommendedShape": "rectangle",
                        "bbox": [10.0, 20.0, 110.0, 120.0],
                        "confidence": 0.92,
                        "sharpnessScore": 45.0,
                        "visibilityStatus": "occluded",
                        "occludedBySimIndices": [2],
                        "overlapIouMax": 0.25,
                        "overlapCoverRatio": 0.35,
                        "recommendedObjectTags": [
                            {
                                "tagName": "Occlusion",
                                "value": None,
                                "reason": "Occluded by foreground Horse (#2)",
                                "confidence": 0.88,
                            }
                        ],
                        "outsideViewport": False,
                    }
                ],
                "recommendedImageTags": [],
                "misplacedImageTags": ["Occlusion"],
                "ignoredOntologyClasses": ["Animal", "Boat"],
                "disambiguationNotes": ["Ontology has both 'Horse' and 'Animal' — using specific class 'Horse'."],
                "activeSidebarClassWarning": "Active sidebar class is 'Boat', expected 'Horse'.",
            },
            "timingMs": {},
            "engineCapabilities": {"device": "cpu", "modelsUsed": ["yolov8x.pt"]},
        }
    )
    assert sim_resp.scene_simulation is not None
    assert sim_resp.scene_simulation.candidates[0].sim_index == 1
    assert sim_resp.findings[0].suggested_fixes[0].class_title == "Horse"


def test_builtin_yaml_profiles_and_js_regex_compatibility() -> None:
    yaml_files = sorted(PROFILES_DIR.glob("*.yaml"))
    assert len(yaml_files) >= 6
    patterns: list[str] = []
    for path in yaml_files:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        profile = RuleProfile.model_validate(raw)
        assert profile.profile_id == path.stem
        assert profile.is_builtin is True
        if profile.matchers.job_title_regex:
            patterns.append(profile.matchers.job_title_regex)

    js_check = (
        "const patterns = JSON.parse(process.argv[1]);"
        "for (const p of patterns) { new RegExp(p, 'i'); }"
    )
    proc = subprocess.run(
        ["node", "-e", js_check, json.dumps(patterns)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"JS RegExp compile failed: {proc.stderr}"
