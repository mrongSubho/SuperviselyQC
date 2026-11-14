from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.config import EngineSettings
from app.schemas.qc import CacheStats, ImageCacheAck

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_.-]")


class ImageCacheError(Exception):
    """Base error for image cache operations."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class _RamCacheEntry:
    key: str
    rgb: np.ndarray
    size_bytes: int


class ImageCacheService:
    """Two-tier LRU cache: Tier 1 encrypted-safe atomic disk store + Tier 2 decoded RGB RAM LRU."""

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.cache_dir = settings.cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.cache_dir, 0o700)
        except OSError:
            pass
        self._lock = threading.RLock()
        self._ram: OrderedDict[str, _RamCacheEntry] = OrderedDict()
        self._ram_bytes = 0

    @staticmethod
    def _cache_key(image_id: str, image_hash: str) -> str:
        safe_id = _SAFE_ID_RE.sub("_", image_id)[:80] or "img"
        digest = hashlib.sha256(image_hash.encode("utf-8")).hexdigest()[:16]
        return f"{safe_id}__{digest}"

    def _bin_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.bin"

    def _meta_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.meta.json"

    def _is_expired(self, meta: dict[str, Any], now: float) -> bool:
        stored_at = float(meta.get("storedAt", 0.0))
        return (now - stored_at) > self.settings.disk_cache_ttl_seconds

    def _read_meta(self, meta_path: Path) -> dict[str, Any] | None:
        if not meta_path.exists():
            return None
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            return None
        return None

    def _write_meta(self, meta_path: Path, meta: dict[str, Any]) -> None:
        tmp = meta_path.with_suffix(".meta.tmp")
        tmp.write_text(json.dumps(meta), encoding="utf-8")
        os.replace(tmp, meta_path)

    def _delete_disk_entry(self, key: str) -> None:
        self._bin_path(key).unlink(missing_ok=True)
        self._meta_path(key).unlink(missing_ok=True)
        self._evict_ram_key(key)

    def _evict_ram_key(self, key: str) -> None:
        entry = self._ram.pop(key, None)
        if entry is not None:
            self._ram_bytes -= entry.size_bytes

    def _evict_disk_if_needed(self) -> None:
        now = time.time()
        entries: list[tuple[str, float, int]] = []
        total_bytes = 0

        for meta_path in self.cache_dir.glob("*.meta.json"):
            key = meta_path.name[: -len(".meta.json")]
            bin_path = self._bin_path(key)
            meta = self._read_meta(meta_path)
            if meta is None or not bin_path.exists() or self._is_expired(meta, now):
                self._delete_disk_entry(key)
                continue
            size = bin_path.stat().st_size
            last_access = float(meta.get("lastAccessAt", meta.get("storedAt", 0.0)))
            entries.append((key, last_access, size))
            total_bytes += size

        if total_bytes <= self.settings.max_disk_cache_bytes:
            return

        entries.sort(key=lambda item: item[1])
        for key, _, size in entries:
            if total_bytes <= self.settings.max_disk_cache_bytes:
                break
            self._delete_disk_entry(key)
            total_bytes -= size

    def head(
        self,
        image_id: str,
        image_hash: str,
        width: int | None = None,
        height: int | None = None,
    ) -> bool:
        key = self._cache_key(image_id, image_hash)
        with self._lock:
            meta_path = self._meta_path(key)
            bin_path = self._bin_path(key)
            meta = self._read_meta(meta_path)
            if meta is None or not bin_path.exists():
                return False
            now = time.time()
            if self._is_expired(meta, now):
                self._delete_disk_entry(key)
                return False
            if meta.get("imageHash") != image_hash:
                return False
            if width is not None and int(meta.get("width", -1)) != width:
                return False
            if height is not None and int(meta.get("height", -1)) != height:
                return False
            meta["lastAccessAt"] = now
            self._write_meta(meta_path, meta)
            return True

    @staticmethod
    def _decode_bytes_to_rgb(raw_bytes: bytes) -> np.ndarray:
        arr = np.frombuffer(raw_bytes, dtype=np.uint8)
        decoded = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if decoded is None or decoded.size == 0:
            raise ImageCacheError("INVALID_PAYLOAD", "Uploaded bytes could not be decoded as an image", 400)
        return cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)

    def put(
        self,
        image_id: str,
        image_hash: str,
        raw_bytes: bytes,
        expected_width: int | None = None,
        expected_height: int | None = None,
        content_type: str | None = None,
    ) -> ImageCacheAck:
        if not raw_bytes:
            raise ImageCacheError("INVALID_PAYLOAD", "Empty image payload", 400)
        if len(raw_bytes) > self.settings.max_image_upload_bytes:
            raise ImageCacheError(
                "INVALID_PAYLOAD",
                f"Image payload exceeds {self.settings.max_image_upload_bytes} byte limit",
                413,
            )

        rgb = self._decode_bytes_to_rgb(raw_bytes)
        actual_h, actual_w = rgb.shape[:2]
        if expected_width is not None and actual_w != expected_width:
            raise ImageCacheError(
                "INVALID_PAYLOAD",
                f"Image width mismatch: expected {expected_width}, decoded {actual_w}",
                400,
            )
        if expected_height is not None and actual_h != expected_height:
            raise ImageCacheError(
                "INVALID_PAYLOAD",
                f"Image height mismatch: expected {expected_height}, decoded {actual_h}",
                400,
            )

        key = self._cache_key(image_id, image_hash)
        now = time.time()
        meta = {
            "imageId": image_id,
            "imageHash": image_hash,
            "width": int(actual_w),
            "height": int(actual_h),
            "contentType": content_type or "application/octet-stream",
            "bytesStored": len(raw_bytes),
            "storedAt": now,
            "lastAccessAt": now,
        }

        with self._lock:
            bin_path = self._bin_path(key)
            tmp_bin = bin_path.with_suffix(".bin.tmp")
            tmp_bin.write_bytes(raw_bytes)
            os.replace(tmp_bin, bin_path)
            self._write_meta(self._meta_path(key), meta)
            self._store_ram_locked(key, rgb)
            self._evict_disk_if_needed()

        return ImageCacheAck(
            image_id=image_id,
            image_hash=image_hash,
            width=int(actual_w),
            height=int(actual_h),
            bytes_stored=len(raw_bytes),
            cached=True,
        )

    def _store_ram_locked(self, key: str, rgb: np.ndarray) -> None:
        self._evict_ram_key(key)
        item_bytes = int(rgb.nbytes)
        if item_bytes > self.settings.max_ram_cache_bytes:
            return
        while (
            len(self._ram) >= self.settings.max_ram_images
            or (self._ram_bytes + item_bytes) > self.settings.max_ram_cache_bytes
        ) and self._ram:
            _, evicted = self._ram.popitem(last=False)
            self._ram_bytes -= evicted.size_bytes
        self._ram[key] = _RamCacheEntry(key=key, rgb=rgb, size_bytes=item_bytes)
        self._ram_bytes += item_bytes

    def get_decoded_rgb(self, image_id: str, image_hash: str) -> np.ndarray | None:
        key = self._cache_key(image_id, image_hash)
        with self._lock:
            meta_path = self._meta_path(key)
            bin_path = self._bin_path(key)
            meta = self._read_meta(meta_path)
            if meta is None or not bin_path.exists():
                self._evict_ram_key(key)
                return None
            now = time.time()
            if self._is_expired(meta, now):
                self._delete_disk_entry(key)
                return None
            meta["lastAccessAt"] = now
            self._write_meta(meta_path, meta)

            ram_entry = self._ram.get(key)
            if ram_entry is not None:
                self._ram.move_to_end(key)
                return ram_entry.rgb

            raw_bytes = bin_path.read_bytes()

        rgb = self._decode_bytes_to_rgb(raw_bytes)
        with self._lock:
            self._store_ram_locked(key, rgb)
        return rgb

    def ram_entry_count(self) -> int:
        with self._lock:
            return len(self._ram)

    def cache_stats(self) -> CacheStats:
        now = time.time()
        image_count = 0
        disk_bytes = 0
        with self._lock:
            for meta_path in self.cache_dir.glob("*.meta.json"):
                key = meta_path.name[: -len(".meta.json")]
                bin_path = self._bin_path(key)
                meta = self._read_meta(meta_path)
                if meta is None or not bin_path.exists() or self._is_expired(meta, now):
                    self._delete_disk_entry(key)
                    continue
                image_count += 1
                disk_bytes += bin_path.stat().st_size

        return CacheStats(
            image_count=image_count,
            disk_bytes=disk_bytes,
            max_disk_bytes=self.settings.max_disk_cache_bytes,
        )
