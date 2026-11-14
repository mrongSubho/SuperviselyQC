import { isNonWorkspaceImageUrl } from "../shared/imageUrlFilter";
import type {
  AnnotationFigure,
  CanvasTransformMetadata,
  ClassDefinition,
  GeometryType,
  ImageContext,
  PageBridgeSnapshot,
  Point2D,
  ProjectOntology,
  TagDefinition,
  TagValue,
} from "../shared/types";

export interface ReplayEntry {
  url: string;
  capturedAtMs: number;
  kind: "meta" | "job" | "image" | "annotations" | "other";
  data: unknown;
}

export interface InterceptorRuntimeState {
  replayBuffer: ReplayEntry[];
  projectId: string | number | null;
  projectName: string | null;
  classes: ClassDefinition[];
  tags: TagDefinition[];
  jobId: string | number | null;
  jobTitle: string | null;
  jobClassesToLabel: string[] | null;
  currentImageId: string | null;
  imagesById: Record<string, { meta: ImageContext; url: string | null }>;
  annotationsByImageId: Record<string, { figures: AnnotationFigure[]; imageTags: TagValue[] }>;
  lastCanvasImage?: { url: string | null; width: number; height: number } | null;
}

const MAX_REPLAY_ENTRIES = 50;

export function createInterceptorState(): InterceptorRuntimeState {
  return {
    replayBuffer: [],
    projectId: null,
    projectName: null,
    classes: [],
    tags: [],
    jobId: null,
    jobTitle: null,
    jobClassesToLabel: null,
    currentImageId: null,
    imagesById: {},
    annotationsByImageId: {},
    lastCanvasImage: null,
  };
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function asPoint2D(val: unknown): Point2D | null {
  if (Array.isArray(val) && val.length >= 2) {
    const x = Number(val[0]);
    const y = Number(val[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
  }
  const obj = asRecord(val);
  if (obj && obj.x !== undefined && obj.y !== undefined) {
    const x = Number(obj.x);
    const y = Number(obj.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
  }
  return null;
}

function normalizeGeometryType(raw: unknown): GeometryType {
  const s = String(raw ?? "rectangle").toLowerCase();
  if (s === "polygon" || s === "bitmap" || s === "polyline" || s === "point" || s === "graph") {
    return s;
  }
  return "rectangle";
}

export function normalizeTagValue(raw: unknown): TagValue | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const tagId = rec.tagId ?? rec.id ?? 0;
  const name = typeof rec.name === "string" ? rec.name : String(rec.title ?? "");
  if (!name) return null;
  const val = rec.value;
  const cleanVal =
    val === undefined ||
    val === null ||
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "boolean"
      ? val ?? null
      : String(val);
  return {
    tagId: typeof tagId === "number" || typeof tagId === "string" ? tagId : 0,
    name,
    value: cleanVal,
  };
}

export function normalizeFigure(raw: unknown, idx: number, classesById: Map<string, ClassDefinition>): AnnotationFigure | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const geometryType = normalizeGeometryType(rec.geometryType ?? rec.shape);
  const clsObj = asRecord(rec.class) ?? asRecord(rec.objClass) ?? asRecord(rec.meta);
  const classIdRaw = rec.classId ?? rec.objClassId ?? clsObj?.id ?? clsObj?.classId ?? 0;
  const classId = typeof classIdRaw === "number" || typeof classIdRaw === "string" ? classIdRaw : 0;
  const clsDef = classesById.get(String(classId));
  const classTitle =
    typeof rec.classTitle === "string"
      ? rec.classTitle
      : typeof rec.className === "string"
        ? rec.className
        : typeof clsObj?.title === "string"
          ? clsObj.title
          : typeof rec.objClassTitle === "string"
            ? rec.objClassTitle
            : clsDef?.title ?? "Unknown";

  const figureId = String(rec.figureId ?? rec.id ?? rec.key ?? `fig_${idx}`);
  const tagsRaw = Array.isArray(rec.tags) ? rec.tags : [];
  const tags = tagsRaw.map(normalizeTagValue).filter((t): t is TagValue => t !== null);

  const base = {
    figureId,
    classId,
    classTitle,
    tags,
    labelIndex: typeof rec.labelIndex === "number" ? rec.labelIndex : undefined,
    visible: typeof rec.visible === "boolean" ? rec.visible : undefined,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : undefined,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : undefined,
  };

  if (geometryType === "bitmap") {
    const bm = asRecord(rec.bitmap) ?? asRecord(asRecord(rec.geometry)?.bitmap);
    const data = typeof bm?.data === "string" ? bm.data : "";
    const org = asPoint2D(bm?.origin) ?? [0, 0];
    return {
      ...base,
      geometryType: "bitmap",
      bitmap: { data, origin: org },
    };
  }

  if (geometryType === "graph") {
    const rawNodes = asRecord(rec.nodes) ?? asRecord(asRecord(rec.geometry)?.nodes);
    const nodes: Record<string, { loc: Point2D; disabled?: boolean }> = {};
    if (rawNodes) {
      for (const [nid, nVal] of Object.entries(rawNodes)) {
        const nRec = asRecord(nVal);
        const loc = asPoint2D(nRec?.loc);
        if (loc) {
          nodes[nid] = {
            loc,
            disabled: typeof nRec?.disabled === "boolean" ? nRec.disabled : undefined,
          };
        }
      }
    }
    return {
      ...base,
      geometryType: "graph",
      nodes,
    };
  }

  const geomRec = asRecord(rec.geometry);
  const rawPts = asRecord(rec.points) ?? asRecord(geomRec?.points) ?? geomRec;
  const extRaw = Array.isArray(rawPts?.exterior)
    ? rawPts!.exterior
    : Array.isArray(rec.exterior)
      ? rec.exterior
      : [];
  const intRaw = Array.isArray(rawPts?.interior) ? rawPts!.interior : [];
  let exterior = extRaw.map(asPoint2D).filter((p): p is Point2D => p !== null);
  if (exterior.length === 0 && geometryType === "rectangle") {
    const boxSrc = rawPts ?? geomRec ?? rec;
    if (Array.isArray(rec.bbox) && rec.bbox.length >= 4) {
      const [bx1, by1, bx2, by2] = rec.bbox.map(Number);
      if ([bx1, by1, bx2, by2].every(Number.isFinite)) {
        exterior = [[bx1!, by1!], [bx2!, by2!]];
      }
    } else if (boxSrc) {
      const x = Number(boxSrc.x ?? boxSrc.left ?? NaN);
      const y = Number(boxSrc.y ?? boxSrc.top ?? NaN);
      const w = Number(boxSrc.width ?? NaN);
      const h = Number(boxSrc.height ?? NaN);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        exterior = [[x, y], [x + w, y + h]];
      }
    }
  }
  const interior = intRaw
    .filter(Array.isArray)
    .map((ring) => (ring as unknown[]).map(asPoint2D).filter((p): p is Point2D => p !== null));
  switch (geometryType) {
    case "polygon":
      return { ...base, geometryType: "polygon", points: { exterior, interior } };
    case "polyline":
      return { ...base, geometryType: "polyline", points: { exterior, interior: [] } };
    case "point":
      return {
        ...base,
        geometryType: "point",
        points: {
          exterior: exterior.length === 1 ? [exterior[0]!] : (exterior as unknown as [Point2D]),
          interior: [],
        },
      };
    default:
      return {
        ...base,
        geometryType: "rectangle",
        points: {
          exterior:
            exterior.length === 2
              ? [exterior[0]!, exterior[1]!]
              : (exterior as unknown as [Point2D, Point2D]),
          interior: [],
        },
      };
  }
}

function normalizeClassDef(raw: unknown): ClassDefinition | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const classId = rec.classId ?? rec.id ?? 0;
  const title = typeof rec.title === "string" ? rec.title : "";
  if (!title) return null;
  const shape = normalizeGeometryType(rec.shape ?? "rectangle");
  const gcRaw = asRecord(rec.geometryConfig ?? rec.geometry_config);
  let geometryConfig: ClassDefinition["geometryConfig"];
  if (gcRaw) {
    const rawNodes = asRecord(gcRaw.nodes);
    const parsedNodes: NonNullable<ClassDefinition["geometryConfig"]>["nodes"] = {};
    if (rawNodes) {
      for (const [nid, nVal] of Object.entries(rawNodes)) {
        const nRec = asRecord(nVal);
        if (!nRec) continue;
        parsedNodes[nid] = {
          label: String(nRec.label ?? nid),
          color: typeof nRec.color === "string" ? nRec.color : undefined,
          disabled: typeof nRec.disabled === "boolean" ? nRec.disabled : undefined,
        };
      }
    }
    const rawEdges = Array.isArray(gcRaw.edges) ? gcRaw.edges : [];
    const parsedEdges = rawEdges
      .map((e) => {
        const eRec = asRecord(e);
        if (!eRec) return null;
        return {
          src: String(eRec.src ?? ""),
          dst: String(eRec.dst ?? ""),
          color: typeof eRec.color === "string" ? eRec.color : undefined,
        };
      })
      .filter((e): e is { src: string; dst: string; color: string | undefined } => e !== null);
    geometryConfig = { nodes: parsedNodes, edges: parsedEdges };
  }
  return {
    classId: typeof classId === "number" || typeof classId === "string" ? classId : 0,
    title,
    shape,
    color: typeof rec.color === "string" ? rec.color : "#6b4eff",
    geometryConfig,
  };
}

