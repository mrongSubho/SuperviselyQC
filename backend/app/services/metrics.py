from __future__ import annotations

import threading
from collections import defaultdict, deque


class MetricsTracker:
    """Thread-safe in-memory request/latency/error counters for local observability."""

    def __init__(self, max_samples: int = 200) -> None:
        self._lock = threading.Lock()
        self._max_samples = max_samples
        self._requests_total: dict[str, int] = defaultdict(int)
        self._errors_total: dict[str, int] = defaultdict(int)
        self._latencies_ms: dict[str, deque[float]] = defaultdict(
            lambda: deque(maxlen=self._max_samples)
        )

    def record_http(self, method: str, path: str, status_code: int, duration_ms: float) -> None:
        key = f"{method} {path}"
        with self._lock:
            self._requests_total[key] += 1
            if status_code >= 400:
                self._errors_total[key] += 1
            self._latencies_ms[key].append(duration_ms)

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            routes: dict[str, dict[str, float | int]] = {}
            for key, count in self._requests_total.items():
                samples = sorted(self._latencies_ms[key])
                p50 = samples[len(samples) // 2] if samples else 0.0
                p95_idx = min(len(samples) - 1, int(len(samples) * 0.95)) if samples else 0
                p95 = samples[p95_idx] if samples else 0.0
                routes[key] = {
                    "count": count,
                    "errors": self._errors_total.get(key, 0),
                    "p50Ms": round(p50, 2),
                    "p95Ms": round(p95, 2),
                }
            return {
                "totalRequests": sum(self._requests_total.values()),
                "totalErrors": sum(self._errors_total.values()),
                "routes": routes,
            }
