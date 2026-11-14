import { clamp } from "../shared/geometry";
import { isNonWorkspaceImageUrl } from "../shared/imageUrlFilter";
import type {
  DomFigureSummary,
  ExtractedDomState,
  QCFinding,
  QuickFixAction,
  QuickFixExecutionResult,
  ViewportMetadata,
} from "../shared/types";

function parseRgbString(colorStr: string): [number, number, number, number] | null {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i.exec(
    colorStr,
  );
  if (!m) return null;
  return [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] !== undefined ? Number(m[4]) : 1,
  ];
}

function isAmberYellowColor(colorStr: string | null | undefined): boolean {
  if (!colorStr) return false;
  const rgba = parseRgbString(colorStr);
  if (!rgba) return false;
  const [r, g, b, a] = rgba;
  return a > 0.2 && r > 175 && g > 125 && b < 115;
}

function isReddishColor(colorStr: string | null | undefined): boolean {
  if (!colorStr) return false;
  const rgba = parseRgbString(colorStr);
  if (!rgba) return false;
  const [r, g, b, a] = rgba;
  return a > 0.25 && r > 175 && g < 105 && b < 105;
}

function findButtonByText(pattern: RegExp): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, [role="button"], a[role="button"], [data-testid*="confirm"], [data-testid*="sync"]',
    ),
  );
  for (const el of candidates) {
    if (el.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host")) {
      continue;
    }
    const text = (el.textContent ?? "").trim();
    if (pattern.test(text)) {
      return el;
    }
  }
  return null;
}

export function detectSynchronizeDirty(btn: HTMLElement | null): boolean {
  if (!btn) return false;
  if (btn.dataset.dirty === "true" || btn.getAttribute("aria-dirty") === "true") {
    return true;
  }
  if (/\bdirty\b|\bunsaved\b|\bwarning\b/i.test(btn.className)) {
    return true;
  }
  const styleAttr = btn.getAttribute("style") ?? "";
  if (/#f59e0b|#fbbf24|#eab308|rgb\(245|rgb\(251|rgb\(234|yellow|amber|orange/i.test(styleAttr)) {
    return true;
  }
  if (typeof window !== "undefined") {
    const cs = window.getComputedStyle(btn);
    if (isAmberYellowColor(cs.backgroundColor) || isAmberYellowColor(cs.borderColor) || isAmberYellowColor(cs.color)) {
      return true;
    }
  }
  return false;
}

