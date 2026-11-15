import { decodeSuperviselyBitmapPng } from "../shared/geometry";
import type {
  AnnotationFigure,
  BoundingBoxTuple,
  SceneSimulationPlan,
  SwRequestMessage,
  SwUploadPortMessage,
} from "../shared/types";

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

const ANIMAL_SUBCLASSES = new Set([
  "dog",
  "cat",
  "bird",
  "horse",
  "sheep",
  "cow",
  "bear",
  "deer",
]);

export function isEditableKeyboardEvent(evt: KeyboardEvent): boolean {
  const path = typeof evt.composedPath === "function" ? evt.composedPath() : [evt.target];
  for (const node of path) {
    if (node instanceof HTMLElement && node.matches(EDITABLE_SELECTOR)) {
      return true;
    }
  }
  return false;
}

export function sendSwMessage<T = unknown>(msg: SwRequestMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function openSwUploadPort() {
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

const TOOL_SUFFIX_RE =
  /(?:[_\-\s]+)(?:b|brush|bitmap|mask|p|poly|polygon|seg|l|line|polyline|k|kp|kpt|keypoint|keypoints|pose|graph|r|rect|rectangle|box|bbox)$/i;

const bitmapBboxCache = new Map<string, BoundingBoxTuple>();

function stripToolSuffix(label: string): string {
  const trimmed = label.trim();
  const stripped = trimmed.replace(TOOL_SUFFIX_RE, "").trim();
  return stripped || trimmed;
}

function getBitmapCacheKey(fig: Extract<AnnotationFigure, { geometryType: "bitmap" }>): string {
  const [ox, oy] = fig.bitmap.origin;
  const d = fig.bitmap.data;
  return `${ox},${oy}:${d.length}:${d.slice(0, 48)}:${d.slice(-24)}`;
}

export async function warmBitmapBoundingBoxes(
  figures: AnnotationFigure[],
  imgW = 16384,
  imgH = 16384,
): Promise<boolean> {
  let updated = false;
  const safeW = Math.max(16384, imgW);
  const safeH = Math.max(16384, imgH);
  for (const fig of figures) {
    if (fig.geometryType !== "bitmap" || !fig.bitmap?.data) continue;
    const key = getBitmapCacheKey(fig);
    if (bitmapBboxCache.has(key)) continue;
    try {
      const dec = await decodeSuperviselyBitmapPng(
        fig.bitmap.data,
        fig.bitmap.origin,
        safeW,
        safeH,
      );
      if (!dec.mask || dec.width <= 0 || dec.height <= 0) continue;
      let minX = dec.width;
      let minY = dec.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < dec.height; y += 1) {
        const row = y * dec.width;
        for (let x = 0; x < dec.width; x += 1) {
          if (dec.mask[row + x]) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      const box: BoundingBoxTuple =
        maxX >= minX && maxY >= minY
          ? [
              dec.originX + minX,
              dec.originY + minY,
              dec.originX + maxX + 1,
              dec.originY + maxY + 1,
            ]
          : [dec.originX, dec.originY, dec.originX + dec.width, dec.originY + dec.height];
      bitmapBboxCache.set(key, box);
      if (bitmapBboxCache.size > 512) {
        const oldest = bitmapBboxCache.keys().next().value;
        if (oldest !== undefined) bitmapBboxCache.delete(oldest);
      }
      updated = true;
    } catch {
      // Ignore corrupt bitmap during warm cache
    }
  }
  return updated;
}

export function extractFigureBoundingBox(fig: AnnotationFigure): BoundingBoxTuple | null {
  if (fig.geometryType === "graph") {
    const coords = Object.values(fig.nodes)
      .filter((n) => !n.disabled)
      .map((n) => n.loc);
    if (coords.length === 0) return null;
    const xs = coords.map((p) => p[0]);
    const ys = coords.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (fig.geometryType === "bitmap") {
    const cached = bitmapBboxCache.get(getBitmapCacheKey(fig));
    if (cached) return cached;
    return null;
  }
  const pts = fig.points.exterior;
  if (!pts || pts.length === 0) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function computeBoxIou(a: BoundingBoxTuple, b: BoundingBoxTuple): number {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

export function areClassesCompatibleForMatch(
  figClass: string,
  candClass: string,
): { compatible: boolean; figUnknown: boolean } {
  const f = figClass.trim().toLowerCase();
  const c = candClass.trim().toLowerCase();
  if (!f || f === "unknown") {
    return { compatible: false, figUnknown: true };
  }
  if (f === c || stripToolSuffix(f) === stripToolSuffix(c)) {
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

  const existingIds = new Set(figures.map((f) => f.figureId));
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
      const minIou =
        fb.fig.geometryType === "bitmap" || fb.fig.geometryType === "polygon" ? 0.42 : 0.5;
      if (compatible && iou >= minIou) {
        pairs.push({ candIdx: ci, figIdx: fi, iou });
      } else if (figUnknown && iou >= 0.65) {
        pairs.push({ candIdx: ci, figIdx: fi, iou });
      }
    }
  }
  pairs.sort((a, b) => b.iou - a.iou);

  const matchedByCand = new Map<number, string>();
  const usedFigs = new Set<number>();
  const usedFigIds = new Set<string>();
  for (const p of pairs) {
    if (matchedByCand.has(p.candIdx) || usedFigs.has(p.figIdx)) continue;
    const fid = figBoxes[p.figIdx]!.fig.figureId;
    matchedByCand.set(p.candIdx, fid);
    usedFigs.add(p.figIdx);
    usedFigIds.add(fid);
  }

  // Preserve valid backend bitmap matches while async bitmap bounds finish warming
  const uncachedBitmapIds = new Set(
    figures
      .filter((f) => f.geometryType === "bitmap" && extractFigureBoundingBox(f) === null)
      .map((f) => f.figureId),
  );
  const nextCandidates = plan.candidates.map((cand, idx) => {
    const fresh = matchedByCand.get(idx);
    if (fresh) {
      return { ...cand, matchedFigureId: fresh };
    }
    const prev = cand.matchedFigureId;
    if (prev && existingIds.has(prev) && uncachedBitmapIds.has(prev) && !usedFigIds.has(prev)) {
      return cand;
    }
    return { ...cand, matchedFigureId: null };
  });

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
