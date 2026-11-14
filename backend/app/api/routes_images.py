from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query, Request, Response, status

from app.config import EngineSettings
from app.schemas.qc import ImageCacheAck
from app.security import error_response, verify_bridge_token
from app.services.image_cache import ImageCacheError, ImageCacheService

router = APIRouter(
    prefix="/api/v1/qc/images",
    tags=["images"],
    dependencies=[Depends(verify_bridge_token)],
)


@router.head("/{image_id}")
async def head_cached_image(
    image_id: str,
    request: Request,
    image_hash: str = Query(..., alias="hash"),
    width: int | None = Query(default=None),
    height: int | None = Query(default=None),
) -> Response:
    """Check whether (imageId, imageHash) already exists in local cache."""
    image_cache = request.app.state.image_cache
    if image_cache.head(image_id, image_hash, width=width, height=height):
        return Response(status_code=status.HTTP_200_OK, headers={"X-Cache-Hit": "true"})
    return Response(status_code=status.HTTP_404_NOT_FOUND)


@router.put(
    "/{image_id}",
    status_code=status.HTTP_201_CREATED,
    response_model=ImageCacheAck,
    response_model_by_alias=True,
)
async def put_cached_image(
    image_id: str,
    request: Request,
    x_image_hash: str | None = Header(default=None, alias="X-Image-Hash"),
    x_image_width: int | None = Header(default=None, alias="X-Image-Width"),
    x_image_height: int | None = Header(default=None, alias="X-Image-Height"),
) -> ImageCacheAck | Response:
    """Upload full-resolution image bytes once into the local LRU cache."""
    settings: EngineSettings = request.app.state.settings
    image_cache: ImageCacheService = request.app.state.image_cache

    content_length_raw = request.headers.get("content-length")
    if content_length_raw:
        try:
            if int(content_length_raw) > settings.max_image_upload_bytes:
                return error_response(
                    status.HTTP_413_CONTENT_TOO_LARGE,
                    "INVALID_PAYLOAD",
                    f"Image payload exceeds {settings.max_image_upload_bytes} byte limit",
                )
        except ValueError:
            pass

    content_type = (request.headers.get("content-type") or "").lower()
    image_hash = x_image_hash
    raw_bytes: bytes

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            return error_response(
                status.HTTP_400_BAD_REQUEST,
                "INVALID_PAYLOAD",
                "Multipart upload requires a 'file' field",
            )
        if not image_hash:
            form_hash = form.get("imageHash") or form.get("hash")
            image_hash = str(form_hash) if form_hash else None
        raw_bytes = await upload.read()
        content_type = getattr(upload, "content_type", None) or content_type
    else:
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > settings.max_image_upload_bytes:
                return error_response(
                    status.HTTP_413_CONTENT_TOO_LARGE,
                    "INVALID_PAYLOAD",
                    f"Image payload exceeds {settings.max_image_upload_bytes} byte limit",
                )
            chunks.append(chunk)
        raw_bytes = b"".join(chunks)

    if not image_hash:
        return error_response(
            status.HTTP_400_BAD_REQUEST,
            "INVALID_PAYLOAD",
            "X-Image-Hash header is required",
        )

    try:
        return image_cache.put(
            image_id=image_id,
            image_hash=image_hash,
            raw_bytes=raw_bytes,
            expected_width=x_image_width,
            expected_height=x_image_height,
            content_type=content_type,
        )
    except ImageCacheError as exc:
        return error_response(exc.status_code, exc.code, exc.message)
