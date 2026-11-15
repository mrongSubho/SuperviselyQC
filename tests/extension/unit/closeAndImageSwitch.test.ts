import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentQcCoordinator } from "../../../extension/src/content/index";
import { installPageBridge } from "../../../extension/src/page/interceptor";
import {
  buildPageBridgeSnapshot,
  createInterceptorState,
  ingestApiPayload,
} from "../../../extension/src/page/slyStoreAdapter";
import {
  DEFAULT_EXTENSION_SETTINGS,
  type ExtensionSettings,
  type PageBridgeSnapshot,
  type QCResponse,
} from "../../../extension/src/shared/types";
import { loadSettings, saveSettings } from "../../../extension/src/shared/storage";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface StorageChangeMap {
  [key: string]: chrome.storage.StorageChange;
}

function makeMockChrome(initialStorage: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initialStorage };
  const storageListeners = new Set<
    (changes: StorageChangeMap, areaName: string) => void
  >();
  const messageListeners = new Set<
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (resp?: unknown) => void,
    ) => unknown
  >();

  let sendMessageHandler: (msg: unknown) => Promise<unknown> = async (msg) => {
    const req = msg as { type?: string };
    if (req?.type === "QC_GET_HEALTH") {
      return {
        ok: true,
        health: { status: "ok", device: "mps", offline: false, models_loaded: [] },
      };
    }
    return { ok: true };
  };

  const chromeMock = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
      sendMessage: vi.fn((msg: unknown, cb?: (resp: unknown) => void) => {
        const p = Promise.resolve().then(() => sendMessageHandler(msg));
        if (cb) {
          p.then((res) => cb(res));
          return;
        }
        return p;
      }),
      onMessage: {
        addListener: vi.fn(
          (
            fn: (
              message: unknown,
              sender: chrome.runtime.MessageSender,
              sendResponse: (resp?: unknown) => void,
            ) => unknown,
          ) => {
            messageListeners.add(fn);
          },
        ),
        removeListener: vi.fn(
          (
            fn: (
              message: unknown,
              sender: chrome.runtime.MessageSender,
              sendResponse: (resp?: unknown) => void,
            ) => unknown,
          ) => {
            messageListeners.delete(fn);
          },
        ),
      },
      connect: vi.fn(() => ({
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      })),
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
          if (typeof keys === "string") {
            return keys in store ? { [keys]: store[keys] } : {};
          }
          if (Array.isArray(keys)) {
            const out: Record<string, unknown> = {};
            for (const k of keys) if (k in store) out[k] = store[k];
            return out;
          }
          return { ...store };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          const changes: StorageChangeMap = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          for (const fn of storageListeners) {
            fn(changes, "local");
          }
        }),
      },
      onChanged: {
        addListener: vi.fn((fn: (changes: StorageChangeMap, areaName: string) => void) => {
          storageListeners.add(fn);
        }),
        removeListener: vi.fn((fn: (changes: StorageChangeMap, areaName: string) => void) => {
          storageListeners.delete(fn);
        }),
      },
    },
  };

  return {
    chromeMock,
    store,
    setSendMessageHandler: (fn: (msg: unknown) => Promise<unknown>) => {
      sendMessageHandler = fn;
    },
    dispatchRuntimeMessage: async (msg: unknown) => {
      for (const fn of messageListeners) {
        await new Promise<void>((resolve) => {
          let responded = false;
          const res = fn(msg, {} as chrome.runtime.MessageSender, () => {
            responded = true;
            resolve();
          });
          if (res !== true && !responded) resolve();
        });
      }
    },
  };
}

function makeQcResponse(imageId: string, overallScore: number): QCResponse {
  return {
    analysisId: `a_${imageId}_${overallScore}`,
    requestId: `r_${imageId}_${overallScore}`,
    jobId: null,
    status: "completed",
    imageId,
    snapshotSeq: 1,
    mode: "deep",
    profileId: "default",
    overallScore,
    readiness: overallScore >= 85 ? "ready" : "needs_review",
    summaryCounts: {
      blocker: 0,
      warning: overallScore >= 85 ? 0 : 1,
      info: 0,
    },
    findings:
      overallScore >= 85
        ? []
        : [
            {
              findingId: `f_${imageId}`,
              ruleId: "GEOM_OUT_OF_BOUNDS",
              severity: "warning",
              category: "geometry",
              title: "Warning",
              message: `Finding for ${imageId}`,
              figureIds: [`fig_${imageId}`],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: false,
              focusRect: null,
              confidence: 1,
              suggestedFixes: [],
              fingerprint: `fp_${imageId}`,
            },
          ],
    missedObjects: [],
    timingMs: { rules: 4, vision: 8, total: 12 },
    engineCapabilities: { device: "mps", modelsUsed: ["yolo11s"] },
    error: null,
  };
}

