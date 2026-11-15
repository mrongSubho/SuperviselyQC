from __future__ import annotations

import gc
import hashlib
import hmac
import importlib.util
import platform
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import EngineSettings


@dataclass
class LoadedModelEntry:
    name: str
    model: Any
    heavy: bool
    last_used: float


class ModelManager:
    """Lazy model lifecycle manager for 8 GB Unified Memory Apple Silicon MPS / CPU."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.models_dir: Path = settings.models_dir
        self._lock = threading.RLock()
        self._models: dict[str, LoadedModelEntry] = {}
        self._torch_checked = False
        self._resolved_device: str | None = None

    def probe_device_lightweight(self) -> str:
        """Report 'mps' or 'cpu' without importing heavy torch into RSS unless already loaded."""
        if self._resolved_device is not None:
            return self._resolved_device
        if (
            sys.platform == "darwin"
            and platform.machine() == "arm64"
            and importlib.util.find_spec("torch") is not None
        ):
            return "mps"
        return "cpu"

    def resolve_device(self) -> str:
        """Actually import torch (when Layer 2 runs) and verify MPS availability."""
        with self._lock:
            if self._resolved_device is not None:
                return self._resolved_device
            try:
                import torch  # noqa: PLC0415

                if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    self._resolved_device = "mps"
                else:
                    self._resolved_device = "cpu"
            except Exception:
                self._resolved_device = "cpu"
            self._torch_checked = True
            return self._resolved_device

    def loaded_model_names(self) -> list[str]:
        with self._lock:
            return sorted(self._models.keys())

    def has_weight_file(self, filename: str) -> Path | None:
        candidate = self.models_dir / filename
        if not (candidate.exists() and candidate.is_file() and candidate.stat().st_size > 0):
            return None
        sha_path = candidate.with_suffix(candidate.suffix + ".sha256")
        if sha_path.exists() and sha_path.is_file():
            expected = sha_path.read_text(encoding="utf-8").strip().split()[0].lower()
            digest = hashlib.sha256()
            with candidate.open("rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    digest.update(chunk)
            if not hmac.compare_digest(digest.hexdigest().lower(), expected):
                return None
        return candidate

    def register_model(self, name: str, model: Any, heavy: bool = False) -> None:
        with self._lock:
            if heavy:
                # Enforce max_heavy_models = 1 slot on 8 GB Unified Memory
                for key in list(self._models.keys()):
                    if self._models[key].heavy and key != name:
                        self.unload_model(key)
            self._models[name] = LoadedModelEntry(
                name=name,
                model=model,
                heavy=heavy,
                last_used=time.monotonic(),
            )

    def get_model(self, name: str) -> Any | None:
        with self._lock:
            entry = self._models.get(name)
            if entry is None:
                return None
            entry.last_used = time.monotonic()
            return entry.model

    def unload_model(self, name: str) -> None:
        with self._lock:
            entry = self._models.pop(name, None)
        if entry is not None:
            del entry
            self.release_device_cache()

    def evict_idle(self) -> list[str]:
        """Evict models idle longer than model_idle_ttl_seconds."""
        now = time.monotonic()
        evicted: list[str] = []
        with self._lock:
            for key, entry in list(self._models.items()):
                if (now - entry.last_used) >= float(self.settings.model_idle_ttl_seconds):
                    self._models.pop(key, None)
                    evicted.append(key)
        if evicted:
            self.release_device_cache()
        return evicted

    def release_all(self) -> None:
        with self._lock:
            self._models.clear()
        self.release_device_cache(collect_gc=True)

    @staticmethod
    def release_device_cache(collect_gc: bool = False) -> None:
        if collect_gc:
            gc.collect()
        if "torch" in sys.modules:
            torch = sys.modules["torch"]
            try:
                if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
                    torch.mps.empty_cache()
            except Exception:
                pass