function normalizeTagDef(raw: unknown): TagDefinition | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const name = typeof rec.name === "string" ? rec.name : "";
  if (!name) return null;
  const tagId = rec.tagId ?? rec.id ?? 0;
  const vtRaw = String(rec.valueType ?? rec.value_type ?? "none");
  const valueType =
    vtRaw === "any_number" || vtRaw === "any_string" || vtRaw === "oneof_string"
      ? vtRaw
      : "none";
  const atRaw = String(rec.applicableType ?? rec.applicable_type ?? "all");
  const applicableType =
    atRaw === "imagesOnly" || atRaw === "objectsOnly" ? atRaw : "all";
  return {
    tagId: typeof tagId === "number" || typeof tagId === "string" ? tagId : 0,
    name,
    valueType,
    applicableType,
    classes: Array.isArray(rec.classes) ? rec.classes.map(String) : [],
    values: Array.isArray(rec.values) ? rec.values.map(String) : [],
  };
}

export function pushReplayEntry(
  state: InterceptorRuntimeState,
  entry: ReplayEntry,
): void {
  state.replayBuffer.push(entry);
  if (state.replayBuffer.length > MAX_REPLAY_ENTRIES) {
    state.replayBuffer.shift();
  }
  const win = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  if (win) {
    win.__slyQcReplayBuffer = state.replayBuffer;
  }
}

