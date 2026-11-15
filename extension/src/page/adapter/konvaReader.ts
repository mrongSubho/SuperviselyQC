import { isNonWorkspaceImageUrl } from "../../shared/imageUrlFilter";
import type {
  AnnotationFigure,
  CanvasTransformMetadata,
  ClassDefinition,
  Point2D,
} from "../../shared/types";
import { collectKonvaStageCandidate } from "./reactStoreReader";
import { asRecord, normalizeFigure } from "./typesAndNormalizers";

interface KonvaStageLike {
  scaleX?: () => number;
  scaleY?: () => number;
  x?: () => number;
  y?: () => number;
  find?: (selector: string) => unknown[];
  getLayers?: () => Array<{
    getChildren?: () => unknown[];
    find?: (selector: string) => unknown[];
  }>;
}

function findKonvaStages(extraStages?: unknown[]): KonvaStageLike[] {
  const out = new Set<unknown>();
  if (typeof window !== "undefined") {
    const win = window as unknown as { Konva?: { stages?: unknown[] } };
    for (const s of win.Konva?.stages ?? []) {
      collectKonvaStageCandidate(s, out);
    }
  }
  if (extraStages) {
    for (const s of extraStages) {
      collectKonvaStageCandidate(s, out);
    }
  }
  if (typeof document !== "undefined") {
    for (const el of Array.from(document.querySelectorAll(".konvajs-content, canvas"))) {
      const rec = el as unknown as Record<string, unknown>;
      collectKonvaStageCandidate(rec, out);
      for (const k of Object.keys(el)) {
        if (
          k.startsWith("__reactFiber$") ||
          k.startsWith("__reactInternalInstance$") ||
          k.startsWith("__reactProps$")
        ) {
          let fiber = asRecord(rec[k]);
          let depth = 0;
          while (fiber && depth < 12) {
            collectKonvaStageCandidate(fiber.stateNode, out);
            collectKonvaStageCandidate(fiber.memoizedProps, out);
            collectKonvaStageCandidate(asRecord(fiber.memoizedProps)?.ref, out);
            fiber = asRecord(fiber.return);
            depth += 1;
          }
        }
      }
    }
  }
  return Array.from(out) as KonvaStageLike[];
}

export function extractKonvaCanvasTransform(extraStages?: unknown[]): CanvasTransformMetadata | null {
  if (typeof window === "undefined") return null;
  const stage = findKonvaStages(extraStages)[0];
  if (!stage || typeof stage.scaleX !== "function" || typeof stage.x !== "function") {
    return null;
  }
  const scaleX = stage.scaleX();
  const scaleY = typeof stage.scaleY === "function" ? stage.scaleY() : scaleX;
  const offsetX = stage.x();
  const offsetY = typeof stage.y === "function" ? stage.y() : 0;
  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    !Number.isFinite(offsetX) ||
    !Number.isFinite(offsetY) ||
    scaleX <= 0 ||
    scaleY <= 0
  ) {
    return null;
  }
  return {
    scaleX,
    scaleY,
    offsetX,
    offsetY,
    source: "konva_or_viewport",
  };
}

export interface KonvaImageSource {
  url: string | null;
  width: number;
  height: number;
}

export function extractKonvaImageSource(extraStages?: unknown[]): KonvaImageSource | null {
  if (typeof window === "undefined") return null;
  const stages = findKonvaStages(extraStages);
  let best: KonvaImageSource | null = null;
  let bestArea = 0;

  for (const stage of stages) {
    const nodes: unknown[] = [];
    if (typeof stage.find === "function") {
      try {
        nodes.push(...stage.find("Image"));
      } catch {
        // ignore
      }
    }
    if (nodes.length === 0 && typeof stage.getLayers === "function") {
      try {
        for (const layer of stage.getLayers()) {
          if (typeof layer.getChildren === "function") {
            nodes.push(...layer.getChildren());
          }
        }
      } catch {
        // ignore
      }
    }

    for (const node of nodes) {
      const rec = node as {
        image?: () => unknown;
        attrs?: { image?: unknown };
      };
      const rawImg =
        typeof rec.image === "function" ? rec.image() : rec.attrs?.image;
      if (!rawImg || typeof rawImg !== "object") continue;
      const imgEl = rawImg as {
        currentSrc?: string;
        src?: string;
        naturalWidth?: number;
        naturalHeight?: number;
        width?: number;
        height?: number;
      };
      const w = Number(imgEl.naturalWidth || imgEl.width || 0);
      const h = Number(imgEl.naturalHeight || imgEl.height || 0);
      const url =
        typeof imgEl.currentSrc === "string" && imgEl.currentSrc
          ? imgEl.currentSrc
          : typeof imgEl.src === "string" && imgEl.src
            ? imgEl.src
            : null;
      const area = w * h;
      if (area > bestArea && (url || area >= 10_000)) {
        bestArea = area;
        best = { url, width: w, height: h };
      }
    }
  }
  return best;
}


