import { isNonWorkspaceImageUrl } from "../../shared/imageUrlFilter";
import type {
  AnnotationFigure,
  ClassDefinition,
  ImageContext,
  ProjectOntology,
  TagDefinition,
  TagValue,
} from "../../shared/types";
import { extractImageDimensions, extractImageRecordUrl } from "./networkIngest";
import { parseUrlContextFallback } from "./snapshotBuilder";
import {
  asRecord,
  ingestObjectMetadataCollection,
  normalizeClassDef,
  normalizeFigure,
  normalizeTagDef,
  normalizeTagValue,
  type InterceptorRuntimeState,
  type ObjectMetaEntry,
} from "./typesAndNormalizers";

export interface ReactStoreSlice {
  image: ImageContext | null;
  originalImageUrl: string | null;
  ontology: ProjectOntology | null;
  imageTags: TagValue[];
  figures: AnnotationFigure[];
  activeTool: string | null;
  activeClassTitle: string | null;
  isConfirmed: boolean | null;
  foundStore: boolean;
  konvaStages?: unknown[];
}

function isFigureLikeRecord(raw: unknown): raw is Record<string, unknown> {
  const r = asRecord(raw);
  if (!r) return false;
  const hasGeom =
    typeof r.geometryType === "string" ||
    asRecord(r.geometry) !== null ||
    asRecord(r.points) !== null ||
    Array.isArray(r.exterior) ||
    asRecord(r.bitmap) !== null;
  const hasCls =
    r.classId !== undefined ||
    r.objClassId !== undefined ||
    typeof r.classTitle === "string" ||
    typeof r.className === "string";
  return hasGeom && (hasCls || r.id !== undefined || r.figureId !== undefined);
}

function extractFigureCollection(
  raw: unknown,
  classesById: Map<string, ClassDefinition>,
  targetImageId: string | null = null,
  depth = 0,
  objectsById?: Record<string, ObjectMetaEntry>,
  figureObjectIdOut?: Record<string, string>,
): AnnotationFigure[] | null {
  if (depth > 2) return null;
  if (raw instanceof Map) {
    if (targetImageId !== null) {
      const keyed = raw.get(targetImageId) ?? raw.get(Number(targetImageId));
      if (keyed !== undefined) {
        return extractFigureCollection(
          keyed,
          classesById,
          null,
          depth + 1,
          objectsById,
          figureObjectIdOut,
        );
      }
    }
    return extractFigureCollection(
      Array.from(raw.values()),
      classesById,
      targetImageId,
      depth + 1,
      objectsById,
      figureObjectIdOut,
    );
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (!isFigureLikeRecord(raw[0])) return null;
    return raw
      .map((f, i) => normalizeFigure(f, i, classesById, objectsById, figureObjectIdOut))
      .filter((f): f is AnnotationFigure => f !== null);
  }
  const rec = asRecord(raw);
  if (!rec) return null;
  if (rec.objects) {
    ingestObjectMetadataCollection(rec.objects, classesById, objectsById ?? {});
  }
  if (rec.objectsById) {
    ingestObjectMetadataCollection(rec.objectsById, classesById, objectsById ?? {});
  }
  if (targetImageId && rec[targetImageId] !== undefined) {
    const forImg = rec[targetImageId];
    const forImgRec = asRecord(forImg);
    if (forImgRec?.objects) {
      ingestObjectMetadataCollection(forImgRec.objects, classesById, objectsById ?? {});
    }
    const innerImgFigs = forImgRec
      ? (forImgRec.figures ?? forImgRec.objects ?? forImg)
      : forImg;
    const parsedForImg = extractFigureCollection(
      innerImgFigs,
      classesById,
      null,
      depth + 1,
      objectsById,
      figureObjectIdOut,
    );
    if (parsedForImg) return parsedForImg;
  }
  const inner = asRecord(rec.byId) ?? asRecord(rec.entities) ?? (Array.isArray(rec.items) ? rec.items : null);
  if (Array.isArray(inner)) {
    return extractFigureCollection(
      inner,
      classesById,
      targetImageId,
      depth + 1,
      objectsById,
      figureObjectIdOut,
    );
  }
  const target = inner ?? rec;
  const vals = Object.values(target);
  if (vals.length === 0) return null;
  if (!vals.slice(0, 3).some((v) => isFigureLikeRecord(v))) return null;
  return vals
    .filter((v) => isFigureLikeRecord(v))
    .map((f, i) => normalizeFigure(f, i, classesById, objectsById, figureObjectIdOut))
    .filter((f): f is AnnotationFigure => f !== null);
}