export function extractMinimapAndViewport(
  imgW: number,
  imgH: number,
  canvasRect: DOMRect | null,
): ViewportMetadata {
  const safeW = Math.max(1, imgW);
  const safeH = Math.max(1, imgH);
  const canvasW = canvasRect ? Math.max(1, Math.round(canvasRect.width)) : 980;
  const canvasH = canvasRect ? Math.max(1, Math.round(canvasRect.height)) : 653;

  let zoomPercent = 100;
  if (typeof document !== "undefined") {
    const zoomEls = document.querySelectorAll<HTMLElement>(
      '[data-qc-role="zoom"], [class*="zoom"], [data-testid*="zoom"], span, button',
    );
    for (const el of zoomEls) {
      if (el.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host")) {
        continue;
      }
      const txt = (el.textContent ?? "").trim();
      const m = /^(\d{1,3}(?:\.\d+)?)\s*%$/.exec(txt);
      if (m?.[1]) {
        const val = Number(m[1]);
        if (val >= 1 && val <= 1600) {
          zoomPercent = val;
          break;
        }
      }
    }
  }

  let visibleNormRect: [number, number, number, number] = [0, 0, 1, 1];
  let source: ViewportMetadata["source"] = "fallback_full";

  if (typeof document !== "undefined") {
    const minimapEl = document.querySelector<HTMLElement>(
      '[data-qc-role="minimap"], [class*="minimap"], [data-testid*="minimap"]',
    );
    if (minimapEl) {
      const mRect = minimapEl.getBoundingClientRect();
      if (mRect.width > 16 && mRect.height > 16) {
        const explicitRectEl = minimapEl.querySelector<HTMLElement>(
          '[data-qc-role="minimap-viewport"], [class*="viewport"], [style*="border"]',
        );
        let redRectEl: HTMLElement | null = explicitRectEl;
        if (!redRectEl) {
          const children = Array.from(minimapEl.querySelectorAll<HTMLElement>("*"));
          for (const child of children) {
            const cs = window.getComputedStyle(child);
            if (isReddishColor(cs.borderColor) || isReddishColor(cs.outlineColor)) {
              redRectEl = child;
              break;
            }
          }
        }
        if (redRectEl) {
          const rRect = redRectEl.getBoundingClientRect();
          if (rRect.width > 1 && rRect.height > 1) {
            const nx0 = clamp((rRect.left - mRect.left) / mRect.width, 0, 1);
            const ny0 = clamp((rRect.top - mRect.top) / mRect.height, 0, 1);
            const nx1 = clamp((rRect.right - mRect.left) / mRect.width, 0, 1);
            const ny1 = clamp((rRect.bottom - mRect.top) / mRect.height, 0, 1);
            if (nx1 > nx0 && ny1 > ny0) {
              visibleNormRect = [nx0, ny0, nx1, ny1];
              source = "minimap";
            }
          }
        }
      }
    }
  }

  if (zoomPercent >= 98 && source === "fallback_full") {
    visibleNormRect = [0, 0, 1, 1];
  }

  const visiblePixelRect: [number, number, number, number] = [
    visibleNormRect[0] * safeW,
    visibleNormRect[1] * safeH,
    visibleNormRect[2] * safeW,
    visibleNormRect[3] * safeH,
  ];

  return {
    zoomPercent,
    visibleNormRect,
    visiblePixelRect,
    canvasSize: { width: canvasW, height: canvasH },
    source,
  };
}

export function findPrimaryCanvas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas")).filter(
    (c) => !c.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host"),
  );
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = c;
    }
  }
  return best;
}

