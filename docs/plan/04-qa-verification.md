# 04 — QA Verification, Edge-Case Checklist, Test Plan & Risk Register

**Document Role:** Adversarial QA Audit, Cross-Spec Verification & Master Test Plan (RUG Validated)  
**Target System:** Supervisely Hybrid QC Assistant — Approach C (Chrome Extension MV3 + Local Python FastAPI on macOS)  
**Audited Specifications:**
- [01-architecture.md](./01-architecture.md)
- [02-qc-engine.md](./02-qc-engine.md)
- [03-ui-ux-design.md](./03-ui-ux-design.md)

---

## FINAL VERDICT: PASS

All Cross-Spec Contract, Specification Compliance (Approach C), Technical Realism (Chrome MV3, Supervisely Web UI, CV/MPS on 8 GB macOS), and Functional Completeness audits passed after **2 RUG Verification Rounds**. All Critical, Major, and Minor defects identified in Round 1 were resolved by `@architect`, `@qc-designer`, and `@ui-designer` and independently verified in Round 2.

---

## 1. RUG Verification Audit Log (Round 1 -> Round 2)

| Round | Target File | Severity | Defect Identified | Resolution Verified in Round 2 |
|---|---|---|---|---|
| R1 | `01-architecture.md` | **CRITICAL** | `MAIN` (`document_start`) vs `ISOLATED` (`document_idle`) race dropped early Supervisely ontology/job/annotation `fetch` payloads. | Added `__slyQcReplayBuffer` + `SLY_QC_BRIDGE_READY` handshake replay in `§2.1` & `§2.3.3`. **PASS** |
| R1 | `01-architecture.md` | **CRITICAL** | `CS -> SW` raw `ArrayBuffer` transfer breaks under `chrome.runtime` JSON serialization; `credentials: "include"` fails CORS on external S3/CDN `ACAO: *`. | Same-site URLs fetch in SW (`credentials: "include"`); external presigned URLs use `credentials: "omit"` + 1 MiB base64 chunks over `chrome.runtime.Port` (`§1.2`, `§2.4`). **PASS** |
| R1 | `01-architecture.md` | **MAJOR** | `dom_fallback` allowed coordinate-less `figures`, triggering `422` in `AnnotationFigure._validate_geometry_union`. | Enforced `figures: []` under `dom_fallback` (`QCAnalyzeRequest._validate_dom_fallback_figures`) + added `DomFigureSummary` / `domFigureSummaries` (`§2.2`, `§3.3`, `§3.4`). **PASS** |
| R1 | `01-architecture.md` | **MINOR** | Cache path mismatch (`sly-qc` vs `supervisely-qc/images`), missing `datasetId` param on `GET /profiles`, invalid sample `imageHash`, unimplemented `Purge Cache` backend promise. | Standardized `~/.cache/supervisely-qc/images/`, added `datasetId` query param (`§3.2`), updated sample hash to `"sly:81b2f3d9a4c0e1"`, aligned `§5.1.3` to auto LRU/TTL + local dismissal clear. **PASS** |
| R1 | `02-qc-engine.md` | **MAJOR** | `dom_fallback` / `WF_*` typo, `BBOX_FOREGROUND_OCCLUSION_FALSE_POSITIVE` vs `FP` drift, missing `ruleId`/`severity` on missed-object `QCFinding`. | Aligned `domFigureSummaries` + `WORKFLOW_*`, unified `BBOX_FOREGROUND_OCCLUSION_FP`, specified `ruleId: "VISION_MISSED_OBJECT"` / `severity: "warning"` (`§2.1`, `§2.3`, `§3.3(a)`). **PASS** |
| R1 | `02-qc-engine.md` | **MAJOR** | PNG shape checked *after* `cv2.imdecode` (decompression OOM bomb vector); `max(W,H)*2` conflicted with bounds check. | Added pre-decode PNG signature + `IHDR` `(w, h)` unpacking before `cv2.imdecode`, `decompressor.eof` check, and `[-1, W+1]` alignment (`§2.5`). **PASS** |
| R1 | `02-qc-engine.md` | **MAJOR** | Bokeh scorer claimed 256px resize + native gradients simultaneously; `E_ref = P_95(E_edge)` mixed units with `sharpnessScore`. | Replaced with `1:1` native-pixel scoring (`512x512` tiles for large ROIs) and `E_ref = P_95({S_raw(p_i)})` (`§3.3(b)`). **PASS** |
| R1 | `02-qc-engine.md` | **MAJOR** | `pose_auditor` wording allowed spatial Hungarian over joints, which masks L/R swaps. | Split strictly into Step 1 instance-level Hungarian + Step 2 semantic label-alias joint pairing + `KP_AI_LR_SWAP_CONFIRMED` (`§3.3(e)`). **PASS** |
| R1 | `02-qc-engine.md` | **MINOR** | YAML `(?i)` crashes JS `RegExp`, missing local model provisioning & MPS `float64` guard, fetch wording sync. | Removed `(?i)` from YAML regexes (`§4.2`), added `scripts/download_models.py` + `MODELS_NOT_DOWNLOADED` + `float32`/`float16` MPS casting (`§3.2`), aligned `§1.3`. **PASS** |
| R1 | `03-ui-ux-design.md` | **CRITICAL** | Offline `shoelace signed area > 0` rejected ~50% of valid CW/CCW polygons as `POLY_DEGENERATE_AREA`. | Fixed to winding-independent `Math.abs(shoelaceSignedArea) >= effectiveMinArea` (`§3.1`). **PASS** |
| R1 | `03-ui-ux-design.md` | **CRITICAL** | Tier-2 `CanvasOverlay` multiplied CSS-space zoom by `dprFactor` (2x oversize on Retina) and broke single-axis zoom (`span_x=1, span_y<0.995`); raw `RectangleGeometry` risked negative SVG dims. | Removed `dprFactor`, fixed per-axis cropped vs fitted `s` and `(tx, ty)` math, added canonical `[min, min, max, max]` box normalization (`§2.2`). **PASS** |
| R1 | `03-ui-ux-design.md` | **MAJOR** | `<svg><image href="blob:/data:...">` in Shadow DOM blocked by host page CSP `img-src`. | Replaced `<svg><image>` with paired transparent HTML `<canvas>` raster overlay (`ctx.setTransform(s*dpr, ...)`) inside `#sly-qc-overlay-host` (`§2.2`). **PASS** |
| R1 | `03-ui-ux-design.md` | **MAJOR** | Offline bounds/micro-click/duplicate rules diverged from `02`; dismissed missed objects didn't update `readiness`; `ConfirmGuard` attached directly to replaceable React button and hardcoded `readiness === "ready"`. | Aligned `[-1, W+1]`, `s_min`, per-primitive duplicate checks, `domFigureSummaries`, dismissed `missedObjectIds` readiness exclusion, delegated `window`/`document` capture hook + `guardPasses(...)` (`§2.1`, `§2.3`, `§3.1`). **PASS** |
| R1 | `03-ui-ux-design.md` | **MINOR** | Options cache controls & wireframe `BITMAP_DISCONNECTED_ISLANDS` (`TIP` vs `warning`) alignment. | Aligned Options Cache Controls with `01` and updated wireframe TIPS card to `BITMAP_SPILLED_MASK` (`info`) (`§2.1`, `§2.4`). **PASS** |

