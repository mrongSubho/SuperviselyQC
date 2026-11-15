import { describe, expect, it, vi } from "vitest";
import {
  base64ToUint8Array,
  concatUploadChunks,
  type PendingChunkUpload,
} from "../../../extension/src/background/imageCacheRelay";
import {
  extractDomObjectTags,
  extractDomOntologyClasses,
  extractDomResolutionHint,
  extractLargestDomImageElement,
} from "../../../extension/src/content/domObserver";
import {
  ensureImageCachedForVision,
  isExternalCdnUrl,
  UPLOAD_CHUNK_BYTES,
} from "../../../extension/src/content/imageFetcher";
import { evaluateConfirmGuard } from "../../../extension/src/content/ui/ConfirmGuard";
import { installPageBridge } from "../../../extension/src/page/interceptor";
import {
  isNonWorkspaceImageUrl,
  isPermittedServiceWorkerFetchUrl,
} from "../../../extension/src/shared/imageUrlFilter";
import {
  buildPageBridgeSnapshot,
  createInterceptorState,
  extractFromReactStore,
  ingestApiPayload,
  pushReplayEntry,
} from "../../../extension/src/page/slyStoreAdapter";
import type { QCResponse, SwRequestMessage, SwUploadPortMessage } from "../../../extension/src/shared/types";