export function extractDomFallbackSummaries(): {
  domFigureSummaries: DomFigureSummary[];
  imageTagNamesDom: string[];
} {
  const domFigureSummaries: DomFigureSummary[] = [];
  const imageTagNamesDom: string[] = [];
  if (typeof document === "undefined") {
    return { domFigureSummaries, imageTagNamesDom };
  }

  // Objects By Classes list rows
  let classPanel = document.querySelector<HTMLElement>(
    '[data-qc-role="objects-by-classes"], [class*="objects-by-classes"], [data-testid*="objects-by-classes"]',
  );
  if (!classPanel) {
    const objTab = Array.from(
      document.querySelectorAll<HTMLElement>("div, span, button, [role='tab']"),
    ).find(
      (el) =>
        !el.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host") &&
        /^objects by classes(?:\s*\d+)?$/i.test((el.textContent ?? "").trim()),
    );
    classPanel =
      (objTab?.closest('[class*="sidebar"], [class*="panel"], aside, section') as HTMLElement | null) ??
      objTab?.parentElement?.parentElement ??
      null;
  }
  if (classPanel) {
    const explicitRows = Array.from(
      classPanel.querySelectorAll<HTMLElement>("[data-class-title], li, .class-row"),
    );
    const rows =
      explicitRows.length > 0
        ? explicitRows
        : Array.from(classPanel.querySelectorAll<HTMLElement>("div, span")).filter((el) => {
            if (el.children.length > 4) return false;
            const txt = (el.textContent ?? "").trim();
            return txt.length > 0 && txt.length < 48 && /\d+$/.test(txt) && !/^objects/i.test(txt);
          });
    const seenClasses = new Set<string>();
    for (const row of rows) {
      const explicitTitle = row.dataset.classTitle;
      const explicitCount = row.dataset.count;
      if (explicitTitle && explicitCount !== undefined) {
        const count = Number(explicitCount);
        if (Number.isFinite(count) && count >= 0) {
          seenClasses.add(explicitTitle.toLowerCase());
          domFigureSummaries.push({
            classTitle: explicitTitle,
            figureCount: count,
            taggedCount: 0,
            visible: row.dataset.visible !== "false",
          });
        }
        continue;
      }
      const txt = (row.textContent ?? "").replace(/^>\s*/, "").trim();
      const m = /^(.+?)\s*[:(\s]\s*(\d+)\s*\)?$/.exec(txt);
      if (m?.[1] && m?.[2]) {
        const clsName = m[1].trim();
        if (/^(objects|objects by classes)$/i.test(clsName)) continue;
        if (seenClasses.has(clsName.toLowerCase())) continue;
        seenClasses.add(clsName.toLowerCase());
        domFigureSummaries.push({
          classTitle: clsName,
          figureCount: Number(m[2]),
          taggedCount: 0,
          visible: true,
        });
      }
    }
  }

  // Current Image Tags chips (explicit attributes or heading fallback)
  let tagsPanel = document.querySelector<HTMLElement>(
    '[data-qc-role="image-tags"], [class*="image-tags"], [data-testid*="image-tags"]',
  );
  if (!tagsPanel) {
    const tagHeading = Array.from(
      document.querySelectorAll<HTMLElement>("div, span, h2, h3, h4, header"),
    ).find(
      (h) =>
        !h.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host") &&
        /^\s*CURRENT IMAGE TAGS\s*$/i.test(h.textContent ?? ""),
    );
    tagsPanel =
      (tagHeading?.closest('[class*="sidebar"], [class*="panel"], aside, section') as HTMLElement | null) ??
      tagHeading?.parentElement ??
      null;
  }
  if (tagsPanel) {
    const chips = Array.from(
      tagsPanel.querySelectorAll<HTMLElement>("[data-tag-name], .tag-chip, .ant-tag, span"),
    );
    const seenTags = new Set<string>();
    for (const chip of chips) {
      const explicit = chip.dataset.tagName;
      if (explicit) {
        if (!seenTags.has(explicit)) {
          seenTags.add(explicit);
          imageTagNamesDom.push(explicit);
        }
        continue;
      }
      // If inside checkbox wrapper or Ant tag, capture only active/checked or explicit chips
      const cb =
        chip.closest("label, [role='checkbox']")?.querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        ) ?? null;
      const ariaChecked = chip
        .closest('[aria-checked]')
        ?.getAttribute("aria-checked");
      if (cb && !cb.checked) continue;
      if (ariaChecked === "false") continue;
      if (!cb && ariaChecked !== "true" && !chip.matches(".tag-chip, .ant-tag")) continue;
      const name = (chip.textContent ?? "").trim();
      if (
        name &&
        name.length < 48 &&
        !/current image tags|add image tag|\{\}/i.test(name) &&
        !seenTags.has(name)
      ) {
        seenTags.add(name);
        imageTagNamesDom.push(name);
      }
    }
  }

  return { domFigureSummaries, imageTagNamesDom };
}

export function extractDomOntologyClasses(): Array<{ title: string; shape: "rectangle" }> {
  const root = findClassesSidebarRoot();
  if (!root) return [];
  const rows = getSidebarClassRowElements(root);
  const seen = new Set<string>();
  const out: Array<{ title: string; shape: "rectangle" }> = [];
  for (const row of rows) {
    const title = getSidebarClassRowTitle(row);
    if (!title || title.length > 48) continue;
    if (/^(classes|definitions|current image tags|image tags|objects by classes|tags|\{\}|\d+)$/i.test(title)) {
      continue;
    }
    if (/[×\n\r{}]/.test(title)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, shape: "rectangle" });
  }
  return out;
}