function extractImageRecordUrl(rec: Record<string, unknown>): string | null {
  const containers = [rec, asRecord(rec.fileMeta), asRecord(rec.meta)];
  for (const c of containers) {
    if (!c) continue;
    for (const key of [
      "fullStorageUrl",
      "originalImageUrl",
      "originalUrl",
      "downloadUrl",
      "link",
      "pathOriginal",
      "url",
      "src",
    ]) {
      const val = c[key];
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed.length > 0 && !isNonWorkspaceImageUrl(trimmed)) {
          return trimmed;
        }
      }
    }
  }
  return null;
}

function extractImageDimensions(
  rec: Record<string, unknown>,
  existing?: ImageContext,
): { width: number; height: number } {
  const candidates = [
    rec,
    asRecord(rec.fileMeta),
    asRecord(rec.meta),
    asRecord(rec.size),
    asRecord(rec.info),
  ];
  let width = 0;
  let height = 0;
  for (const c of candidates) {
    if (!c) continue;
    const cw = Number(c.width ?? 0);
    const ch = Number(c.height ?? 0);
    if (cw > 0 && ch > 0) {
      width = cw;
      height = ch;
      break;
    }
  }
  return {
    width: width > 0 ? width : (existing?.width ?? 0),
    height: height > 0 ? height : (existing?.height ?? 0),
  };
}

