import { createRoot, type Root } from "react-dom/client";
import { QC_DARK_CSS } from "./styles";

export interface ShadowMountHandle {
  host: HTMLElement;
  shadow: ShadowRoot;
  container: HTMLDivElement;
  reactRoot: Root;
  unmount: () => void;
}

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

export function mountShadowRoot(
  hostId: string,
  parent: HTMLElement | null = document.body,
  hostStyles: Partial<CSSStyleDeclaration> = {},
): ShadowMountHandle {
  const existing = document.getElementById(hostId);
  if (existing) {
    existing.remove();
  }

  const host = document.createElement("div");
  host.id = hostId;
  host.setAttribute("data-sly-qc-host", "true");
  Object.assign(host.style, hostStyles);

  const targetParent = parent ?? document.body ?? document.documentElement;
  targetParent.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = QC_DARK_CSS;
  shadow.appendChild(styleEl);

  const container = document.createElement("div");
  container.className = "qc-shadow-mount";
  shadow.appendChild(container);

  // Protect Supervisely single-letter canvas shortcuts (r/p/b/l/Space) while user types inside Shadow inputs
  const isolateTyping = ((evt: KeyboardEvent) => {
    const path = evt.composedPath();
    const target = path[0];
    if (
      target instanceof HTMLElement &&
      target.matches(EDITABLE_SELECTOR) &&
      evt.key !== "Escape" &&
      !evt.altKey
    ) {
      evt.stopPropagation();
    }
  }) as EventListener;
  shadow.addEventListener("keydown", isolateTyping);
  shadow.addEventListener("keyup", isolateTyping);
  shadow.addEventListener("keypress", isolateTyping);

  const reactRoot = createRoot(container);

  return {
    host,
    shadow,
    container,
    reactRoot,
    unmount: () => {
      reactRoot.unmount();
      host.remove();
    },
  };
}