describe("Page bridge replay buffer, CDN chunk relay, and ConfirmGuard", () => {
  it("caps __slyQcReplayBuffer at 50 entries and completes SLY_QC_HELLO handshake", async () => {
    const state = createInterceptorState();
    for (let i = 1; i <= 65; i += 1) {
      pushReplayEntry(state, {
        url: `https://app.supervisely.com/api/images/${i}`,
        capturedAtMs: i,
        kind: "image",
        data: { id: i },
      });
    }
    expect(state.replayBuffer).toHaveLength(50);
    expect((state.replayBuffer[0]?.data as { id: number }).id).toBe(16);

    const posted: unknown[] = [];
    const origPost = window.postMessage.bind(window);
    const spy = vi.spyOn(window, "postMessage").mockImplementation((msg, targetOrigin) => {
      posted.push(msg);
      return origPost(msg, typeof targetOrigin === "string" ? targetOrigin : "*");
    });

    const cleanup = installPageBridge(window, state);
    try {
      expect(posted.length).toBeGreaterThanOrEqual(1);
      const ready = posted[0] as { source: string; type: string; nonce: string };
      expect(ready.source).toBe("SLY_QC_PAGE");
      expect(ready.type).toBe("SLY_QC_BRIDGE_READY");
      expect(ready.nonce.length).toBeGreaterThan(0);

      // Sending SLY_QC_HELLO re-emits SLY_QC_BRIDGE_READY
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { source: "SLY_QC_CONTENT", type: "SLY_QC_HELLO" },
        }),
      );
      const latest = posted[posted.length - 1] as { type: string; nonce: string };
      expect(latest.type).toBe("SLY_QC_BRIDGE_READY");
      expect(latest.nonce).toBe(ready.nonce);
    } finally {
      cleanup();
      spy.mockRestore();
    }
  });

  it("streams 2.3 MiB external CDN image with credentials=omit and 1 MiB Port chunks reassembled identically", async () => {
    expect(
      isExternalCdnUrl(
        "https://s3.amazonaws.com/bucket/frame.jpg",
        "https://app.supervisely.com",
      ),
    ).toBe(true);
    expect(
      isExternalCdnUrl(
        "https://app.supervisely.com/api/images/1/download",
        "https://app.supervisely.com",
      ),
    ).toBe(false);

    const size = Math.floor(2.3 * 1024 * 1024);
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      original[i] = (i * 31 + 7) & 0xff;
    }

    const fetchCalls: Array<{ url: string; credentials?: RequestCredentials }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), credentials: init?.credentials });
      return new Response(original.buffer.slice(0), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const portMessages: SwUploadPortMessage[] = [];
    const session: PendingChunkUpload = {
      imageId: "",
      imageHash: "",
      width: 0,
      height: 0,
      contentType: "",
      totalBytes: 0,
      chunks: new Map(),
      receivedBytes: 0,
    };

    const res = await ensureImageCachedForVision(
      {
        imageId: "img_cdn_1",
        datasetId: "ds_1",
        fileName: "cdn.png",
        width: 2048,
        height: 1536,
        imageHash: "sha256:cdn1",
      },
      "https://cdn.example.com/signed/img.png",
      {
        pageOrigin: "https://app.supervisely.com",
        fetchFn: mockFetch,
        sendMessage: (async () => ({ hit: false })) as <T = unknown>() => Promise<T>,
        openUploadPort: () => ({
          postMessage: (msg) => {
            portMessages.push(msg);
            if (msg.type === "UPLOAD_INIT") {
              session.imageId = msg.imageId;
              session.imageHash = msg.imageHash;
              session.totalBytes = msg.totalBytes;
            } else if (msg.type === "UPLOAD_CHUNK") {
              const decoded = base64ToUint8Array(msg.dataB64);
              session.chunks.set(msg.chunkIndex, decoded);
              session.receivedBytes += decoded.byteLength;
            }
          },
          onAck: async () => ({ ok: true }),
          disconnect: () => undefined,
        }),
      },
    );

    expect(res.cached).toBe(true);
    expect(fetchCalls).toEqual([
      { url: "https://cdn.example.com/signed/img.png", credentials: "omit" },
    ]);

    const chunkMsgs = portMessages.filter((m) => m.type === "UPLOAD_CHUNK");
    expect(chunkMsgs).toHaveLength(Math.ceil(size / UPLOAD_CHUNK_BYTES));
    const reassembled = concatUploadChunks(session);
    expect(reassembled.byteLength).toBe(original.byteLength);
    expect(Buffer.from(reassembled).equals(Buffer.from(original))).toBe(true);
  });

  it("enforces ConfirmGuard strictness modes and respects dismissed blockers", () => {
    const resp: QCResponse = {
      analysisId: "a1",
      requestId: "r1",
      jobId: null,
      status: "completed",
      imageId: "img1",
      snapshotSeq: 1,
      mode: "standard",
      profileId: "default",
      overallScore: 60,
      readiness: "blocked",
      summaryCounts: { blocker: 1, warning: 0, info: 0 },
      findings: [
        {
          findingId: "f1",
          ruleId: "GEOM_OUT_OF_BOUNDS",
          severity: "blocker",
          category: "geometry",
          title: "OOB",
          message: "Out of bounds",
          figureIds: ["fig1"],
          imageTagNames: [],
          missedObjectIds: [],
          outsideViewport: false,
          focusRect: null,
          confidence: 1,
          suggestedFixes: [],
          fingerprint: "fp_oob_1",
        },
      ],
      missedObjects: [],
      timingMs: { rules: 5, vision: 0, total: 5 },
      engineCapabilities: { device: "cpu", modelsUsed: [] },
      error: null,
    };

    expect(
      evaluateConfirmGuard({
        enabled: true,
        strictness: "off",
        synchronizeDirty: true,
        response: resp,
        dismissedFingerprints: new Set(),
      }).allowed,
    ).toBe(true);

    const dirtyDecision = evaluateConfirmGuard({
      enabled: true,
      strictness: "blockers_and_dirty_sync",
      synchronizeDirty: true,
      response: null,
      dismissedFingerprints: new Set(),
    });
    expect(dirtyDecision.allowed).toBe(false);

    const blockerOnlyDirtyAllowed = evaluateConfirmGuard({
      enabled: true,
      strictness: "blockers_only",
      synchronizeDirty: true,
      response: null,
      dismissedFingerprints: new Set(),
    });
    expect(blockerOnlyDirtyAllowed.allowed).toBe(true);

    const dismissedAllowed = evaluateConfirmGuard({
      enabled: true,
      strictness: "blockers_and_dirty_sync",
      synchronizeDirty: false,
      response: resp,
      dismissedFingerprints: new Set(["fp_oob_1"]),
    });
    expect(dismissedAllowed.allowed).toBe(true);
  });

  it("extracts Supervisely v3 entities list and Konva image URL and falls back to canvas capture upload when URL missing", async () => {
    const state = createInterceptorState();
    ingestApiPayload(state, "https://quantigo.supervisely.com/public/api/v3/images.list", {
      entities: [
        {
          id: 20428721,
          name: "Group_of_Horses_4K_Image.jpg",
          pathOriginal: "/h5un6l2/horses_4k.jpg",
          meta: { width: 3840, height: 2160 },
        },
      ],
    });
    const snap = buildPageBridgeSnapshot(state, 1);
    expect(state.imagesById["20428721"]?.url).toBe("/h5un6l2/horses_4k.jpg");
    expect(state.imagesById["20428721"]?.meta.width).toBe(3840);
    expect(snap).toBeDefined();

    // Test fallbackCaptureFn path when originalImageUrl is null and HEAD misses
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer;
    const uploaded: SwUploadPortMessage[] = [];
    const res = await ensureImageCachedForVision(
      {
        imageId: "20428721",
        datasetId: "38357",
        fileName: "Group_of_Horses_4K_Image.jpg",
        width: 3840,
        height: 2160,
        imageHash: "sly:20428721",
      },
      null,
      {
        pageOrigin: "https://quantigo.supervisely.com",
        sendMessage: (async () => ({ hit: false })) as <T = unknown>() => Promise<T>,
        openUploadPort: () => ({
          postMessage: (msg) => uploaded.push(msg),
          onAck: async () => ({ ok: true }),
          disconnect: () => undefined,
        }),
        fallbackCaptureFn: async () => ({
          buffer: jpegBytes,
          contentType: "image/jpeg",
          width: 1920,
          height: 1080,
        }),
      },
    );

    expect(res.cached).toBe(true);
    expect(uploaded[0]?.type).toBe("UPLOAD_INIT");
    expect(uploaded.some((m) => m.type === "UPLOAD_CHUNK")).toBe(true);
    expect(uploaded[uploaded.length - 1]?.type).toBe("UPLOAD_COMMIT");
  });

  it("extracts Supervisely v3 fileMeta dimensions and XHR responseType='json' payloads", () => {
    const state = createInterceptorState();
    ingestApiPayload(state, "https://quantigo.supervisely.com/public/api/v3/projects.meta", {
      data: {
        classes: [
          { id: 10, title: "Horse", shape: "rectangle", color: "#10b981" },
          { id: 11, title: "Human", shape: "rectangle", color: "#ef4444" },
        ],
        tags: [{ id: 1, name: "Occlusion", valueType: "none", applicableType: "objectsOnly" }],
      },
    });
    ingestApiPayload(state, "https://quantigo.supervisely.com/public/api/v3/images.info", {
      result: {
        id: 20428721,
        datasetId: 38357,
        name: "Group_of_Horses_4K_Image.jpg",
        hash: "aPs3ZhNN3i+h1MRGxSHj8RErx4uKVsNAf/MH677diAU=",
        fileMeta: { width: 3840, height: 2160 },
        fullStorageUrl: "https://quantigo.supervisely.com/h5un6l2/images/original.jpg",
      },
    });

    const snap = buildPageBridgeSnapshot(state, 1);
    expect(snap.image?.width).toBe(3840);
    expect(snap.image?.height).toBe(2160);
    expect(snap.image?.imageHash).toBe("aPs3ZhNN3i+h1MRGxSHj8RErx4uKVsNAf/MH677diAU=");
    expect(snap.ontology?.classes.map((c) => c.title)).toEqual(["Horse", "Human"]);
    expect(snap.originalImageUrl).toBe(
      "https://quantigo.supervisely.com/h5un6l2/images/original.jpg",
    );
  });

  it("handles XHR with responseType='json' where responseText throws InvalidStateError", () => {
    const loadHandlers: Array<() => void> = [];
    class MockXhr {
      responseType = "json";
      status = 200;
      response = {
        classes: [{ id: 1, title: "Horse", shape: "rectangle" }],
      };
      get responseText(): string {
        throw new DOMException("InvalidStateError");
      }
      addEventListener(evt: string, cb: () => void): void {
        if (evt === "load") loadHandlers.push(cb);
      }
      open(): void {}
      send(): void {}
    }

    const fakeWin = {
      fetch: async () => new Response("{}"),
      XMLHttpRequest: MockXhr,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      postMessage: () => undefined,
      document: { readyState: "complete" },
      location: { origin: "https://quantigo.supervisely.com" },
    } as unknown as Window & typeof globalThis;

    const bridgeState = createInterceptorState();
    const cleanup = installPageBridge(fakeWin, bridgeState);
    try {
      const xhr = new MockXhr();
      fakeWin.XMLHttpRequest.prototype.open.call(
        xhr as unknown as XMLHttpRequest,
        "GET",
        "https://quantigo.supervisely.com/public/api/v3/projects.meta?id=99",
        true,
      );
      fakeWin.XMLHttpRequest.prototype.send.call(xhr as unknown as XMLHttpRequest, null);
      for (const cb of loadHandlers) cb();

      expect(bridgeState.classes.map((c) => c.title)).toEqual(["Horse"]);
    } finally {
      cleanup();
    }
  });

  it("extracts div-based Definitions -> CLASSES rows and active resolution hint from DOM", () => {
    document.body.innerHTML = `
      <aside class="left-panel">
        <div>Definitions</div>
        <div class="section">
          <div>CLASSES</div>
          <div><svg></svg><span>Animal</span></div>
          <div><svg></svg><span>Horse</span></div>
          <div><svg></svg><span>Human</span></div>
          <div>CURRENT IMAGE TAGS</div>
          <div><span>Occlusion</span></div>
        </div>
      </aside>
      <div class="filmstrip">
        <div class="item selected">
          <span>Group_of_Hor...</span>
          <span>3840 × 2160</span>
        </div>
        <div class="item">
          <span>other_img.jpg</span>
          <span>5472 × 3648</span>
        </div>
      </div>
    `;
    try {
      const domClasses = extractDomOntologyClasses();
      expect(domClasses.map((c) => c.title)).toEqual(["Animal", "Horse", "Human"]);

      const resHint = extractDomResolutionHint("Group_of_Horses_4K_Image.jpg");
      expect(resHint).toEqual({ width: 3840, height: 2160 });
    } finally {
      document.body.innerHTML = "";
    }
  });

  it("extracts Supervisely v3 nested geometry.points.exterior figures from Redux slices and React hooks", () => {
    const state = createInterceptorState();
    ingestApiPayload(
      state,
      "https://quantigo.supervisely.com/public/api/v3/projects.meta?id=10",
      {
        classes: [{ id: 701, title: "Human", shape: "rectangle", color: "#10b981" }],
      },
    );
    state.currentImageId = "21672930";
    state.imagesById["21672930"] = {
      meta: {
        imageId: "21672930",
        datasetId: "38357",
        jobId: "95492",
        fileName: "city.jpg",
        width: 5472,
        height: 3648,
        imageHash: "hash_city",
      },
      url: "https://quantigo.supervisely.com/images/city.jpg",
    };

    const host = document.createElement("div");
    (host as unknown as Record<string, unknown>).__reactContainer$qc = {
      memoizedProps: {
        store: {
          getState: () => ({
            annotationTool: {
              figuresById: {
                fig_redux_1: {
                  id: "fig_redux_1",
                  classId: 701,
                  geometryType: "rectangle",
                  geometry: {
                    points: {
                      exterior: [
                        { x: 100, y: 200 },
                        { x: 420, y: 900 },
                      ],
                    },
                  },
                },
                fig_redux_2: {
                  id: "fig_redux_2",
                  classTitle: "Human",
                  geometryType: "rectangle",
                  geometry: {
                    points: {
                      exterior: [
                        [500, 220],
                        [840, 950],
                      ],
                    },
                  },
                },
              },
            },
          }),
        },
      },
      child: null,
      sibling: null,
    };
    document.body.appendChild(host);

    try {
      const slice = extractFromReactStore(state);
      expect(slice.figures.length).toBeGreaterThanOrEqual(2);
      const fig1 = slice.figures.find((f) => f.figureId === "fig_redux_1");
      expect(fig1).toBeDefined();
      expect(fig1?.classTitle).toBe("Human");
      expect(fig1?.geometryType).toBe("rectangle");
      if (fig1?.geometryType === "rectangle") {
        expect(fig1.points.exterior).toEqual([
          [100, 200],
          [420, 900],
        ]);
      }

      const snap = buildPageBridgeSnapshot(state, 1);
      expect(snap.figures.map((f) => f.figureId)).toContain("fig_redux_1");
      expect(snap.figures.map((f) => f.figureId)).toContain("fig_redux_2");

      // Also verify React 18 hook .next traversal when figures reside only in component hooks
      document.body.innerHTML = "";
      const hookHost = document.createElement("div");
      (hookHost as unknown as Record<string, unknown>).__reactContainer$hook = {
        memoizedState: {
          memoizedState: null,
          next: {
            memoizedState: {
              figures: [
                {
                  id: "fig_hook_1",
                  classTitle: "Human",
                  geometryType: "rectangle",
                  geometry: {
                    points: {
                      exterior: [
                        [60, 80],
                        [220, 480],
                      ],
                    },
                  },
                },
              ],
            },
            next: null,
          },
        },
        child: null,
        sibling: null,
      };
      document.body.appendChild(hookHost);
      const hookSlice = extractFromReactStore(state);
      expect(hookSlice.figures.map((f) => f.figureId)).toContain("fig_hook_1");
    } finally {
      document.body.innerHTML = "";
    }
  });

  it("dispatches stepped mouse drag sequence on canvas for SLY_QC_SIMULATE_RECT_DRAW", async () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);

    const events: Array<{ type: string; x: number; y: number }> = [];
    for (const evtType of ["mousedown", "mousemove", "mouseup", "click"] as const) {
      canvas.addEventListener(evtType, (e: Event) => {
        const me = e as MouseEvent;
        events.push({ type: evtType, x: me.clientX, y: me.clientY });
      });
    }

    const posted: unknown[] = [];
    const origPost = window.postMessage.bind(window);
    const spy = vi.spyOn(window, "postMessage").mockImplementation((msg, targetOrigin) => {
      posted.push(msg);
      return origPost(msg, typeof targetOrigin === "string" ? targetOrigin : "*");
    });

    const state = createInterceptorState();
    const cleanup = installPageBridge(window, state);
    try {
      const ready = posted[0] as { nonce: string };
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: {
            source: "SLY_QC_CONTENT",
            type: "SLY_QC_SIMULATE_RECT_DRAW",
            nonce: ready.nonce,
            clientRect: { x1: 120, y1: 140, x2: 320, y2: 380 },
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 140));

      expect(events[0]).toEqual({ type: "mousedown", x: 120, y: 140 });
      const moves = events.filter((e) => e.type === "mousemove");
      expect(moves).toHaveLength(4);
      expect(moves[3]).toEqual({ type: "mousemove", x: 320, y: 380 });
      expect(events.some((e) => e.type === "mouseup" && e.x === 320 && e.y === 380)).toBe(true);
      expect(events.some((e) => e.type === "click" && e.x === 320 && e.y === 380)).toBe(true);
    } finally {
      cleanup();
      spy.mockRestore();
      document.body.innerHTML = "";
    }
  });

  it("extracts Konva stage Group/Rect figures via React Fiber without window.Konva, bulkInfo maps, and ignores sidebar/guide <img>", () => {
    const state = createInterceptorState();
    ingestApiPayload(state, "https://quantigo.supervisely.com/public/api/v3/projects.meta?id=1", {
      classes: [{ id: 201, title: "Human", shape: "rectangle" }],
    });
    ingestApiPayload(state, "https://quantigo.supervisely.com/public/api/v3/annotations.bulkInfo", {
      "21672930": {
        size: { width: 5472, height: 3648 },
        objects: [
          {
            id: "bulk_fig_1",
            classId: 201,
            geometryType: "rectangle",
            points: { exterior: [[100, 200], [500, 900]], interior: [] },
          },
        ],
      },
    });
    expect(state.annotationsByImageId["21672930"]?.figures).toHaveLength(1);
    expect(state.annotationsByImageId["21672930"]?.figures[0]?.classTitle).toBe("Human");

    // Verify React Fiber on .konvajs-content discovers bundled Konva stage without global window.Konva
    const emptyState = createInterceptorState();
    const konvaDiv = document.createElement("div");
    konvaDiv.className = "konvajs-content";
    const fakeStage = {
      scaleX: () => 0.25,
      scaleY: () => 0.25,
      x: () => 12,
      y: () => 8,
      find: (sel: string) => {
        if (sel === "Image") {
          return [
            {
              image: () => ({
                currentSrc: "https://quantigo.supervisely.com/h5un/full_5472.jpg",
                naturalWidth: 5472,
                naturalHeight: 3648,
              }),
            },
          ];
        }
        return [];
      },
      getLayers: () => [
        {
          find: () => [
            {
              getParent: () => ({
                getAttrs: () => ({ figureId: "k_fig_1", classTitle: "Human" }),
              }),
              getAttrs: () => ({ x: 400, y: 600, width: 320, height: 640 }),
            },
          ],
        },
      ],
    };
    (konvaDiv as unknown as Record<string, unknown>).__reactFiber$k = {
      stateNode: konvaDiv,
      memoizedProps: { stage: fakeStage },
      return: {
        dependencies: {
          firstContext: {
            context: {
              _currentValue: {
                currentImageId: "21672930",
              },
            },
            next: null,
          },
        },
        return: null,
      },
    };
    document.body.appendChild(konvaDiv);

    // Also add a hidden/sidebar 696x1000 rogue <img> that must be ignored
    const aside = document.createElement("aside");
    const rogueImg = document.createElement("img");
    Object.defineProperty(rogueImg, "naturalWidth", { value: 696 });
    Object.defineProperty(rogueImg, "naturalHeight", { value: 1000 });
    rogueImg.src = "https://quantigo.supervisely.com/static/guide_696x1000.png";
    aside.appendChild(rogueImg);
    document.body.appendChild(aside);

    try {
      const snap = buildPageBridgeSnapshot(emptyState, 7);
      expect(snap.originalImageUrl).toBe("https://quantigo.supervisely.com/h5un/full_5472.jpg");
      expect(snap.canvasTransform?.scaleX).toBe(0.25);
      expect(snap.figures.map((f) => f.figureId)).toContain("k_fig_1");
      expect(snap.figures[0]?.classTitle).toBe("Human");
      expect(extractLargestDomImageElement()).toBeNull();
    } finally {
      document.body.innerHTML = "";
    }
  });

  it("ignores GitHub/ecosystem asset URLs, blocks unpermitted third-party SW fetches, and fetches blob URLs in content script", async () => {
    const githubAssetUrl =
      "https://github.com/supervisely-ecosystem/ilastik-pixel-classification/assets/79905215/e5d86bea-7ae7-41dc-8697-dec8eb4c684f";
    expect(isNonWorkspaceImageUrl(githubAssetUrl)).toBe(true);
    expect(isPermittedServiceWorkerFetchUrl(githubAssetUrl, "https://quantigo.supervisely.com")).toBe(
      false,
    );
    expect(
      isPermittedServiceWorkerFetchUrl(
        "https://quantigo.supervisely.com/h5un/img.jpg",
        "https://quantigo.supervisely.com",
      ),
    ).toBe(true);

    // DOM <img> pointing to github.com/supervisely-ecosystem is ignored even outside <aside>
    const div = document.createElement("div");
    const ecoImg = document.createElement("img");
    Object.defineProperty(ecoImg, "naturalWidth", { value: 696 });
    Object.defineProperty(ecoImg, "naturalHeight", { value: 1000 });
    ecoImg.src = githubAssetUrl;
    div.appendChild(ecoImg);
    document.body.appendChild(div);
    try {
      expect(extractLargestDomImageElement()).toBeNull();
    } finally {
      document.body.innerHTML = "";
    }

    // External non-SW URL failure never invokes SW QC_FETCH_AND_CACHE_SAME_ORIGIN_IMAGE
    const swMessages: string[] = [];
    const fallbackBuf = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    const extFailRes = await ensureImageCachedForVision(
      {
        imageId: "21672930",
        datasetId: "38357",
        fileName: "a1bc.jpg",
        width: 5472,
        height: 3648,
        imageHash: "sly:21672930",
      },
      "https://example-cdn.invalid/no-cors.jpg",
      {
        pageOrigin: "https://quantigo.supervisely.com",
        fetchFn: vi.fn(async () => {
          throw new TypeError("CORS error");
        }) as unknown as typeof fetch,
        sendMessage: (async (msg: SwRequestMessage) => {
          swMessages.push(msg.type);
          return { hit: false };
        }) as <T>(msg: SwRequestMessage) => Promise<T>,
        openUploadPort: () => ({
          postMessage: vi.fn(),
          onAck: async () => ({ ok: true }),
          disconnect: vi.fn(),
        }),
        fallbackCaptureFn: async () => ({
          buffer: fallbackBuf,
          contentType: "image/jpeg",
          width: 1798,
          height: 1452,
          source: "canvas",
        }),
      },
    );
    expect(extFailRes.cached).toBe(true);
    expect(extFailRes.fromCanvasCapture).toBe(true);
    expect(swMessages).not.toContain("QC_FETCH_AND_CACHE_SAME_ORIGIN_IMAGE");

    // blob: URLs are fetched directly in Content Script rather than forwarded to SW
    const png1x1 = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x0f, 0x00, 0x00, 0x00, 0x08, 0x70, 0x08, 0x02, 0x00, 0x00, 0x00,
    ]);
    const blobSwMsgs: string[] = [];
    const blobRes = await ensureImageCachedForVision(
      {
        imageId: "21672931",
        datasetId: "38357",
        fileName: "blob.png",
        width: 3840,
        height: 2160,
        imageHash: "sly:21672931",
      },
      "blob:https://quantigo.supervisely.com/11111111-2222-3333-4444-555555555555",
      {
        pageOrigin: "https://quantigo.supervisely.com",
        fetchFn: vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: async () => png1x1.buffer.slice(0),
        })) as unknown as typeof fetch,
        sendMessage: (async (msg: SwRequestMessage) => {
          blobSwMsgs.push(msg.type);
          return { hit: false };
        }) as <T>(msg: SwRequestMessage) => Promise<T>,
        openUploadPort: () => ({
          postMessage: vi.fn(),
          onAck: async () => ({ ok: true }),
          disconnect: vi.fn(),
        }),
      },
    );
    expect(blobRes.cached).toBe(true);
    expect(blobRes.width).toBe(3840);
    expect(blobRes.height).toBe(2160);
    expect(blobSwMsgs).not.toContain("QC_FETCH_AND_CACHE_SAME_ORIGIN_IMAGE");
  });

  it("extracts dynamic object tags (Occlusion, Truncation, Male, Female) from CURRENT OBJECT TAGS panel", () => {
    document.body.innerHTML = `
      <aside>
        <div>CURRENT OBJECT ...512 TAGS</div>
        <label><input type="checkbox" /> <span>Occlusion</span></label>
        <label><input type="checkbox" /> <span>Truncation</span></label>
        <label><input type="checkbox" /> <span>Male</span></label>
        <label><input type="checkbox" /> <span>Female</span></label>
      </aside>
    `;
    try {
      const tags = extractDomObjectTags();
      expect(tags.map((t) => t.name)).toEqual(["Occlusion", "Truncation", "Male", "Female"]);
    } finally {
      document.body.innerHTML = "";
    }
  });
});