export function extractDomResolutionHint(
  fileNameHint?: string | null,
): { width: number; height: number } | null {
  if (typeof document === "undefined") return null;
  const resRegex = /\b([1-9]\d{2,4})\s*[×xX]\s*([1-9]\d{2,4})\b/;
  const cleanStem = fileNameHint
    ? fileNameHint.replace(/\.[^.]+$/, "").toLowerCase().slice(0, 10)
    : "";

  const candidates = Array.from(document.querySelectorAll<HTMLElement>("div, span, li, a, p"));
  const allMatches: Array<{ width: number; height: number; isSelected: boolean; matchesName: boolean }> = [];

  for (const el of candidates) {
    if (el.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host, #sly-qc-assistant-host")) {
      continue;
    }
    // Prefer leaf/near-leaf text nodes to avoid scanning huge wrappers
    if (el.children.length > 4) continue;
    const text = (el.textContent ?? "").trim();
    if (!text || text.length > 64) continue;
    const m = resRegex.exec(text);
    if (!m?.[1] || !m[2]) continue;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w < 64 || h < 64 || w > 32768 || h > 32768) continue;

    const card = el.closest('[aria-selected], [class*="selected"], [class*="active"], [class*="item"], li, a') ?? el.parentElement;
    const cardText = (card?.textContent ?? text).toLowerCase();
    const isSelected = Boolean(
      el.closest('[aria-selected="true"], [data-selected="true"], [data-active="true"]') ||
      (card && /\b(active|selected)\b/i.test(card.className)),
    );
    const matchesName = Boolean(cleanStem.length >= 6 && cardText.includes(cleanStem));
    allMatches.push({ width: w, height: h, isSelected, matchesName });
  }

  const exactMatch =
    allMatches.find((m) => m.isSelected && m.matchesName) ??
    allMatches.find((m) => m.matchesName) ??
    allMatches.find((m) => m.isSelected);
  if (exactMatch) {
    return { width: exactMatch.width, height: exactMatch.height };
  }
  if (allMatches.length === 1 && allMatches[0]) {
    return { width: allMatches[0].width, height: allMatches[0].height };
  }
  return null;
}

function hasHiddenAncestorOrAria(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el;
  for (let i = 0; i < 6 && cur; i += 1) {
    if (cur.getAttribute("aria-hidden") === "true") return true;
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const st = window.getComputedStyle(cur);
      if (
        st.display === "none" ||
        st.visibility === "hidden" ||
        Number.parseFloat(st.opacity || "1") <= 0.01
      ) {
        return true;
      }
    }
    cur = cur.parentElement;
  }
  return false;
}

function isVisibleWorkspaceImg(
  img: HTMLImageElement,
  canvasRect: DOMRect | null,
): boolean {
  if (img.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host")) {
    return false;
  }
  if (
    img.closest(
      "aside, nav, header, footer, [role='dialog'], [class*='modal' i], [class*='drawer' i], [class*='popover' i], [class*='popup' i], [class*='tooltip' i], [class*='markdown' i], [class*='ecosystem' i], [class*='plugin' i], [class*='readme' i], [class*='news' i], [class*='banner' i], [class*='sidebar' i], [class*='thumb' i], [class*='filmstrip' i], [class*='tutorial' i], [class*='guide' i], [class*='hotkey' i], [class*='avatar' i]",
    )
  ) {
    return false;
  }
  const srcUrl = img.currentSrc || img.src || "";
  if (isNonWorkspaceImageUrl(srcUrl)) {
    return false;
  }
  if (hasHiddenAncestorOrAria(img)) {
    return false;
  }
  const rect = typeof img.getBoundingClientRect === "function" ? img.getBoundingClientRect() : null;
  if (rect) {
    const isJsdom = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
    // In real browsers, ignore collapsed/offscreen/thumbnail <img> elements and require canvas overlap when a canvas is active
    if (!isJsdom) {
      if (rect.width < 180 || rect.height < 140) return false;
      if (
        typeof window !== "undefined" &&
        (rect.right <= 0 ||
          rect.left >= window.innerWidth ||
          rect.bottom <= 0 ||
          rect.top >= window.innerHeight)
      ) {
        return false;
      }
      if (canvasRect && canvasRect.width >= 200 && canvasRect.height >= 150) {
        const overlapsCanvas =
          rect.right > canvasRect.left &&
          rect.left < canvasRect.right &&
          rect.bottom > canvasRect.top &&
          rect.top < canvasRect.bottom;
        if (!overlapsCanvas) return false;
      }
    } else if ((rect.width > 0 || rect.height > 0) && (rect.width < 180 || rect.height < 140)) {
      return false;
    }
  }
  return true;
}

