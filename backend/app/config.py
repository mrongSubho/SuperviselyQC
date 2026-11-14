from __future__ import annotations

import os
import secrets
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class EngineTunables(BaseSettings):
    """Internal geometric and CV thresholds not exposed directly on RuleProfile."""

    model_config = SettingsConfigDict(env_prefix="SLY_QC_TUNE_", extra="ignore")

    duplicate_iou_threshold: float = 0.90
    canvas_wide_area_ratio: float = 0.90
    micro_click_min_side_px: float = 15.0
    min_relative_area: float = 1e-5
    bbox_max_aspect_ratio: float = 16.0
    poly_collinear_tol_px: float = 0.75
    poly_acute_spike_deg: float = 10.0
    poly_micro_hole_px: float = 16.0
    bitmap_min_island_px: int = 25
    bitmap_max_pinhole_px: int = 500
    bitmap_max_roughness_ratio: float = 1.38
    line_acute_backtrack_deg: float = 25.0
    line_endpoint_gap_px: float = 35.0
    sam_loose_slack_px: float = 14.0
    sam_clipped_recall_min: float = 0.88


class EngineSettings(BaseSettings):
    """Runtime settings for the local Supervisely QC FastAPI server."""

    model_config = SettingsConfigDict(env_prefix="SLY_QC_", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8765
    version: str = "1.0.0"

    config_dir: Path = Field(default_factory=lambda: Path.home() / ".config" / "supervisely-qc")
    cache_dir: Path = Field(
        default_factory=lambda: Path.home() / ".cache" / "supervisely-qc" / "images"
    )
    models_dir: Path = Field(
        default_factory=lambda: Path.home() / ".cache" / "supervisely-qc" / "models"
    )
    builtin_profiles_dir: Path = Field(
        default_factory=lambda: Path(__file__).resolve().parent.parent / "profiles"
    )
    user_profiles_dir: Path | None = None
    bridge_token_path: Path | None = None
    bridge_token: str | None = None

    allowed_extension_ids: list[str] = Field(default_factory=list)
    allow_unpacked_extensions: bool = True

    max_disk_cache_bytes: int = 1_073_741_824  # 1 GiB
    disk_cache_ttl_seconds: int = 86_400  # 24 hours
    max_image_upload_bytes: int = 104_857_600  # 100 MiB
    max_ram_images: int = 2
    max_ram_cache_bytes: int = 157_286_400  # 150 MiB

    model_idle_ttl_seconds: int = 180
    deep_job_timeout_seconds: float = 15.0
    low_ram_standard_mb: int = 900
    low_ram_rules_mb: int = 450

    tunables: EngineTunables = Field(default_factory=EngineTunables)

    @property
    def resolved_user_profiles_dir(self) -> Path:
        return self.user_profiles_dir or (self.config_dir / "profiles")

    @property
    def resolved_bridge_token_path(self) -> Path:
        return self.bridge_token_path or (self.config_dir / "bridge_token")


def ensure_loopback_host(host: str) -> str:
    """Reject non-loopback bindings so local images/endpoints never expose on LAN."""
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"Refusing non-loopback bind host '{host}'; must be 127.0.0.1")
    return host


def ensure_bridge_token(settings: EngineSettings) -> str:
    """Load or securely generate a 256-bit hex bridge token with 0600 permissions."""
    if settings.bridge_token and settings.bridge_token.strip():
        return settings.bridge_token.strip()

    settings.config_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(settings.config_dir, 0o700)
    except OSError:
        pass

    token_path = settings.resolved_bridge_token_path
    token_path.parent.mkdir(parents=True, exist_ok=True)

    if token_path.exists():
        existing = token_path.read_text(encoding="utf-8").strip()
        if len(existing) >= 32:
            try:
                os.chmod(token_path, 0o600)
            except OSError:
                pass
            return existing

    token = secrets.token_hex(32)
    tmp_path = token_path.with_suffix(".tmp")
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
    os.replace(tmp_path, token_path)
    try:
        os.chmod(token_path, 0o600)
    except OSError:
        pass
    return token