function upsertImageRecord(
  state: InterceptorRuntimeState,
  rec: Record<string, unknown>,
  makeCurrent: boolean,
): void {
  const rawId = rec.imageId ?? rec.id ?? rec.entityId;
  if (rawId === undefined || rawId === null) return;
  const imgId = String(rawId);
  const existing = state.imagesById[imgId];
  const { width: w, height: h } = extractImageDimensions(rec, existing?.meta);
  const imgUrl = extractImageRecordUrl(rec) ?? existing?.url ?? null;

  if ((w > 0 && h > 0) || imgUrl) {
    if (makeCurrent) {
      state.currentImageId = imgId;
    }
    state.imagesById[imgId] = {
      meta: {
        imageId: imgId,
        datasetId: String(rec.datasetId ?? existing?.meta.datasetId ?? "0"),
        jobId: state.jobId !== null ? String(state.jobId) : existing?.meta.jobId,
        jobTitle: state.jobTitle ?? existing?.meta.jobTitle,
        fileName: String(
          rec.name ?? rec.fileName ?? existing?.meta.fileName ?? `${imgId}.jpg`,
        ),
        width: w,
        height: h,
        imageHash: String(rec.hash ?? rec.imageHash ?? existing?.meta.imageHash ?? `sly:${imgId}`),
      },
      url: imgUrl,
    };
  }
}

function unwrapEnvelopePayload(payload: unknown): unknown {
  const outer = asRecord(payload);
  if (!outer) return payload;
  const hasTopLevelData =
    Array.isArray(outer.classes) ||
    Array.isArray(outer.entities) ||
    Array.isArray(outer.objects) ||
    Array.isArray(outer.figures) ||
    outer.id !== undefined ||
    outer.imageId !== undefined;
  if (hasTopLevelData) return payload;
  if (outer.data !== undefined && (typeof outer.data === "object" && outer.data !== null)) {
    return outer.data;
  }
  if (outer.result !== undefined && (typeof outer.result === "object" && outer.result !== null)) {
    return outer.result;
  }
  return payload;
}

function ingestAnnotationRecord(
  state: InterceptorRuntimeState,
  imgId: string,
  annRec: Record<string, unknown>,
  rawFigs: unknown[],
  classesById: Map<string, ClassDefinition>,
  makeCurrent: boolean,
): void {
  if (!imgId) return;
  const figs = rawFigs
    .map((f, i) => normalizeFigure(f, i, classesById))
    .filter((f): f is AnnotationFigure => f !== null);
  const rawTags = Array.isArray(annRec.tags) ? annRec.tags : [];
  const imgTags = rawTags
    .map(normalizeTagValue)
    .filter((t): t is TagValue => t !== null);
  state.annotationsByImageId[imgId] = { figures: figs, imageTags: imgTags };
  if (makeCurrent) {
    state.currentImageId = imgId;
  }
  const sizeRec = asRecord(annRec.size) ?? asRecord(annRec.imageSize);
  const existing = state.imagesById[imgId];
  if (!existing && sizeRec && Number(sizeRec.width) > 0 && Number(sizeRec.height) > 0) {
    state.imagesById[imgId] = {
      meta: {
        imageId: imgId,
        datasetId: String(annRec.datasetId ?? "0"),
        jobId: state.jobId !== null ? String(state.jobId) : undefined,
        jobTitle: state.jobTitle ?? undefined,
        fileName: String(annRec.imageName ?? annRec.name ?? `${imgId}.jpg`),
        width: Number(sizeRec.width),
        height: Number(sizeRec.height),
        imageHash: String(annRec.hash ?? `sly:${imgId}`),
      },
      url: extractImageRecordUrl(annRec),
    };
  }
}