export function extractKonvaStageFigures(
  classesById: Map<string, ClassDefinition>,
  extraStages?: unknown[],
): AnnotationFigure[] {
  if (typeof window === "undefined") return [];
  const stages = findKonvaStages(extraStages);
  const out: AnnotationFigure[] = [];
  const seenIds = new Set<string>();
  let seq = 0;

  for (const stage of stages) {
    const layers = typeof stage.getLayers === "function" ? stage.getLayers() : [];
    for (const layer of layers) {
      const nodes: unknown[] = [];
      if (typeof layer.find === "function") {
        try {
          nodes.push(...layer.find("Rect, Line, Path, Group"));
        } catch {
          // ignore
        }
      } else if (typeof layer.getChildren === "function") {
        try {
          nodes.push(...layer.getChildren());
        } catch {
          // ignore
        }
      }
      for (const n of nodes) {
        const rec = n as {
          attrs?: Record<string, unknown>;
          getAttrs?: () => Record<string, unknown>;
          getParent?: () => { attrs?: Record<string, unknown>; getAttrs?: () => Record<string, unknown> } | null;
        };
        const attrs = typeof rec.getAttrs === "function" ? rec.getAttrs() : rec.attrs;
        if (!attrs) continue;
        const parentNode = typeof rec.getParent === "function" ? rec.getParent() : null;
        const parentAttrs = parentNode
          ? (typeof parentNode.getAttrs === "function" ? parentNode.getAttrs() : parentNode.attrs) ?? {}
          : {};
        const figMeta =
          attrs.figureId ??
          attrs.objectId ??
          attrs.figure ??
          parentAttrs.figureId ??
          parentAttrs.objectId ??
          parentAttrs.figure;
        const clsRaw =
          attrs.classId ?? attrs.objClassId ?? parentAttrs.classId ?? parentAttrs.objClassId;
        const classTitleRaw =
          attrs.classTitle ?? attrs.className ?? parentAttrs.classTitle ?? parentAttrs.className;
        if (figMeta === undefined && clsRaw === undefined && classTitleRaw === undefined) continue;
        const fid = String(
          attrs.figureId ??
            attrs.objectId ??
            parentAttrs.figureId ??
            parentAttrs.objectId ??
            attrs.id ??
            parentAttrs.id ??
            `konva_fig_${seq}`,
        );
        if (seenIds.has(fid)) continue;

        const sx = Number(attrs.scaleX ?? 1);
        const sy = Number(attrs.scaleY ?? 1);
        const w = Number(attrs.width ?? 0) * (Number.isFinite(sx) && sx > 0 ? sx : 1);
        const h = Number(attrs.height ?? 0) * (Number.isFinite(sy) && sy > 0 ? sy : 1);
        const x = Number(attrs.x ?? 0);
        const y = Number(attrs.y ?? 0);
        const pts = attrs.points;
        if (w > 0 && h > 0 && Number.isFinite(x) && Number.isFinite(y)) {
          seenIds.add(fid);
          seq += 1;
          const fig = normalizeFigure(
            {
              id: fid,
              classId: clsRaw ?? 0,
              classTitle: classTitleRaw,
              geometryType: "rectangle",
              points: { exterior: [[x, y], [x + w, y + h]], interior: [] },
            },
            seq,
            classesById,
          );
          if (fig) out.push(fig);
        } else if (Array.isArray(pts) && pts.length >= 4) {
          seenIds.add(fid);
          seq += 1;
          const exterior: Point2D[] = [];
          for (let k = 0; k + 1 < pts.length; k += 2) {
            const px = Number(pts[k]);
            const py = Number(pts[k + 1]);
            if (Number.isFinite(px) && Number.isFinite(py)) exterior.push([px, py]);
          }
          if (exterior.length >= 3) {
            const fig = normalizeFigure(
              {
                id: fid,
                classId: clsRaw ?? 0,
                classTitle: classTitleRaw,
                geometryType: "polygon",
                points: { exterior, interior: [] },
              },
              seq,
              classesById,
            );
            if (fig) out.push(fig);
          }
        }
      }
    }
  }
  return out;
}
