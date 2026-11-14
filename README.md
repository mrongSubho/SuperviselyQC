# SuperviselyQC

**Supervisely Hybrid QC Assistant** — a Chrome Extension (Manifest V3) paired with a local macOS Python FastAPI daemon (`127.0.0.1:8765`) for real-time geometry QA, local Apple Silicon (`MPS`/`CPU`) computer vision checks, and pre-annotation scene blueprints on Supervisely.

## Architecture

- [`extension/`](extension/): Chrome MV3 extension (React + TypeScript + Vite) injecting Shadow DOM controls (`#sly-qc-*`), read-only Supervisely store/network bridges, non-destructive Canvas/Blueprint overlays, and offline rule fallback.
- [`backend/`](backend/): Loopback-only FastAPI service (`127.0.0.1:8765`) with 256-bit `X-QC-Bridge-Token` authentication, disk/RAM image LRU cache, deterministic Layer 1 rule evaluators across all 5 Supervisely annotation primitives, and optional local CV checks (YOLO11s, Depth Anything V2 Small, YOLO-World, YOLO11s-pose, SAM 2.1).
- [`shared/`](shared/): Canonical TypeScript types and generated JSON Schema validated via `scripts/sync_contracts.py`.
- [`scripts/`](scripts/): Contract synchronization (`sync_contracts.py`), local CV weight downloader (`download_models.py`), and macOS LaunchAgent installer (`install_launchagent.sh`).
- [`tests/`](tests/): Contract parity tests, FastAPI/rule unit tests, Vitest extension unit tests, and Playwright E2E suite.

See [`docs/architecture.md`](docs/architecture.md) for system details.

## Quick Start

### 1. Bootstrap Python & Node dependencies

```bash
make bootstrap
```

To enable local PyTorch/Ultralytics CV models (`MPS`/`CPU`):

```bash
uv pip install --python backend/.venv/bin/python -e "backend[vision]"
backend/.venv/bin/python scripts/download_models.py --tier deep
```

### 2. Build the Chrome Extension

```bash
make build-extension
```

Load the unpacked extension in `chrome://extensions` from `extension/dist/`.

### 3. Run the Local Backend

```bash
make start-backend
```

Or install as a macOS LaunchAgent:

```bash
./scripts/install_launchagent.sh
```

On startup, the backend writes a local bridge token to `~/.config/supervisely-qc/bridge_token` for pairing in the extension **Options** page.

## Verification

```bash
make sync-contracts
make lint
make test
make test-e2e
```
