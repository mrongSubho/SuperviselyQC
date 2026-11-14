import { createElement } from "react";
import type {
  AnnotationFigure,
  BoundingBoxTuple,
  ContentToPageMessage,
  DrawerDockMode,
  ExtensionSettings,
  ImageContext,
  MissedObjectOverlay,
  ProjectOntology,
  PageBridgeSnapshot,
  PageToContentMessage,
  QCAnalyzeRequest,
  QCFinding,
  QCMode,
  QCResponse,
  QuickFixAction,
  RuleProfileSummary,
  SceneSimulationPlan,
  SimulatedObjectCandidate,
  SwJobPushMessage,
  SwRequestMessage,
  SwUploadPortMessage,
} from "../shared/types";
import {
  DEFAULT_EXTENSION_SETTINGS,
} from "../shared/types";
import {
  computeEffectiveSummary,
  loadDismissedFingerprints,
  loadSettings,
  saveDismissedFingerprints,
  saveSettings,
  subscribeSettingsChanges,
} from "../shared/storage";
import {
  captureCanvasOrImgFallback,
  executeQuickFix,
  extractDomOntologyClasses,
  extractDomResolutionHint,
  extractDomState,
  extractLargestDomImageElement,
  selectRectangleTool,
  selectSidebarClassRow,
} from "./domObserver";
import { ensureImageCachedForVision } from "./imageFetcher";
import { runOfflineDeterministicQc } from "./offlineQcEngine";
import {
  CanvasOverlay,
  computeCanvasAffineTransform,
  projectBboxToCssRect,
} from "./ui/CanvasOverlay";
import {
  ConfirmGuardModal,
  evaluateConfirmGuard,
  isConfirmTargetElement,
  type ConfirmGuardDecision,
} from "./ui/ConfirmGuard";
import { QcDrawer } from "./ui/QcDrawer";
import { mountShadowRoot, type ShadowMountHandle } from "./ui/shadowHost";
import { TopBarWidget } from "./ui/TopBarWidget";

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

function isEditableKeyboardEvent(evt: KeyboardEvent): boolean {
  const path = typeof evt.composedPath === "function" ? evt.composedPath() : [evt.target];
  for (const node of path) {
    if (node instanceof HTMLElement && node.matches(EDITABLE_SELECTOR)) {
      return true;
    }
  }
  return false;
}

function sendSwMessage<T = unknown>(msg: SwRequestMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function openSwUploadPort() {
  const port = chrome.runtime.connect({ name: "sly-qc-upload" });
  return {
    postMessage: (msg: SwUploadPortMessage) => port.postMessage(msg),
    onAck: () =>
      new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const handler = (ack: unknown) => {
          port.onMessage.removeListener(handler);
          resolve((ack as { ok: boolean; error?: string }) ?? { ok: false });
        };
        port.onMessage.addListener(handler);
      }),
    disconnect: () => port.disconnect(),
  };
}

const ANIMAL_SUBCLASSES = new Set(["horse", "dog", "cat", "bird", "cow", "sheep"]);

function extractFigureBoundingBox(fig: AnnotationFigure): BoundingBoxTuple | null {
  if (fig.geometryType === "rectangle" && fig.points.exterior.length >= 2) {
    const [p0, p1] = fig.points.exterior;
    return [
      Math.min(p0[0], p1[0]),
      Math.min(p0[1], p1[1]),
      Math.max(p0[0], p1[0]),
      Math.max(p0[1], p1[1]),
    ];
  }
  if (
    (fig.geometryType === "polygon" || fig.geometryType === "polyline") &&
    fig.points.exterior.length >= 2
  ) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of fig.points.exterior) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      return [minX, minY, maxX, maxY];
    }
  }
  return null;
}

function computeBoxIou(a: BoundingBoxTuple, b: BoundingBoxTuple): number {
  const ix0 = Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2]));
  const iy0 = Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3]));
  const ix1 = Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2]));
  const iy1 = Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3]));
  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, Math.abs(a[2] - a[0])) * Math.max(0, Math.abs(a[3] - a[1]));
  const areaB = Math.max(0, Math.abs(b[2] - b[0])) * Math.max(0, Math.abs(b[3] - b[1]));
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function areClassesCompatibleForMatch(figClass: string, candClass: string): {
  compatible: boolean;
  figUnknown: boolean;
} {
  const f = figClass.trim().toLowerCase();
  const c = candClass.trim().toLowerCase();
  if (!f || f === "unknown") {
    return { compatible: false, figUnknown: true };
  }
  if (f === c) {
    return { compatible: true, figUnknown: false };
  }
  if (
    (f === "animal" && ANIMAL_SUBCLASSES.has(c)) ||
    (c === "animal" && ANIMAL_SUBCLASSES.has(f))
  ) {
    return { compatible: true, figUnknown: false };
  }
  return { compatible: false, figUnknown: false };
}