export function extractLargestDomImageElement(): HTMLImageElement | null {
  if (typeof document === "undefined") return null;
  const primaryCanvas = findPrimaryCanvas();
  const canvasRect =
    primaryCanvas && typeof primaryCanvas.getBoundingClientRect === "function"
      ? primaryCanvas.getBoundingClientRect()
      : null;
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>("img")).filter((img) =>
    isVisibleWorkspaceImg(img, canvasRect),
  );
  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  for (const img of imgs) {
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    const area = w * h;
    if (w >= 300 && h >= 200 && area > bestArea) {
      bestArea = area;
      best = img;
    }
  }
  return best;
}

export async function captureCanvasOrImgFallback(
  canvasEl: HTMLCanvasElement | null,
): Promise<{
  buffer: ArrayBuffer;
  contentType: string;
  width: number;
  height: number;
  source?: "dom_img" | "canvas";
} | null> {
  if (typeof document === "undefined") return null;

  // Try largest high-res visible workspace <img> via clean offscreen canvas first
  const domImg = extractLargestDomImageElement();
  if (domImg && domImg.naturalWidth > 0 && domImg.naturalHeight > 0) {
    try {
      const offscreen = document.createElement("canvas");
      offscreen.width = domImg.naturalWidth;
      offscreen.height = domImg.naturalHeight;
      const ctx = offscreen.getContext("2d");
      if (ctx) {
        ctx.drawImage(domImg, 0, 0, offscreen.width, offscreen.height);
        const blob = await new Promise<Blob | null>((resolve) =>
          offscreen.toBlob((b) => resolve(b), "image/jpeg", 0.92),
        );
        if (blob && blob.size > 0) {
          return {
            buffer: await blob.arrayBuffer(),
            contentType: "image/jpeg",
            width: offscreen.width,
            height: offscreen.height,
            source: "dom_img",
          };
        }
      }
    } catch {
      // Tainted cross-origin <img>; try canvasEl fallback below
    }
  }

  if (canvasEl && canvasEl.width > 0 && canvasEl.height > 0) {
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvasEl.toBlob((b) => resolve(b), "image/jpeg", 0.92),
      );
      if (blob && blob.size > 0) {
        return {
          buffer: await blob.arrayBuffer(),
          contentType: "image/jpeg",
          width: canvasEl.width,
          height: canvasEl.height,
          source: "canvas",
        };
      }
    } catch {
      // Tainted canvas
    }
  }

  return null;
}

const CLASS_ROW_SELECTOR =
  '[data-class-title], [data-testid*="class-item"], [class*="class-item"], [class*="class-row"], li, button, [role="button"], [role="option"], [role="listitem"]';

function isExtensionDomNode(el: Element): boolean {
  return Boolean(
    el.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host, #sly-qc-assistant-host"),
  );
}

function getSidebarClassRowElements(root: HTMLElement): HTMLElement[] {
  const explicit = Array.from(root.querySelectorAll<HTMLElement>(CLASS_ROW_SELECTOR)).filter(
    (el) => !isExtensionDomNode(el) && getSidebarClassRowTitle(el).length > 0,
  );
  if (explicit.length > 0) {
    return explicit;
  }

  // Fallback for div-based Supervisely sidebars without li/button/data-class-title attributes:
  // collect compact row elements after the CLASSES heading and stop before CURRENT IMAGE TAGS.
  const rows: HTMLElement[] = [];
  const rootHasClassesHeading = /\bclasses\b/i.test(root.textContent ?? "");
  let pastClassesHeading = !rootHasClassesHeading;

  const allNodes = Array.from(root.querySelectorAll<HTMLElement>("div, span, a"));
  for (const el of allNodes) {
    if (isExtensionDomNode(el)) continue;
    const text = (el.textContent ?? "").trim();
    if (!text) continue;
    if (/^(current image tags|image tags|objects by classes)$/i.test(text)) {
      break;
    }
    if (!pastClassesHeading) {
      if (/^classes(?:\s*\(\d+\))?$/i.test(text)) {
        pastClassesHeading = true;
      }
      continue;
    }
    if (/^(definitions|classes(?:\s*\(\d+\))?)$/i.test(text)) continue;
    if (text.length > 48 || /\n/.test(text) || /\{\}/.test(text)) continue;
    // Skip wrapper containers that enclose multiple items
    if (el.querySelectorAll("div").length > 3) continue;
    // If parent is already queued, prefer the outer clickable row element
    if (el.parentElement && rows.includes(el.parentElement)) continue;
    const hasChildTextNode = el.children.length > 0 && el.querySelector("svg, canvas, span");
    if (el.tagName === "DIV" || el.tagName === "A" || hasChildTextNode) {
      rows.push(el);
    }
  }
  return rows;
}