---

## 2. Cross-Spec Verification Matrix

### 2.1 Architecture & Contract Consistency (`01` <-> `02` <-> `03`)

| Verification Dimension | Verified Specification Evidence | Status |
|---|---|---|
| **Approach C Adherence** | Strictly Chrome Extension MV3 (`MAIN` + `ISOLATED` + `SW`) + Local Python FastAPI (`http://127.0.0.1:8765`), zero cloud CV/LLM or unauthorized substitutions. | **PASS** |
| **Wire & Auth Conventions** | All schemas inherit `CamelModel(alias_generator=to_camel, extra="forbid")` matching `shared/types/qc-contract.ts` in `camelCase`. Unauthenticated `GET /api/v1/health`; constant-time `X-QC-Bridge-Token` (`?token=` for WS) on `/api/v1/qc/*` and `/api/v1/profiles*`. | **PASS** |
| **Endpoint Parity** | `GET /api/v1/health`, `HEAD/PUT /api/v1/qc/images/{imageId}`, `POST /api/v1/qc/analyze` (`200`/`202`/`424`/`422`), `GET /api/v1/qc/jobs/{jobId}`, `WS /api/v1/qc/ws/{clientId}`, `GET /api/v1/profiles?projectId&datasetId&jobTitle`, `GET/PUT/DELETE /api/v1/profiles/{profileId}` align across `01`, `02`, `03`. | **PASS** |
| **All 5 Primitives (+ Point)** | `rectangle` (`points.exterior[2]`), `polygon` (`exterior` + `interior` holes), `bitmap` (`bitmap.data` zlib+b64 PNG + `origin`), `polyline` (`points.exterior`), `point` (`points.exterior[1]`), and `graph` (`nodes` map + `ClassDefinition.geometryConfig`) match across TypeScript, Pydantic v2, Layer 1/2 rules, and Canvas overlays. | **PASS** |
| **Context & Findings Parity** | `ImageContext` (`imageHash` `"sly:"`/`"meta:"`), `ViewportMetadata` (`minimap` / `transform` / `fallback_full`), `UiStateSnapshot`, `DomFigureSummary[]`, `QCFinding` (all 9 `QuickFixActionType`s), `MissedObjectOverlay` (8 `ViewportEdgeDirection`s), `overallScore` (`100 - 25*B - min(45, 8*W) - min(10, 2*I)`), `readiness`, and deterministic `fingerprint`s match 1:1 across `01`, `02`, `03`. | **PASS** |
| **RuleProfile & YAML Parity** | Built-in YAML profiles in `02` §4.2 use `RuleProfile` keys strictly (`extra="forbid"`), JS-compatible `jobTitleRegex`, and map 1:1 to `Options.tsx` Profile Studio controls in `03` §2.4. | **PASS** |

