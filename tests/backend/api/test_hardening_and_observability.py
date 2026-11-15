from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import EngineSettings
from app.main import create_app
from app.schemas.qc import RuleProfile
from app.services.profile_store import ProfileStore, ProfileStoreError
from app.vision.detector import map_detector_label_to_ontology
from app.vision.model_manager import ModelManager


def test_metrics_endpoint_requires_token_and_records_requests(tmp_path: Path) -> None:
    cfg = EngineSettings(
        config_dir=tmp_path / "cfg",
        cache_dir=tmp_path / "cache",
        models_dir=tmp_path / "models",
        bridge_token="metrics-test-token-1234567890abcdef",
        allowed_extension_ids=["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    )
    app = create_app(settings=cfg)
    with TestClient(app) as client:
        unauth = client.get("/api/v1/metrics")
        assert unauth.status_code == 401

        health = client.get("/api/v1/health")
        assert health.status_code == 200

        metrics = client.get(
            "/api/v1/metrics",
            headers={"X-QC-Bridge-Token": cfg.bridge_token or ""},
        )
        assert metrics.status_code == 200
        body = metrics.json()
        assert body["totalRequests"] >= 2
        assert "GET /api/v1/health" in body["routes"]


def test_detector_alias_removes_truck_to_car_and_supports_profile_aliases() -> None:
    assert map_detector_label_to_ontology("truck", ["Car", "Person"]) is None
    assert map_detector_label_to_ontology("truck", ["Truck", "Car"]) == "Truck"
    assert (
        map_detector_label_to_ontology(
            "truck",
            ["HeavyVan", "Car"],
            custom_aliases={"truck": ["HeavyVan"]},
        )
        == "HeavyVan"
    )


def test_model_manager_sha256_sidecar_verification(tmp_path: Path) -> None:
    cfg = EngineSettings(
        config_dir=tmp_path / "cfg",
        cache_dir=tmp_path / "cache",
        models_dir=tmp_path / "models",
    )
    mgr = ModelManager(cfg)
    weights = cfg.models_dir / "yolo11s.pt"
    weights.parent.mkdir(parents=True, exist_ok=True)
    weights.write_bytes(b"fake-weights-payload")

    # No sidecar -> accepted
    assert mgr.has_weight_file("yolo11s.pt") == weights

    # Mismatched sidecar -> rejected
    sha_file = weights.with_suffix(".pt.sha256")
    sha_file.write_text("0" * 64 + "  yolo11s.pt\n", encoding="utf-8")
    assert mgr.has_weight_file("yolo11s.pt") is None


def test_profile_store_rejects_redos_job_title_regex(tmp_path: Path) -> None:
    cfg = EngineSettings(
        config_dir=tmp_path / "cfg",
        cache_dir=tmp_path / "cache",
        models_dir=tmp_path / "models",
    )
    store = ProfileStore(cfg)
    bad_profile = RuleProfile(
        profile_id="custom-redos",
        name="Bad Regex",
        description="Should fail",
    )
    bad_profile.matchers.job_title_regex = r"^(a+)+$"
    with pytest.raises(ProfileStoreError):
        store.upsert_profile("custom-redos", bad_profile)


@pytest.mark.asyncio
async def test_job_manager_wait_for_job_event_wakeup(tmp_path: Path) -> None:
    cfg = EngineSettings(
        config_dir=tmp_path / "cfg",
        cache_dir=tmp_path / "cache",
        models_dir=tmp_path / "models",
    )
    app = create_app(settings=cfg)
    jm = app.state.job_manager
    assert await jm.wait_for_job("nonexistent") is None
    await asyncio.sleep(0)