export function collectKonvaStageCandidate(candidate: unknown, out: Set<unknown>): void {
  if (!candidate || typeof candidate !== "object") return;
  const rec = candidate as {
    getLayers?: () => unknown[];
    scaleX?: () => number;
    getStage?: () => unknown;
    stage?: unknown;
    current?: unknown;
  };
  if (typeof rec.getLayers === "function" && typeof rec.scaleX === "function") {
    out.add(candidate);
    return;
  }
  if (typeof rec.getStage === "function") {
    try {
      const stage = rec.getStage();
      if (stage && typeof stage === "object" && typeof (stage as { getLayers?: unknown }).getLayers === "function") {
        out.add(stage);
      }
    } catch {
      // ignore
    }
  }
  if (rec.stage && typeof rec.stage === "object" && typeof (rec.stage as { getLayers?: unknown }).getLayers === "function") {
    out.add(rec.stage);
  }
  if (rec.current && typeof rec.current === "object") {
    const cur = rec.current as { getStage?: () => unknown; getLayers?: unknown; scaleX?: unknown };
    if (typeof cur.getLayers === "function" && typeof cur.scaleX === "function") {
      out.add(cur);
    } else if (typeof cur.getStage === "function") {
      try {
        const stage = cur.getStage();
        if (stage && typeof stage === "object" && typeof (stage as { getLayers?: unknown }).getLayers === "function") {
          out.add(stage);
        }
      } catch {
        // ignore
      }
    }
  }
}