export function ingestApiPayload(
  state: InterceptorRuntimeState,
  url: string,
  payload: unknown,
): void {
  const lowerUrl = url.toLowerCase();
  const unwrapped = unwrapEnvelopePayload(payload);
  const rec = asRecord(unwrapped);
  let kind: ReplayEntry["kind"] = "other";

  const projMatch = /\/projects\/(\d+)/i.exec(url);
  if (projMatch?.[1]) {
    state.projectId = projMatch[1];
  }
  const urlImgMatch = /[?&](?:imageId|entityId)=(\d+)/i.exec(url);
  const activeUrlImageId = urlImgMatch?.[1] ?? parseUrlContextFallback().imageId;

  const metaContainer =
    rec && (Array.isArray(rec.classes) || Array.isArray(rec.tags))
      ? rec
      : rec && asRecord(rec.meta) && (Array.isArray(asRecord(rec.meta)!.classes) || Array.isArray(asRecord(rec.meta)!.tags))
        ? asRecord(rec.meta)!
        : null;

  if (
    metaContainer &&
    (lowerUrl.includes("/meta") ||
      lowerUrl.includes(".meta") ||
      lowerUrl.includes("projects") ||
      Array.isArray(metaContainer.classes))
  ) {
    kind = "meta";
    if (Array.isArray(metaContainer.classes)) {
      const parsed = metaContainer.classes
        .map(normalizeClassDef)
        .filter((c): c is ClassDefinition => c !== null);
      if (parsed.length > 0) state.classes = parsed;
    }
    if (Array.isArray(metaContainer.tags)) {
      const parsed = metaContainer.tags
        .map(normalizeTagDef)
        .filter((t): t is TagDefinition => t !== null);
      if (parsed.length > 0) state.tags = parsed;
    }
    if (typeof rec?.projectName === "string" || typeof rec?.name === "string") {
      state.projectName = String(rec.projectName ?? rec.name);
    }
    if (rec?.projectId !== undefined) state.projectId = rec.projectId as string | number;
  } else if (
    rec &&
    (lowerUrl.includes("labeling-jobs") || lowerUrl.includes("/jobs/") || Array.isArray(rec.classesToLabel))
  ) {
    kind = "job";
    if (rec.id !== undefined || rec.jobId !== undefined) {
      state.jobId = (rec.jobId ?? rec.id) as string | number;
    }
    if (typeof rec.name === "string" || typeof rec.jobTitle === "string") {
      state.jobTitle = String(rec.jobTitle ?? rec.name);
    }
    if (Array.isArray(rec.classesToLabel)) {
      state.jobClassesToLabel = rec.classesToLabel.map(String);
    } else if (Array.isArray(rec.meta && asRecord(rec.meta)?.classes)) {
      state.jobClassesToLabel = (asRecord(rec.meta)!.classes as unknown[]).map(String);
    }
  } else if (rec && (Array.isArray(rec.objects) || Array.isArray(rec.figures))) {
    kind = "annotations";
    const imgId = String(rec.imageId ?? rec.entityId ?? urlImgMatch?.[1] ?? rec.id ?? state.currentImageId ?? "");
    const classesById = new Map(state.classes.map((c) => [String(c.classId), c]));
    const rawFigs = (Array.isArray(rec.figures) ? rec.figures : rec.objects) as unknown[];
    ingestAnnotationRecord(
      state,
      imgId,
      rec,
      rawFigs,
      classesById,
      !activeUrlImageId || imgId === activeUrlImageId,
    );
  } else if (
    (lowerUrl.includes("figure") || lowerUrl.includes("annotation") || lowerUrl.includes("bulkinfo")) &&
    (Array.isArray(unwrapped) || (rec && Array.isArray(rec.entities)) || rec !== null)
  ) {
    const classesById = new Map(state.classes.map((c) => [String(c.classId), c]));
    if (Array.isArray(unwrapped) || (rec && Array.isArray(rec.entities))) {
      const list = Array.isArray(unwrapped) ? unwrapped : (rec!.entities as unknown[]);
      const firstItem = asRecord(list[0]);
      if (firstItem && (Array.isArray(firstItem.objects) || Array.isArray(firstItem.figures))) {
        kind = "annotations";
        for (const item of list) {
          const itemRec = asRecord(item);
          if (!itemRec) continue;
          const rawFigs = Array.isArray(itemRec.figures)
            ? itemRec.figures
            : Array.isArray(itemRec.objects)
              ? itemRec.objects
              : [];
          const itemImgId = String(itemRec.imageId ?? itemRec.entityId ?? itemRec.id ?? "");
          ingestAnnotationRecord(
            state,
            itemImgId,
            itemRec,
            rawFigs,
            classesById,
            list.length === 1 || itemImgId === activeUrlImageId,
          );
        }
      } else {
        kind = "annotations";
        const imgId = String(
          rec?.entityId ??
            rec?.imageId ??
            firstItem?.entityId ??
            firstItem?.imageId ??
            urlImgMatch?.[1] ??
            state.currentImageId ??
            "",
        );
        if (imgId && (list.length === 0 || (firstItem && (firstItem.geometryType || firstItem.geometry || firstItem.points)))) {
          const figs = list
            .map((f, i) => normalizeFigure(f, i, classesById))
            .filter((f): f is AnnotationFigure => f !== null);
          const prev = state.annotationsByImageId[imgId];
          state.annotationsByImageId[imgId] = {
            figures: figs,
            imageTags: prev?.imageTags ?? [],
          };
          if (!activeUrlImageId || imgId === activeUrlImageId) {
            state.currentImageId = imgId;
          }
        }
      }
    } else if (rec) {
      // Handle dictionary keyed by imageId (e.g. annotations.bulkInfo -> { "21672930": { objects/figures: [...] } })
      const entries = Object.entries(rec).filter(([k]) => /^\d+$/.test(k));
      if (entries.length > 0) {
        kind = "annotations";
        for (const [imgId, val] of entries) {
          if (Array.isArray(val)) {
            ingestAnnotationRecord(
              state,
              imgId,
              {},
              val,
              classesById,
              entries.length === 1 || imgId === activeUrlImageId,
            );
          } else {
            const valRec = asRecord(val);
            if (!valRec) continue;
            const rawFigs = Array.isArray(valRec.figures)
              ? valRec.figures
              : Array.isArray(valRec.objects)
                ? valRec.objects
                : null;
            if (rawFigs) {
              ingestAnnotationRecord(
                state,
                imgId,
                valRec,
                rawFigs,
                classesById,
                entries.length === 1 || imgId === activeUrlImageId,
              );
            }
          }
        }
      }
    }
  } else if (
    (lowerUrl.includes("image") || lowerUrl.includes("entities")) &&
    (Array.isArray(unwrapped) || (rec && Array.isArray(rec.entities)))
  ) {
    kind = "image";
    const list = Array.isArray(unwrapped) ? unwrapped : (rec!.entities as unknown[]);
    for (const item of list) {
      const itemRec = asRecord(item);
      if (itemRec) {
        const itemId = String(itemRec.imageId ?? itemRec.id ?? itemRec.entityId ?? "");
        upsertImageRecord(state, itemRec, list.length === 1 || (Boolean(activeUrlImageId) && itemId === activeUrlImageId));
      }
    }
  } else if (
    rec &&
    (lowerUrl.includes("/images/") || lowerUrl.includes("images.") || lowerUrl.includes("entities.info")) &&
    (rec.id !== undefined || rec.imageId !== undefined || rec.entityId !== undefined)
  ) {
    kind = "image";
    upsertImageRecord(state, rec, true);
  }

  pushReplayEntry(state, {
    url,
    capturedAtMs: Date.now(),
    kind,
    data: payload,
  });
}

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
): AnnotationFigure[] | null {
  if (depth > 2) return null;
  if (raw instanceof Map) {
    if (targetImageId !== null) {
      const keyed = raw.get(targetImageId) ?? raw.get(Number(targetImageId));
      if (keyed !== undefined) {
        return extractFigureCollection(keyed, classesById, null, depth + 1);
      }
    }
    return extractFigureCollection(Array.from(raw.values()), classesById, targetImageId, depth + 1);
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (!isFigureLikeRecord(raw[0])) return null;
    return raw
      .map((f, i) => normalizeFigure(f, i, classesById))
      .filter((f): f is AnnotationFigure => f !== null);
  }
  const rec = asRecord(raw);
  if (!rec) return null;
  if (targetImageId && rec[targetImageId] !== undefined) {
    const forImg = rec[targetImageId];
    const forImgRec = asRecord(forImg);
    const innerImgFigs = forImgRec
      ? (forImgRec.figures ?? forImgRec.objects ?? forImg)
      : forImg;
    const parsedForImg = extractFigureCollection(innerImgFigs, classesById, null, depth + 1);
    if (parsedForImg) return parsedForImg;
  }
  const inner = asRecord(rec.byId) ?? asRecord(rec.entities) ?? (Array.isArray(rec.items) ? rec.items : null);
  if (Array.isArray(inner)) {
    return extractFigureCollection(inner, classesById, targetImageId, depth + 1);
  }
  const target = inner ?? rec;
  const vals = Object.values(target);
  if (vals.length === 0) return null;
  if (!vals.slice(0, 3).some((v) => isFigureLikeRecord(v))) return null;
  return vals
    .filter((v) => isFigureLikeRecord(v))
    .map((f, i) => normalizeFigure(f, i, classesById))
    .filter((f): f is AnnotationFigure => f !== null);
}

