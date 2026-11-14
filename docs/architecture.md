# Supervisely Hybrid QC Assistant Architecture

## Overview

Supervisely Hybrid QC Assistant implements **Approach C (Hybrid)**: a Chrome Extension (Manifest V3) paired with a local macOS Python FastAPI daemon listening strictly on `http://127.0.0.1:8765`. No Supervisely credentials leave the browser and no remote LLM/CV telemetry calls are ever made.

```text
Supervisely Tab (MAIN world)        Content Script + Shadow DOM (ISOLATED)       MV3 Service Worker             Local FastAPI Daemon (127.0.0.1:8765)
───────────────────────────         ──────────────────────────────────────       ──────────────────             ─────────────────────────────────────
interceptor.ts / slyStoreAdapter    content/index.ts + ui/*                      serviceWorker.ts               backend/main.py -> app/main.py
  - fetch / XHR read-only clone       - Shadow DOM hosts (#sly-qc-*)               - REST & WS proxy              - BridgeAuthMiddleware (X-QC-Bridge-Token)
  - 50-entry __slyQcReplayBuffer      - domObserver.ts (Minimap / Sync / Confirm)  - 1 MiB chunk reassembly       - ImageCacheService (1 GB disk / 2-img RAM)
  - React fiber / Redux store read    - ConfirmGuard capture listener              - chrome.storage.session       - Layer 1 RuleEngine (5 primitives)
  - SLY_QC_HELLO handshake  ───────►  - offlineQcEngine.ts fallback   ───────────► - credentials:"include" same-   - Layer 2 VisionPipeline (MPS/CPU + JobManager)
                                                                                     origin image fetch
```

## Components

### 1. Canonical Cross-Language Contract
- TypeScript: `shared/types/qc-contract.ts`
- Python Pydantic v2: `backend/app/schemas/qc.py` (`CamelModel` with `extra="forbid"`)
- Parity check & schema generator: `scripts/sync_contracts.py` -> `shared/schemas/qc-contract.schema.json`
- Tested by `tests/contract/test_contract_parity.py`.

All 5 Supervisely annotation primitives share a discriminated union (`FigureGeometry`):
- `rectangle` (`points.exterior: [p1, p2]`)
- `polygon` (`points.exterior` + `points.interior` hole rings)
- `bitmap` (`bitmap.data`: base64 zlib-compressed PNG + `bitmap.origin`)
- `polyline` (`points.exterior`)
- `point` & `graph` (`points.exterior` / `nodes` map validated against `ClassDefinition.geometryConfig`)

### 2. Local FastAPI Backend (`backend/`)
- **Entrypoint:** `backend/main.py` (`uvicorn` on `127.0.0.1:8765`, `PYTORCH_ENABLE_MPS_FALLBACK=1`).
- **Loopback Security (`backend/app/middleware/auth.py`):**
  - Refuses non-loopback bind hosts (`ensure_loopback_host`).
  - Generates a 256-bit `X-QC-Bridge-Token` at `~/.config/supervisely-qc/bridge_token` (`0600`).
  - Enforces constant-time token comparison (`hmac.compare_digest`), origin validation (`chrome-extension://`, localhost, optional `.supervisely.com` origin), and Chrome Private Network Access headers.
  - `GET /api/v1/health` remains a lightweight unauthenticated status probe (lazy-loading vision dependencies so idle RSS stays `< 120 MB`).
- **2-Tier Image Cache (`backend/app/services/image_cache.py`):**
  - `HEAD /api/v1/qc/images/{imageId}?hash=...` and `PUT /api/v1/qc/images/{imageId}`.
  - Enforces `<= 100 MB` upload size, image magic-byte + Pillow decode validation, `1 GB` / `24h` disk LRU (`~/.cache/supervisely-qc/images/`), and `<= 2` decoded RGB arrays in RAM.
- **Deterministic Layer 1 Rules (`backend/app/rules/`):**
  - `global_rules.py`, `bbox_rules.py`, `polygon_rules.py`, `bitmap_rules.py`, `polyline_rules.py`, `keypoint_rules.py`.
  - Executes `< 50 ms` typical (`< 300 ms` SLA for 150+ mixed figures).
- **Local Apple Silicon Vision Pipeline (`backend/app/vision/`):**
  - `model_manager.py`: auto-selects `mps` -> `cpu`, supports `scripts/download_models.py`, enforces `180s` idle unload and `psutil` free-memory auto-downgrade (`< 900 MB` -> `standard`, `< 450 MB` -> `rules`).
  - `tiling.py`: full-frame + `2×2` 20%-overlap tiling with torchvision CPU NMS for `W >= 2400` imagery.
  - `blur_bokeh.py`: native-resolution Laplacian/Tenengrad sharpness bokeh gate to suppress background false positives.
  - `occlusion_depth.py`: Depth Anything V2 Small depth ordering override for foreground vs occluded overlaps.
  - `tightness_auditor.py`: SAM 2.1 Hiera-Tiny (`deep` mode) clipping & looseness audit (`+8%` prompt expansion).
  - `pose_auditor.py`: YOLO11s-pose (`deep` mode) bilateral ankle/wrist L/R sanity check and keypoint drift detection.
  - `job_manager.py`: single-slot vision serialization (`max_heavy_models=1`), latest-`snapshotSeq` coalescing, WebSocket progress/completion notifications.

### 3. Chrome Extension MV3 (`extension/`)
- **Default Execution Policy:** `defaultMode: "standard"`, `autoRunOnImageSwitch: false`, `autoRunAfterSync: false`, `confirmGuardStrictness: "blockers_and_dirty_sync"`, `overlayVisible: true`.
- **World Isolation & State Recovery:**
  - `extension/src/page/interceptor.ts` (`MAIN`, `document_start`) maintains `__slyQcReplayBuffer` (capped at 50 entries), responds to `SLY_QC_HELLO` with a per-page nonce, and delegates snapshot building to `slyStoreAdapter.ts`.
  - `extension/src/content/index.ts` (`ISOLATED`) gracefully degrades `store` -> `network_interceptor` -> `dom_fallback` (`figures: []`, `partialGeometry: true`).
- **CDN & Loopback Transfer:**
  - Same-origin Supervisely images fetch directly inside `serviceWorker.ts` (`credentials: "include"`).
  - Cross-origin S3/GCS/CloudFront presigned URLs fetch inside the content script with `credentials: "omit"` and stream in `1 MiB` base64 chunks over `chrome.runtime.Port`.
- **Shadow DOM UI & Keyboard Isolation (`extension/src/content/ui/`):**
  - Hosts: `#sly-qc-topbar-host`, `#sly-qc-drawer-host`, `#sly-qc-overlay-host`, `#sly-qc-modal-host`.
  - Physical `KeyboardEvent.code` shortcuts avoid Supervisely single-letter hotkeys:
    - `Option + Q`: Run QC
    - `Option + D`: Toggle QC Drawer
    - `Option + O`: Toggle Canvas Overlays
    - `Option + [` / `Option + ]`: Previous / Next finding
    - `Escape`: Dismiss Confirm Guard modal or close Drawer

## Verification Commands
```bash
make sync-contracts     # Verify Pydantic <-> TypeScript JSON schema parity
make lint               # ruff, mypy, tsc --noEmit
make test               # Contract + Backend pytest + Extension Vitest suite
make build-extension    # Build extension/dist MV3 bundle
make test-e2e           # Run Mock-Supervisely Playwright E2E suite
./scripts/install_launchagent.sh --dry-run
```