function makeSnapshotPayload(imageId: string, seq: number): PageBridgeSnapshot {
  const state = createInterceptorState();
  ingestApiPayload(state, "https://app.supervisely.com/api/projects/11402/meta", {
    classes: [{ id: 1, title: "car", shape: "rectangle" }],
  });
  ingestApiPayload(state, `https://app.supervisely.com/api/images/${imageId}`, {
    imageId,
    datasetId: "5501",
    name: `${imageId}.png`,
    width: 1200,
    height: 900,
    hash: `hash_${imageId}`,
    link: `/assets/${imageId}.png`,
  });
  ingestApiPayload(state, `https://app.supervisely.com/api/annotations?imageId=${imageId}`, {
    imageId,
    imageTags: [],
    figures: [
      {
        figureId: `fig_${imageId}`,
        classId: 1,
        classTitle: "car",
        geometryType: "rectangle",
        points: { exterior: [[100, 100], [300, 260]], interior: [] },
        tags: [],
        labelIndex: 1,
      },
    ],
  });
  state.currentImageId = imageId;
  return buildPageBridgeSnapshot(state, seq);
}

function emitBridgeReady(nonce = "test-nonce") {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { source: "SLY_QC_PAGE", type: "SLY_QC_BRIDGE_READY", nonce },
    }),
  );
}

function emitBridgeSnapshot(imageId: string, seq: number, nonce = "test-nonce") {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: {
        source: "SLY_QC_PAGE",
        type: "SLY_QC_SNAPSHOT",
        nonce,
        payload: makeSnapshotPayload(imageId, seq),
      },
    }),
  );
}

function setupWorkspaceDom() {
  document.body.innerHTML = `
    <div id="root">
      <canvas data-testid="sly-canvas" width="980" height="653"></canvas>
      <button id="confirm-btn" data-testid="confirm-btn">Confirm</button>
    </div>
  `;
}

function queryShadowTestId(testId: string): HTMLElement | null {
  const hosts = Array.from(document.querySelectorAll('[data-sly-qc-host="true"]'));
  for (const h of hosts) {
    const found = h.shadowRoot?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (found) return found;
  }
  return null;
}

