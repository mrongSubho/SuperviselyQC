from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response, status

from app.schemas.qc import ProfileListResponse, RuleProfile
from app.security import error_response, verify_bridge_token
from app.services.profile_store import ProfileNotFoundError, ProfileStore, ProfileStoreError

router = APIRouter(
    prefix="/api/v1/profiles",
    tags=["profiles"],
    dependencies=[Depends(verify_bridge_token)],
)


@router.get("", response_model=ProfileListResponse, response_model_by_alias=True)
async def list_profiles(
    request: Request,
    project_id: str | None = Query(default=None, alias="projectId"),
    dataset_id: str | None = Query(default=None, alias="datasetId"),
    job_title: str | None = Query(default=None, alias="jobTitle"),
) -> ProfileListResponse:
    """List all built-in and custom rule profiles plus best auto-matched profile ID."""
    profile_store: ProfileStore = request.app.state.profile_store
    return profile_store.list_profiles(
        project_id=project_id,
        dataset_id=dataset_id,
        job_title=job_title,
    )


@router.get("/{profile_id}", response_model=RuleProfile, response_model_by_alias=True)
async def get_profile(profile_id: str, request: Request) -> RuleProfile | Response:
    profile_store: ProfileStore = request.app.state.profile_store
    try:
        return profile_store.get_profile(profile_id)
    except ProfileNotFoundError as exc:
        return error_response(status.HTTP_404_NOT_FOUND, "PROFILE_NOT_FOUND", str(exc))


@router.put("/{profile_id}", response_model=RuleProfile, response_model_by_alias=True)
async def upsert_profile(
    profile_id: str,
    profile: RuleProfile,
    request: Request,
) -> RuleProfile | Response:
    profile_store: ProfileStore = request.app.state.profile_store
    try:
        return profile_store.upsert_profile(profile_id, profile)
    except ProfileStoreError as exc:
        return error_response(exc.status_code, exc.code, exc.message)


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_profile(profile_id: str, request: Request) -> Response:
    profile_store: ProfileStore = request.app.state.profile_store
    try:
        profile_store.delete_profile(profile_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except ProfileNotFoundError as exc:
        return error_response(status.HTTP_404_NOT_FOUND, "PROFILE_NOT_FOUND", str(exc))
    except ProfileStoreError as exc:
        return error_response(exc.status_code, exc.code, exc.message)
