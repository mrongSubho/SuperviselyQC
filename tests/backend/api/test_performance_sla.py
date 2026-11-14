from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.config import EngineTunables
from app.rules.context import RuleContext
from app.schemas.qc import RuleProfile
from app.services.image_cache import ImageCacheService
from app.services.qc_orchestrator import QCOrchestrator
from tests.backend.conftest import make_analyze_request, make_jpeg_bytes


def test_rules_mode_150_mixed_figures_under_300ms_sla(
    tmp_path: Any,
    default_profile: RuleProfile,
) -> None:
    from app.config import EngineSettings

    figures: list[dict[str, Any]] = []
    for i in range(150):
        kind = i % 4
        x0 = float((i % 15) * 320 + 20)
        y0 = float((i // 15) * 320 + 20)
        if kind == 0:
            figures.append(
                {
                    "figureId": f"r_{i}",
                    "classId": 101,
                    "classTitle": "Human",
                    "geometryType": "rectangle",
                    "points": {"exterior": [[x0, y0], [x0 + 180, y0 + 220]], "interior": []},
                }
            )
        elif kind == 1:
            figures.append(
                {
                    "figureId": f"p_{i}",
                    "classId": 104,
                    "classTitle": "Car",
                    "geometryType": "polygon",
                    "points": {
                        "exterior": [
                            [x0, y0],
                            [x0 + 200, y0 + 10],
                            [x0 + 210, y0 + 140],
                            [x0 + 10, y0 + 150],
                        ],
                        "interior": [],
                    },
                }
            )
        elif kind == 2:
            figures.append(
                {
                    "figureId": f"l_{i}",
                    "classId": 106,
                    "classTitle": "LaneLine",
                    "geometryType": "polyline",
                    "points": {
                        "exterior": [[x0, y0], [x0 + 90, y0 + 50], [x0 + 180, y0 + 80]],
                        "interior": [],
                    },
                }
            )
        else:
            figures.append(
                {
                    "figureId": f"pt_{i}",
                    "classId": 107,
                    "classTitle": "AnchorPt",
                    "geometryType": "point",
                    "points": {"exterior": [[x0 + 40, y0 + 40]], "interior": []},
                }
            )

    req = make_analyze_request(width=5472, height=3648, figures=figures, mode="rules")
    settings = EngineSettings(cache_dir=tmp_path / "cache")
    orch = QCOrchestrator(settings, ImageCacheService(settings))

    # Warm JIT/Shapely structs once then assert latency SLA
    t0 = time.perf_counter()
    resp = orch.analyze_sync(req, default_profile)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    assert resp.status == "completed"
    assert elapsed_ms < 300.0, f"150-figure rules run took {elapsed_ms:.1f}ms (SLA < 300ms)"

    ctx = RuleContext.build(req, default_profile, EngineTunables())
    assert len(ctx.normalized_figures) == 150


def test_5472x3648_image_upload_and_ram_lru_cap(
    api_client: TestClient,
    test_settings: Any,
) -> None:
    headers = {"X-QC-Bridge-Token": test_settings.bridge_token}
    highres = make_jpeg_bytes(5472, 3648, (30, 80, 140))

    for idx in range(3):
        res = api_client.put(
            f"/api/v1/qc/images/hr_{idx}",
            content=highres,
            headers={
                **headers,
                "X-Image-Hash": f"sha256:hr_{idx}",
                "X-Image-Width": "5472",
                "X-Image-Height": "3648",
                "Content-Type": "image/jpeg",
            },
        )
        assert res.status_code == 201
        img_cache: ImageCacheService = api_client.app.state.image_cache  # type: ignore[union-attr]
        decoded = img_cache.get_decoded_rgb(f"hr_{idx}", f"sha256:hr_{idx}")
        assert decoded is not None and decoded.shape == (3648, 5472, 3)

    img_cache = api_client.app.state.image_cache  # type: ignore[union-attr]
    # Tier-2 RAM LRU max_ram_images = 2 prevents 3rd decoded image from bloating RAM
    assert len(img_cache._ram) <= test_settings.max_ram_images


def test_idle_backend_rss_below_120mb() -> None:
    """Launch backend app cleanly in a fresh Python interpreter and measure RSS (must be < 120 MB)."""
    code = (
        "import os, psutil; "
        "from fastapi.testclient import TestClient; "
        "from app.config import EngineSettings; "
        "from app.main import create_app; "
        "import tempfile; "
        "d = tempfile.TemporaryDirectory(); "
        "s = EngineSettings(config_dir=d.name + '/c', cache_dir=d.name + '/i', user_profiles_dir=d.name + '/p'); "
        "app = create_app(s); "
        "client = TestClient(app); "
        "r = client.get('/api/v1/health'); "
        "assert r.status_code == 200; "
        "rss_mb = psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024); "
        "print(f'RSS_MB={rss_mb:.1f}')"
    )
    backend_dir = str(Path(__file__).resolve().parents[3] / "backend")
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": backend_dir},
        timeout=15,
        check=True,
    )
    line = [ln for ln in proc.stdout.splitlines() if ln.startswith("RSS_MB=")][0]
    rss_mb = float(line.split("=")[1])
    assert rss_mb < 120.0, f"Idle backend RSS {rss_mb:.1f} MB exceeded 120 MB SLA"