async function flushUi(ms = 25): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Close persistence & automatic QC on Prev/Next image switch", () => {
  const origChrome = (globalThis as { chrome?: unknown }).chrome;
  const origResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  const trackedWindowListeners: Array<{
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }> = [];
  const origWinAdd = window.addEventListener.bind(window);
  const origWinRemove = window.removeEventListener.bind(window);

  beforeEach(() => {
    vi.useFakeTimers();
    if (typeof globalThis.ResizeObserver === "undefined") {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    vi.spyOn(window, "addEventListener").mockImplementation(
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        trackedWindowListeners.push({ type, listener, options });
        return origWinAdd(type, listener, options);
      },
    );
    window.history.replaceState({}, "", "/app/images2/11402/5501?imageId=img_100");
    setupWorkspaceDom();
  });

  afterEach(() => {
    while (trackedWindowListeners.length > 0) {
      const entry = trackedWindowListeners.pop()!;
      origWinRemove(entry.type, entry.listener, entry.options);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    (globalThis as { chrome?: unknown }).chrome = origChrome;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = origResizeObserver;
  });

  it("defaults autoRunOnImageSwitch=true, assistantClosed=false, and serializes concurrent saveSettings writes", async () => {
    expect(DEFAULT_EXTENSION_SETTINGS.autoRunOnImageSwitch).toBe(true);
    expect(DEFAULT_EXTENSION_SETTINGS.assistantClosed).toBe(false);

    const { chromeMock } = makeMockChrome();
    (globalThis as { chrome?: unknown }).chrome = chromeMock;

    await Promise.all([
      saveSettings({ assistantClosed: true }),
      saveSettings({ defaultMode: "standard" }),
      saveSettings({ autoRunOnImageSwitch: false }),
    ]);

    const loaded = await loadSettings();
    expect(loaded.assistantClosed).toBe(true);
    expect(loaded.defaultMode).toBe("standard");
    expect(loaded.autoRunOnImageSwitch).toBe(false);
  });

  it("emits SLY_QC_SNAPSHOT on history.pushState SPA navigation and prioritizes URL imageId over stale fiber image", async () => {
    const state = createInterceptorState();
    ingestApiPayload(
      state,
      "https://app.supervisely.com/api/images/img_202",
      {
        imageId: "img_202",
        datasetId: "5501",
        name: "next_202.png",
        width: 1000,
        height: 800,
      },
    );
    ingestApiPayload(
      state,
      "https://app.supervisely.com/api/annotations?imageId=img_202",
      {
        imageId: "img_202",
        figures: [
          {
            id: "fig_202",
            classId: 1,
            classTitle: "car",
            geometryType: "rectangle",
            points: { exterior: [[10, 20], [110, 120]], interior: [] },
          },
        ],
      },
    );

    const rootEl = document.getElementById("root")!;
    (rootEl as unknown as Record<string, unknown>).__store = {
      getState: () => ({
        currentImage: { id: "img_201", name: "stale_201.png", width: 800, height: 600 },
        annotations: {
          imageTags: [{ name: "StaleTag" }],
          figures: [
            {
              figureId: "fig_stale_201",
              classTitle: "bus",
              geometryType: "rectangle",
              points: { exterior: [[1, 1], [50, 50]], interior: [] },
            },
          ],
        },
      }),
    };

    const origPushState = window.history.pushState;
    const posted: unknown[] = [];
    const postSpy = vi.spyOn(window, "postMessage").mockImplementation((msg) => {
      posted.push(msg);
    });

    const cleanup = installPageBridge(window, state);
    try {
      const ready = posted[0] as { nonce?: string };
      expect(ready?.nonce).toBeTruthy();

      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: {
            source: "SLY_QC_CONTENT",
            type: "SLY_QC_HANDSHAKE_ACK",
            nonce: ready.nonce,
          },
        }),
      );
      posted.length = 0;

      window.history.pushState({ imageId: "img_202" }, "", "/app/images2/11402/5501?imageId=img_202");
      await flushUi(500);

      const snap = buildPageBridgeSnapshot(state, 5);
      expect(snap.image?.imageId).toBe("img_202");
      expect(snap.figures.map((f) => f.figureId)).toEqual(["fig_202"]);
      expect(snap.imageTags).toEqual([]);
      expect(posted.map((m) => (m as { type?: string })?.type)).toContain("SLY_QC_SNAPSHOT");
    } finally {
      cleanup();
      postSpy.mockRestore();
      expect(window.history.pushState).toBe(origPushState);
    }
  });

  it("stays closed across reload, suppresses image-switch QC and ConfirmGuard while closed, and reopens only on icon click", async () => {
    const initialSettings: Partial<ExtensionSettings> = {
      assistantClosed: true,
      autoRunOnImageSwitch: true,
    };
    const { chromeMock, store, dispatchRuntimeMessage } = makeMockChrome({
      sly_qc_settings_v1: initialSettings,
    });
    (globalThis as { chrome?: unknown }).chrome = chromeMock;

    const coord = new ContentQcCoordinator();
    await act(async () => {
      await coord.init();
      emitBridgeReady();
    });
    await flushUi();

    // Closed at startup -> TopBar and Drawer must NOT render
    expect(queryShadowTestId("qc-topbar")).toBeNull();
    expect(queryShadowTestId("qc-drawer")).toBeNull();

    // Emit initial img_100 and switch to img_101 while closed
    await act(async () => {
      emitBridgeSnapshot("img_100", 1);
      emitBridgeSnapshot("img_101", 2);
    });
    await flushUi(600);

    const runCallsWhileClosed = chromeMock.runtime.sendMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === "QC_ANALYZE",
    );
    expect(runCallsWhileClosed).toHaveLength(0);
    expect(queryShadowTestId("qc-topbar")).toBeNull();

    // Confirm button is NOT intercepted while extension is closed
    let nativeConfirmReached = 0;
    document.getElementById("confirm-btn")!.addEventListener("click", () => {
      nativeConfirmReached += 1;
    });
    await act(async () => {
      document.getElementById("confirm-btn")!.click();
    });
    await flushUi();
    expect(nativeConfirmReached).toBe(1);
    expect(queryShadowTestId("qc-confirm-modal")).toBeNull();

    // Alt+Q keyboard shortcut must not open/run while closed
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", code: "KeyQ", altKey: true }));
    });
    await flushUi();
    expect(queryShadowTestId("qc-topbar")).toBeNull();

    // Clicking the extension icon (QC_SHOW_TOPBAR_FROM_ACTION) reopens TopBar and persists assistantClosed=false
    await act(async () => {
      await dispatchRuntimeMessage({ type: "QC_SHOW_TOPBAR_FROM_ACTION" });
    });
    await flushUi();

    expect(queryShadowTestId("qc-topbar")).not.toBeNull();
    expect((store.sly_qc_settings_v1 as ExtensionSettings).assistantClosed).toBe(false);

    // Clicking Close (×) persists assistantClosed=true again and hides TopBar
    await act(async () => {
      queryShadowTestId("qc-topbar-close")!.click();
    });
    await flushUi();
    expect(queryShadowTestId("qc-topbar")).toBeNull();
    expect((store.sly_qc_settings_v1 as ExtensionSettings).assistantClosed).toBe(true);
  });

  it("auto-runs QC on every Prev/Next image switch when open and discards stale in-flight responses", async () => {
    const { chromeMock, setSendMessageHandler } = makeMockChrome({
      sly_qc_settings_v1: { assistantClosed: false, autoRunOnImageSwitch: true },
    });
    (globalThis as { chrome?: unknown }).chrome = chromeMock;

    let resolveDeferredImg101: ((val: unknown) => void) | null = null;
    const requestedImageIds: string[] = [];
    setSendMessageHandler(async (msg) => {
      const m = msg as {
        type?: string;
        request?: { image?: { imageId?: string }; imageId?: string };
        payload?: { image?: { imageId?: string }; imageId?: string };
      };
      if (m.type === "QC_GET_HEALTH") {
        return {
          ok: true,
          health: { status: "ok", device: "mps", offline: false, models_loaded: [] },
        };
      }
      if (m.type === "QC_IMAGE_HEAD") {
        return { hit: true };
      }
      if (m.type === "QC_ANALYZE") {
        const reqObj = m.request ?? m.payload;
        const imgId = reqObj?.image?.imageId ?? reqObj?.imageId ?? "unknown";
        requestedImageIds.push(imgId);
        if (imgId === "img_101" && requestedImageIds.filter((id) => id === "img_101").length === 1) {
          return new Promise((resolve) => {
            resolveDeferredImg101 = resolve;
          });
        }
        return { ok: true, data: makeQcResponse(imgId, imgId === "img_102" ? 100 : 72) };
      }
      return { ok: true };
    });

    const coord = new ContentQcCoordinator();
    await act(async () => {
      await coord.init();
      emitBridgeReady();
    });
    await flushUi();

    // Initial page load (lastImageId: null -> img_100) must NOT auto-run QC
    await act(async () => {
      emitBridgeSnapshot("img_100", 1);
    });
    await flushUi(550);
    expect(requestedImageIds).toEqual([]);
    expect(queryShadowTestId("qc-score-pill")?.textContent).toBe("QC --");

    // Switch 1: img_100 -> img_101 (stays deferred to simulate slow Vision inference)
    await act(async () => {
      window.history.replaceState({}, "", "/app/images2/11402/5501?imageId=img_101");
      emitBridgeSnapshot("img_101", 2);
    });
    await flushUi(550);
    expect(requestedImageIds).toEqual(["img_101"]);

    // Switch 2: quickly Next to img_102 before img_101 finishes
    await act(async () => {
      window.history.replaceState({}, "", "/app/images2/11402/5501?imageId=img_102");
      emitBridgeSnapshot("img_102", 3);
    });
    await flushUi(550);
    expect(requestedImageIds).toEqual(["img_101", "img_102"]);
    expect(queryShadowTestId("qc-score-pill")?.textContent).toBe("QC 100");

    // Now the stale img_101 response arrives late -> must NOT overwrite img_102's score (100)!
    await act(async () => {
      resolveDeferredImg101!({ ok: true, data: makeQcResponse("img_101", 55) });
    });
    await flushUi();
    expect(queryShadowTestId("qc-score-pill")?.textContent).toBe("QC 100");

    // Switch 3: Prev back to img_101 -> triggers a fresh QC run on img_101 too (every switch)
    await act(async () => {
      window.history.replaceState({}, "", "/app/images2/11402/5501?imageId=img_101");
      emitBridgeSnapshot("img_101", 4);
    });
    await flushUi(550);
    expect(requestedImageIds).toEqual(["img_101", "img_102", "img_101"]);
    expect(queryShadowTestId("qc-score-pill")?.textContent).toBe("QC 92");
  });
});