export function extractFromReactStore(state: InterceptorRuntimeState): ReactStoreSlice {
  const discoveredStages = new Set<unknown>();
  const result: ReactStoreSlice = {
    image: null,
    originalImageUrl: null,
    ontology: null,
    imageTags: [],
    figures: [],
    activeTool: null,
    activeClassTitle: null,
    isConfirmed: null,
    foundStore: false,
  };

  if (typeof document === "undefined") {
    return result;
  }

  const visited = new Set<unknown>();
  const storeNodes = new Set<unknown>();
  const queue: unknown[] = [];

  const pushElementFiberAndStore = (el: Element | null, highPriority: boolean) => {
    if (!el) return;
    const rec = el as unknown as Record<string, unknown>;
    for (const key of Object.keys(el)) {
      if (
        key.startsWith("__reactContainer$") ||
        key.startsWith("__reactFiber$") ||
        key.startsWith("__reactInternalInstance$") ||
        key.startsWith("__reactProps$")
      ) {
        const fiberVal = rec[key];
        if (highPriority) {
          queue.unshift(fiberVal);
          // Also walk parent fibers (.return) from canvas/workspace up to Redux Provider / Context
          let parent = asRecord(asRecord(fiberVal)?.return);
          let depth = 0;
          while (parent && depth < 50) {
            queue.push(parent);
            parent = asRecord(parent.return);
            depth += 1;
          }
        } else {
          queue.push(fiberVal);
        }
      }
    }
    const directStore = rec.__store ?? rec.__REDUX_STORE__;
    if (directStore) {
      storeNodes.add(directStore);
      queue.unshift(directStore);
    }
  };

  // Seed high-priority workspace DOM nodes first so huge nav/filmstrip trees cannot starve maxSteps
  const priorityNodes = Array.from(
    document.querySelectorAll(
      ".konvajs-content, canvas, [class*='Objects' i], [class*='objects' i], [class*='workspace' i], [class*='labeling' i]",
    ),
  ).filter((el) => !el.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host"));
  for (const el of priorityNodes) {
    pushElementFiberAndStore(el, true);
  }

  const candidateRoots = [
    document.getElementById("root"),
    document.getElementById("app"),
    document.body?.firstElementChild ?? null,
    document.body,
  ];
  for (const el of candidateRoots) {
    pushElementFiberAndStore(el, false);
  }

  if (typeof window !== "undefined") {
    const winRec = window as unknown as Record<string, unknown>;
    for (const k of ["__REDUX_STORE__", "__store", "__STORE__", "store"]) {
      if (winRec[k] && typeof winRec[k] === "object") {
        storeNodes.add(winRec[k]);
        queue.unshift(winRec[k]);
      }
    }
  }

  let steps = 0;
  const maxSteps = 12000;
  const classesById = new Map(state.classes.map((c) => [String(c.classId), c]));
  let hintImageId: string | null = parseUrlContextFallback().imageId ?? state.currentImageId;

  while (queue.length > 0 && steps < maxSteps) {
    const node = queue.shift();
    steps += 1;
    if (!node || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);

    const rec = node as Record<string, unknown>;
    collectKonvaStageCandidate(node, discoveredStages);
    if ("nodeType" in rec || typeof rec.getLayer === "function") {
      continue;
    }

    if (typeof rec.getState === "function") {
      try {
        const storeState = (rec.getState as () => unknown)();
        const sr = asRecord(storeState);
        if (sr) {
          storeNodes.add(sr);
          queue.unshift(sr);
        }
      } catch {
        // Ignore protected stores
      }
    }

    const rawCurId =
      rec.currentImageId ?? rec.selectedImageId ?? rec.entityId ?? rec.currentEntityId ?? rec.activeImageId;
    if (typeof rawCurId === "string" || typeof rawCurId === "number") {
      const parsedId = String(rawCurId).trim();
      if (/^\d+$/.test(parsedId)) {
        hintImageId = parsedId;
      }
    }

    // Harvest class/object metadata first so figure -> objectId -> classId resolution always succeeds
    const annRec = asRecord(rec.annotations) ?? asRecord(rec.labeling) ?? rec;
    for (const objKey of ["objects", "objectsById", "objectsByImageId"] as const) {
      if (annRec[objKey] !== undefined) {
        ingestObjectMetadataCollection(annRec[objKey], classesById, state.objectsById);
      }
      if (rec[objKey] !== undefined && rec[objKey] !== annRec[objKey]) {
        ingestObjectMetadataCollection(rec[objKey], classesById, state.objectsById);
      }
    }
    const metaSlice =
      asRecord(rec.projectMeta) ??
      asRecord(rec.ontology) ??
      (asRecord(rec.meta) && Array.isArray(asRecord(rec.meta)!.classes) ? asRecord(rec.meta) : null) ??
      rec;
    if (metaSlice && Array.isArray(metaSlice.classes) && state.classes.length === 0) {
      const parsed = metaSlice.classes
        .map(normalizeClassDef)
        .filter((c): c is ClassDefinition => c !== null);
      if (parsed.length > 0) {
        state.classes = parsed;
        for (const cls of parsed) {
          classesById.set(String(cls.classId), cls);
        }
      }
    }
    if (metaSlice && Array.isArray(metaSlice.tags) && state.tags.length === 0) {
      const parsedTags = metaSlice.tags
        .map(normalizeTagDef)
        .filter((t): t is TagDefinition => t !== null);
      if (parsedTags.length > 0) state.tags = parsedTags;
    }

    // Check candidate annotation/store containers (never overwrite non-empty figures with [])
    for (const candidateKey of [
      "figures",
      "objects",
      "figuresById",
      "objectsById",
      "entities",
      "entitiesById",
      "annotations",
      "annotationsByEntityId",
      "figuresByImageId",
      "objectsByImageId",
      "items",
      "labels",
      "shapes",
    ]) {
      const candidateVal = annRec[candidateKey];
      if (candidateVal === undefined) continue;
      const parsedFigs = extractFigureCollection(
        candidateVal,
        classesById,
        hintImageId,
        0,
        state.objectsById,
        state.figureObjectIdByFigureId,
      );
      if (!parsedFigs) continue;
      if (parsedFigs.length > 0 && parsedFigs.length >= result.figures.length) {
        const prevUnknown = result.figures.filter((f) => f.classTitle === "Unknown").length;
        const nextUnknown = parsedFigs.filter((f) => f.classTitle === "Unknown").length;
        if (parsedFigs.length > result.figures.length || nextUnknown < prevUnknown) {
          result.figures = parsedFigs;
          result.foundStore = true;
        }
      } else if (parsedFigs.length === 0 && storeNodes.has(node)) {
        result.foundStore = true;
      }
    }
    if (Array.isArray(annRec.imageTags)) {
      result.imageTags = (annRec.imageTags as unknown[])
        .map(normalizeTagValue)
        .filter((t): t is TagValue => t !== null);
    }
    if (typeof rec.activeTool === "string") result.activeTool = rec.activeTool;
    if (typeof rec.activeClassTitle === "string") {
      result.activeClassTitle = rec.activeClassTitle;
    } else if (asRecord(rec.activeClass)?.title) {
      result.activeClassTitle = String(asRecord(rec.activeClass)!.title);
    }
    if (typeof rec.isConfirmed === "boolean") result.isConfirmed = rec.isConfirmed;

    const imagesDict =
      asRecord(rec.imagesById) ?? asRecord(rec.entitiesById) ?? asRecord(rec.images);
    const dictImgRec = hintImageId && imagesDict ? asRecord(imagesDict[hintImageId]) : null;
    const imgRec =
      asRecord(rec.currentImage) ??
      asRecord(rec.image) ??
      asRecord(rec.currentEntity) ??
      asRecord(rec.activeImage) ??
      asRecord(rec.selectedImage) ??
      asRecord(rec.imageInfo) ??
      asRecord(rec.entity) ??
      dictImgRec;
    if (imgRec && (imgRec.id !== undefined || imgRec.imageId !== undefined || imgRec.entityId !== undefined)) {
      const { width: w, height: h } = extractImageDimensions(imgRec);
      const imgUrl = extractImageRecordUrl(imgRec);
      const imgId = String(imgRec.imageId ?? imgRec.id ?? imgRec.entityId);
      hintImageId = imgId;
      if (w > 0 && h > 0) {
        const prevArea = result.image ? result.image.width * result.image.height : 0;
        const nextArea = w * h;
        const isSameOrBetter = !result.image || result.image.imageId !== imgId || nextArea >= prevArea;
        if (isSameOrBetter) {
          result.image = {
            imageId: imgId,
            datasetId: String(imgRec.datasetId ?? result.image?.datasetId ?? "0"),
            jobId: state.jobId !== null ? String(state.jobId) : result.image?.jobId,
            jobTitle: state.jobTitle ?? result.image?.jobTitle,
            fileName: String(
              imgRec.name ?? imgRec.fileName ?? result.image?.fileName ?? `${imgId}.jpg`,
            ),
            width: w,
            height: h,
            imageHash: String(
              imgRec.hash ?? imgRec.imageHash ?? result.image?.imageHash ?? `sly:${imgId}`,
            ),
          };
        }
        if (imgUrl && (!result.originalImageUrl || nextArea >= prevArea)) {
          result.originalImageUrl = imgUrl;
        }
      } else if (imgUrl && !result.originalImageUrl) {
        result.originalImageUrl = imgUrl;
      }
    }

    if (
      result.foundStore &&
      result.figures.length > 0 &&
      result.image &&
      state.classes.length > 0 &&
      result.activeTool !== null
    ) {
      break;
    }

    if (storeNodes.has(node)) {
      const keys = Object.keys(rec);
      if (keys.length <= 80) {
        for (const k of keys) {
          const child = rec[k];
          if (child && typeof child === "object" && !visited.has(child) && !Array.isArray(child)) {
            storeNodes.add(child);
            queue.push(child);
          }
        }
      }
    }

    // Traverse React Context dependencies (e.g. Redux Provider / Store Context in React 18)
    const deps = asRecord(rec.dependencies);
    let ctxNode = asRecord(deps?.firstContext);
    let ctxDepth = 0;
    while (ctxNode && ctxDepth < 16) {
      const ctxObj = asRecord(ctxNode.context);
      const ctxVal = ctxObj?._currentValue ?? ctxObj?._currentValue2 ?? ctxNode.memoizedValue;
      if (ctxVal && typeof ctxVal === "object" && !visited.has(ctxVal)) {
        queue.unshift(ctxVal);
      }
      ctxNode = asRecord(ctxNode.next);
      ctxDepth += 1;
    }

    for (const childKey of [
      "memoizedProps",
      "memoizedState",
      "next",
      "baseState",
      "current",
      "store",
      "value",
      "children",
      "child",
      "sibling",
      "stateNode",
    ]) {
      const next = rec[childKey];
      if (next && typeof next === "object" && !visited.has(next)) {
        queue.push(next);
      }
    }
  }

  if (discoveredStages.size > 0) {
    result.konvaStages = Array.from(discoveredStages);
  }
  return result;
}
