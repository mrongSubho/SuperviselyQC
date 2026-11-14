from __future__ import annotations

import hmac
import re
from collections.abc import Awaitable, Callable

from fastapi import Header, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import EngineSettings
from app.schemas.qc import ApiErrorDetail, ApiErrorEnvelope

_EXT_ORIGIN_RE = re.compile(r"^chrome-extension://[a-p]{32}$")


def is_allowed_extension_origin(origin: str | None, settings: EngineSettings) -> bool:
    """Allow strictly configured chrome-extension:// IDs (or valid unpacked IDs in dev)."""
    if not origin:
        return False
    if settings.allowed_extension_ids:
        allowed = {f"chrome-extension://{ext_id}" for ext_id in settings.allowed_extension_ids}
        return origin in allowed
    if settings.allow_unpacked_extensions:
        return bool(_EXT_ORIGIN_RE.match(origin))
    return False


def error_response(
    status_code: int,
    code: str,
    message: str,
    details: dict | None = None,
) -> JSONResponse:
    envelope = ApiErrorEnvelope(
        error=ApiErrorDetail(code=code, message=message, details=details)  # type: ignore[arg-type]
    )
    return JSONResponse(status_code=status_code, content=envelope.model_dump(by_alias=True))


class LoopbackCorsAndPnaMiddleware(BaseHTTPMiddleware):
    """Strict chrome-extension CORS + Private Network Access preflight middleware."""

    def __init__(self, app, settings: EngineSettings) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self.settings = settings

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        origin = request.headers.get("origin")
        origin_allowed = is_allowed_extension_origin(origin, self.settings)

        if request.method == "OPTIONS":
            if origin and not origin_allowed:
                return Response(status_code=status.HTTP_403_FORBIDDEN)
            preflight = Response(status_code=status.HTTP_204_NO_CONTENT)
            self._apply_cors_headers(preflight, origin, origin_allowed)
            if request.headers.get("access-control-request-private-network") == "true":
                preflight.headers["Access-Control-Allow-Private-Network"] = "true"
            return preflight

        if origin and not origin_allowed:
            return error_response(
                status.HTTP_403_FORBIDDEN,
                "UNAUTHORIZED",
                "Origin not permitted to access Supervisely QC local bridge",
            )

        response = await call_next(request)
        self._apply_cors_headers(response, origin, origin_allowed)
        if request.headers.get("access-control-request-private-network") == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    @staticmethod
    def _apply_cors_headers(
        response: Response, origin: str | None, origin_allowed: bool
    ) -> None:
        if origin and origin_allowed:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "GET, HEAD, PUT, POST, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = (
                "Content-Type, X-QC-Bridge-Token, X-Image-Hash, X-Image-Width, X-Image-Height"
            )
            response.headers["Access-Control-Expose-Headers"] = "X-Cache-Hit"
            response.headers["Access-Control-Allow-Private-Network"] = "true"


def verify_bridge_token(
    request: Request,
    x_qc_bridge_token: str | None = Header(default=None, alias="X-QC-Bridge-Token"),
) -> str:
    """Verify constant-time X-QC-Bridge-Token header on protected HTTP routes."""
    expected: str = request.app.state.bridge_token
    if not x_qc_bridge_token or not hmac.compare_digest(x_qc_bridge_token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid X-QC-Bridge-Token",
        )
    return x_qc_bridge_token


def verify_ws_bridge_token(
    expected_token: str,
    token: str | None = Query(default=None),
) -> bool:
    """Constant-time verification for WebSocket ?token= parameter."""
    if not token:
        return False
    return hmac.compare_digest(token, expected_token)