### 2.2 Functional & Pain-Point Completeness Matrix

| User Pain Point / Primitive | `01-architecture.md` | `02-qc-engine.md` | `03-ui-ux-design.md` | Status |
|---|---|---|---|---|
| **1. Yellow `Synchronize` & `CONFIRM ->` Gating** | `UiStateSnapshot.synchronizeDirty`, `isConfirmed`, capture hook | `WORKFLOW_UNSAVED_SYNC` (`blocker`), `WORKFLOW_EMPTY_UNCONFIRMED` (`warning`) | Top-bar pill (`Blocked`), `highlight_synchronize`, `ConfirmGuard.tsx` modal | **PASS** |
| **2. Image vs. Object `Occlusion` Tag Scope** | `TagDefinition.applicableType`, `imageTags`, `TagRulesConfig` | `TAG_SCOPE_IMAGE_MISPLACED` & `TAG_SCOPE_OBJECT_MISPLACED` (`blocker`) | Finding card + `move_tag_image_to_object` / `remove_image_tag` guided fix | **PASS** |
| **3. Overlapping Occlusion & Foreground FP** | `TagRulesConfig` (`IoU >= 0.10`, `IoS >= 0.15`, FP flag) | Asymmetric IoS + Layer 1 perspective heuristic + Layer 2 `Depth Anything V2 Small` | Diagonal hatch overlap zone + `"24% IoU"` pill + `BBOX_OCCLUSION_MISSING_TAG` / `BBOX_FOREGROUND_OCCLUSION_FP` | **PASS** |
| **4. Missed Objects Outside Zoom Viewport** | `ViewportMetadata` (Minimap red box -> `visiblePixelRect`) | `1280px` + `2x2` 20%-overlap tiling (`W>=2400`), `VISION_MISSED_OBJECT` | Dashed cyan Ghost Boxes, clamped off-screen edge pills, Minimap radar dots, Locate/Focus | **PASS** |
| **5. Bokeh Background `Building` & Absent `Bus`** | `ClassRuleOverride`, `VisionRulesConfig` | Native `1:1` Tenengrad boundary + interior Laplacian + `S_rel` gate, `CLASS_BOKEH_BACKGROUND`, `CLASS_DISABLED_OR_OFF_JOB`, `Bus` high-conf/area gate | Per-class override matrix in `Options.tsx`, `[✨ Sharp]` badge on ghost boxes | **PASS** |
| **Primitives: BBox, Poly, Brush, Line, Keypoint** | Discriminated `FigureGeometry` + `AnnotationFigure.to_geometry()` | Dedicated `bbox_rules`, `polygon_rules` (Shapely), `bitmap_rules` (IHDR + islands/holes/jagged/spill), `polyline_rules` (spikes/gaps), `keypoint_rules` (template/parent/L-R facing/pose) | Vector SVG + Raster `<canvas>` overlays for all 5 primitives + pure-TS `offlineQcEngine.ts` parity | **PASS** |

