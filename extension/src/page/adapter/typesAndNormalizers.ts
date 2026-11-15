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
} from "../../shared/types";

export interface ReplayEntry {
  url: string;
  capturedAtMs: number;
  kind: "meta" | "job" | "image" | "annotations" | "other";
  data: unknown;
}

export interface ObjectMetaEntry {
  classId: number | string;
  classTitle?: string;
  tags: TagValue[];
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
  objectsById: Record<string, ObjectMetaEntry>;
  figureObjectIdByFigureId: Record<string, string>;
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
    objectsById: {},
    figureObjectIdByFigureId: {},
    annotationsByImageId: {},
    lastCanvasImage: null,
  };
}

export function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

export function asPoint2D(val: unknown): Point2D | null {
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

export function normalizeGeometryType(raw: unknown): GeometryType {
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

export function ingestObjectMetadataCollection(
  raw: unknown,
  classesById: Map<string, ClassDefinition>,
  objectsById: Record<string, ObjectMetaEntry>,
  depth = 0,
): void {
  if (!raw || depth > 2) return;
  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) {
      const rec = asRecord(v);
      if (rec) {
        ingestObjectMetadataCollection({ [String(k)]: rec }, classesById, objectsById, depth + 1);
      } else {
        ingestObjectMetadataCollection(v, classesById, objectsById, depth + 1);
      }
    }
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const rec = asRecord(item);
      if (!rec) continue;
      const oid = rec.id ?? rec.objectId ?? rec.key;
      if (oid === undefined || oid === null) continue;
      const clsObj = asRecord(rec.class) ?? asRecord(rec.objClass);
      const classIdRaw = rec.classId ?? rec.objClassId ?? clsObj?.id ?? clsObj?.classId ?? 0;
      const classId =
        typeof classIdRaw === "number" || typeof classIdRaw === "string" ? classIdRaw : 0;
      const clsDef = classesById.get(String(classId));
      const rawTitle =
        typeof rec.classTitle === "string"
          ? rec.classTitle
          : typeof rec.className === "string"
            ? rec.className
            : typeof clsObj?.title === "string"
              ? clsObj.title
              : typeof rec.objClassTitle === "string"
                ? rec.objClassTitle
                : clsDef?.title;
      const tagsRaw = Array.isArray(rec.tags) ? rec.tags : [];
      const tags = tagsRaw.map(normalizeTagValue).filter((t): t is TagValue => t !== null);
      if (classId !== 0 || rawTitle || tags.length > 0) {
        const key = String(oid);
        const prev = objectsById[key];
        objectsById[key] = {
          classId: classId !== 0 ? classId : (prev?.classId ?? 0),
          classTitle: rawTitle && rawTitle !== "Unknown" ? rawTitle : prev?.classTitle,
          tags: tags.length > 0 ? tags : (prev?.tags ?? []),
        };
      }
    }
    return;
  }
  const dict = asRecord(raw);
  if (!dict) return;
  const inner = asRecord(dict.byId) ?? asRecord(dict.entities);
  const entries = Object.entries(inner ?? dict);
  for (const [key, val] of entries) {
    if (Array.isArray(val)) {
      ingestObjectMetadataCollection(val, classesById, objectsById, depth + 1);
      continue;
    }
    const rec = asRecord(val);
    if (!rec) continue;
    if (Array.isArray(rec.objects) || rec.objectsById) {
      if (Array.isArray(rec.objects)) {
        ingestObjectMetadataCollection(rec.objects, classesById, objectsById, depth + 1);
      }
      if (rec.objectsById) {
        ingestObjectMetadataCollection(rec.objectsById, classesById, objectsById, depth + 1);
      }
      continue;
    }
    ingestObjectMetadataCollection([{ id: rec.id ?? key, ...rec }], classesById, objectsById, depth + 1);
  }
}

export function normalizeFigure(
  raw: unknown,
  idx: number,
  classesById: Map<string, ClassDefinition>,
  objectsById?: Record<string, ObjectMetaEntry>,
  figureObjectIdByFigureId?: Record<string, string>,
): AnnotationFigure | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const geometryType = normalizeGeometryType(rec.geometryType ?? rec.shape);
  const inlineObj = asRecord(rec.object) ?? asRecord(rec.obj);
  const objectIdRaw = rec.objectId ?? rec.objId ?? inlineObj?.id ?? inlineObj?.objectId;
  const objectIdStr =
    objectIdRaw !== undefined && objectIdRaw !== null && String(objectIdRaw) !== ""
      ? String(objectIdRaw)
      : null;
  const linkedObj = objectIdStr && objectsById ? objectsById[objectIdStr] : undefined;
  const clsObj =
    asRecord(rec.class) ??
    asRecord(rec.objClass) ??
    asRecord(inlineObj?.class) ??
    asRecord(inlineObj?.objClass) ??
    asRecord(rec.meta);
  const classIdRaw =
    rec.classId ??
    rec.objClassId ??
    inlineObj?.classId ??
    inlineObj?.objClassId ??
    clsObj?.id ??
    clsObj?.classId ??
    linkedObj?.classId ??
    0;
  const classId = typeof classIdRaw === "number" || typeof classIdRaw === "string" ? classIdRaw : 0;
  const clsDef = classesById.get(String(classId));
  const inlineTitle =
    typeof inlineObj?.classTitle === "string"
      ? inlineObj.classTitle
      : typeof inlineObj?.objClassTitle === "string"
        ? inlineObj.objClassTitle
        : undefined;
  const classTitle =
    typeof rec.classTitle === "string" && rec.classTitle !== "Unknown"
      ? rec.classTitle
      : typeof rec.className === "string" && rec.className !== "Unknown"
        ? rec.className
        : typeof clsObj?.title === "string" && clsObj.title !== "Unknown"
          ? clsObj.title
          : typeof rec.objClassTitle === "string" && rec.objClassTitle !== "Unknown"
            ? rec.objClassTitle
            : inlineTitle ??
              (linkedObj?.classTitle && linkedObj.classTitle !== "Unknown"
                ? linkedObj.classTitle
                : undefined) ??
              clsDef?.title ??
              "Unknown";

  const figureId = String(rec.figureId ?? rec.id ?? rec.key ?? `fig_${idx}`);
  if (objectIdStr && figureObjectIdByFigureId) {
    figureObjectIdByFigureId[figureId] = objectIdStr;
  }
  const tagsRaw = Array.isArray(rec.tags) ? rec.tags : [];
  const figTags = tagsRaw.map(normalizeTagValue).filter((t): t is TagValue => t !== null);
  const inheritedTags =
    figTags.length > 0
      ? figTags
      : Array.isArray(inlineObj?.tags)
        ? inlineObj.tags.map(normalizeTagValue).filter((t): t is TagValue => t !== null)
        : (linkedObj?.tags ?? []);
  const tags = inheritedTags;

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

export function normalizeClassDef(raw: unknown): ClassDefinition | null {
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

export function normalizeTagDef(raw: unknown): TagDefinition | null {
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
