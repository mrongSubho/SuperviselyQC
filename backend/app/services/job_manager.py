from __future__ import annotations

import asyncio
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from fastapi import WebSocket

from app.config import EngineSettings
from app.schemas.qc import (
    EngineCapabilities,
    QCAnalyzeRequest,
    QCErrorDetail,
    QCMode,
    QCResponse,
    RuleProfile,
    SummaryCounts,
    WsEvent,
)
from app.services.qc_orchestrator import QCOrchestrator


@dataclass
class JobRecord:
    job_id: str
    image_id: str
    snapshot_seq: int
    mode: QCMode
    profile_id: str
    request_id: str
    status: str = "queued"
    cancel_event: threading.Event = field(default_factory=threading.Event)
    result: QCResponse | None = None
    created_at: float = field(default_factory=time.time)
    error_message: str | None = None


class JobManager:
    """Manages bounded thread pools, serial MPS lock, snapshotSeq coalescing, and WS push."""

    def __init__(self, settings: EngineSettings, orchestrator: QCOrchestrator) -> None:
        self.settings = settings
        self.orchestrator = orchestrator
        self.rules_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="qc-rules")
        self.vision_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qc-mps")
        self._vision_lock = asyncio.Lock()
        self._jobs: dict[str, JobRecord] = {}
        self._latest_seq_by_image: dict[str, int] = {}
        self._websockets: dict[str, WebSocket] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def shutdown(self) -> None:
        for job in self._jobs.values():
            job.cancel_event.set()
        self.rules_executor.shutdown(wait=False, cancel_futures=True)
        self.vision_executor.shutdown(wait=False, cancel_futures=True)

    async def register_ws(self, client_id: str, websocket: WebSocket) -> None:
        self._websockets[client_id] = websocket

    def unregister_ws(self, client_id: str) -> None:
        self._websockets.pop(client_id, None)

    async def broadcast_event(self, event: WsEvent) -> None:
        if not self._websockets:
            return
        payload = event.model_dump(by_alias=True)
        dead: list[str] = []
        for cid, ws in list(self._websockets.items()):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(cid)
        for cid in dead:
            self._websockets.pop(cid, None)

    def _emit_from_worker(self, event: WsEvent) -> None:
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self.broadcast_event(event), self._loop)

    def _coalesce_stale_jobs(self, image_id: str, snapshot_seq: int) -> None:
        prev_seq = self._latest_seq_by_image.get(image_id, -1)
        if snapshot_seq > prev_seq:
            self._latest_seq_by_image[image_id] = snapshot_seq
        for job in list(self._jobs.values()):
            if job.image_id == image_id and job.snapshot_seq < snapshot_seq and job.status in {
                "queued",
                "running",
            }:
                job.cancel_event.set()
                if job.status == "queued":
                    job.status = "failed"
                    job.error_message = "Superseded by newer snapshotSeq"
                    job.result = self._make_cancelled_response(job)

    @staticmethod
    def _make_cancelled_response(job: JobRecord, code: str = "MODEL_EXECUTION_ERROR") -> QCResponse:
        return QCResponse(
            analysis_id=f"qc_{job.job_id}",
            request_id=job.request_id,
            job_id=job.job_id,
            status="failed",
            image_id=job.image_id,
            snapshot_seq=job.snapshot_seq,
            mode=job.mode,
            profile_id=job.profile_id,
            overall_score=0,
            readiness="blocked",
            summary_counts=SummaryCounts(),
            findings=[],
            missed_objects=[],
            timing_ms={},
            engine_capabilities=EngineCapabilities(device="none", models_used=[], degraded_reason=code),
            error=QCErrorDetail(
                code=code,
                message=job.error_message or "Job cancelled or failed",
            ),
        )

    async def run_rules_sync(
        self,
        request: QCAnalyzeRequest,
        profile: RuleProfile,
        degraded_reason: str | None = None,
    ) -> QCResponse:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self.rules_executor,
            lambda: self.orchestrator.analyze_sync(
                request,
                profile,
                effective_mode="rules",
                degraded_reason=degraded_reason,
            ),
        )

    async def run_standard_sync(
        self,
        request: QCAnalyzeRequest,
        profile: RuleProfile,
        degraded_reason: str | None = None,
    ) -> QCResponse:
        self._coalesce_stale_jobs(request.image.image_id, request.snapshot_seq)
        async with self._vision_lock:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(
                self.vision_executor,
                lambda: self.orchestrator.analyze_sync(
                    request,
                    profile,
                    effective_mode="standard",
                    degraded_reason=degraded_reason,
                ),
            )

    async def submit_async_job(
        self,
        request: QCAnalyzeRequest,
        profile: RuleProfile,
        effective_mode: QCMode,
        degraded_reason: str | None = None,
    ) -> JobRecord:
        self._coalesce_stale_jobs(request.image.image_id, request.snapshot_seq)
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        job = JobRecord(
            job_id=job_id,
            image_id=request.image.image_id,
            snapshot_seq=request.snapshot_seq,
            mode=effective_mode,
            profile_id=profile.profile_id,
            request_id=request.request_id,
            status="queued",
        )
        self._jobs[job_id] = job
        self._prune_old_jobs()

        asyncio.create_task(
            self._execute_async_job(job, request, profile, effective_mode, degraded_reason)
        )
        return job

    async def _execute_async_job(
        self,
        job: JobRecord,
        request: QCAnalyzeRequest,
        profile: RuleProfile,
        effective_mode: QCMode,
        degraded_reason: str | None,
    ) -> None:
        def on_progress(stage: str, pct: float) -> None:
            self._emit_from_worker(
                WsEvent(
                    event_type="job_progress",
                    job_id=job.job_id,
                    stage=stage,
                    progress_pct=pct,
                )
            )

        async with self._vision_lock:
            if job.cancel_event.is_set() or (
                self._latest_seq_by_image.get(job.image_id, 0) > job.snapshot_seq
            ):
                job.cancel_event.set()
                job.status = "failed"
                job.error_message = "Superseded by newer snapshotSeq before execution"
                job.result = self._make_cancelled_response(job)
                return

            job.status = "running"
            await self.broadcast_event(
                WsEvent(
                    event_type="job_progress",
                    job_id=job.job_id,
                    stage="starting_vision",
                    progress_pct=10.0,
                )
            )

            loop = asyncio.get_running_loop()
            try:
                future = loop.run_in_executor(
                    self.vision_executor,
                    lambda: self.orchestrator.analyze_sync(
                        request,
                        profile,
                        effective_mode=effective_mode,
                        degraded_reason=degraded_reason,
                        cancel_event=job.cancel_event,
                        progress_cb=on_progress,
                        job_id=job.job_id,
                    ),
                )
                result = await asyncio.wait_for(
                    future, timeout=self.settings.deep_job_timeout_seconds
                )
                if job.cancel_event.is_set():
                    job.status = "failed"
                    job.error_message = "Job cancelled by newer snapshotSeq"
                    job.result = self._make_cancelled_response(job)
                    await self.broadcast_event(
                        WsEvent(
                            event_type="job_failed",
                            job_id=job.job_id,
                            error=job.error_message,
                        )
                    )
                    return

                job.status = "completed"
                job.result = result
                await self.broadcast_event(
                    WsEvent(
                        event_type="job_completed",
                        job_id=job.job_id,
                        progress_pct=100.0,
                        result=result,
                    )
                )
            except TimeoutError:
                job.cancel_event.set()
                job.status = "failed"
                job.error_message = f"Deep QC exceeded {self.settings.deep_job_timeout_seconds:.1f}s timeout"
                job.result = self._make_cancelled_response(job)
                await self.broadcast_event(
                    WsEvent(
                        event_type="job_failed",
                        job_id=job.job_id,
                        error=job.error_message,
                    )
                )
            except Exception as exc:
                job.status = "failed"
                job.error_message = str(exc)
                job.result = self._make_cancelled_response(job)
                await self.broadcast_event(
                    WsEvent(
                        event_type="job_failed",
                        job_id=job.job_id,
                        error=job.error_message,
                    )
                )

    def get_job_response(self, job_id: str) -> QCResponse | None:
        job = self._jobs.get(job_id)
        if job is None:
            return None
        if job.result is not None:
            return job.result
        return QCResponse(
            analysis_id=f"qc_{job.job_id}",
            request_id=job.request_id,
            job_id=job.job_id,
            status=job.status,  # type: ignore[arg-type]
            image_id=job.image_id,
            snapshot_seq=job.snapshot_seq,
            mode=job.mode,
            profile_id=job.profile_id,
            overall_score=100,
            readiness="ready",
            summary_counts=SummaryCounts(),
            findings=[],
            missed_objects=[],
            timing_ms={},
            engine_capabilities=EngineCapabilities(device="none", models_used=[]),
            error=None,
        )

    def _prune_old_jobs(self, max_keep: int = 100) -> None:
        if len(self._jobs) <= max_keep:
            return
        ordered = sorted(self._jobs.values(), key=lambda j: j.created_at)
        for old in ordered[: len(self._jobs) - max_keep]:
            if old.status in {"completed", "failed"}:
                self._jobs.pop(old.job_id, None)