function collectKonvaStageCandidate(candidate: unknown, out: Set<unknown>): void {
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

    // Check candidate annotation/store containers (never overwrite non-empty figures with [])
    const annRec = asRecord(rec.annotations) ?? asRecord(rec.labeling) ?? rec;
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
      const parsedFigs = extractFigureCollection(candidateVal, classesById, hintImageId);
      if (!parsedFigs) continue;
      if (parsedFigs.length > 0 && parsedFigs.length > result.figures.length) {
        result.figures = parsedFigs;
        result.foundStore = true;
      } else if (parsedFigs.length === 0 && storeNodes.has(node)) {
        result.foundStore = true;
      }
    }
    if (Array.isArray(annRec.imageTags)) {
      result.imageTags = (annRec.imageTags as unknown[])
        .map(normalizeTagValue)
        .filter((t): t is TagValue => t !== null);
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
        result.image = {
          imageId: imgId,
          datasetId: String(imgRec.datasetId ?? "0"),
          jobId: state.jobId !== null ? String(state.jobId) : undefined,
          jobTitle: state.jobTitle ?? undefined,
          fileName: String(imgRec.name ?? imgRec.fileName ?? `${imgId}.jpg`),
          width: w,
          height: h,
          imageHash: String(imgRec.hash ?? imgRec.imageHash ?? `sly:${imgId}`),
        };
        if (imgUrl) {
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

function extractKonvaStageFigures(
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

export function buildPageBridgeSnapshot(
  state: InterceptorRuntimeState,
  snapshotSeq: number,
): PageBridgeSnapshot {
  const urlCtx = parseUrlContextFallback();
  const fiber = extractFromReactStore(state);
  const konvaImg = extractKonvaImageSource(fiber.konvaStages) ?? state.lastCanvasImage ?? null;

  const imgId = fiber.image?.imageId ?? state.currentImageId ?? urlCtx.imageId;
  const cachedImg = imgId ? state.imagesById[imgId] : undefined;
  const synthesizedImageMeta: ImageContext | null =
    imgId && (konvaImg?.width || cachedImg)
      ? {
          imageId: imgId,
          datasetId: urlCtx.datasetId,
          jobId: urlCtx.jobId ?? undefined,
          fileName: cachedImg?.meta.fileName ?? `${imgId}.jpg`,
          width: konvaImg?.width || cachedImg?.meta.width || 1920,
          height: konvaImg?.height || cachedImg?.meta.height || 1080,
          imageHash: cachedImg?.meta.imageHash ?? `sly:${imgId}`,
        }
      : null;

  const imageMeta: ImageContext | null =
    fiber.image ??
    (cachedImg && cachedImg.meta.width > 0 && cachedImg.meta.height > 0
      ? cachedImg.meta
      : synthesizedImageMeta);

  const candidateImageUrl =
    fiber.originalImageUrl ??
    cachedImg?.url ??
    konvaImg?.url ??
    extractResourceTimingImageUrl(imgId) ??
    null;
  const originalImageUrl =
    candidateImageUrl && !isNonWorkspaceImageUrl(candidateImageUrl) ? candidateImageUrl : null;

  const classesById = new Map(state.classes.map((c) => [String(c.classId), c]));
  const cachedAnn = imgId ? state.annotationsByImageId[imgId] : undefined;
  const hasFiberFigs = fiber.foundStore;
  const hasNetworkFigs = Boolean(cachedAnn);

  let rawFigures: AnnotationFigure[] = [];
  if (fiber.figures.length > 0) {
    rawFigures = fiber.figures;
  } else if (cachedAnn && cachedAnn.figures.length > 0) {
    rawFigures = cachedAnn.figures;
  } else {
    rawFigures = extractKonvaStageFigures(classesById, fiber.konvaStages);
  }

  const figures = rawFigures.map((fig) => {
    if (fig.classTitle && fig.classTitle !== "Unknown") return fig;
    const mapped = classesById.get(String(fig.classId));
    return mapped ? { ...fig, classTitle: mapped.title } : fig;
  });

  const imageTags =
    fiber.imageTags.length > 0 ? fiber.imageTags : cachedAnn?.imageTags ?? [];

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