export function reconcileSimulationWithFigures(
  plan: SceneSimulationPlan,
  figures: AnnotationFigure[],
): SceneSimulationPlan {
  if (plan.candidates.length === 0) return plan;

  const figBoxes = figures
    .map((fig) => ({ fig, bbox: extractFigureBoundingBox(fig) }))
    .filter((entry): entry is { fig: AnnotationFigure; bbox: BoundingBoxTuple } =>
      Boolean(entry.bbox),
    );

  // Greedy highest-IoU 1-to-1 matching mirroring backend _match_existing_figures
  const pairs: Array<{ candIdx: number; figIdx: number; iou: number }> = [];
  for (let ci = 0; ci < plan.candidates.length; ci += 1) {
    const cand = plan.candidates[ci]!;
    for (let fi = 0; fi < figBoxes.length; fi += 1) {
      const fb = figBoxes[fi]!;
      const iou = computeBoxIou(cand.bbox, fb.bbox);
      const { compatible, figUnknown } = areClassesCompatibleForMatch(
        fb.fig.classTitle,
        cand.classTitle,
      );
      if (compatible && iou >= 0.5) {
        pairs.push({ candIdx: ci, figIdx: fi, iou });
      } else if (figUnknown && iou >= 0.65) {
        pairs.push({ candIdx: ci, figIdx: fi, iou });
      }
    }
  }
  pairs.sort((a, b) => b.iou - a.iou);

  const matchedByCand = new Map<number, string>();
  const usedFigs = new Set<number>();
  for (const p of pairs) {
    if (matchedByCand.has(p.candIdx) || usedFigs.has(p.figIdx)) continue;
    matchedByCand.set(p.candIdx, figBoxes[p.figIdx]!.fig.figureId);
    usedFigs.add(p.figIdx);
  }

  const nextCandidates = plan.candidates.map((cand, idx) => ({
    ...cand,
    matchedFigureId: matchedByCand.get(idx) ?? null,
  }));

  const completedByClass = new Map<string, number>();
  let completedTotal = 0;
  for (const cand of nextCandidates) {
    if (cand.matchedFigureId) {
      completedTotal += 1;
      const key = cand.classTitle.trim().toLowerCase();
      completedByClass.set(key, (completedByClass.get(key) ?? 0) + 1);
    }
  }

  const nextSummaries = plan.classSummaries.map((summary) => {
    const completed = completedByClass.get(summary.classTitle.trim().toLowerCase()) ?? 0;
    return {
      ...summary,
      completedCount: completed,
      remainingCount: Math.max(0, summary.totalCount - completed),
    };
  });

  return {
    ...plan,
    completedTargetObjects: completedTotal,
    classSummaries: nextSummaries,
    candidates: nextCandidates,
  };
}

class ContentQcCoordinator {
  private settings: ExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
  private mode: QCMode = "standard";
  private pageNonce: string | null = null;
  private latestSnapshot: PageBridgeSnapshot | null = null;
  private snapshotWaiters: Array<(snap: PageBridgeSnapshot | null) => void> = [];

  private running = false;
  private offline = false;
  private device: "mps" | "cpu" | "none" = "none";
  private response: QCResponse | null = null;
  private lastEvaluatedSeq = 0;
  private lastImageId: string | null = null;
  private staleSnapshot = false;
  private activeJobId: string | null = null;
  private lastRequestSnapshot: QCAnalyzeRequest | null = null;

  private profiles: RuleProfileSummary[] = [];
  private dismissedFingerprints = new Set<string>();
  private focusedFindingId: string | null = null;
  private highlightedRect: BoundingBoxTuple | null = null;
  private highlightedLabel: string | null = null;
  private assistantClosed = false;
  private drawerOpen = false;
  private simulateAllActive = false;
  private simulatedCandidateIds = new Set<string>();
  private locatedCandidateId: string | null = null;
  private liveSceneSimulation: SceneSimulationPlan | null = null;
  private toastMessage: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private guardOpen = false;
  private guardDecision: ConfirmGuardDecision = {
    allowed: true,
    reasons: [],
    blockingFindings: [],
  };
  private bypassNextConfirmClick = false;
  private pendingConfirmTarget: HTMLElement | null = null;

  private topbarMount: ShadowMountHandle | null = null;
  private drawerMount: ShadowMountHandle | null = null;
  private overlayMount: ShadowMountHandle | null = null;
  private modalMount: ShadowMountHandle | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private observedCanvas: HTMLCanvasElement | null = null;
  private lastKnownCanvasRect: DOMRect | null = null;

  async init(): Promise<void> {
    this.settings = await loadSettings();
    this.mode = this.settings.defaultMode;
    subscribeSettingsChanges((next) => {
      this.settings = next;
      this.mode = next.defaultMode;
      this.renderAll();
    });

    this.mountShadowHosts();
    this.installWindowListeners();
    void this.refreshHealthAndProfiles();

    // Initiate/recover handshake with MAIN world interceptor.js
    const hello: ContentToPageMessage & { type: "SLY_QC_HELLO" } = {
      source: "SLY_QC_CONTENT",
      type: "SLY_QC_HELLO",
      nonce: "",
    };
    window.postMessage(hello, window.location.origin);

    this.renderAll();
  }

  private mountShadowHosts(): void {
    const dom = extractDomState(1000, 1000);
    // Always mount the top bar on document.body with fixed positioning so it can be freely dragged
    // across the workspace without being clipped or offset by Supervisely's header layout.
    this.topbarMount = mountShadowRoot("sly-qc-topbar-host", document.body);

    this.drawerMount = mountShadowRoot("sly-qc-drawer-host", document.body);
    this.overlayMount = mountShadowRoot("sly-qc-overlay-host", document.body);
    this.modalMount = mountShadowRoot("sly-qc-modal-host", document.body);

    if (dom.canvasElement && typeof ResizeObserver !== "undefined") {
      this.observedCanvas = dom.canvasElement;
      this.lastKnownCanvasRect = dom.canvasRect;
      this.resizeObserver = new ResizeObserver(() => {
        this.renderAll();
      });
      this.resizeObserver.observe(dom.canvasElement);
    }
  }

  private installWindowListeners(): void {
    // 1. Page Bridge postMessage listener
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.source !== window) return;
      const msg = event.data as Partial<PageToContentMessage> | null;
      if (!msg || msg.source !== "SLY_QC_PAGE" || typeof msg.nonce !== "string") return;

      if (msg.type === "SLY_QC_BRIDGE_READY") {
        this.pageNonce = msg.nonce;
        const ack: ContentToPageMessage = {
          source: "SLY_QC_CONTENT",
          type: "SLY_QC_HANDSHAKE_ACK",
          nonce: msg.nonce,
        };
        window.postMessage(ack, window.location.origin);
        return;
      }

