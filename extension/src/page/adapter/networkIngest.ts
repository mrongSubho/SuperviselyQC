import { isNonWorkspaceImageUrl } from "../../shared/imageUrlFilter";
import type {
  AnnotationFigure,
  ClassDefinition,
  ImageContext,
  TagDefinition,
  TagValue,
} from "../../shared/types";
import {
  asRecord,
  ingestObjectMetadataCollection,
  normalizeClassDef,
  normalizeFigure,
  normalizeTagDef,
  normalizeTagValue,
  pushReplayEntry,
  type InterceptorRuntimeState,
  type ReplayEntry,
} from "./typesAndNormalizers";
import { parseUrlContextFallback } from "./snapshotBuilder";

export function extractImageRecordUrl(rec: Record<string, unknown>): string | null {
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

export function extractImageDimensions(
  rec: Record<string, unknown>,
  existing?: ImageContext,
): { width: number; height: number; fromMetadata: boolean } {
  const metaContainers = [
    asRecord(rec.fileMeta),
    asRecord(rec.meta),
    asRecord(rec.size),
    asRecord(rec.info),
  ];
  for (const c of metaContainers) {
    if (!c) continue;
    const cw = Number(c.originalWidth ?? c.naturalWidth ?? c.width ?? 0);
    const ch = Number(c.originalHeight ?? c.naturalHeight ?? c.height ?? 0);
    if (cw > 0 && ch > 0) {
      return { width: cw, height: ch, fromMetadata: true };
    }
  }
  const origW = Number(rec.originalWidth ?? rec.naturalWidth ?? 0);
  const origH = Number(rec.originalHeight ?? rec.naturalHeight ?? 0);
  if (origW > 0 && origH > 0) {
    return { width: origW, height: origH, fromMetadata: true };
  }
  const cw = Number(rec.width ?? 0);
  const ch = Number(rec.height ?? 0);
  if (cw > 0 && ch > 0) {
    if (existing && existing.width > 0 && existing.height > 0 && existing.width * existing.height > cw * ch) {
      return { width: existing.width, height: existing.height, fromMetadata: false };
    }
    return { width: cw, height: ch, fromMetadata: false };
  }
  return {
    width: existing?.width ?? 0,
    height: existing?.height ?? 0,
    fromMetadata: false,
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
  const { width: rawW, height: rawH } = extractImageDimensions(rec, existing?.meta);
  const existingArea = existing ? existing.meta.width * existing.meta.height : 0;
  const keepLargerExisting = existing && existingArea > rawW * rawH;
  const w = keepLargerExisting ? existing.meta.width : rawW;
  const h = keepLargerExisting ? existing.meta.height : rawH;
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
  if (annRec.objects) {
    ingestObjectMetadataCollection(annRec.objects, classesById, state.objectsById);
  }
  if (annRec.objectsById) {
    ingestObjectMetadataCollection(annRec.objectsById, classesById, state.objectsById);
  }
  const figs = rawFigs
    .map((f, i) =>
      normalizeFigure(
        f,
        i,
        classesById,
        state.objectsById,
        state.figureObjectIdByFigureId,
      ),
    )
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
  const sw = sizeRec ? Number(sizeRec.width ?? 0) : 0;
  const sh = sizeRec ? Number(sizeRec.height ?? 0) : 0;
  const existing = state.imagesById[imgId];
  if (sw > 0 && sh > 0 && (!existing || sw * sh > existing.meta.width * existing.meta.height)) {
    state.imagesById[imgId] = {
      meta: {
        imageId: imgId,
        datasetId: String(annRec.datasetId ?? existing?.meta.datasetId ?? "0"),
        jobId: state.jobId !== null ? String(state.jobId) : existing?.meta.jobId,
        jobTitle: state.jobTitle ?? existing?.meta.jobTitle,
        fileName: String(annRec.imageName ?? annRec.name ?? existing?.meta.fileName ?? `${imgId}.jpg`),
        width: sw,
        height: sh,
        imageHash: String(annRec.hash ?? existing?.meta.imageHash ?? `sly:${imgId}`),
      },
      url: extractImageRecordUrl(annRec) ?? existing?.url ?? null,
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
            .map((f, i) =>
              normalizeFigure(
                f,
                i,
                classesById,
                state.objectsById,
                state.figureObjectIdByFigureId,
              ),
            )
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