function findClassesSidebarRoot(): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const explicit = document.querySelector<HTMLElement>(
    '[data-qc-role="classes"], [data-testid*="definitions-classes"], [class*="definitions-classes"]',
  );
  if (explicit) {
    return explicit;
  }
  const headings = Array.from(
    document.querySelectorAll<HTMLElement>("div, span, h2, h3, h4, header"),
  );
  for (const h of headings) {
    if (isExtensionDomNode(h) || h.closest('[data-qc-role="objects-by-classes"]')) {
      continue;
    }
    const headingText = (h.textContent ?? "").trim();
    if (!/^classes(?:\s*\(\d+\))?$/i.test(headingText)) {
      continue;
    }
    const candidates: Array<HTMLElement | null> = [
      h.parentElement,
      h.parentElement?.parentElement ?? null,
      h.closest('[class*="sidebar"], [class*="panel"], aside, section') as HTMLElement | null,
    ];
    for (const container of candidates) {
      if (
        !container ||
        isExtensionDomNode(container) ||
        container.closest('[data-qc-role="objects-by-classes"]')
      ) {
        continue;
      }
      if ((container.textContent ?? "").length > 6000) continue;
      if (getSidebarClassRowElements(container).length > 0) {
        return container;
      }
    }
  }
  return null;
}

function getSidebarClassRowTitle(row: HTMLElement): string {
  if (row.dataset.classTitle) {
    return row.dataset.classTitle.trim();
  }
  const child = row.querySelector<HTMLElement>("[data-class-title], [class*='class-title'], [class*='title']");
  if (child?.dataset.classTitle) {
    return child.dataset.classTitle.trim();
  }
  const rawText = (child?.textContent ?? row.textContent ?? "").trim();
  return rawText.replace(/\s*\(\d+\)\s*$/, "").replace(/\s+\[[A-Z]\]$/, "").trim();
}

function isSidebarRowActive(row: HTMLElement): boolean {
  if (
    row.dataset.active === "true" ||
    row.dataset.selected === "true" ||
    row.getAttribute("aria-selected") === "true" ||
    row.getAttribute("aria-pressed") === "true" ||
    /\b(active|selected)\b/i.test(row.className)
  ) {
    return true;
  }
  try {
    const cs = window.getComputedStyle(row);
    const visual = `${cs.borderColor} ${cs.outlineColor} ${cs.backgroundColor}`;
    return /rgb\(\s*37\s*,\s*99\s*,\s*235\s*\)|rgb\(\s*29\s*,\s*78\s*,\s*216\s*\)|rgb\(\s*24\s*,\s*144\s*,\s*255\s*\)/i.test(
      visual,
    );
  } catch {
    return false;
  }
}

export function extractActiveClassTitle(): string | null {
  const root = findClassesSidebarRoot();
  if (!root) {
    return null;
  }
  const rows = getSidebarClassRowElements(root);
  for (const row of rows) {
    if (isSidebarRowActive(row)) {
      const title = getSidebarClassRowTitle(row);
      if (title) {
        return title;
      }
    }
  }
  return null;
}

export function extractActiveTool(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-qc-tool], [data-tool], [data-testid*="tool-"], [class*="tool-btn"]',
    ),
  );
  for (const el of candidates) {
    if (isExtensionDomNode(el)) {
      continue;
    }
    const active =
      el.dataset.active === "true" ||
      el.getAttribute("aria-pressed") === "true" ||
      /\b(active|selected)\b/i.test(el.className);
    if (!active) {
      continue;
    }
    const raw =
      el.dataset.qcTool ??
      el.dataset.tool ??
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      (el.textContent ?? "").trim();
    if (raw) {
      return raw.trim().toLowerCase();
    }
  }
  return null;
}

