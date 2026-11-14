from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.api.routes_health import router as health_router
from app.api.routes_images import router as images_router
from app.api.routes_profiles import router as profiles_router
from app.api.routes_qc import router as qc_router
from app.config import EngineSettings, ensure_bridge_token, ensure_loopback_host
from app.security import LoopbackCorsAndPnaMiddleware, error_response
from app.services.image_cache import ImageCacheService
from app.services.job_manager import JobManager
from app.services.profile_store import ProfileStore
from app.services.qc_orchestrator import QCOrchestrator
from app.vision.pipeline import VisionPipeline


def create_app(
    settings: EngineSettings | None = None,
    vision_pipeline: VisionPipeline | None = None,
) -> FastAPI:
    """Create and wire the FastAPI local QC application."""
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    cfg = settings or EngineSettings()
    ensure_loopback_host(cfg.host)
    bridge_token = ensure_bridge_token(cfg)

    image_cache = ImageCacheService(cfg)
    profile_store = ProfileStore(cfg)
    vis = vision_pipeline or VisionPipeline(cfg)
    orchestrator = QCOrchestrator(cfg, image_cache, vis)
    job_manager = JobManager(cfg, orchestrator)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.started_at = time.monotonic()
        job_manager.bind_loop(asyncio.get_running_loop())
        try:
            yield
        finally:
            job_manager.shutdown()

    app = FastAPI(
        title="Supervisely Hybrid QC Assistant Backend",
        version=cfg.version,
        lifespan=lifespan,
    )

    app.state.settings = cfg
    app.state.bridge_token = bridge_token
    app.state.image_cache = image_cache
    app.state.profile_store = profile_store
    app.state.vision_pipeline = vis
    app.state.orchestrator = orchestrator
    app.state.job_manager = job_manager
    app.state.started_at = time.monotonic()

    app.add_middleware(LoopbackCorsAndPnaMiddleware, settings=cfg)

    @app.exception_handler(HTTPException)
    async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
        del request
        if exc.status_code == status.HTTP_401_UNAUTHORIZED:
            return error_response(
                status.HTTP_401_UNAUTHORIZED,
                "UNAUTHORIZED",
                str(exc.detail or "Unauthorized"),
            )
        return error_response(
            exc.status_code,
            "INVALID_PAYLOAD",
            str(exc.detail or "Request error"),
        )

    app.include_router(health_router)
    app.include_router(images_router)
    app.include_router(profiles_router)
    app.include_router(qc_router)
    return app