---

## 3. Edge-Case Verification Checklist (Implementation Gate)

Engineers implementing `/Users/mrongsubho/Documents/Termninal/SuerpvicelyQC/` MUST verify every edge case below passes automated tests:

### 3.1 Chrome MV3 & Network Extraction
- [ ] **Early-Boot Interception:** Project ontology (`classes`, `geometryConfig`, `tags`) fetched during initial SPA load before `document_idle` is retained in `__slyQcReplayBuffer` and delivered upon `SLY_QC_BRIDGE_READY`.
- [ ] **CSP & PNA Isolation:** Content script never sends HTTP/WS calls to `127.0.0.1` directly; Service Worker handles all FastAPI traffic with `X-QC-Bridge-Token` and PNA/extension-origin CORS headers.
- [ ] **Origin-Aware Image Fetching:** Same-site `*.supervisely.com` URLs fetch in SW with `credentials: "include", cache: "force-cache"`; external presigned CDN/S3 URLs (`ACAO: *`) strictly use `credentials: "omit"` (never `"include"`), using 1 MiB base64 chunks over `chrome.runtime.Port` if relayed from CS (never raw `ArrayBuffer` over `runtime.sendMessage`).
- [ ] **SW 30s Suspension Recovery:** Pending `deep` job `jobId` persists in `chrome.storage.session`; after simulated SW termination, SW resumes via `GET /api/v1/qc/jobs/{jobId}` without duplicating inference.
- [ ] **Fallback Ladder:** Breaking React Fiber store hooks degrades `store -> network_interceptor -> dom_fallback` (`figures: []`, `partialGeometry: true`, `domFigureSummaries` populated, zero `422` errors).
- [ ] **Bitmap Overlay CSP Safety:** Rendering `bitmap` masks in `CanvasOverlay.tsx` uses paired HTML `<canvas>` (`createImageBitmap` + `ctx.setTransform`) with zero `<svg><image href="blob:/data:...">` URLs.