export function extractDomState(imgW: number, imgH: number): ExtractedDomState {
  const syncBtn = findButtonByText(/\bsynchronize\b|\bsync\b/i);
  const confirmBtn = findButtonByText(/\bconfirm\b/i);
  const confirmEnabled = confirmBtn
    ? !(confirmBtn as HTMLButtonElement).disabled &&
      confirmBtn.getAttribute("aria-disabled") !== "true"
    : true;
  const isConfirmed = confirmBtn
    ? confirmBtn.dataset.confirmed === "true" ||
      confirmBtn.getAttribute("aria-pressed") === "true" ||
      /\bconfirmed\b/i.test(confirmBtn.textContent ?? "") ||
      /\bconfirmed\b/i.test(confirmBtn.className)
    : false;

  const canvasElement = findPrimaryCanvas();
  const canvasRect = canvasElement ? canvasElement.getBoundingClientRect() : null;
  const minimapEl =
    typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(
          '[data-qc-role="minimap"], [class*="minimap"], [data-testid*="minimap"]',
        )
      : null;
  const minimapRect = minimapEl ? minimapEl.getBoundingClientRect() : null;
  const viewport = extractMinimapAndViewport(imgW, imgH, canvasRect);
  const { domFigureSummaries, imageTagNamesDom } = extractDomFallbackSummaries();

  const topBarAnchor =
    (confirmBtn?.closest("header, [class*='header'], [class*='toolbar'], [data-qc-role='topbar']") as HTMLElement | null) ??
    confirmBtn?.parentElement ??
    syncBtn?.parentElement ??
    null;

  return {
    synchronizeDirty: detectSynchronizeDirty(syncBtn),
    synchronizeButton: syncBtn,
    confirmButtonEnabled: confirmEnabled,
    isConfirmed,
    confirmButton: confirmBtn,
    topBarAnchor,
    viewport,
    canvasElement,
    canvasRect,
    minimapRect,
    domFigureSummaries,
    imageTagNamesDom,
    activeTool: extractActiveTool(),
    activeClassTitle: extractActiveClassTitle(),
  };
}

function pulseDomElement(el: HTMLElement): void {
  const prevOutline = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = "2px solid #fbbf24";
  el.style.outlineOffset = "2px";
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.outlineOffset = prevOffset;
  }, 2200);
}

