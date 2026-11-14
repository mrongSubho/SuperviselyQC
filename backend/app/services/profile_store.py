from __future__ import annotations

import os
import re
import threading
from pathlib import Path

import yaml

from app.config import EngineSettings
from app.schemas.qc import ProfileListResponse, RuleProfile

_SAFE_PROFILE_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


class ProfileNotFoundError(Exception):
    def __init__(self, profile_id: str) -> None:
        super().__init__(f"Profile '{profile_id}' not found")
        self.profile_id = profile_id


class ProfileStoreError(Exception):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class ProfileStore:
    """Manages built-in and user-editable YAML/JSON QC RuleProfiles."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.builtin_dir = settings.builtin_profiles_dir
        self.user_dir = settings.resolved_user_profiles_dir
        self.user_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._builtin_profiles: dict[str, RuleProfile] = {}
        self._user_profiles: dict[str, RuleProfile] = {}
        self.reload()

    def reload(self) -> None:
        with self._lock:
            self._builtin_profiles = self._load_dir(self.builtin_dir, force_builtin=True)
            self._user_profiles = self._load_dir(self.user_dir, force_builtin=False)

    @staticmethod
    def _load_dir(directory: Path, force_builtin: bool) -> dict[str, RuleProfile]:
        loaded: dict[str, RuleProfile] = {}
        if not directory.exists():
            return loaded
        for path in sorted(list(directory.glob("*.yaml")) + list(directory.glob("*.yml")) + list(directory.glob("*.json"))):
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
            if not raw:
                continue
            profile = RuleProfile.model_validate(raw)
            if force_builtin:
                profile = profile.model_copy(update={"is_builtin": True})
            loaded[profile.profile_id] = profile
        return loaded

    def _all_profiles_locked(self) -> dict[str, RuleProfile]:
        merged = dict(self._builtin_profiles)
        merged.update(self._user_profiles)
        return merged

    def match_profile_id(
        self,
        project_id: int | str | None = None,
        dataset_id: int | str | None = None,
        job_title: str | None = None,
    ) -> str:
        with self._lock:
            profiles = list(self._all_profiles_locked().values())

        # Priority 1: datasetIds
        if dataset_id is not None:
            ds_str = str(dataset_id)
            for p in profiles:
                if ds_str in {str(x) for x in p.matchers.dataset_ids}:
                    return p.profile_id

        # Priority 2: projectIds
        if project_id is not None:
            proj_str = str(project_id)
            for p in profiles:
                if proj_str in {str(x) for x in p.matchers.project_ids}:
                    return p.profile_id

        # Priority 3: jobTitleRegex (case-insensitive portable matching)
        if job_title:
            for p in profiles:
                pattern = p.matchers.job_title_regex
                if not pattern:
                    continue
                try:
                    if re.search(pattern, job_title, re.IGNORECASE):
                        return p.profile_id
                except re.error:
                    continue

        return "default" if "default" in {p.profile_id for p in profiles} else (profiles[0].profile_id if profiles else "default")

    def list_profiles(
        self,
        project_id: int | str | None = None,
        dataset_id: int | str | None = None,
        job_title: str | None = None,
    ) -> ProfileListResponse:
        with self._lock:
            all_profiles = sorted(
                self._all_profiles_locked().values(),
                key=lambda p: (0 if p.profile_id == "default" else 1, p.profile_id),
            )
        matched_id = self.match_profile_id(
            project_id=project_id, dataset_id=dataset_id, job_title=job_title
        )
        return ProfileListResponse(profiles=all_profiles, matched_profile_id=matched_id)

    def get_profile(self, profile_id: str) -> RuleProfile:
        with self._lock:
            merged = self._all_profiles_locked()
            if profile_id not in merged:
                raise ProfileNotFoundError(profile_id)
            return merged[profile_id]

    def resolve_for_request(
        self,
        explicit_profile_id: str | None,
        project_id: int | str | None,
        dataset_id: int | str | None,
        job_title: str | None,
    ) -> RuleProfile:
        if explicit_profile_id:
            return self.get_profile(explicit_profile_id)
        matched_id = self.match_profile_id(
            project_id=project_id, dataset_id=dataset_id, job_title=job_title
        )
        return self.get_profile(matched_id)

    def upsert_profile(self, profile_id: str, profile: RuleProfile) -> RuleProfile:
        if not _SAFE_PROFILE_RE.match(profile_id):
            raise ProfileStoreError("INVALID_PAYLOAD", "Invalid profileId format", 422)
        if profile.profile_id != profile_id:
            raise ProfileStoreError(
                "INVALID_PAYLOAD",
                f"Body profileId '{profile.profile_id}' must match path '{profile_id}'",
                422,
            )
        if profile.matchers.job_title_regex:
            try:
                re.compile(profile.matchers.job_title_regex)
            except re.error as exc:
                raise ProfileStoreError(
                    "INVALID_PAYLOAD", f"Invalid jobTitleRegex: {exc}", 422
                ) from exc

        with self._lock:
            is_builtin_id = profile_id in self._builtin_profiles
            stored = profile.model_copy(update={"is_builtin": is_builtin_id})
            target = self.user_dir / f"{profile_id}.yaml"
            tmp = target.with_suffix(".yaml.tmp")
            tmp.write_text(
                yaml.safe_dump(stored.model_dump(by_alias=True), sort_keys=False),
                encoding="utf-8",
            )
            os.replace(tmp, target)
            self._user_profiles[profile_id] = stored
            return stored

    def delete_profile(self, profile_id: str) -> None:
        with self._lock:
            if profile_id in self._builtin_profiles:
                raise ProfileStoreError(
                    "INVALID_PAYLOAD",
                    f"Cannot delete built-in profile '{profile_id}'",
                    400,
                )
            if profile_id not in self._user_profiles:
                raise ProfileNotFoundError(profile_id)
            self._user_profiles.pop(profile_id, None)
            for suffix in (".yaml", ".yml", ".json"):
                (self.user_dir / f"{profile_id}{suffix}").unlink(missing_ok=True)
