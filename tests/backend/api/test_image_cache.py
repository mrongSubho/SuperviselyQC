from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import EngineSettings
from tests.backend.conftest import make_analyze_request, make_jpeg_bytes


def test_head_put_image_cache_and_424_miss(
    api_client: TestClient, test_settings: EngineSettings
) -> None:
    headers = {"X-QC-Bridge-Token": test_settings.bridge_token or ""}

    # 1. Analyze standard without cached image -> 424 IMAGE_CACHE_MISS
    req = make_analyze_request(width=640, height=480, mode="standard")
    miss_res = api_client.post(
        "/api/v1/qc/analyze",
        json=req.model_dump(by_alias=True, exclude_none=True),
        headers=headers,
    )
    assert miss_res.status_code == 424
    assert miss_res.json()["error"]["code"] == "IMAGE_CACHE_MISS"

    # 2. HEAD miss -> 404
    head_miss = api_client.head(
        "/api/v1/qc/images/img_100?hash=sly:abc123&width=640&height=480",
        headers=headers,
    )
    assert head_miss.status_code == 404

    # 3. PUT mismatch dimension -> 400
    jpg = make_jpeg_bytes(640, 480)
    bad_dim = api_client.put(
        "/api/v1/qc/images/img_100",
        content=jpg,
        headers={
            **headers,
            "Content-Type": "image/jpeg",
            "X-Image-Hash": "sly:abc123",
            "X-Image-Width": "1024",
            "X-Image-Height": "768",
        },
    )
    assert bad_dim.status_code == 400

    # 4. PUT valid -> 201 Created, then HEAD hit -> 200
    put_ok = api_client.put(
        "/api/v1/qc/images/img_100",
        content=jpg,
        headers={
            **headers,
            "Content-Type": "image/jpeg",
            "X-Image-Hash": "sly:abc123",
            "X-Image-Width": "640",
            "X-Image-Height": "480",
        },
    )
    assert put_ok.status_code == 201
    assert put_ok.json()["cached"] is True

    head_ok = api_client.head(
        "/api/v1/qc/images/img_100?hash=sly:abc123&width=640&height=480",
        headers=headers,
    )
    assert head_ok.status_code == 200
    assert head_ok.headers.get("x-cache-hit") == "true"


def test_ram_lru_eviction_and_oversize_413(test_settings: EngineSettings) -> None:
    test_settings.max_image_upload_bytes = 5000
    test_settings.max_ram_images = 2
    from app.main import create_app

    app = create_app(settings=test_settings)
    with TestClient(app) as client:
        headers = {"X-QC-Bridge-Token": test_settings.bridge_token or ""}

        # > 5000 bytes -> 413
        too_big = client.put(
            "/api/v1/qc/images/big",
            content=b"\xff\xd8\xff" + b"0" * 6000,
            headers={**headers, "X-Image-Hash": "sly:big"},
        )
        assert too_big.status_code == 413

        # Put 3 tiny images -> Tier 2 RAM LRU keeps <= 2 images
        tiny_jpg = make_jpeg_bytes(64, 64)
        assert len(tiny_jpg) < 5000
        for idx in range(3):
            res = client.put(
                f"/api/v1/qc/images/img_{idx}",
                content=tiny_jpg,
                headers={**headers, "X-Image-Hash": f"sly:h_{idx}"},
            )
            assert res.status_code == 201

        assert app.state.image_cache.ram_entry_count() == 2
        # All 3 remain on disk and reload seamlessly
        for idx in range(3):
            rgb = app.state.image_cache.get_decoded_rgb(f"img_{idx}", f"sly:h_{idx}")
            assert rgb is not None and rgb.shape == (64, 64, 3)
        assert app.state.image_cache.ram_entry_count() == 2