export function selectSidebarClassRow(classTitle: string): {
  selected: boolean;
  shapeHint: string;
} {
  const targetClass = classTitle.trim();
  const root = findClassesSidebarRoot();
  const candidates = root ? getSidebarClassRowElements(root) : [];
  const targetRow = targetClass
    ? candidates.find(
        (row) => getSidebarClassRowTitle(row).toLowerCase() === targetClass.toLowerCase(),
      )
    : undefined;
  if (!targetRow) {
    return { selected: false, shapeHint: "" };
  }
  if (typeof targetRow.scrollIntoView === "function") {
    targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  pulseDomElement(targetRow);
  targetRow.click();
  const shapeAttr = targetRow.dataset.shape ?? targetRow.dataset.geometryType ?? "";
  return { selected: true, shapeHint: shapeAttr };
}

export function selectRectangleTool(): boolean {
  if (typeof document === "undefined") return false;
  const active = extractActiveTool();
  if (active && active.includes("rect")) {
    return true;
  }
  const rectBtn = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-qc-tool="rectangle"], [data-tool="rectangle"], [data-testid*="rect" i], [aria-label*="rectangle" i], [title*="rectangle" i], button, [role="button"]',
    ),
  ).find((el) => {
    if (isExtensionDomNode(el)) return false;
    const hint = `${el.dataset.qcTool ?? ""} ${el.dataset.tool ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
    return /\brect(angle)?\b/i.test(hint);
  });
  if (rectBtn) {
    rectBtn.click();
    return true;
  }
  return false;
}

export function executeQuickFix(
  fix: QuickFixAction,
  finding: QCFinding | undefined,
  callbacks: {
    onFocusRect: (rect: [number, number, number, number], figureIds?: string[]) => void;
    onToast: (msg: string) => void;
  },
): QuickFixExecutionResult {
  if (fix.actionType === "highlight_synchronize") {
    const syncBtn = findButtonByText(/\bsynchronize\b/i);
    if (syncBtn) {
      pulseDomElement(syncBtn);
      callbacks.onToast("Highlighted Synchronize button — click it to save annotations before Confirm.");
      return {
        executed: true,
        feedback: "Highlighted Synchronize button in Supervisely toolbar.",
        action: fix,
        highlightedFinding: finding,
      };
    }
    return {
      executed: false,
      feedback: "Synchronize button not found in toolbar; press Cmd/Ctrl+S or check top bar.",
      action: fix,
    };
  }

  if (fix.actionType === "focus_viewport" || fix.actionType === "inspect_figure") {
    const figIds = fix.targetFigureIds ?? finding?.figureIds ?? [];
    const rect = fix.focusRect ?? finding?.focusRect ?? null;
    if (figIds.length > 0 && typeof document !== "undefined") {
      const row = document.querySelector<HTMLElement>(
        `[data-figure-id="${CSS.escape(figIds[0]!)}"]`,
      );
      if (row) {
        pulseDomElement(row);
        row.click();
      }
    }
    if (rect) {
      callbacks.onFocusRect(rect, figIds);
    }
    return {
      executed: true,
      feedback: rect
        ? `Focused annotation region [${Math.round(rect[0])}, ${Math.round(rect[1])}].`
        : "Focused figure row.",
      focusRect: rect,
      highlightFigureIds: figIds,
      action: fix,
      highlightedFinding: finding,
    };
  }

  if (fix.actionType === "remove_image_tag" || fix.actionType === "move_tag_image_to_object") {
    const tagTarget = fix.tagName ?? "";
    const addBtn = findButtonByText(/add image tag|current image tags/i);
    if (addBtn) {
      pulseDomElement(addBtn);
    }
    const hint = tagTarget
      ? `Check image tag "${tagTarget}" in CURRENT IMAGE TAGS panel.`
      : fix.label;
    callbacks.onToast(hint);
    return {
      executed: true,
      feedback: hint,
      action: fix,
      highlightedFinding: finding,
    };
  }

  if (fix.actionType === "add_object_tag") {
    const figIds = fix.targetFigureIds ?? finding?.figureIds ?? [];
    const rect = fix.focusRect ?? finding?.focusRect ?? null;
    if (rect) {
      callbacks.onFocusRect(rect, figIds);
    }
    const objTagBtn = findButtonByText(/add object tag|current object tags/i);
    if (objTagBtn) {
      pulseDomElement(objTagBtn);
    }
    const tagLabel = fix.tagName ? `"${fix.tagName}"` : "required object tag";
    const msg = `Focused target object — apply ${tagLabel} in CURRENT OBJECT TAGS.`;
    callbacks.onToast(msg);
    return {
      executed: true,
      feedback: msg,
      focusRect: rect,
      highlightFigureIds: figIds,
      action: fix,
      highlightedFinding: finding,
    };
  }

  if (fix.actionType === "select_sidebar_class") {
    const targetClass = (fix.classTitle ?? "").trim();
    const { selected, shapeHint } = selectSidebarClassRow(targetClass);
    if (selected) {
      const hotkeyHint =
        shapeHint.toLowerCase() === "rectangle"
          ? " Use Rectangle tool (R)."
          : shapeHint.toLowerCase() === "polygon"
            ? " Use Polygon tool."
            : "";
      const msg = `Selected class "${targetClass}" in Definitions -> CLASSES.${hotkeyHint}`;
      callbacks.onToast(msg);
      return {
        executed: true,
        feedback: msg,
        action: fix,
        highlightedFinding: finding,
      };
    }

    const fallbackMsg = targetClass
      ? `Select class "${targetClass}" in Definitions -> CLASSES sidebar.`
      : fix.label;
    callbacks.onToast(fallbackMsg);
    return {
      executed: false,
      feedback: fallbackMsg,
      action: fix,
    };
  }

  return {
    executed: false,
    feedback: `Unsupported Quick Fix action: ${String(fix.actionType)}`,
    action: fix,
  };
}