      if (msg.type === "SLY_QC_SNAPSHOT" && msg.nonce === this.pageNonce && msg.payload) {
        void this.handleIncomingSnapshot(msg.payload);
      }
    });

    // 2. Service Worker async push updates (deep jobs + popup trigger)
    chrome.runtime.onMessage.addListener((msg: SwJobPushMessage | { type: string }) => {
      if (msg.type === "QC_TRIGGER_RUN_FROM_POPUP") {
        this.assistantClosed = false;
        void this.runQc();
        return;
      }
      if (msg.type === "QC_TOGGLE_PANEL_FROM_POPUP") {
        this.assistantClosed = !this.assistantClosed;
        if (!this.assistantClosed) {
          this.drawerOpen = true;
        }
        this.renderAll();
        return;
      }
      if (msg.type === "QC_JOB_EVENT") {
        const evt = (msg as SwJobPushMessage).event;
        if (!evt.jobId || evt.jobId !== this.activeJobId) return;
        if (evt.eventType === "job_completed" && evt.result) {
          this.activeJobId = null;
          this.running = false;
          this.applyQcResponse(evt.result, false);
        } else if (evt.eventType === "job_failed") {
          this.activeJobId = null;
          this.running = false;
          this.showToast(evt.error ?? "Deep QC job failed.");
          this.renderAll();
        }
      }
    });

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((_changes, areaName) => {
        if (areaName !== "local" && areaName !== "sync") return;
        void loadSettings().then((updated) => {
          this.settings = updated;
          this.renderAll();
        });
      });
    }

    // 3. Persistent Capture-Phase Confirm Guard (survives React button re-renders)
    window.addEventListener(
      "click",
      (evt: MouseEvent) => {
        if (this.bypassNextConfirmClick) {
          this.bypassNextConfirmClick = false;
          return;
        }
        const confirmBtn = isConfirmTargetElement(evt.target);
        if (!confirmBtn) return;

        const dom = extractDomState(
          this.latestSnapshot?.image?.width ?? 1000,
          this.latestSnapshot?.image?.height ?? 1000,
        );
        const decision = evaluateConfirmGuard({
          enabled: this.settings.confirmGuardEnabled,
          strictness: this.settings.confirmGuardStrictness,
          synchronizeDirty: dom.synchronizeDirty,
          response: this.response,
          dismissedFingerprints: this.dismissedFingerprints,
        });
        if (!decision.allowed) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          evt.stopPropagation();
          this.pendingConfirmTarget = confirmBtn;
          this.guardDecision = decision;
          this.guardOpen = true;
          this.renderAll();
        }
      },
      { capture: true },
    );

    // 4. Safe macOS Option (Alt) keyboard shortcuts matched by physical e.code
    window.addEventListener(
      "keydown",
      (evt: KeyboardEvent) => {
        if (evt.key === "Escape") {
          if (this.guardOpen) {
            this.guardOpen = false;
            this.renderAll();
            return;
          }
          if (this.drawerOpen) {
            this.drawerOpen = false;
            this.renderAll();
            return;
          }
        }
        if (isEditableKeyboardEvent(evt)) return;
        if (!evt.altKey || evt.ctrlKey || evt.metaKey) return;

        if (evt.code === "KeyQ") {
          evt.preventDefault();
          this.assistantClosed = false;
          void this.runQc();
        } else if (evt.code === "KeyD") {
          evt.preventDefault();
          if (this.assistantClosed) {
            this.assistantClosed = false;
            this.drawerOpen = true;
          } else {
            this.drawerOpen = !this.drawerOpen;
          }
          this.renderAll();
        } else if (evt.code === "KeyO") {
          evt.preventDefault();
          void this.toggleOverlay();
        } else if (evt.code === "KeyB") {
          evt.preventDefault();
          this.toggleSimulateAll();
        } else if (evt.code === "BracketLeft") {
          evt.preventDefault();
          this.stepFinding(-1);
        } else if (evt.code === "BracketRight") {
          evt.preventDefault();
          this.stepFinding(1);
        }
      },
      { capture: false },
    );
  }

  private async handleIncomingSnapshot(snap: PageBridgeSnapshot): Promise<void> {
    this.latestSnapshot = snap;
    while (this.snapshotWaiters.length > 0) {
      const waiter = this.snapshotWaiters.shift();
      waiter?.(snap);
    }

    const newImgId = snap.image?.imageId ?? null;
    const imgChanged = Boolean(newImgId && newImgId !== this.lastImageId);
    if (imgChanged && newImgId) {
      this.lastImageId = newImgId;
      this.response = null;
      this.liveSceneSimulation = null;
      this.simulateAllActive = false;
      this.simulatedCandidateIds.clear();
      this.locatedCandidateId = null;
      this.staleSnapshot = false;
      this.focusedFindingId = null;
      this.highlightedRect = null;
      this.highlightedLabel = null;
      const savedDismissals = await loadDismissedFingerprints(newImgId);
      this.dismissedFingerprints = new Set(savedDismissals);
      if (this.settings.autoRunOnImageSwitch) {
        void this.runQc();
      }
    } else if (this.response && snap.snapshotSeq > this.lastEvaluatedSeq) {
      this.staleSnapshot = true;
    }

    // Re-observe canvas if SPA swapped the canvas element
    const fallbackW = snap.image?.width ?? this.lastRequestSnapshot?.image.width ?? 1000;
    const fallbackH = snap.image?.height ?? this.lastRequestSnapshot?.image.height ?? 1000;
    const dom = extractDomState(fallbackW, fallbackH);
    if (this.response?.sceneSimulation) {
      const domTotalCount = dom.domFigureSummaries.reduce((sum, s) => sum + s.figureCount, 0);
      if (snap.figures.length > 0 || domTotalCount === 0) {
        this.liveSceneSimulation = reconcileSimulationWithFigures(
          this.response.sceneSimulation,
          snap.figures,
        );
      }
    }
    if (dom.canvasElement && dom.canvasElement !== this.observedCanvas && this.resizeObserver) {
      if (this.observedCanvas) this.resizeObserver.unobserve(this.observedCanvas);
      this.observedCanvas = dom.canvasElement;
      this.resizeObserver.observe(dom.canvasElement);
    }
    this.lastKnownCanvasRect = dom.canvasRect;
    this.renderAll();
  }

  private async requestFreshSnapshot(timeoutMs = 300): Promise<PageBridgeSnapshot | null> {
    if (!this.pageNonce) {
      return this.latestSnapshot;
    }
    return await new Promise<PageBridgeSnapshot | null>((resolve) => {
      let done = false;
      const finish = (s: PageBridgeSnapshot | null) => {
        if (done) return;
        done = true;
        resolve(s);
      };
      this.snapshotWaiters.push(finish);
      const reqMsg: ContentToPageMessage = {
        source: "SLY_QC_CONTENT",
        type: "SLY_QC_REQUEST_SNAPSHOT",
        nonce: this.pageNonce!,
      };
      window.postMessage(reqMsg, window.location.origin);
      setTimeout(() => finish(this.latestSnapshot), timeoutMs);
    });
  }

  private async refreshHealthAndProfiles(): Promise<void> {
    try {
      const health = (await sendSwMessage({ type: "QC_GET_HEALTH" })) as {
        online?: boolean;
        data?: { device?: "mps" | "cpu" };
      };
      if (health?.online && health.data) {
        this.offline = false;
        this.device = health.data.device ?? "cpu";
        const profs = (await sendSwMessage({
          type: "QC_LIST_PROFILES",
          projectId: this.latestSnapshot?.ontology?.projectId,
          datasetId: this.latestSnapshot?.image?.datasetId,
          jobTitle: this.latestSnapshot?.image?.jobTitle,
        })) as { ok?: boolean; data?: { profiles: RuleProfileSummary[] } };
        if (profs?.ok && profs.data) {
          this.profiles = profs.data.profiles;
        }
      } else {
        this.offline = true;
        this.device = "none";
      }
    } catch {
      this.offline = true;
      this.device = "none";
    }
    this.renderAll();
  }

  private buildAnalyzeRequest(snap: PageBridgeSnapshot | null): QCAnalyzeRequest {
    const searchParams =
      typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const urlImageId =
      searchParams?.get("imageId") ??
      searchParams?.get("entityId") ??
      (/\/images\/(\d+)/i.exec(window.location.pathname)?.[1] ?? null);
    const urlDatasetId = searchParams?.get("datasetId") ?? "0";
    const urlJobId = searchParams?.get("jobId") ?? undefined;
    const domImg = !snap?.image ? extractLargestDomImageElement() : null;
    const domResHint = extractDomResolutionHint(snap?.image?.fileName);
    const fallbackWidth = domResHint?.width || domImg?.naturalWidth || 1920;
    const fallbackHeight = domResHint?.height || domImg?.naturalHeight || 1080;
    const fallbackImageId =
      urlImageId ?? `dom_${window.location.pathname.replace(/[^a-zA-Z0-9]/g, "_")}`;

    const imgMeta: ImageContext = snap?.image ?? {
      imageId: fallbackImageId,
      datasetId: urlDatasetId,
      jobId: urlJobId,
      fileName: `${fallbackImageId}.jpg`,
      width: fallbackWidth,
      height: fallbackHeight,
      imageHash: `sly:${fallbackImageId}`,
    };
    if (snap?.image && domResHint && snap.image.width === 1920 && snap.image.height === 1080) {
      imgMeta.width = domResHint.width;
      imgMeta.height = domResHint.height;
    }

    const dom = extractDomState(imgMeta.width, imgMeta.height);
    const useDomFallback =
      !snap || (snap.rawStateSource === "empty" && snap.figures.length === 0);

    const domClasses =
      !snap?.ontology || snap.ontology.classes.length === 0
        ? extractDomOntologyClasses().map((c, idx) => ({
            classId: `dom_cls_${idx + 1}`,
            title: c.title,
            shape: c.shape,
            color: "#6b4eff",
          }))
        : [];

    const imageTags =
      snap && snap.imageTags.length > 0
        ? snap.imageTags
        : dom.imageTagNamesDom.map((name, i) => ({
            tagId: i + 1,
            name,
            value: null,
          }));

    const ontology: ProjectOntology =
      snap?.ontology && snap.ontology.classes.length > 0
        ? snap.ontology
        : {
            projectId: snap?.ontology?.projectId ?? searchParams?.get("projectId") ?? "0",
            projectName: snap?.ontology?.projectName,
            classes: domClasses,
            tags:
              snap?.ontology?.tags && snap.ontology.tags.length > 0
                ? snap.ontology.tags
                : imageTags.map((t, i) => ({
                    tagId: t.tagId ?? i + 1,
                    name: t.name,
                    valueType: "none" as const,
                    applicableType: "all" as const,
                    classes: [],
                    values: [],
                  })),
            jobClassesToLabel: snap?.ontology?.jobClassesToLabel,
          };

    return {
      requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      snapshotSeq: snap?.snapshotSeq ?? 1,
      mode: this.mode,
      profileId:
        this.settings.selectedProfileId === "auto"
          ? undefined
          : this.settings.selectedProfileId,
      asyncIfHeavy: true,
      image: imgMeta,
      ontology,
      imageTags,
      // Strict contract invariant: figures MUST be [] when stateSource === "dom_fallback"
      figures: useDomFallback ? [] : snap.figures,
      domFigureSummaries: useDomFallback ? dom.domFigureSummaries : [],
      viewport: dom.viewport,
      uiState: {
        synchronizeDirty: dom.synchronizeDirty,
        confirmButtonEnabled: dom.confirmButtonEnabled,
        isConfirmed: snap?.uiState.isConfirmed ?? dom.isConfirmed,
        activeTool: dom.activeTool ?? snap?.uiState.activeTool ?? null,
        activeClassTitle: dom.activeClassTitle ?? snap?.uiState.activeClassTitle ?? null,
        stateSource: useDomFallback
          ? "dom_fallback"
          : snap.rawStateSource === "intercepted"
            ? "network_interceptor"
            : "store",
        partialGeometry: useDomFallback ? true : snap.partialGeometry,
      },
    };
  }

  async runQc(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.staleSnapshot = false;
    this.renderAll();

    try {
      const snap = await this.requestFreshSnapshot(300);
      const req = this.buildAnalyzeRequest(snap);
      this.lastRequestSnapshot = req;
      this.lastImageId = req.image.imageId;
      this.dismissedFingerprints = new Set(await loadDismissedFingerprints(req.image.imageId));

      // Cache image if vision mode requested (even if snap.originalImageUrl was null, try HEAD/DOM/canvas)
      if (this.mode !== "rules") {
        const domImgEl = extractLargestDomImageElement();
        const fallbackImgUrl = domImgEl ? domImgEl.currentSrc || domImgEl.src || null : null;
        const effectiveImageUrl = snap?.originalImageUrl ?? fallbackImgUrl;
        const domNow = extractDomState(req.image.width, req.image.height);
        const cacheRes = await ensureImageCachedForVision(req.image, effectiveImageUrl, {
          pageOrigin: window.location.origin,
          sendMessage: sendSwMessage,
          openUploadPort: openSwUploadPort,
          fallbackCaptureFn: () => captureCanvasOrImgFallback(domNow.canvasElement),
        });
        if (cacheRes.imageHash) {
          req.image.imageHash = cacheRes.imageHash;
        }
        const hasReliableDims =
          (Boolean(snap?.image) && !(req.image.width === 1920 && req.image.height === 1080)) ||
          Boolean(extractDomResolutionHint(req.image.fileName));
        if (
          (!cacheRes.fromCanvasCapture || !hasReliableDims) &&
          cacheRes.width &&
          cacheRes.width > 0 &&
          cacheRes.height &&
          cacheRes.height > 0 &&
          (cacheRes.width !== req.image.width || cacheRes.height !== req.image.height)
        ) {
          req.image.width = cacheRes.width;
          req.image.height = cacheRes.height;
          req.viewport = extractDomState(req.image.width, req.image.height).viewport;
          this.lastRequestSnapshot = req;
        }
        if (!cacheRes.cached && !cacheRes.offline && !this.offline) {
          this.showToast(
            cacheRes.error
              ? `Image cache failed: ${cacheRes.error}`
              : "Could not cache image for Vision QC — check Options or use Rules mode.",
          );
          this.running = false;
          this.renderAll();
          return;
        }
      }

      const swRes = (await sendSwMessage({
        type: "QC_ANALYZE",
        request: req,
      })) as {
        ok?: boolean;
        offline?: boolean;
        imageCacheMiss?: boolean;
        authError?: boolean;
        error?: string;
        data?: QCResponse;
      };

      if (swRes?.ok && swRes.data) {
        if (swRes.data.status === "queued" && swRes.data.jobId) {
          this.activeJobId = swRes.data.jobId;
          this.showToast("Deep QC running locally on Apple Silicon...");
          this.renderAll();
          return;
        }
        this.running = false;
        this.applyQcResponse(swRes.data, false);
        return;
      }

      if (swRes?.authError) {
        this.showToast(swRes.error ?? "Invalid Bridge Token — check Options.");
      }

      if (swRes?.offline && this.settings.offlineFallbackEnabled) {
        const offlineRes = await runOfflineDeterministicQc(req);
        this.running = false;
        this.applyQcResponse(offlineRes, true);
        return;
      }

      this.showToast(swRes?.error ?? "QC analysis failed.");
      this.running = false;
      this.renderAll();
    } catch (err) {
      this.running = false;
      this.showToast(`QC error: ${String(err)}`);
      this.renderAll();
    }
  }

  private applyQcResponse(res: QCResponse, isOffline: boolean): void {
    this.response = res;
    this.assistantClosed = false;
    this.simulateAllActive = false;
    this.simulatedCandidateIds.clear();
    this.locatedCandidateId = null;
    this.highlightedRect = null;
    this.highlightedLabel = null;
    this.offline = isOffline || res.engineCapabilities.degradedReason === "BACKEND_OFFLINE";
    this.device = res.engineCapabilities.device;
    this.lastEvaluatedSeq = res.snapshotSeq;
    this.staleSnapshot = false;
    this.drawerOpen = true;
    this.liveSceneSimulation =
      res.sceneSimulation && this.latestSnapshot?.figures?.length
        ? reconcileSimulationWithFigures(res.sceneSimulation, this.latestSnapshot.figures)
        : (res.sceneSimulation ?? null);
    this.renderAll();
  }

  private ensureOverlayVisible(): void {
    if (this.settings.overlayVisible) return;
    this.settings = { ...this.settings, overlayVisible: true };
    void saveSettings({ overlayVisible: true });
  }

  private async toggleOverlay(): Promise<void> {
    this.settings = await saveSettings({ overlayVisible: !this.settings.overlayVisible });
    this.renderAll();
  }

  private stepFinding(dir: -1 | 1): void {
    if (!this.response) return;
    const eff = computeEffectiveSummary(this.response, this.dismissedFingerprints);
    if (eff.activeFindings.length === 0) return;
    const currIdx = eff.activeFindings.findIndex((f) => f.findingId === this.focusedFindingId);
    const nextIdx =
      currIdx < 0
        ? dir > 0
          ? 0
          : eff.activeFindings.length - 1
        : (currIdx + dir + eff.activeFindings.length) % eff.activeFindings.length;
    const next = eff.activeFindings[nextIdx]!;
    this.focusFinding(next);
  }

  private focusFinding(finding: QCFinding): void {
    this.assistantClosed = false;
    this.focusedFindingId = finding.findingId;
    this.locatedCandidateId = null;
    this.highlightedRect = finding.focusRect ?? null;
    this.highlightedLabel = finding.focusRect ? finding.title : null;
    if (finding.focusRect) {
      this.ensureOverlayVisible();
    }
    this.drawerOpen = true;
    this.renderAll();
  }

  private focusMissedObject(missed: MissedObjectOverlay): void {
    const linked = this.response?.findings.find((f) =>
      f.missedObjectIds.includes(missed.missedId),
    );
    if (linked) {
      this.focusedFindingId = linked.findingId;
    }
    this.assistantClosed = false;
    this.ensureOverlayVisible();
    this.locatedCandidateId = null;
    this.highlightedRect = missed.bbox;
    this.highlightedLabel = `Missed: ${missed.classTitle}`;
    this.drawerOpen = true;
    this.renderAll();
  }

  private toggleSimulateAll(): void {
    const next = !this.simulateAllActive;
    this.simulateAllActive = next;
    this.simulatedCandidateIds.clear();
    if (next) {
      this.assistantClosed = false;
      this.ensureOverlayVisible();
      this.showToast("Simulation Preview: ALL ON (click again to hide)");
    } else {
      if (this.locatedCandidateId !== null) {
        this.locatedCandidateId = null;
        this.highlightedRect = null;
        this.highlightedLabel = null;
      }
      this.showToast("Simulation Preview: OFF");
    }
    this.renderAll();
  }

  private toggleSimCandidate(cand: SimulatedObjectCandidate): void {
    this.assistantClosed = false;
    if (this.simulateAllActive) {
      const allIds = (this.liveSceneSimulation?.candidates ?? []).map((c) => c.simId);
      this.simulatedCandidateIds = new Set(allIds.filter((id) => id !== cand.simId));
      this.simulateAllActive = false;
      this.renderAll();
      return;
    }
    if (this.simulatedCandidateIds.has(cand.simId)) {
      this.simulatedCandidateIds.delete(cand.simId);
    } else {
      this.simulatedCandidateIds.add(cand.simId);
      this.ensureOverlayVisible();
    }
    this.renderAll();
  }

  private focusSimulatedCandidate(bbox: BoundingBoxTuple, label?: string): void {
    this.assistantClosed = false;
    this.ensureOverlayVisible();
    this.highlightedRect = bbox;
    this.highlightedLabel = label ?? null;
    this.drawerOpen = true;
    this.renderAll();
  }

  private locateSimulatedCandidate(cand: SimulatedObjectCandidate): void {
    if (this.locatedCandidateId === cand.simId) {
      this.locatedCandidateId = null;
      this.highlightedRect = null;
      this.highlightedLabel = null;
      this.renderAll();
      return;
    }

    this.locatedCandidateId = cand.simId;
    this.focusSimulatedCandidate(cand.bbox, `🎯 #${cand.simIndex} ${cand.classTitle}`);
    const imgW =
      this.latestSnapshot?.image?.width ??
      this.lastRequestSnapshot?.image.width ??
      1920;
    const imgH =
      this.latestSnapshot?.image?.height ??
      this.lastRequestSnapshot?.image.height ??
      1080;
    const dom = extractDomState(imgW, imgH);
    if (dom.canvasElement && typeof dom.canvasElement.scrollIntoView === "function") {
      const rect = dom.canvasElement.getBoundingClientRect();
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        dom.canvasElement.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    this.showToast(
      `Target mark shown for #${cand.simIndex} ${cand.classTitle}${
        cand.outsideViewport ? " (outside current pan — follow edge arrow)" : ""
      }. Click Locate again to hide.`,
    );
  }

  private async autoDrawCandidateAnnotation(
    cand: SimulatedObjectCandidate,
    overrideClassTitle: string | null,
  ): Promise<void> {
    if (!this.settings.experimentalAutoDrawEnabled) {
      this.showToast("Auto-Draw is disabled — enable it in Extension Options > Execution Behavior.");
      return;
    }
    if (cand.recommendedShape !== "rectangle") {
      this.locateSimulatedCandidate(cand);
      this.showToast(
        `Shape ${cand.recommendedShape} cannot be auto-dragged — #${cand.simIndex} highlighted for manual drawing.`,
      );
      return;
    }

    const targetClass =
      overrideClassTitle && overrideClassTitle.trim()
        ? overrideClassTitle.trim()
        : cand.classTitle;

    this.locatedCandidateId = cand.simId;
    this.focusSimulatedCandidate(cand.bbox, `⚡ #${cand.simIndex} ${targetClass}`);

    if (!this.pageNonce) {
      this.showToast(`Page bridge inactive — located #${cand.simIndex} ${targetClass} instead.`);
      return;
    }

    const imgW =
      this.latestSnapshot?.image?.width ??
      this.lastRequestSnapshot?.image.width ??
      1920;
    const imgH =
      this.latestSnapshot?.image?.height ??
      this.lastRequestSnapshot?.image.height ??
      1080;
    const domBefore = extractDomState(imgW, imgH);
    const canvasRect = domBefore.canvasRect ?? this.lastKnownCanvasRect;
    if (!canvasRect || canvasRect.width < 10 || canvasRect.height < 10) {
      this.showToast(`Canvas not found — located #${cand.simIndex} ${targetClass} instead.`);
      return;
    }

    if (cand.outsideViewport) {
      this.showToast(
        `#${cand.simIndex} ${targetClass} is outside the current zoomed view — pan toward the edge arrow first.`,
      );
      return;
    }

    const transform = computeCanvasAffineTransform({
      imageWidth: imgW,
      imageHeight: imgH,
      canvasCssWidth: canvasRect.width,
      canvasCssHeight: canvasRect.height,
      viewport: domBefore.viewport,
      canvasTransform: this.latestSnapshot?.canvasTransform ?? null,
    });
    const cssRect = projectBboxToCssRect(cand.bbox, transform);
    const x1 = Math.max(
      canvasRect.left + 2,
      Math.min(canvasRect.right - 2, canvasRect.left + cssRect.x),
    );
    const y1 = Math.max(
      canvasRect.top + 2,
      Math.min(canvasRect.bottom - 2, canvasRect.top + cssRect.y),
    );
    const x2 = Math.max(
      canvasRect.left + 2,
      Math.min(canvasRect.right - 2, canvasRect.left + cssRect.x + cssRect.width),
    );
    const y2 = Math.max(
      canvasRect.top + 2,
      Math.min(canvasRect.bottom - 2, canvasRect.top + cssRect.y + cssRect.height),
    );
    if (Math.abs(x2 - x1) < 4 || Math.abs(y2 - y1) < 4) {
      this.showToast(`Target #${cand.simIndex} is too small at current zoom to simulate.`);
      return;
    }

    const classSelection = selectSidebarClassRow(targetClass);
    if (!classSelection.selected) {
      this.showToast(
        `Class "${targetClass}" not found in sidebar — located #${cand.simIndex} instead.`,
      );
      return;
    }

    const toolSelected = selectRectangleTool();
    if (
      !toolSelected &&
      domBefore.activeTool &&
      domBefore.activeTool !== "unknown" &&
      !domBefore.activeTool.includes("rect")
    ) {
      this.showToast(
        `Select the Rectangle tool in the left toolbar first — #${cand.simIndex} (${targetClass}) highlighted.`,
      );
      return;
    }

    const beforeCount = this.latestSnapshot?.figures.length ?? 0;
    const beforeDomTotal = domBefore.domFigureSummaries.reduce(
      (acc, s) => acc + s.figureCount,
      0,
    );

    // Let Supervisely sidebar class click settle before dispatching canvas drag
    await new Promise((resolve) => setTimeout(resolve, 60));

    const msg: ContentToPageMessage = {
      source: "SLY_QC_CONTENT",
      type: "SLY_QC_SIMULATE_RECT_DRAW",
      nonce: this.pageNonce,
      clientRect: { x1, y1, x2, y2 },
    };
    window.postMessage(msg, "*");

    await new Promise((resolve) => setTimeout(resolve, 260));
    const afterSnap = await this.requestFreshSnapshot(450);
    const domAfter = extractDomState(imgW, imgH);
    const afterCount = afterSnap?.figures.length ?? this.latestSnapshot?.figures.length ?? 0;
    const afterDomTotal = domAfter.domFigureSummaries.reduce(
      (acc, s) => acc + s.figureCount,
      0,
    );

    if (afterCount > beforeCount || afterDomTotal > beforeDomTotal) {
      this.showToast(
        `Auto-drew ${targetClass} rectangle for #${cand.simIndex}. Review edges and tags before confirming.`,
      );
    } else {
      this.showToast(
        `Selected ${targetClass} & aimed at #${cand.simIndex}, but Supervisely ignored synthetic canvas drag — draw inside the yellow crosshair guide.`,
      );
    }
  }

  private async dismissFinding(finding: QCFinding): Promise<void> {
    this.dismissedFingerprints.add(finding.fingerprint);
    if (this.lastImageId) {
      await saveDismissedFingerprints(
        this.lastImageId,
        Array.from(this.dismissedFingerprints),
      );
    }
    if (this.focusedFindingId === finding.findingId) {
      this.focusedFindingId = null;
      this.highlightedRect = null;
      this.highlightedLabel = null;
    }
    this.renderAll();
  }

  private showToast(msg: string): void {
    this.toastMessage = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMessage = null;
      this.renderAll();
    }, 3500);
    this.renderAll();
  }

  private renderAll(): void {
    const imgW =
      this.latestSnapshot?.image?.width ??
      this.lastRequestSnapshot?.image.width ??
      1920;
    const imgH =
      this.latestSnapshot?.image?.height ??
      this.lastRequestSnapshot?.image.height ??
      1080;
    const dom = extractDomState(imgW, imgH);
    const canvasRect = dom.canvasRect ?? this.lastKnownCanvasRect;
    const compact = typeof window !== "undefined" && window.innerWidth < 1200;

    const eff = this.response
      ? computeEffectiveSummary(this.response, this.dismissedFingerprints)
      : null;

    const activeSimulation =
      this.liveSceneSimulation ?? this.response?.sceneSimulation ?? null;

    // 1. TopBar Widget
    this.topbarMount?.reactRoot.render(
      createElement(TopBarWidget, {
        visible: !this.assistantClosed,
        mode: this.mode,
        running: this.running,
        offline: this.offline,
        device: this.device,
        overlayVisible: this.settings.overlayVisible,
        drawerOpen: this.drawerOpen,
        effectiveScore: eff ? eff.overallScore : null,
        effectiveReadiness: eff ? eff.readiness : null,
        compact,
        floatingPos: this.settings.floatingTopbarPos,
        response: this.response,
        onChangeMode: (nextMode) => {
          this.mode = nextMode;
          void saveSettings({ defaultMode: nextMode });
          this.renderAll();
        },
        onChangeFloatingPos: (pos) => {
          this.settings = { ...this.settings, floatingTopbarPos: pos };
          void saveSettings({ floatingTopbarPos: pos });
          this.renderAll();
        },
        onRunQc: () => void this.runQc(),
        onToggleOverlay: () => void this.toggleOverlay(),
        onToggleDrawer: () => {
          this.drawerOpen = !this.drawerOpen;
          this.renderAll();
        },
        onCloseAssistant: () => {
          this.assistantClosed = true;
          this.locatedCandidateId = null;
          this.highlightedRect = null;
          this.highlightedLabel = null;
          this.renderAll();
        },
      }),
    );

    // 2. CanvasOverlay (Raster + Vector SVG + Directional Pills + Minimap Radar)
    this.overlayMount?.reactRoot.render(
      createElement(CanvasOverlay, {
        visible: !this.assistantClosed && this.settings.overlayVisible,
        canvasRect: canvasRect
          ? {
              left: canvasRect.left,
              top: canvasRect.top,
              width: canvasRect.width,
              height: canvasRect.height,
            }
          : null,
        minimapRect: dom.minimapRect
          ? {
              left: dom.minimapRect.left,
              top: dom.minimapRect.top,
              width: dom.minimapRect.width,
              height: dom.minimapRect.height,
            }
          : null,
        imageWidth: imgW,
        imageHeight: imgH,
        viewport: dom.viewport,
        canvasTransform: this.latestSnapshot?.canvasTransform ?? null,
        activeFindings: eff?.activeFindings ?? [],
        activeMissedObjects: eff?.activeMissedObjects ?? [],
        sceneSimulation: activeSimulation,
        showBlueprintGuides: this.simulateAllActive,
        simulatedCandidateIds: Array.from(this.simulatedCandidateIds),
        focusedFindingId: this.focusedFindingId,
        highlightedRect: this.highlightedRect,
        highlightedLabel: this.highlightedLabel,
        figures: this.latestSnapshot?.figures ?? [],
        onClickMissedOverlay: (m) => this.focusMissedObject(m),
        onClickFindingOverlay: (f) => this.focusFinding(f),
        onClickSimCandidate: (cand) => this.locateSimulatedCandidate(cand),
      }),
    );

    // 3. Dockable QC Drawer
    this.drawerMount?.reactRoot.render(
      createElement(QcDrawer, {
        open: !this.assistantClosed && this.drawerOpen,
        dockMode: this.settings.drawerDockMode,
        floatingPos: this.settings.floatingDrawerPos,
        mode: this.mode,
        running: this.running,
        offline: this.offline,
        staleSnapshot: this.staleSnapshot,
        response: this.response,
        sceneSimulation: activeSimulation,
        showBlueprintGuides: this.simulateAllActive,
        simulatedCandidateIds: Array.from(this.simulatedCandidateIds),
        locatedCandidateId: this.locatedCandidateId,
        experimentalAutoDrawEnabled: this.settings.experimentalAutoDrawEnabled,
        activeSidebarClass:
          dom.activeClassTitle ?? this.latestSnapshot?.uiState.activeClassTitle ?? null,
        domFigureSummaries: dom.domFigureSummaries,
        profiles: this.profiles,
        selectedProfileId: this.settings.selectedProfileId,
        activeFindings: eff?.activeFindings ?? [],
        effectiveScore: eff ? eff.overallScore : null,
        effectiveReadiness: eff ? eff.readiness : null,
        blockerCount: eff?.summaryCounts.blocker ?? 0,
        warningCount: eff?.summaryCounts.warning ?? 0,
        infoCount: eff?.summaryCounts.info ?? 0,
        focusedFindingId: this.focusedFindingId,
        onClose: () => {
          this.drawerOpen = false;
          this.renderAll();
        },
        onChangeDockMode: (dock: DrawerDockMode) => {
          this.settings = { ...this.settings, drawerDockMode: dock };
          void saveSettings({ drawerDockMode: dock });
          this.renderAll();
        },
        onChangeFloatingPos: (pos: { x: number; y: number }) => {
          this.settings = { ...this.settings, floatingDrawerPos: pos };
          void saveSettings({ floatingDrawerPos: pos });
          this.renderAll();
        },
        onFloatAtPos: (pos: { x: number; y: number }) => {
          this.settings = {
            ...this.settings,
            drawerDockMode: "floating",
            floatingDrawerPos: pos,
          };
          void saveSettings({
            drawerDockMode: "floating",
            floatingDrawerPos: pos,
          });
          this.renderAll();
        },
        onChangeMode: (nextMode: QCMode) => {
          this.mode = nextMode;
          void saveSettings({ defaultMode: nextMode });
          this.renderAll();
        },
        onChangeProfile: (pid: string) => {
          void saveSettings({ selectedProfileId: pid });
        },
        onRunQc: () => void this.runQc(),
        onSelectFinding: (f) => this.focusFinding(f),
        onStepFinding: (dir) => this.stepFinding(dir),
        onQuickFix: (fix: QuickFixAction, finding: QCFinding) => {
          executeQuickFix(fix, finding, {
            onFocusRect: (rect) => {
              this.assistantClosed = false;
              this.ensureOverlayVisible();
              this.focusedFindingId = finding.findingId;
              this.locatedCandidateId = null;
              this.highlightedRect = rect;
              this.highlightedLabel = fix.label;
              this.renderAll();
            },
            onToast: (m) => this.showToast(m),
          });
        },
        onDismissFinding: (f) => void this.dismissFinding(f),
        onToggleBlueprintGuides: () => this.toggleSimulateAll(),
        onToggleSimCandidate: (cand) => this.toggleSimCandidate(cand),
        onLocateRect: (bbox) => this.focusSimulatedCandidate(bbox),
        onLocateCandidate: (cand) => this.locateSimulatedCandidate(cand),
        onAutoDrawCandidate: this.settings.experimentalAutoDrawEnabled
          ? (cand, overrideClassTitle) =>
              void this.autoDrawCandidateAnnotation(cand, overrideClassTitle)
          : undefined,
        onSelectSidebarClass: (classTitle) => {
          executeQuickFix(
            {
              actionId: `bp_select_${classTitle}`,
              label: `Switch Sidebar to ${classTitle}`,
              actionType: "select_sidebar_class",
              classTitle,
            },
            undefined,
            {
              onFocusRect: () => {},
              onToast: (m) => this.showToast(m),
            },
          );
          this.renderAll();
        },
      }),
    );

    // 4. Confirm Guard Modal + Toast Notification
    this.modalMount?.reactRoot.render(
      createElement("div", null, [
        createElement(ConfirmGuardModal, {
          key: "confirm-guard-modal",
          open: this.guardOpen,
          decision: this.guardDecision,
          onCancel: () => {
            this.guardOpen = false;
            this.renderAll();
          },
          onFixFirst: () => {
            this.guardOpen = false;
            this.drawerOpen = true;
            if (this.guardDecision.blockingFindings[0]) {
              this.focusedFindingId = this.guardDecision.blockingFindings[0].findingId;
              this.highlightedRect =
                this.guardDecision.blockingFindings[0].focusRect ?? null;
            }
            this.renderAll();
          },
          onReRunQc: () => {
            this.guardOpen = false;
            this.renderAll();
            void this.runQc();
          },
          onConfirmAnyway: () => {
            this.guardOpen = false;
            this.renderAll();
            if (this.pendingConfirmTarget) {
              this.bypassNextConfirmClick = true;
              this.pendingConfirmTarget.click();
            }
          },
        }),
        this.toastMessage
          ? createElement(
              "div",
              { key: "toast", className: "qc-toast", "data-testid": "qc-toast" },
              this.toastMessage,
            )
          : null,
      ]),
    );
  }
}

if (
  typeof window !== "undefined" &&
  typeof chrome !== "undefined" &&
  Boolean(chrome.runtime?.id)
) {
  const coordinator = new ContentQcCoordinator();
  void coordinator.init();
}