### 3.2 Supervisely Coordinates, Primitives & Geometry
- [ ] **Inverted Rectangle Corners:** `[[3780, 2940], [3310, 1280]]` normalizes cleanly to `[3310, 1280, 3780, 2940]` in Python Layer 1, TS offline engine, and SVG `<rect>`/`intersection` overlays.
- [ ] **Sub-Pixel Canvas Edge Tolerance:** Coordinates at `-0.5` or `W + 0.5` pass `[-1.0, W + 1.0] x [-1.0, H + 1.0]` without false `GEOM_OUT_OF_BOUNDS` blockers (both online and offline).
- [ ] **CW & CCW Polygons + Holes:** Identical polygons drawn clockwise vs counter-clockwise both produce positive area (`abs(signedArea)`) and pass `POLY_DEGENERATE_AREA`. Self-intersecting bowtie sets `focusRect` to witness point; hole crossing exterior or nested holes trigger `POLY_HOLE_INVALID`.
- [ ] **Bitmap Decompression Bombs & Channel Variants:** Malicious small compressed PNG claiming `20000x20000` in `IHDR` is rejected *before* `cv2.imdecode` allocation; truncated zlib streams (`not decompressor.eof`) raise `BITMAP_DECODE_ERROR`; 4-channel RGBA (both alpha `< 255` and opaque `alpha == 255`), 3-channel RGB, and 1-channel Gray masks all extract identical boolean foreground masks.
- [ ] **Border-Touching Brush Masks:** `binary_fill_holes` with 1px `False` padding does not mistakenly fill open C-shaped objects touching the bitmap boundary.
- [ ] **Polyline Spikes & Collinear Gaps:** `180°` hairline backtrack (`alpha < 25°`) triggers `LINE_ACUTE_BACKTRACK_SPIKE`; T-junction gap (`3px <= d <= 35px`) triggers `LINE_DISCONNECTED_ENDPOINT_GAP`; near-closed loop (`<12px`) emits `info` hint.
- [ ] **Keypoints (Non-Bilateral & Facing-Aware):** `Fruit` skeleton (`stem`, `center`) skips `KP_ANATOMICAL_LR_INVERSION`; person facing camera vs facing away flips expected L/R `x`-ordering correctly without false positives; crossed ankles during walking require knee+ankle flip or threshold margin; sentinel `[0, 0]` nodes flag `KP_MISSING_REQUIRED_NODES`.
- [ ] **Viewport Transform Edge Cases:** `5472x3648 @ 16%` inside `980x653` letterboxed canvas, single-axis cropped zoom (`25%` on wide `1400x650`: `span_x = 1.0`, `span_y < 0.995`), and macOS Retina `devicePixelRatio = 2` all align overlays within `<= 2 CSS px` of target figures.

### 3.3 Vision, Bokeh, Memory & UI Ergonomics
- [ ] **Bokeh Rejection vs Sharp Foreground:** Crisp solid-dark coat pedestrian passes boundary Tenengrad ring (`blur_bokeh.py`) while heavily blurred background `Building` fails `sharpnessScore` / `S_rel` and is filtered out of missed objects (and flagged if manually boxed).
- [ ] **Snapshot Coalescing (`snapshotSeq`):** Rapidly sending `seq=10`, `seq=11`, `seq=12` for `deep` mode cancels queued stale runs without leaking MPS tensors or returning stale results over newer findings.
- [ ] **Low-RAM & Missing-Weights Degradation:** `available < 900 MB` downgrades `deep -> standard` (`LOW_SYSTEM_MEMORY_DOWNGRADE`); missing local model weights return Layer 1 results with `MODELS_NOT_DOWNLOADED` without hanging on downloads.
- [ ] **Mac Hotkey & Guard Isolation:** `Option+Q` (`event.key === "œ"` on macOS!) triggers via `e.code === "KeyQ"` and blocks `"œ"` insertion; typing `r`, `b`, `p`, `l`, `Space` inside Options/Drawer inputs never triggers Supervisely canvas tools; `ConfirmGuard` intercepts clicks even after React re-renders the `CONFIRM ->` button.

---

## 4. Master Test Plan

Aligned to repository structure `/Users/mrongsubho/Documents/Termninal/SuerpvicelyQC/tests/`:

### 4.1 Contract Parity Tests (`tests/contract/`)
- **Schema Export & Diff Test (`test_contract_parity.py`):** Runs `scripts/sync_contracts.py` against `backend/app/schemas/qc.py`, asserts zero drift with `shared/schemas/qc-contract.schema.json`, and checks every field/literal in `shared/types/qc-contract.ts` (including `DomFigureSummary`, `QCAnalyzeRequest`, `QCResponse`, `RuleProfile`, `WsEvent`, `ApiErrorEnvelope`).
- **Round-Trip Serialization Tests:** Validates representative payloads containing all 6 `FigureGeometry` variants (`rectangle`, `polygon`, `bitmap`, `polyline`, `point`, `graph`), `dom_fallback` (`figures=[]` + `domFigureSummaries`), and `422` rejection when `extra` keys or coordinate-less figures are supplied.
- **YAML Profile & Cross-Runtime Regex Tests:** Validates every YAML under `backend/profiles/*.yaml` against `RuleProfile.model_validate(..., strict=False)` (`extra="forbid"`) AND executes `node -e` / Vitest to verify `new RegExp(matchers.jobTitleRegex, "i")` compiles cleanly in V8/Chrome without Python-only inline flags.

### 4.2 Backend Unit & Integration Tests (`tests/backend/`)
- **Unit — Rule Engine (`tests/backend/rules/`):**
  - `test_global_rules.py`: `WORKFLOW_UNSAVED_SYNC`, `WORKFLOW_EMPTY_UNCONFIRMED` (normal + `dom_fallback`), `TAG_SCOPE_IMAGE_MISPLACED` (`"Occlusion"` on image), `TAG_SCOPE_OBJECT_MISPLACED`, `TAG_CLASS_INCOMPATIBLE`, `TAG_VALUE_INVALID`, `TAG_REQUIRED_MISSING`, `CLASS_DISABLED_OR_OFF_JOB`, `GEOM_DUPLICATE_FIGURE` (same-class `blocker` vs diff-class `warning` across all 5 primitives), scale-invariant `GEOM_EXTREME_MICRO_CLICK` (`540x360` vs `5472x3648`), `GEOM_CANVAS_WIDE_OUTLIER`, `GEOM_OUT_OF_BOUNDS` (`-0.5` pass vs `-1.5` fail).
  - `test_bbox_rules.py`: Asymmetric occlusion (`IoU=0.18, IoS=0.42` triggers), foreground `#6` wrongly tagged `Occlusion` triggers `BBOX_FOREGROUND_OCCLUSION_FP`, near-miss border gap (`7px` from right edge), inverted corner normalization.
  - `test_polygon_rules.py`: Valid CW/CCW polygons, bowtie self-intersection witness `focusRect`, collinear simplification hint, acute `<10°` spike, valid interior hole vs outside/crossing/nested/micro holes.
  - `test_bitmap_rules.py`: Valid Supervisely `base64(zlib(png))` round-trip (RGBA alpha, RGBA opaque, RGB, Gray), decompression bomb (`>32 MB` stream and oversized `IHDR` `20000x20000` rejected pre-decode), stray islands, 1px-padded border-touching hole test vs pinholes, jaggedness ratio `>1.38`, scattered & cross-figure spill.
  - `test_polyline_rules.py`: `<2` pts, duplicate consecutive pts, micro-line, acute `<25°` backtrack spike, self-crossing `LineString.is_simple`, collinear endpoint gap & T-junction gap, near-closed loop.
  - `test_keypoint_rules.py`: Standalone `point`, missing required `graph` nodes, `[0,0]` sentinel, unknown node key, outside parent bbox, `Fruit` non-bilateral skip, facing-camera vs facing-away L/R swap, crossed-ankle false-positive avoidance, bone proportion outlier.
