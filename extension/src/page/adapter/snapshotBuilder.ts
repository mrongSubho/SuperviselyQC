import { isNonWorkspaceImageUrl } from "../../shared/imageUrlFilter";
import type {
  AnnotationFigure,
  ClassDefinition,
  ImageContext,
  PageBridgeSnapshot,
  ProjectOntology,
} from "../../shared/types";
import {
  extractKonvaCanvasTransform,
  extractKonvaImageSource,
  extractKonvaStageFigures,
} from "./konvaReader";
import { extractFromReactStore } from "./reactStoreReader";
import { type InterceptorRuntimeState } from "./typesAndNormalizers";

export function extractResourceTimingImageUrl(imageId: string | null): string | null {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
    return null;
  }
  const entries = performance.getEntriesByType("resource") as Array<{
    name?: string;
    initiatorType?: string;
  }>;
  let fallbackCandidate: string | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const name = entry?.name ?? "";
    if (!name || name.startsWith("data:") || name.startsWith("chrome-extension:") || name.startsWith("blob:")) {
      continue;
    }
    const lower = name.toLowerCase();
    const looksLikeImage =
      /\.(jpg|jpeg|png|webp)(\?|$)/i.test(lower) ||
      lower.includes("/h5un") ||
      lower.includes("images.download") ||
      lower.includes("/public/files/") ||
      lower.includes("x-amz-") ||
      entry?.initiatorType === "img";
    if (!looksLikeImage) continue;
    if (isNonWorkspaceImageUrl(name) || /preview.*w=1[0-9]{2}\b/i.test(lower)) {
      continue;
    }
    if (imageId && lower.includes(imageId.toLowerCase())) {
      return name;
    }
    if (!fallbackCandidate && (lower.includes("/h5un") || lower.includes("storage") || lower.includes("/public/files/"))) {
      fallbackCandidate = name;
    }
  }
  return fallbackCandidate;
}

export function parseUrlContextFallback(): {
  projectId: string;
  datasetId: string;
  imageId: string | null;
  jobId: string | null;
} {
  if (typeof window === "undefined") {
    return { projectId: "0", datasetId: "0", imageId: null, jobId: null };
  }
  const u = new URL(window.location.href);
  const qs = u.searchParams;
  const p = qs.get("projectId") ?? (/\/projects\/(\d+)/i.exec(u.pathname)?.[1] ?? "0");
  const d = qs.get("datasetId") ?? (/\/datasets\/(\d+)/i.exec(u.pathname)?.[1] ?? "0");
  const i =
    qs.get("imageId") ??
    qs.get("entityId") ??
    (/\/images\/(\d+)/i.exec(u.pathname)?.[1] ?? null);
  const j = qs.get("jobId") ?? (/\/labeling-jobs\/(\d+)/i.exec(u.pathname)?.[1] ?? null);
  return { projectId: p, datasetId: d, imageId: i, jobId: j };
}


