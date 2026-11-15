from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Depends, Request

from app.config import EngineSettings
from app.schemas.qc import HealthResponse
from app.security import verify_bridge_token
from app.services.image_cache import ImageCacheService
from app.services.metrics import MetricsTracker
from app.vision.pipeline import VisionPipeline

router = APIRouter(tags=["health"])


@router.get("/api/v1/health", response_model=HealthResponse, response_model_by_alias=True)
async def get_health(request: Request) -> HealthResponse:
    """Unauthenticated minimal readiness probe for extension background worker."""
    settings: EngineSettings = request.app.state.settings
    image_cache: ImageCacheService = request.app.state.image_cache
    vision_pipeline: VisionPipeline = request.app.state.vision_pipeline
    started_at: float = request.app.state.started_at

    device_raw = vision_pipeline.probe_device_name()
    device: Literal["mps", "cpu"] = "mps" if device_raw == "mps" else "cpu"
    loaded_models = vision_pipeline.loaded_models()
    status_val: Literal["ok", "degraded"] = "ok"

    return HealthResponse(
        status=status_val,
        version=settings.version,
        device=device,
        loaded_models=loaded_models,
        cache_stats=image_cache.cache_stats(),
        uptime_seconds=round(max(0.0, time.monotonic() - started_at), 2),
    )


@router.get("/api/v1/metrics", dependencies=[Depends(verify_bridge_token)])
async def get_metrics(request: Request) -> dict[str, object]:
    """Authenticated lightweight in-memory request/latency metrics."""
    metrics: MetricsTracker = request.app.state.metrics
    return metrics.snapshot()