- **Unit & Integration — Services & API (`tests/backend/api/`):**
  - `test_auth_and_pna.py`: `GET /api/v1/health` unauthenticated `200`; `/qc/*` & `/profiles*` reject missing/invalid `X-QC-Bridge-Token` (`401`); CORS preflight allows only configured `chrome-extension://` origin + emits `Access-Control-Allow-Private-Network: true`.
  - `test_image_cache.py`: `HEAD` miss (`404`) -> `PUT` (`201`) -> `HEAD` hit (`200`), `POST /qc/analyze` without image returns `424 IMAGE_CACHE_MISS`, size `>100 MB` returns `413`, dimension mismatch returns `400`, LRU eviction respects `1 GB` disk & `2`-image RAM ceiling.
  - `test_profiles_api.py`: Priority resolution (`explicit profileId` > `datasetIds` > `projectIds` > `jobTitleRegex` > `default`), built-in `DELETE` returns `400`, `404 PROFILE_NOT_FOUND`.
  - `test_vision_pipeline.py` *(synthetic + fixture images)*: Multi-scale `2x2` tiling NMS + containment merge; `blur_bokeh.py` separating crisp dark coat vs Gaussian-blurred `Building` crop; `occlusion_depth.py` depth map override on `#5` vs `#6`; `pose_auditor.py` confirming L/R ankle swap via semantic joint mapping; `JobManager` `snapshotSeq` cancellation and `LOW_SYSTEM_MEMORY_DOWNGRADE` / `MODELS_NOT_DOWNLOADED` fallbacks.

### 4.3 Extension Unit & Playwright E2E Tests (`tests/extension/`)
- **Vitest Unit Tests (`tests/extension/unit/`):**
  - `offlineQcEngine.test.ts`: Runs exact shared JSON fixture suite against `offlineQcEngine.ts` and asserts parity with backend Layer 1 `ruleId`s, `overallScore`, `readiness`, `fingerprint`s, CW & CCW polygons, `[-1, W+1]` bounds, and per-primitive duplicate checks.
  - `canvasOverlayMath.test.ts`: Tests Tier 1/2/3 affine `(s, tx, ty)` across `5472x3648 @ 16%` inside `980x653`, `25%` single-axis cropped (`span_x=1, span_y=0.71`), inverted boxes, and DPR=`2` CSS pixel invariance; tests `DecompressionStream("deflate")` PNG decode + IHDR guard.
  - `replayAndRelay.test.ts`: Verifies `__slyQcReplayBuffer` captures `document_start` fetches and replays on `SLY_QC_BRIDGE_READY`; verifies external presigned URLs fetch with `credentials: "omit"` and chunk over `chrome.runtime.Port` in base64 (zero raw `ArrayBuffer` over JSON IPC).
- **Playwright Extension E2E Tests (`tests/extension/e2e/`):**
  - Launches Chromium with unpacked built MV3 extension against a local **Mock Supervisely Workspace** (`https`/`http` fixture mimicking `quantigo.supervisely.com/app/images2/` dark DOM: React root, `<canvas>`, `Synchronize` yellow button, `CONFIRM ->` button, `CURRENT IMAGE TAGS`, top-right Minimap red box, `Objects By Classes`) and live FastAPI test instance on `127.0.0.1:8765`:
    1. **End-to-End Hybrid Run:** Draw/mutate figure (`Synchronize` turns yellow) -> press `Option+Q` (`code: "KeyQ"`) -> verify `HEAD`/`PUT` image cache runs once -> Drawer displays `WORKFLOW_UNSAVED_SYNC`, `TAG_SCOPE_IMAGE_MISPLACED`, overlap hatch overlay, and off-viewport Ghost badge + Minimap radar dot.
    2. **Pre-Confirm Guard & React Re-Render:** Click `CONFIRM ->` while blocked -> modal intercepts -> simulate React replacing `CONFIRM ->` DOM node -> click `Re-Run QC` after fixing -> auto-proceeds cleanly when `guardPasses` holds.
    3. **Shadow DOM & Hotkey Isolation:** Type `r`, `p`, `b`, `l`, `Space` inside Drawer search / Options inputs -> verify zero Supervisely canvas tool switches; press `Option+[` / `Option+]` -> steps through findings.
    4. **Offline Fallback E2E:** Stop FastAPI backend -> press `Option+Q` -> pill flips to `Offline · Rules` within `<1s` and offline deterministic findings still render accurately.

