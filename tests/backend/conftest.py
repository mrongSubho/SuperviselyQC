from __future__ import annotations

import base64
import io
import zlib
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import EngineSettings
from app.main import create_app
from app.schemas.qc import QCAnalyzeRequest, RuleProfile
from app.services.profile_store import ProfileStore


def encode_mask_to_sly_bitmap(mask: np.ndarray, mode: str = "RGBA_ALPHA") -> str:
    """Encode a boolean 2D numpy mask into Supervisely base64(zlib(PNG)) across channel modes."""
    h, w = mask.shape
    if mode == "RGBA_ALPHA":
        arr = np.zeros((h, w, 4), dtype=np.uint8)
        arr[mask] = [255, 40, 120, 255]
        img = Image.fromarray(arr, mode="RGBA")
    elif mode == "RGBA_OPAQUE":
        arr = np.zeros((h, w, 4), dtype=np.uint8)
        arr[:, :, 3] = 255
        arr[mask, :3] = [255, 255, 255]
        img = Image.fromarray(arr, mode="RGBA")
    elif mode == "RGB":
        arr = np.zeros((h, w, 3), dtype=np.uint8)
        arr[mask] = [0, 255, 0]
        img = Image.fromarray(arr, mode="RGB")
    elif mode == "GRAY":
        arr = np.zeros((h, w), dtype=np.uint8)
        arr[mask] = 255
        img = Image.fromarray(arr, mode="L")
    else:
        raise ValueError(f"Unsupported mode {mode}")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(zlib.compress(buf.getvalue())).decode("ascii")


def make_jpeg_bytes(width: int, height: int, color: tuple[int, int, int] = (40, 120, 200)) -> bytes:
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def make_ontology(extra_classes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    classes: list[dict[str, Any]] = [
        {"classId": 101, "title": "Human", "shape": "rectangle", "color": "#2ce1b4"},
        {"classId": 102, "title": "Building", "shape": "rectangle", "color": "#6b4eff"},
        {"classId": 103, "title": "Bus", "shape": "rectangle", "color": "#38bdf8"},
        {"classId": 104, "title": "Car", "shape": "polygon", "color": "#ef4444"},
        {"classId": 105, "title": "Car1", "shape": "bitmap", "color": "#ec4899"},
        {"classId": 106, "title": "LaneLine", "shape": "polyline", "color": "#fbbf24"},
        {"classId": 107, "title": "AnchorPt", "shape": "point", "color": "#38bdf8"},
        {
            "classId": 108,
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
        {
            "classId": 109,
            "title": "HumanSkeleton",
            "shape": "graph",
            "color": "#a855f7",
            "geometryConfig": {
                "nodes": {
                    "l_eye": {"label": "left_eye"},
                    "r_eye": {"label": "right_eye"},
                    "l_sh": {"label": "left_shoulder"},
                    "r_sh": {"label": "right_shoulder"},
                    "l_hip": {"label": "left_hip"},
                    "r_hip": {"label": "right_hip"},
                    "l_knee": {"label": "left_knee"},
                    "r_knee": {"label": "right_knee"},
                    "l_ank": {"label": "left_ankle"},
                    "r_ank": {"label": "right_ankle"},
                },
                "edges": [
                    {"src": "l_sh", "dst": "r_sh"},
                    {"src": "l_sh", "dst": "l_hip"},
                    {"src": "r_sh", "dst": "r_hip"},
                    {"src": "l_hip", "dst": "l_knee"},
                    {"src": "l_knee", "dst": "l_ank"},
                    {"src": "r_hip", "dst": "r_knee"},
                    {"src": "r_knee", "dst": "r_ank"},
                ],
            },
        },
    ]
    if extra_classes:
        classes.extend(extra_classes)

    tags = [
        {
            "tagId": 501,
            "name": "Occlusion",
            "valueType": "none",
            "applicableType": "all",
            "classes": [],
            "values": [],
        },
        {
            "tagId": 502,
            "name": "Night",
            "valueType": "none",
            "applicableType": "imagesOnly",
            "classes": [],
            "values": [],
        },
        {
            "tagId": 503,
            "name": "Age",
            "valueType": "any_number",
            "applicableType": "objectsOnly",
            "classes": ["Human"],
            "values": [],
        },
        {
            "tagId": 504,
            "name": "Pose",
            "valueType": "oneof_string",
            "applicableType": "objectsOnly",
            "classes": ["Human"],
            "values": ["standing", "walking", "sitting"],
        },
    ]
    return {
        "projectId": "11402",
        "projectName": "Quantigo Test",
        "classes": classes,
        "tags": tags,
    }


def make_analyze_request(
    *,
    width: int = 5472,
    height: int = 3648,
    figures: list[dict[str, Any]] | None = None,
    image_tags: list[dict[str, Any]] | None = None,
    synchronize_dirty: bool = False,
    is_confirmed: bool = True,
    state_source: str = "store",
    partial_geometry: bool = False,
    dom_summaries: list[dict[str, Any]] | None = None,
    job_classes_to_label: list[str] | None = None,
    zoom_percent: float = 100.0,
    visible_norm_rect: list[float] | None = None,
    visible_pixel_rect: list[float] | None = None,
    mode: str = "rules",
    profile_id: str | None = "default",
) -> QCAnalyzeRequest:
    ont = make_ontology()
    if job_classes_to_label is not None:
        ont["jobClassesToLabel"] = job_classes_to_label

    v_norm = visible_norm_rect or [0.0, 0.0, 1.0, 1.0]
    v_pix = visible_pixel_rect or [0.0, 0.0, float(width), float(height)]

    return QCAnalyzeRequest.model_validate(
        {
            "requestId": "req_test_1",
            "snapshotSeq": 1,
            "mode": mode,
            "profileId": profile_id,
            "asyncIfHeavy": True,
            "image": {
                "imageId": "img_100",
                "datasetId": "ds_200",
                "jobId": "job_300",
                "jobTitle": "Bounding Box Task",
                "fileName": "test.jpg",
                "width": width,
                "height": height,
                "imageHash": "sly:abc123",
            },
            "ontology": ont,
            "imageTags": image_tags or [],
            "figures": figures or [],
            "domFigureSummaries": dom_summaries or [],
            "viewport": {
                "zoomPercent": zoom_percent,
                "visibleNormRect": v_norm,
                "visiblePixelRect": v_pix,
                "canvasSize": {"width": 980, "height": 653},
                "source": "minimap",
            },
            "uiState": {
                "synchronizeDirty": synchronize_dirty,
                "confirmButtonEnabled": True,
                "isConfirmed": is_confirmed,
                "activeTool": "rectangle",
                "activeClassTitle": "Human",
                "stateSource": state_source,
                "partialGeometry": partial_geometry,
            },
        }
    )


@pytest.fixture
def default_profile() -> RuleProfile:
    settings = EngineSettings()
    return ProfileStore(settings).get_profile("default")


@pytest.fixture
def test_settings(tmp_path: Path) -> EngineSettings:
    return EngineSettings(
        host="127.0.0.1",
        port=8765,
        config_dir=tmp_path / "config",
        cache_dir=tmp_path / "cache" / "images",
        models_dir=tmp_path / "cache" / "models",
        user_profiles_dir=tmp_path / "config" / "profiles",
        bridge_token="test-bridge-token-0123456789abcdef0123456789abcdef0123456789abcdef",
        allowed_extension_ids=["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        allow_unpacked_extensions=False,
    )


@pytest.fixture
def api_client(test_settings: EngineSettings) -> TestClient:
    app = create_app(settings=test_settings)
    with TestClient(app) as client:
        yield client
