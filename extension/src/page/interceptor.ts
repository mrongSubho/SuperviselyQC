import { isNonWorkspaceImageUrl } from "../shared/imageUrlFilter";
import type { ContentToPageMessage, PageToContentMessage } from "../shared/types";
import {
  buildPageBridgeSnapshot,
  createInterceptorState,
  ingestApiPayload,
  type InterceptorRuntimeState,
} from "./slyStoreAdapter";

const INTERESTING_API_RE =
  /(\/projects\/\d+\/meta|projects\.|labeling-jobs|entities\.|\/entities\/|\/datasets\/|\/images|images\.|\/annotations|annotations\.|\/figures|\/tags|\/app\/images2|\/rpc\/|bulkInfo)/i;

function makeNonce(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function shouldInspectUrl(url: string): boolean {
  return INTERESTING_API_RE.test(url);
}

export function installPageBridge(
  targetWindow: Window = window,
  state: InterceptorRuntimeState = createInterceptorState(),
): () => void {
  const nonce = makeNonce();
  let snapshotSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let handshakeEstablished = false;

  const postToContent = (msg: PageToContentMessage) => {
    try {
      targetWindow.postMessage(msg, targetWindow.location.origin);
    } catch {
      targetWindow.postMessage(msg, "*");
    }
  };

  const emitSnapshot = () => {
    snapshotSeq += 1;
    const payload = buildPageBridgeSnapshot(state, snapshotSeq);
    postToContent({
      source: "SLY_QC_PAGE",
      type: "SLY_QC_SNAPSHOT",
      nonce,
      payload,
    });
  };

  const scheduleSnapshot = () => {
    if (!handshakeEstablished) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emitSnapshot();
    }, 180);
  };

  // 1. Hook window.fetch non-destructively (read-only .clone() inspection)
  const origFetch = targetWindow.fetch.bind(targetWindow);
  targetWindow.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await origFetch(input, init);
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url && shouldInspectUrl(url) && response.ok) {
        const ct = response.headers.get("content-type") ?? "";
        if (ct.includes("application/json") || ct === "") {
          void response
            .clone()
            .json()
            .then((json) => {
              ingestApiPayload(state, url, json);
              scheduleSnapshot();
            })
            .catch(() => undefined);
        }
      }
    } catch {
      // Never interfere with host page requests
    }
    return response;
  };

  // 2. Hook XMLHttpRequest non-destructively
  const XhrProto = (targetWindow as Window & typeof globalThis).XMLHttpRequest.prototype;
  const origOpen = XhrProto.open;
  const origSend = XhrProto.send;
  const urlWeakMap = new WeakMap<XMLHttpRequest, string>();

  XhrProto.open = function (
    method: string,
    url: string | URL,
    asyncFlag?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    try {
      urlWeakMap.set(this, String(url));
    } catch {
      // ignore
    }
    return origOpen.call(
      this,
      method,
      url,
      asyncFlag ?? true,
      username ?? null,
      password ?? null,
    );
  };

  XhrProto.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const reqUrl = urlWeakMap.get(this) ?? "";
      if (reqUrl && shouldInspectUrl(reqUrl)) {
        this.addEventListener("load", () => {
          try {
            if (this.status >= 200 && this.status < 300) {
              // Reading responseText throws InvalidStateError when responseType is "json" (Axios/v3 APIs).
              if (this.responseType === "json" && this.response !== null && typeof this.response === "object") {
                ingestApiPayload(state, reqUrl, this.response);
                scheduleSnapshot();
              } else if (
                (this.responseType === "" || this.responseType === "text") &&
                typeof this.responseText === "string"
              ) {
                const trimmed = this.responseText.trim();
                if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                  const json = JSON.parse(trimmed) as unknown;
                  ingestApiPayload(state, reqUrl, json);
                  scheduleSnapshot();
                }
              }
            }
          } catch {
            // Ignore malformed or binary payloads
          }
        });
      }
    } catch {
      // Ignore
    }
    return origSend.call(this, body);
  };

  // 3. Handshake & snapshot request listener
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== targetWindow) return;
    const data = event.data as Partial<ContentToPageMessage> & { type?: string };
    if (!data || data.source !== "SLY_QC_CONTENT") return;

    if (data.type === "SLY_QC_HELLO") {
      postToContent({
        source: "SLY_QC_PAGE",
        type: "SLY_QC_BRIDGE_READY",
        nonce,
      });
      return;
    }

    if (data.nonce !== nonce) return;

    if (data.type === "SLY_QC_HANDSHAKE_ACK") {
      handshakeEstablished = true;
      emitSnapshot();
    } else if (data.type === "SLY_QC_REQUEST_SNAPSHOT") {
      handshakeEstablished = true;
      emitSnapshot();
    } else if (data.type === "SLY_QC_SIMULATE_RECT_DRAW" && data.clientRect) {
      const { x1, y1, x2, y2 } = data.clientRect;
      const canvases = Array.from(targetWindow.document.querySelectorAll("canvas")).filter(
        (c) => !c.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host, #sly-qc-overlay-host"),
      );
      let canvas: HTMLCanvasElement | null = null;
      let bestArea = 0;
      for (const c of canvases) {
        const r = c.getBoundingClientRect();
        if (r.width * r.height > bestArea) {
          bestArea = r.width * r.height;
          canvas = c;
        }
      }
      if (canvas) {
        let safeView: Window | undefined = targetWindow;
        try {
          // Verify runtime realm accepts `view: targetWindow` (strict in jsdom)
          new MouseEvent("mousemove", { view: safeView });
        } catch {
          safeView = undefined;
        }
        const dispatchPair = (
          target: EventTarget,
          ptrType: string,
          mouseType: string,
          cx: number,
          cy: number,
          buttons: number,
        ) => {
          try {
            if (typeof PointerEvent === "function") {
              target.dispatchEvent(
                new PointerEvent(ptrType, {
                  bubbles: true,
                  cancelable: true,
                  ...(safeView ? { view: safeView } : {}),
                  clientX: cx,
                  clientY: cy,
                  button: 0,
                  buttons,
                  pointerId: 1,
                  pointerType: "mouse",
                  isPrimary: true,
                }),
              );
            }
          } catch {
            // ignore
          }
          try {
            target.dispatchEvent(
              new MouseEvent(mouseType, {
                bubbles: true,
                cancelable: true,
                ...(safeView ? { view: safeView } : {}),
                clientX: cx,
                clientY: cy,
                button: 0,
                buttons,
              }),
            );
          } catch {
            // ignore
          }
        };

        const steps = 4;
        dispatchPair(canvas, "pointerdown", "mousedown", x1, y1, 1);
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps;
          const mx = x1 + (x2 - x1) * t;
          const my = y1 + (y2 - y1) * t;
          targetWindow.setTimeout(() => {
            const dragTarget: EventTarget = canvas?.isConnected ? canvas : targetWindow;
            dispatchPair(dragTarget, "pointermove", "mousemove", mx, my, 1);
            if (s === steps) {
              dispatchPair(dragTarget, "pointerup", "mouseup", x2, y2, 0);
              dispatchPair(canvas!, "click", "click", x2, y2, 0);
              targetWindow.setTimeout(() => emitSnapshot(), 140);
            }
          }, s * 18);
        }
      }
    }
  };
  targetWindow.addEventListener("message", onMessage);

  // 4. Lightweight hook on CanvasRenderingContext2D.drawImage to record Konva's active image & natural size
  const Ctx2DProto = (
    targetWindow as unknown as {
      CanvasRenderingContext2D?: { prototype: CanvasRenderingContext2D };
    }
  ).CanvasRenderingContext2D?.prototype;
  const origDrawImage = Ctx2DProto?.drawImage;
  if (Ctx2DProto && typeof origDrawImage === "function") {
    Ctx2DProto.drawImage = function (
      this: CanvasRenderingContext2D,
      image: CanvasImageSource,
      ...rest: number[]
    ) {
      try {
        const HtmlImgCtor = (
          targetWindow as unknown as { HTMLImageElement?: typeof HTMLImageElement }
        ).HTMLImageElement;
        if (HtmlImgCtor && image instanceof HtmlImgCtor) {
          const w = image.naturalWidth || 0;
          const h = image.naturalHeight || 0;
          if (w >= 300 && h >= 200) {
            const canvas = this.canvas;
            const inQcOverlay = Boolean(
              canvas?.closest?.("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host, #sly-qc-overlay-host"),
            );
            if (!inQcOverlay && (!canvas || (canvas.width >= 200 && canvas.height >= 150))) {
              const srcUrl = image.currentSrc || image.src || null;
              if (
                srcUrl &&
                !isNonWorkspaceImageUrl(srcUrl) &&
                (state.lastCanvasImage?.url !== srcUrl ||
                  state.lastCanvasImage?.width !== w ||
                  state.lastCanvasImage?.height !== h)
              ) {
                state.lastCanvasImage = { url: srcUrl, width: w, height: h };
                scheduleSnapshot();
              }
            }
          }
        }
      } catch {
        // Never interfere with host canvas rendering
      }
      return (origDrawImage as (...args: unknown[]) => void).apply(this, [image, ...rest]);
    } as typeof Ctx2DProto.drawImage;
  }

  // 5. Event-driven change detection (no continuous polling loops)
  const onDomMutationAction = () => scheduleSnapshot();
  targetWindow.addEventListener("mouseup", onDomMutationAction, { passive: true });
  targetWindow.addEventListener("keyup", onDomMutationAction, { passive: true });
  targetWindow.addEventListener("popstate", onDomMutationAction);
  targetWindow.addEventListener("hashchange", onDomMutationAction);

  const hist = targetWindow.history;
  const origPushState = hist?.pushState;
  const origReplaceState = hist?.replaceState;
  if (hist && typeof origPushState === "function") {
    hist.pushState = function (
      this: History,
      ...args: Parameters<History["pushState"]>
    ): void {
      origPushState.apply(this, args);
      scheduleSnapshot();
    };
  }
  if (hist && typeof origReplaceState === "function") {
    hist.replaceState = function (
      this: History,
      ...args: Parameters<History["replaceState"]>
    ): void {
      origReplaceState.apply(this, args);
      scheduleSnapshot();
    };
  }

  // Announce readiness immediately at document_start and once DOM settles
  postToContent({
    source: "SLY_QC_PAGE",
    type: "SLY_QC_BRIDGE_READY",
    nonce,
  });

  if (targetWindow.document.readyState === "loading") {
    targetWindow.addEventListener(
      "DOMContentLoaded",
      () => {
        postToContent({
          source: "SLY_QC_PAGE",
          type: "SLY_QC_BRIDGE_READY",
          nonce,
        });
      },
      { once: true },
    );
  }

  return () => {
    targetWindow.removeEventListener("message", onMessage);
    targetWindow.removeEventListener("mouseup", onDomMutationAction);
    targetWindow.removeEventListener("keyup", onDomMutationAction);
    targetWindow.removeEventListener("popstate", onDomMutationAction);
    targetWindow.removeEventListener("hashchange", onDomMutationAction);
    if (hist && typeof origPushState === "function") {
      hist.pushState = origPushState;
    }
    if (hist && typeof origReplaceState === "function") {
      hist.replaceState = origReplaceState;
    }
    targetWindow.fetch = origFetch;
    XhrProto.open = origOpen;
    XhrProto.send = origSend;
    if (Ctx2DProto && typeof origDrawImage === "function") {
      Ctx2DProto.drawImage = origDrawImage;
    }
  };
}

// Auto-install when executed in browser MAIN world
if (typeof window !== "undefined") {
  const w = window as unknown as { __slyQcPageBridgeInstalled?: boolean };
  if (!w.__slyQcPageBridgeInstalled) {
    w.__slyQcPageBridgeInstalled = true;
    installPageBridge(window);
  }
}