### 4.4 Performance & Apple Silicon Memory Benchmarks
- **Layer 1 SLA Test:** 150 dense figures (30 rects, 30 multi-hole polygons, 20 brush bitmaps, 35 polylines, 35 17-node skeletons) on `5472x3648` -> assert `timingMs.rules < 300 ms` (target `< 50 ms` p95).
- **Image Cache Loopback Test:** `5472x3648` 8 MB JPEG `PUT` once (`< 50 ms`), subsequent 10 `QCAnalyzeRequest` runs skip upload (`HEAD` `< 5 ms`, Tier-2 RAM `< 125 MB`).
- **8 GB Memory Ceiling Test (Apple Silicon M1/M2/M3):** Measure backend RSS via `psutil.Process().memory_info().rss` across 20 consecutive `standard` and `deep` analyses on distinct `5472x3648` images:
  - `rules`: `< 120 MB` RSS
  - `standard`: `< 950 MB` RSS, p95 `< 1000 ms`
  - `deep` (sequential Stage A -> C -> D unload): `< 1.45 GB` peak RSS, `< 3.5 s` p95, zero monotonic leak (`RSS_run20 - RSS_run5 < 50 MB`).

---

## 5. Residual Risk Register

| ID | Risk Description | Likelihood | Impact | Mitigation & Monitoring | Owner |
|---|---|---|---|---|---|
| **R1** | **Supervisely Web UI DOM/Store Refactor** breaks `slyStoreAdapter.ts` fiber keys or CSS selectors (`Synchronize`, `CONFIRM ->`, Minimap). | Medium | Medium | 3-tier extraction fallback (`store -> network_interceptor -> dom_fallback` with `domFigureSummaries`), semantic ARIA/text+color hue selectors (`35°–65°` yellow), and decoupled Playwright DOM smoke fixture tests. | Extension Team |
| **R2** | **Chrome MV3 Web Store / Enterprise Policy Restrictions** on unpacked extension `host_permissions` (`Optional` vs `https://*/*` for external S3 buckets). | Low | Medium | Restrict default `host_permissions` to `127.0.0.1/*` and `*.supervisely.com/*`; request `optional_host_permissions` only if presigned storage host differs, with `CS -> Port` base64 chunk relay as zero-permission fallback. | Extension Team |
| **R3** | **PyTorch MPS Operator Gaps / `fp16` NaNs** on macOS updates (`Depth Anything V2` or `SAM 2.1` kernels). | Medium | Medium | `PYTORCH_ENABLE_MPS_FALLBACK=1`, strict `float32 -> float16` pre-cast, CPU NMS, and automatic per-model `mps -> cpu` fallback flagging `engineCapabilities.device = "cpu"`. | Backend CV Team |
| **R4** | **8 GB Mac Swap Pressure** when Chrome holds multiple `5K` tabs alongside `deep` mode. | Medium | High | Strict `max_heavy_models = 1` sequential swap, Tier-2 decoded RAM cap (`<= 2` images), `psutil` preflight downgrade (`< 900 MB` -> `standard`, `< 450 MB` -> `rules`), and 180s idle weight unload. | Backend CV Team |
| **R5** | **Bridge Token Setup Friction** for non-technical annotators on macOS. | Medium | Low | First-run CLI/LaunchAgent setup prints token + copy helper; Extension Options `[Test Connection]` verifies `health` + `profiles` separately to distinguish "backend down" from "token mismatch". | Full-Stack Team |