export function buildPageBridgeSnapshot(
  state: InterceptorRuntimeState,
  snapshotSeq: number,
): PageBridgeSnapshot {
  const urlCtx = parseUrlContextFallback();
  const fiber = extractFromReactStore(state);
  const konvaImg = extractKonvaImageSource(fiber.konvaStages) ?? state.lastCanvasImage ?? null;

  const urlImgId = urlCtx.imageId;
  const fiberMatchesUrl = !urlImgId || !fiber.image || fiber.image.imageId === urlImgId;
  const fiberImageForActive = fiberMatchesUrl ? fiber.image : null;
  const imgId = urlImgId ?? fiberImageForActive?.imageId ?? state.currentImageId ?? null;
  const cachedImg = imgId ? state.imagesById[imgId] : undefined;
  const synthesizedImageMeta: ImageContext | null =
    imgId && (konvaImg?.width || cachedImg || urlImgId)
      ? {
          imageId: imgId,
          datasetId: urlCtx.datasetId,
          jobId: urlCtx.jobId ?? undefined,
          fileName: cachedImg?.meta.fileName ?? `${imgId}.jpg`,
          width: cachedImg?.meta.width || konvaImg?.width || 1920,
          height: cachedImg?.meta.height || konvaImg?.height || 1080,
          imageHash: cachedImg?.meta.imageHash ?? `sly:${imgId}`,
        }
      : null;

  const cachedArea =
    cachedImg && cachedImg.meta.width > 0 && cachedImg.meta.height > 0
      ? cachedImg.meta.width * cachedImg.meta.height
      : 0;
  const fiberArea = fiberImageForActive
    ? fiberImageForActive.width * fiberImageForActive.height
    : 0;
  const preferCachedImg =
    Boolean(cachedImg && cachedArea > 0) &&
    (!fiberImageForActive || cachedArea >= fiberArea);

  const imageMeta: ImageContext | null = preferCachedImg
    ? {
        ...cachedImg!.meta,
        jobId: cachedImg!.meta.jobId ?? fiberImageForActive?.jobId,
        jobTitle: cachedImg!.meta.jobTitle ?? fiberImageForActive?.jobTitle,
      }
    : (fiberImageForActive ?? synthesizedImageMeta);

  const candidateImageUrl =
    (preferCachedImg ? cachedImg?.url : null) ??
    (fiberMatchesUrl ? fiber.originalImageUrl : null) ??
    cachedImg?.url ??
    konvaImg?.url ??
    extractResourceTimingImageUrl(imgId) ??
    null;
  const originalImageUrl =
    candidateImageUrl && !isNonWorkspaceImageUrl(candidateImageUrl) ? candidateImageUrl : null;

  const classesById = new Map(state.classes.map((c) => [String(c.classId), c]));
  const cachedAnn = imgId ? state.annotationsByImageId[imgId] : undefined;
  const hasFiberFigs = fiberMatchesUrl && fiber.foundStore;
  const hasNetworkFigs = Boolean(cachedAnn);

  let rawFigures: AnnotationFigure[] = [];
  if (fiberMatchesUrl && fiber.figures.length > 0) {
    rawFigures = fiber.figures;
  } else if (cachedAnn && cachedAnn.figures.length > 0) {
    rawFigures = cachedAnn.figures;
  } else {
    rawFigures = extractKonvaStageFigures(classesById, fiber.konvaStages);
  }

  const figures = rawFigures.map((fig) => {
    const objId = state.figureObjectIdByFigureId[fig.figureId];
    const linkedObj = objId ? state.objectsById[objId] : undefined;
    const resolvedClassId = fig.classId !== 0 ? fig.classId : (linkedObj?.classId ?? fig.classId);
    const clsFromId = classesById.get(String(resolvedClassId));
    const nextClassTitle =
      fig.classTitle && fig.classTitle !== "Unknown"
        ? fig.classTitle
        : linkedObj?.classTitle && linkedObj.classTitle !== "Unknown"
          ? linkedObj.classTitle
          : clsFromId?.title ?? "Unknown";
    const nextTags =
      fig.tags.length > 0 ? fig.tags : (linkedObj?.tags ?? []);
    if (
      nextClassTitle === fig.classTitle &&
      resolvedClassId === fig.classId &&
      nextTags === fig.tags
    ) {
      return fig;
    }
    return {
      ...fig,
      classId: resolvedClassId,
      classTitle: nextClassTitle,
      tags: nextTags,
    };
  });

  const imageTags =
    fiberMatchesUrl && fiber.imageTags.length > 0 ? fiber.imageTags : cachedAnn?.imageTags ?? [];

  const ontology: ProjectOntology | null =
    state.classes.length > 0 || state.tags.length > 0
      ? {
          projectId: state.projectId ?? urlCtx.projectId,
          projectName: state.projectName ?? undefined,
          classes: state.classes,
          tags: state.tags,
          jobClassesToLabel: state.jobClassesToLabel ?? undefined,
        }
      : null;

  const rawStateSource: PageBridgeSnapshot["rawStateSource"] =
    fiber.figures.length > 0 || hasFiberFigs
      ? "store"
      : hasNetworkFigs || figures.length > 0
        ? "intercepted"
        : "empty";

  return {
    snapshotSeq,
    capturedAtMs: Date.now(),
    image: imageMeta,
    originalImageUrl,
    ontology,
    imageTags,
    figures,
    uiState: {
      activeTool: fiber.activeTool ?? undefined,
      activeClassTitle: fiber.activeClassTitle ?? undefined,
      isConfirmed: fiber.isConfirmed ?? undefined,
    },
    canvasTransform: extractKonvaCanvasTransform(fiber.konvaStages),
    rawStateSource,
    partialGeometry: false,
  };
}
