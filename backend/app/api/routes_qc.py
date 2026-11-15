from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Query, Request, Response, WebSocket, WebSocketDisconnect, status

from app.schemas.qc import (
    EngineCapabilities,
    QCAnalyzeRequest,
    QCResponse,
    SummaryCounts,
    WsEvent,
)
from app.security import error_response, verify_bridge_token, verify_ws_bridge_token
from app.services.image_cache import ImageCacheService
from app.services.job_manager import JobManager
from app.services.profile_store import ProfileNotFoundError, ProfileStore
from app.services.qc_orchestrator import QCOrchestrator

router = APIRouter(prefix="/api/v1/qc", tags=["qc"])


@router.post(
    "/analyze",
    response_model=QCResponse,
    response_model_by_alias=True,
    dependencies=[Depends(verify_bridge_token)],
)
async def analyze_snapshot(
    payload: QCAnalyzeRequest,
    request: Request,
    response: Response,
) -> QCResponse | Response:
    """Run deterministic rules and optional local vision checks on the current snapshot."""
    profile_store: ProfileStore = request.app.state.profile_store
    image_cache: ImageCacheService = request.app.state.image_cache
    orchestrator: QCOrchestrator = request.app.state.orchestrator
    job_manager: JobManager = request.app.state.job_manager

    try:
        profile = profile_store.resolve_for_request(
            explicit_profile_id=payload.profile_id,
            project_id=payload.ontology.project_id,
            dataset_id=payload.image.dataset_id,
            job_title=payload.image.job_title,
        )
    except ProfileNotFoundError as exc:
        return error_response(status.HTTP_404_NOT_FOUND, "PROFILE_NOT_FOUND", str(exc))

    effective_mode, degraded_reason = orchestrator.check_memory_mode(payload.mode)

    if effective_mode in {"standard", "deep"}:
        if not image_cache.head(payload.image.image_id, payload.image.image_hash):
            return error_response(
                status.HTTP_424_FAILED_DEPENDENCY,
                "IMAGE_CACHE_MISS",
                (
                    f"Image '{payload.image.image_id}' ({payload.image.image_hash}) is not cached. "
                    "Upload via PUT /api/v1/qc/images/{imageId} before running vision mode."
                ),
            )

    if effective_mode == "rules":
        return await job_manager.run_rules_sync(
            payload, profile, degraded_reason=degraded_reason
        )

    if effective_mode == "standard":
        return await job_manager.run_standard_sync(
            payload, profile, degraded_reason=degraded_reason
        )

    # deep mode
    job = await job_manager.submit_async_job(
        payload, profile, effective_mode="deep", degraded_reason=degraded_reason
    )
    if payload.async_if_heavy:
        response.status_code = status.HTTP_202_ACCEPTED
        return QCResponse(
            analysis_id=f"qc_{job.job_id}",
            request_id=payload.request_id,
            job_id=job.job_id,
            status="queued",
            image_id=payload.image.image_id,
            snapshot_seq=payload.snapshot_seq,
            mode="deep",
            profile_id=profile.profile_id,
            overall_score=100,
            readiness="ready",
            summary_counts=SummaryCounts(),
            findings=[],
            missed_objects=[],
            timing_ms={},
            engine_capabilities=EngineCapabilities(
                device="none", models_used=[], degraded_reason=degraded_reason
            ),
            error=None,
        )

    # Synchronous wait if caller explicitly requested asyncIfHeavy=false
    waited = await job_manager.wait_for_job(job.job_id)
    if waited is not None:
        return waited
    return error_response(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "MODEL_EXECUTION_ERROR",
        f"Job '{job.job_id}' disappeared before completion",
    )


@router.get(
    "/jobs/{job_id}",
    response_model=QCResponse,
    response_model_by_alias=True,
    dependencies=[Depends(verify_bridge_token)],
)
async def get_job_status(job_id: str, request: Request) -> QCResponse | Response:
    job_manager: JobManager = request.app.state.job_manager
    result = job_manager.get_job_response(job_id)
    if result is None:
        return error_response(
            status.HTTP_404_NOT_FOUND, "JOB_NOT_FOUND", f"Job '{job_id}' not found or expired"
        )
    return result


@router.websocket("/ws/{client_id}")
async def qc_websocket(
    websocket: WebSocket,
    client_id: str,
    token: str | None = Query(default=None),
) -> None:
    expected_token: str = websocket.app.state.bridge_token
    await websocket.accept()
    if token is not None:
        if not verify_ws_bridge_token(expected_token, token):
            await websocket.close(code=4001, reason="Unauthorized bridge token")
            return
    else:
        try:
            raw_auth = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
            auth_payload = json.loads(raw_auth)
            ws_token = auth_payload.get("token") if isinstance(auth_payload, dict) else None
        except Exception:
            await websocket.close(code=4001, reason="Unauthorized bridge token")
            return
        if not verify_ws_bridge_token(expected_token, ws_token if isinstance(ws_token, str) else None):
            await websocket.close(code=4001, reason="Unauthorized bridge token")
            return

    job_manager = websocket.app.state.job_manager
    await job_manager.register_ws(client_id, websocket)
    try:
        await websocket.send_json(WsEvent(event_type="ping").model_dump(by_alias=True))
        while True:
            msg = await websocket.receive_text()
            if msg == "ping":
                await websocket.send_json(WsEvent(event_type="ping").model_dump(by_alias=True))
    except WebSocketDisconnect:
        pass
    finally:
        job_manager.unregister_ws(client_id)
