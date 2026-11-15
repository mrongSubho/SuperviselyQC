from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.config import EngineSettings
from app.schemas.qc import QCAnalyzeRequest, RuleProfile
from app.services.image_cache import ImageCacheService
from app.services.qc_orchestrator import QCOrchestrator
from app.vision.pipeline import VisionPipeline

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "rule_parity_snapshots.json"
FIXTURE_DATA = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
PROFILE = RuleProfile.model_validate(FIXTURE_DATA["profile"])


@pytest.mark.parametrize("case", FIXTURE_DATA["cases"], ids=lambda c: c["name"])
def test_python_rules_match_shared_parity_fixtures(case: dict, tmp_path: Path) -> None:
    cfg = EngineSettings(
        config_dir=tmp_path / "cfg",
        cache_dir=tmp_path / "cache",
        models_dir=tmp_path / "models",
    )
    orchestrator = QCOrchestrator(cfg, ImageCacheService(cfg), VisionPipeline(cfg))
    req = QCAnalyzeRequest.model_validate(case["request"])
    resp = orchestrator.analyze_sync(req, PROFILE, effective_mode="rules")

    actual = sorted((f.rule_id, f.severity) for f in resp.findings)
    expected = sorted((e["ruleId"], e["severity"]) for e in case["expected"])
    assert actual == expected
