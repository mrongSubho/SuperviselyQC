#!/usr/bin/env python3
"""Export canonical JSON Schema from Pydantic v2 models and verify TS contract parity."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from pydantic.json_schema import models_json_schema  # noqa: E402

from app.config import EngineTunables  # noqa: E402
from app.schemas.qc import (  # noqa: E402
    ApiErrorEnvelope,
    BitmapGeometry,
    ClassDefinition,
    ClassRuleOverride,
    DomFigureSummary,
    GraphGeometry,
    HealthResponse,
    ImageCacheAck,
    ImageContext,
    MissedObjectOverlay,
    PointGeometry,
    PolygonGeometry,
    PolylineGeometry,
    ProfileListResponse,
    ProjectOntology,
    QCAnalyzeRequest,
    QCFinding,
    QCResponse,
    QuickFixAction,
    RectangleGeometry,
    RuleProfile,
    SceneSimulationPlan,
    SimulatedClassSummary,
    SimulatedObjectCandidate,
    SimulatedTagRecommendation,
    TagDefinition,
    TagValue,
    UiStateSnapshot,
    ViewportMetadata,
    WsEvent,
)

SCHEMA_PATH = ROOT_DIR / "shared" / "schemas" / "qc-contract.schema.json"
TUNABLES_PATH = ROOT_DIR / "shared" / "schemas" / "rule-tunables.json"
TS_CONTRACT_PATH = ROOT_DIR / "shared" / "types" / "qc-contract.ts"

CONTRACT_MODELS = [
    RectangleGeometry,
    PolygonGeometry,
    BitmapGeometry,
    PolylineGeometry,
    PointGeometry,
    GraphGeometry,
    TagValue,
    ClassDefinition,
    TagDefinition,
    ProjectOntology,
    ImageContext,
    ViewportMetadata,
    UiStateSnapshot,
    DomFigureSummary,
    QCAnalyzeRequest,
    QuickFixAction,
    QCFinding,
    MissedObjectOverlay,
    SimulatedTagRecommendation,
    SimulatedObjectCandidate,
    SimulatedClassSummary,
    SceneSimulationPlan,
    QCResponse,
    HealthResponse,
    ImageCacheAck,
    WsEvent,
    ClassRuleOverride,
    RuleProfile,
    ProfileListResponse,
    ApiErrorEnvelope,
]


def build_schema_bundle() -> dict[str, Any]:
    """Generate unified JSON Schema with camelCase aliases from Pydantic v2 models."""
    _, top_schema = models_json_schema(
        [(model, "validation") for model in CONTRACT_MODELS],
        title="Supervisely Hybrid QC Assistant Canonical Contract",
        by_alias=True,
    )
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Supervisely Hybrid QC Assistant Canonical Contract",
        "version": "1.0.0",
        "$defs": top_schema.get("$defs", {}),
    }


def _extract_ts_interfaces(ts_source: str) -> dict[str, set[str]]:
    """Parse top-level TypeScript interface bodies and extract declared property names."""
    interfaces: dict[str, set[str]] = {}
    pattern = re.compile(r"export\s+interface\s+(\w+)\s*\{")
    for match in pattern.finditer(ts_source):
        name = match.group(1)
        start = match.end()
        depth = 1
        idx = start
        while idx < len(ts_source) and depth > 0:
            ch = ts_source[idx]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            idx += 1
        body = ts_source[start : idx - 1]
        props: set[str] = set()
        top_depth = 0
        for line in body.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
                continue
            if top_depth == 0:
                prop_match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\??\s*:", stripped)
                if prop_match:
                    props.add(prop_match.group(1))
            top_depth += stripped.count("{") - stripped.count("}")
        interfaces[name] = props
    return interfaces


def _extract_ts_string_union(ts_source: str, type_name: str) -> set[str]:
    """Extract string literal union members for an exported TS type alias."""
    match = re.search(
        rf"export\s+type\s+{re.escape(type_name)}\s*=([^;]+);",
        ts_source,
        re.DOTALL,
    )
    if not match:
        return set()
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def verify_ts_parity(schema_bundle: dict[str, Any], ts_path: Path = TS_CONTRACT_PATH) -> list[str]:
    """Verify field-level and literal union parity between JSON Schema and TypeScript."""
    ts_source = ts_path.read_text(encoding="utf-8")
    ts_interfaces = _extract_ts_interfaces(ts_source)
    defs: dict[str, Any] = schema_bundle.get("$defs", {})
    errors: list[str] = []

    for model in CONTRACT_MODELS:
        name = model.__name__
        if name not in ts_interfaces:
            errors.append(f"Missing TypeScript interface '{name}' in {ts_path.name}")
            continue
        py_props = set(defs.get(name, {}).get("properties", {}).keys())
        ts_props = ts_interfaces[name]
        missing_in_ts = sorted(py_props - ts_props)
        extra_in_ts = sorted(ts_props - py_props)
        if missing_in_ts:
            errors.append(f"Interface '{name}' missing fields in TS: {missing_in_ts}")
        if extra_in_ts:
            errors.append(f"Interface '{name}' has extra fields in TS not in Pydantic: {extra_in_ts}")

    # Verify key string literal unions match Pydantic definitions
    union_checks: dict[str, set[str]] = {
        "QCMode": {"rules", "standard", "deep"},
        "QCSeverity": {"blocker", "warning", "info"},
        "QCCategory": {
            "workflow",
            "tags",
            "geometry",
            "missed_objects",
            "classification",
            "keypoints",
        },
        "QuickFixActionType": {
            "highlight_synchronize",
            "move_tag_image_to_object",
            "add_object_tag",
            "remove_object_tag",
            "remove_image_tag",
            "focus_viewport",
            "inspect_figure",
            "confirm_delete_figure",
            "toggle_class_visibility",
            "select_sidebar_class",
        },
        "ViewportEdgeDirection": {
            "left",
            "right",
            "top",
            "bottom",
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right",
        },
        "ApiErrorCode": {
            "UNAUTHORIZED",
            "IMAGE_CACHE_MISS",
            "INVALID_PAYLOAD",
            "PROFILE_NOT_FOUND",
            "JOB_NOT_FOUND",
            "MODEL_EXECUTION_ERROR",
        },
    }
    for union_name, expected in union_checks.items():
        actual = _extract_ts_string_union(ts_source, union_name)
        if actual != expected:
            errors.append(
                f"Union '{union_name}' mismatch: expected {sorted(expected)}, got {sorted(actual)}"
            )

    expected_geometries = {"rectangle", "polygon", "bitmap", "polyline", "point", "graph"}
    geom_literals = set(re.findall(r'geometryType:\s*"([^"]+)"\s*;', ts_source))
    if geom_literals != expected_geometries:
        errors.append(
            f"FigureGeometry literals mismatch: expected {sorted(expected_geometries)}, got {sorted(geom_literals)}"
        )
    if 'export type GeometryType = FigureGeometry["geometryType"];' not in ts_source:
        errors.append("Missing GeometryType indexed access type in TS contract")

    # Verify AnnotationFigure outer fields appear in TS contract
    if "export type AnnotationFigure" not in ts_source:
        errors.append("Missing AnnotationFigure type in TS contract")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync & verify QC canonical contract schemas.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify schema file is up-to-date and matches TS without writing.",
    )
    args = parser.parse_args()

    bundle = build_schema_bundle()
    serialized = json.dumps(bundle, indent=2, sort_keys=True) + "\n"
    tunables_serialized = json.dumps(EngineTunables().model_dump(), indent=2, sort_keys=True) + "\n"

    if args.check:
        if not SCHEMA_PATH.exists():
            print(f"ERROR: Missing schema file {SCHEMA_PATH}", file=sys.stderr)
            return 1
        existing = SCHEMA_PATH.read_text(encoding="utf-8")
        if existing != serialized:
            print(
                f"ERROR: {SCHEMA_PATH} is out of date with backend/app/schemas/qc.py. "
                "Run 'python scripts/sync_contracts.py' to regenerate.",
                file=sys.stderr,
            )
            return 1
        if not TUNABLES_PATH.exists() or TUNABLES_PATH.read_text(encoding="utf-8") != tunables_serialized:
            print(
                f"ERROR: {TUNABLES_PATH} is out of date with backend/app/config.py EngineTunables. "
                "Run 'python scripts/sync_contracts.py' to regenerate.",
                file=sys.stderr,
            )
            return 1
    else:
        SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)
        SCHEMA_PATH.write_text(serialized, encoding="utf-8")
        print(f"Wrote {SCHEMA_PATH}")
        TUNABLES_PATH.write_text(tunables_serialized, encoding="utf-8")
        print(f"Wrote {TUNABLES_PATH}")

    parity_errors = verify_ts_parity(bundle)
    if parity_errors:
        for err in parity_errors:
            print(f"PARITY ERROR: {err}", file=sys.stderr)
        return 1

    print("Contract parity verified: Pydantic <-> JSON Schema <-> TypeScript OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
