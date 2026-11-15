# Changelog

All notable changes to SuperviselyQC are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) running `make lint`, `make test`, and macOS `make test-e2e`.
- Reproducible Python dependency lockfile (`backend/uv.lock`) with `uv sync --frozen`.
- Cross-engine rule-logic parity test suite (`tests/contract/test_rule_logic_parity.py` and `tests/extension/unit/ruleParity.test.ts`) and shared `shared/schemas/rule-tunables.json` spec.
- Structured JSON logging with `X-Request-Id` correlation (`backend/app/logging_config.py`).
- Authenticated `GET /api/v1/metrics` endpoint (`backend/app/services/metrics.py`).
- `.sha256` sidecar weight verification in `ModelManager` and `scripts/download_models.py`.
- Query-free first-message WebSocket authentication in `/api/v1/qc/ws/{client_id}`.
- Per-profile `detectorAliases` on `RuleProfile`.
- Auto-draw confirmation modal (`AutoDrawConfirmModal.tsx`) with dry-run preview, real-annotation warning, and `Cmd/Ctrl+Z` undo hint.
- First-run onboarding checklist and guided profile-authoring form in Extension Options.
- `.env.example` documenting all `SLY_QC_*` and `SLY_QC_TUNE_*` variables.

### Changed
- Replaced 50 ms busy-wait polling in `routes_qc.py` with `asyncio.Event` (`JobManager.wait_for_job`) and added graceful async shutdown (`JobManager.ashutdown`).
- Removed `"Car"` fallback from `"truck"` in `backend/app/vision/detector.py`.
- Aligned `offlineQcEngine.ts` rule IDs/severities (`WORKFLOW_EMPTY_UNCONFIRMED`, `GEOM_EXTREME_MICRO_CLICK`, `GEOM_DUPLICATE_FIGURE`) with Python.
- Modularized `slyStoreAdapter.ts` into `extension/src/page/adapter/*` and `content/index.ts` with `simulationMatch.ts` and `rendering.ts`.
- Replaced O(n) disk cache glob on `PUT` with an in-memory LRU index and debounced `head()` metadata writes.
- Defaulted `allow_unpacked_extensions` to `False` (enabled explicitly in `Makefile` `start-backend` for local dev).
- Updated `scripts/install_launchagent.sh` to use `KeepAlive=true` with `ThrottleInterval=10`.

## [1.0.0] - 2026-11-13

### Added
- Initial release of Supervisely Hybrid QC Assistant (Chrome MV3 extension + local macOS FastAPI daemon).
