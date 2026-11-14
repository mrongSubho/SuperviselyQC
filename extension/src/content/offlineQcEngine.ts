import {
  bboxIouAndIos,
  computeFigureBbox,
  decodeSuperviselyBitmapPng,
  pointInPolygon,
  shoelacePolygonArea,
} from "../shared/geometry";
import type {
  AnnotationFigure,
  BoundingBoxTuple,
  ClassDefinition,
  Point2D,
  QCAnalyzeRequest,
  QCFinding,
  QCResponse,
  QuickFixAction,
  RuleProfile,
  SummaryCounts,
  TagDefinition,
} from "../shared/types";

const DEFAULT_OFFLINE_PROFILE: RuleProfile = {
  profileId: "offline-default",
  name: "Offline Default Rules Profile",
  description: "Client-side deterministic fallback rules when local FastAPI backend is offline.",
  isBuiltin: true,
  matchers: { jobTitleRegex: ".*", projectIds: [], datasetIds: [] },
  workflowRules: {
    blockOnUnsavedSync: true,
    warnOnEmptyImageWithoutConfirm: true,
  },
  tagRules: {
    imageOnlyTags: [],
    objectOnlyTags: ["Occlusion"],
    occlusionOverlapIouThreshold: 0.1,
    occlusionCoverRatioThreshold: 0.15,
    flagForegroundOcclusionFalsePositive: true,
  },
  geometryRules: {
    minBoxAreaPx: 64,
    minPolygonVertices: 3,
    minPolylineVertices: 2,
    minMaskAreaPx: 32,
    maxDisconnectedMaskComponents: 8,
    edgeSnapMarginPx: 3,
    minBoxIouTightness: 0.72,
    requireRequiredGraphNodes: true,
  },
  visionRules: {
    missedObjectMinConfidence: 0.45,
    minLaplacianSharpness: 35.0,
    ignoreBackgroundBokeh: true,
    enableDepthOcclusionOrdering: true,
  },
  classOverrides: {},
};

interface NormFig {
  fig: AnnotationFigure;
  label: string;
  bbox: BoundingBoxTuple;
  bboxArea: number;
  geomArea: number;
  invertedBoxCoords: boolean;
  vertices: Point2D[];
  outsideViewport: boolean;
  fgMaskPixels?: number;
}

function hashFingerprint(fp: string): string {
  let h = 2166136261;
  for (let i = 0; i < fp.length; i += 1) {
    h ^= fp.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return String((h >>> 0) % 1_000_000).padStart(6, "0");
}

function makeFinding(
  imgW: number,
  imgH: number,
  params: Omit<QCFinding, "findingId" | "focusRect"> & { focusRect?: BoundingBoxTuple },
): QCFinding {
  const r = params.focusRect
    ? ([
        Math.max(0, Math.min(imgW, Math.min(params.focusRect[0], params.focusRect[2]))),
        Math.max(0, Math.min(imgH, Math.min(params.focusRect[1], params.focusRect[3]))),
        Math.max(0, Math.min(imgW, Math.max(params.focusRect[0], params.focusRect[2]))),
        Math.max(0, Math.min(imgH, Math.max(params.focusRect[1], params.focusRect[3]))),
      ] as BoundingBoxTuple)
    : undefined;
  return {
    ...params,
    findingId: `f_${params.ruleId.toLowerCase()}_${hashFingerprint(params.fingerprint)}`,
    focusRect: r ?? null,
  };
}

function isOutsideViewport(bbox: BoundingBoxTuple, req: QCAnalyzeRequest): boolean {
  const vp = req.viewport;
  const nr = vp.visibleNormRect;
  const cropped =
    Math.abs(nr[0]) > 1e-3 ||
    Math.abs(nr[1]) > 1e-3 ||
    Math.abs(nr[2] - 1) > 1e-3 ||
    Math.abs(nr[3] - 1) > 1e-3;
  if (vp.zoomPercent >= 98 && !cropped) return false;

  const [vx1, vy1, vx2, vy2] = vp.visiblePixelRect;
  const [bx1, by1, bx2, by2] = bbox;
  const ix = Math.max(0, Math.min(bx2, vx2) - Math.max(bx1, vx1));
  const iy = Math.max(0, Math.min(by2, vy2) - Math.max(by1, vy1));
  const area = Math.max((bx2 - bx1) * (by2 - by1), 1e-6);
  return (ix * iy) / area < 0.15;
}

function orientation(a: Point2D, b: Point2D, c: Point2D): number {
  const val = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(val) < 1e-7) return 0;
  return val > 0 ? 1 : 2;
}

function segmentsProperlyIntersect(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

function hasPolygonSelfIntersection(ring: Point2D[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a1 = ring[i]!;
    const a2 = ring[(i + 1) % n]!;
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue; // adjacent wrap-around edge
      const b1 = ring[j]!;
      const b2 = ring[(j + 1) % n]!;
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function hasPolylineSelfIntersection(pts: Point2D[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n - 1; i += 1) {
    const a1 = pts[i]!;
    const a2 = pts[i + 1]!;
    for (let j = i + 2; j < n - 1; j += 1) {
      if (segmentsProperlyIntersect(a1, a2, pts[j]!, pts[j + 1]!)) return true;
    }
  }
  return false;
}

function polylineLength(pts: Point2D[]): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    len += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
  }
  return len;
}

function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 <= 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distToPolyline(p: Point2D, pts: Point2D[]): number {
  let minD = Infinity;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const d = pointToSegmentDist(p, pts[i]!, pts[i + 1]!);
    if (d < minD) minD = d;
  }
  return minD;
}

function samplePolyline(pts: Point2D[]): Point2D[] {
  const out: Point2D[] = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    for (let k = 0; k <= 4; k += 1) {
      const t = k / 4;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function parseBilateral(label: string): { side: "L" | "R"; part: string } | null {
  const norm = label.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const sideM = /^(left|l)_(.+)$/.exec(norm) ?? /^(.+)_(left|l)$/.exec(norm);
  if (sideM) {
    const part = sideM[1] === "left" || sideM[1] === "l" ? sideM[2]! : sideM[1]!;
    return { side: "L", part };
  }
  const rSideM = /^(right|r)_(.+)$/.exec(norm) ?? /^(.+)_(right|r)$/.exec(norm);
  if (rSideM) {
    const part = rSideM[1] === "right" || rSideM[1] === "r" ? rSideM[2]! : rSideM[1]!;
    return { side: "R", part };
  }
  return null;
}

export async function runOfflineDeterministicQc(
  req: QCAnalyzeRequest,
  profile: RuleProfile = DEFAULT_OFFLINE_PROFILE,
): Promise<QCResponse> {
  const t0 = performance.now();
  const W = req.image.width;
  const H = req.image.height;
  const imgArea = Math.max(1, W * H);
  const sMin = Math.min(15.0, Math.max(8.0, 0.025 * Math.min(W, H)));
  const isPartial =
    req.uiState.stateSource === "dom_fallback" || req.uiState.partialGeometry;

  const classesByTitle = new Map<string, ClassDefinition>(
    req.ontology.classes.map((c) => [c.title, c]),
  );
  const classesById = new Map<string, ClassDefinition>(
    req.ontology.classes.map((c) => [String(c.classId), c]),
  );
  const tagsByName = new Map<string, TagDefinition>(
    req.ontology.tags.map((t) => [t.name, t]),
  );

  const findings: QCFinding[] = [];
  const labelDisplay = (f: AnnotationFigure) =>
    f.labelIndex !== undefined ? `${f.classTitle} #${f.labelIndex}` : `${f.classTitle} (${f.figureId})`;

  // 1. Workflow rules
  if (profile.workflowRules.blockOnUnsavedSync && req.uiState.synchronizeDirty) {
    const fix: QuickFixAction = {
      actionId: "fix_sync_before_confirm",
      label: "Synchronize Now",
      actionType: "highlight_synchronize",
    };
    findings.push(
      makeFinding(W, H, {
        ruleId: "WORKFLOW_UNSAVED_SYNC",
        severity: "blocker",
        category: "workflow",
        title: "Unsaved Annotations (Synchronize Dirty)",
        message: "The Synchronize button indicates unsaved workspace changes.",
        figureIds: [],
        imageTagNames: [],
        missedObjectIds: [],
        outsideViewport: false,
        confidence: 1.0,
        suggestedFixes: [fix],
        fingerprint: `WORKFLOW_UNSAVED_SYNC:${req.image.imageId}`,
      }),
    );
  }

  const domSummaries = req.domFigureSummaries ?? [];
  const domTotal = domSummaries.reduce((acc, s) => acc + s.figureCount, 0);
  if (
    profile.workflowRules.warnOnEmptyImageWithoutConfirm &&
    !req.uiState.isConfirmed &&
    !req.uiState.synchronizeDirty &&
    ((!isPartial && req.figures.length === 0) || (isPartial && domTotal === 0))
  ) {
    findings.push(
      makeFinding(W, H, {
        ruleId: "WORKFLOW_EMPTY_IMAGE_UNCONFIRMED",
        severity: "info",
        category: "workflow",
        title: "Empty Image Not Confirmed",
        message: "No annotations are present and image is not marked confirmed.",
        figureIds: [],
        imageTagNames: [],
        missedObjectIds: [],
        outsideViewport: false,
        confidence: 1.0,
        suggestedFixes: [],
        fingerprint: `WORKFLOW_EMPTY_IMAGE_UNCONFIRMED:${req.image.imageId}`,
      }),
    );
  }

  // Image tags rules (run in both normal & dom_fallback)
  for (const tag of req.imageTags) {
    const tdef = tagsByName.get(tag.name);
    if (
      (tdef && tdef.applicableType === "objectsOnly") ||
      profile.tagRules.objectOnlyTags.includes(tag.name)
    ) {
      findings.push(
        makeFinding(W, H, {
          ruleId: "TAG_SCOPE_MISMATCH",
          severity: "warning",
          category: "tags",
          title: "Object-Only Tag Applied to Image",
          message: `Tag '${tag.name}' should be attached to an object, not image-level tags.`,
          figureIds: [],
          imageTagNames: [tag.name],
          missedObjectIds: [],
          outsideViewport: false,
          confidence: 0.95,
          suggestedFixes: [],
          fingerprint: `TAG_SCOPE_MISMATCH:img:${tag.name}`,
        }),
      );
    }
    if (tdef) {
      if (tdef.valueType === "any_number" && (tag.value === null || tag.value === "" || !Number.isFinite(Number(tag.value)))) {
        findings.push(
          makeFinding(W, H, {
            ruleId: "TAG_INVALID_VALUE",
            severity: "warning",
            category: "tags",
            title: "Invalid Numeric Image Tag Value",
            message: `Image tag '${tag.name}' requires a valid number.`,
            figureIds: [],
            imageTagNames: [tag.name],
            missedObjectIds: [],
            outsideViewport: false,
            confidence: 0.95,
            suggestedFixes: [],
            fingerprint: `TAG_INVALID_VALUE:img:${tag.name}`,
          }),
        );
      } else if (
        tdef.valueType === "oneof_string" &&
        tdef.values.length > 0 &&
        !tdef.values.includes(String(tag.value ?? ""))
      ) {
        findings.push(
          makeFinding(W, H, {
            ruleId: "TAG_INVALID_VALUE",
            severity: "warning",
            category: "tags",
            title: "Invalid Option for Image Tag",
            message: `Image tag '${tag.name}' value is not in allowed options [${tdef.values.join(", ")}].`,
            figureIds: [],
            imageTagNames: [tag.name],
            missedObjectIds: [],
            outsideViewport: false,
            confidence: 0.95,
            suggestedFixes: [],
            fingerprint: `TAG_INVALID_VALUE:img:${tag.name}`,
          }),
        );
      }
    }
  }

  // Class scope checks
  const allowedJobSet =
    req.ontology.jobClassesToLabel && req.ontology.jobClassesToLabel.length > 0
      ? new Set(req.ontology.jobClassesToLabel)
      : null;

  if (isPartial) {
    findings.push(
      makeFinding(W, H, {
        ruleId: "WORKFLOW_DOM_FALLBACK_PARTIAL",
        severity: "info",
        category: "workflow",
        title: "Partial State (DOM Fallback)",
        message: "Live Supervisely annotation store unavailable; offline QC checked workflow, tags, and class scope.",
        figureIds: [],
        imageTagNames: [],
        missedObjectIds: [],
        outsideViewport: false,
        confidence: 1.0,
        suggestedFixes: [],
        fingerprint: `WORKFLOW_DOM_FALLBACK_PARTIAL:${req.image.imageId}`,
      }),
    );

    for (const s of domSummaries) {
      const ov = profile.classOverrides[s.classTitle];
      if (ov && !ov.enabled && s.figureCount > 0) {
        findings.push(
          makeFinding(W, H, {
            ruleId: "CLASS_DISABLED_IN_PROFILE",
            severity: "warning",
            category: "classification",
            title: "Disabled Class Present",
            message: `${s.figureCount} '${s.classTitle}' annotation(s) present while class is disabled in active profile.`,
            figureIds: [],
            imageTagNames: [],
            missedObjectIds: [],
            outsideViewport: false,
            confidence: 0.9,
            suggestedFixes: [],
            fingerprint: `CLASS_DISABLED_IN_PROFILE:dom:${s.classTitle}`,
          }),
        );
      }
      if (allowedJobSet && !allowedJobSet.has(s.classTitle) && s.figureCount > 0) {
        findings.push(
          makeFinding(W, H, {
            ruleId: "CLASS_OUT_OF_JOB_SCOPE",
            severity: "warning",
            category: "classification",
            title: "Class Outside Labeling Job Scope",
            message: `${s.figureCount} '${s.classTitle}' annotation(s) are not in active labeling job classes.`,
            figureIds: [],
            imageTagNames: [],
            missedObjectIds: [],
            outsideViewport: false,
            confidence: 0.9,
            suggestedFixes: [],
            fingerprint: `CLASS_OUT_OF_JOB_SCOPE:dom:${s.classTitle}`,
          }),
        );
      }
    }
  }

  // Normalize figures in full mode
  const normFigs: NormFig[] = [];
  if (!isPartial) {
    for (const fig of req.figures) {
      const base = computeFigureBbox(fig);
      let bbox = base.bbox;
      let geomArea = Math.max(0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
      let fgMaskPixels: number | undefined;

      if (fig.geometryType === "polygon") {
        const ext = fig.points?.exterior ?? [];
        const ints = fig.points?.interior ?? [];
        const extArea = shoelacePolygonArea(ext);
        const holeArea = ints.reduce((acc, h) => acc + shoelacePolygonArea(h), 0);
        geomArea = Math.max(0, extArea - holeArea);
      } else if (fig.geometryType === "bitmap" && fig.bitmap?.data) {
        const dec = await decodeSuperviselyBitmapPng(fig.bitmap.data, fig.bitmap.origin, W, H);
        if (dec.errorCode && dec.errorCode !== "BITMAP_UNSUPPORTED_OFFLINE_FORMAT") {
          findings.push(
            makeFinding(W, H, {
              ruleId: "BITMAP_DECODE_ERROR",
              severity: "blocker",
              category: "geometry",
              title: "Corrupt or Unsafe Bitmap Payload",
              message: `${labelDisplay(fig)}: ${dec.errorMessage ?? dec.errorCode}`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: false,
              confidence: 1.0,
              suggestedFixes: [],
              fingerprint: `BITMAP_DECODE_ERROR:${fig.figureId}`,
            }),
          );
        } else if (dec.mask) {
          fgMaskPixels = dec.fgPixels;
          bbox = [dec.originX, dec.originY, dec.originX + dec.width, dec.originY + dec.height];
          geomArea = dec.fgPixels;
        }
      }

      const bboxArea = Math.max(0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
      const nf: NormFig = {
        fig,
        label: labelDisplay(fig),
        bbox,
        bboxArea,
        geomArea,
        invertedBoxCoords: base.invertedBoxCoords,
        vertices: base.vertices,
        outsideViewport: isOutsideViewport(bbox, req),
        fgMaskPixels,
      };
      normFigs.push(nf);

      // Class & object tags checks
      const ov = profile.classOverrides[fig.classTitle];
      if (ov && !ov.enabled) {
        findings.push(
          makeFinding(W, H, {
            ruleId: "CLASS_DISABLED_IN_PROFILE",
            severity: "warning",
            category: "classification",
            title: "Disabled Class Used",
            message: `${nf.label} belongs to disabled class '${fig.classTitle}'.`,
            figureIds: [fig.figureId],
            imageTagNames: [],
            missedObjectIds: [],
            outsideViewport: nf.outsideViewport,
            focusRect: nf.bbox,
            confidence: 0.95,
            suggestedFixes: [],
            fingerprint: `CLASS_DISABLED_IN_PROFILE:${fig.figureId}`,
          }),
        );
      }
      if (allowedJobSet && !allowedJobSet.has(fig.classTitle)) {
        findings.push(
          makeFinding(W, H, {
            ruleId: "CLASS_OUT_OF_JOB_SCOPE",
            severity: "warning",
            category: "classification",
            title: "Class Outside Labeling Job Scope",
            message: `${nf.label} is outside job classesToLabel.`,
            figureIds: [fig.figureId],
            imageTagNames: [],
            missedObjectIds: [],
            outsideViewport: nf.outsideViewport,
            focusRect: nf.bbox,
            confidence: 0.95,
            suggestedFixes: [],
            fingerprint: `CLASS_OUT_OF_JOB_SCOPE:${fig.figureId}`,
          }),
        );
      }

      const figTagNames = new Set(fig.tags.map((t) => t.name));
      for (const reqTag of ov?.requiredTags ?? []) {
        if (!figTagNames.has(reqTag)) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "TAG_REQUIRED_MISSING",
              severity: "blocker",
              category: "tags",
              title: "Required Object Tag Missing",
              message: `${nf.label} requires tag '${reqTag}'.`,
              figureIds: [fig.figureId],
              imageTagNames: [reqTag],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 1.0,
              suggestedFixes: [
                {
                  actionId: `fix_tag_${fig.figureId}_${reqTag}`,
                  label: `Add "${reqTag}"`,
                  actionType: "add_object_tag",
                  targetFigureIds: [fig.figureId],
                  tagName: reqTag,
                  focusRect: nf.bbox,
                },
              ],
              fingerprint: `TAG_REQUIRED_MISSING:${fig.figureId}:${reqTag}`,
            }),
          );
        }
      }

      for (const t of fig.tags) {
        const tdef = tagsByName.get(t.name);
        if (
          (tdef && (tdef.applicableType === "imagesOnly" || (tdef.classes.length > 0 && !tdef.classes.includes(fig.classTitle)))) ||
          profile.tagRules.imageOnlyTags.includes(t.name)
        ) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "TAG_SCOPE_MISMATCH",
              severity: "warning",
              category: "tags",
              title: "Incompatible Tag Scope",
              message: `Tag '${t.name}' is not applicable to ${nf.label}.`,
              figureIds: [fig.figureId],
              imageTagNames: [t.name],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 0.95,
              suggestedFixes: [],
              fingerprint: `TAG_SCOPE_MISMATCH:${fig.figureId}:${t.name}`,
            }),
          );
        }
      }

      // Bounds check [-1, W+1] / [-1, H+1]
      const oob = nf.vertices.some(([vx, vy]) => vx < -1 || vy < -1 || vx > W + 1 || vy > H + 1);
      if (oob) {
        findings.push(
          makeFinding(W, H, {
            ruleId: "GEOM_OUT_OF_BOUNDS",
            severity: "blocker",
            category: "geometry",
            title: "Coordinates Outside Image Canvas",
            message: `${nf.label} extends outside valid [0, ${W}] x [0, ${H}] bounds.`,
            figureIds: [fig.figureId],
            imageTagNames: [],
            missedObjectIds: [],
            outsideViewport: nf.outsideViewport,
            focusRect: nf.bbox,
            confidence: 1.0,
            suggestedFixes: [],
            fingerprint: `GEOM_OUT_OF_BOUNDS:${fig.figureId}`,
          }),
        );
      }

      // Primitive geometry rules
      const bw = Math.max(0, nf.bbox[2] - nf.bbox[0]);
      const bh = Math.max(0, nf.bbox[3] - nf.bbox[1]);
      if (fig.geometryType === "rectangle") {
        if (nf.invertedBoxCoords) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "BBOX_NON_CANONICAL_CORNERS",
              severity: "info",
              category: "geometry",
              title: "Inverted Rectangle Corners",
              message: `${nf.label} has non-canonical corner ordering.`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 0.9,
              suggestedFixes: [],
              fingerprint: `BBOX_NON_CANONICAL_CORNERS:${fig.figureId}`,
            }),
          );
        }
        if (Math.min(bw, bh) < sMin || nf.bboxArea < profile.geometryRules.minBoxAreaPx) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "GEOM_MICRO_CLICK",
              severity: "warning",
              category: "geometry",
              title: "Micro / Accidental Box Click",
              message: `${nf.label} (${Math.round(bw)}x${Math.round(bh)}px) is below minimum size threshold.`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 0.92,
              suggestedFixes: [],
              fingerprint: `GEOM_MICRO_CLICK:${fig.figureId}`,
            }),
          );
        }
        const bgClasses = new Set(["background", "sky", "road", "building", "ground"]);
        if (
          nf.bboxArea >= 0.9 * imgArea &&
          !bgClasses.has(fig.classTitle.toLowerCase())
        ) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "GEOM_CANVAS_WIDE_ACCIDENTAL",
              severity: "warning",
              category: "geometry",
              title: "Canvas-Wide Accidental Box",
              message: `${nf.label} covers ${Math.round((nf.bboxArea / imgArea) * 100)}% of image area.`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 0.9,
              suggestedFixes: [],
              fingerprint: `GEOM_CANVAS_WIDE_ACCIDENTAL:${fig.figureId}`,
            }),
          );
        }
      } else if (fig.geometryType === "polygon") {
        const ext = fig.points?.exterior ?? [];
        const ints = fig.points?.interior ?? [];
        if (ext.length < profile.geometryRules.minPolygonVertices) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "POLY_TOO_FEW_VERTICES",
              severity: "blocker",
              category: "geometry",
              title: "Polygon Too Few Vertices",
              message: `${nf.label} has only ${ext.length} vertices.`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 1.0,
              suggestedFixes: [],
              fingerprint: `POLY_TOO_FEW_VERTICES:${fig.figureId}`,
            }),
          );
        } else if (hasPolygonSelfIntersection(ext)) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "POLY_SELF_INTERSECTION",
              severity: "blocker",
              category: "geometry",
              title: "Self-Intersecting Polygon",
              message: `${nf.label} exterior crosses itself (bowtie topology).`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 1.0,
              suggestedFixes: [],
              fingerprint: `POLY_SELF_INTERSECTION:${fig.figureId}`,
            }),
          );
        } else if (nf.geomArea < profile.geometryRules.minBoxAreaPx) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "GEOM_MICRO_CLICK",
              severity: "warning",
              category: "geometry",
              title: "Micro Polygon Area",
              message: `${nf.label} polygon area (${Math.round(nf.geomArea)}px²) is too tiny.`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 0.9,
              suggestedFixes: [],
              fingerprint: `GEOM_MICRO_CLICK:${fig.figureId}`,
            }),
          );
        }
        for (const hole of ints) {
          const hArea = shoelacePolygonArea(hole);
          const anyOutside = hole.length > 0 && !pointInPolygon(hole[0]!, ext);
          if (hole.length < 3 || hArea < 16.0 || anyOutside) {
            findings.push(
              makeFinding(W, H, {
                ruleId: "POLY_INVALID_HOLE",
                severity: "warning",
                category: "geometry",
                title: "Invalid Polygon Interior Hole",
                message: `${nf.label} contains an invalid or outside interior hole ring.`,
                figureIds: [fig.figureId],
                imageTagNames: [],
                missedObjectIds: [],
                outsideViewport: nf.outsideViewport,
                focusRect: nf.bbox,
                confidence: 0.92,
                suggestedFixes: [],
                fingerprint: `POLY_INVALID_HOLE:${fig.figureId}`,
              }),
            );
            break;
          }
        }
      } else if (fig.geometryType === "bitmap" && fgMaskPixels !== undefined) {
        if (fgMaskPixels < profile.geometryRules.minMaskAreaPx) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "BITMAP_TINY_FRAGMENT",
              severity: "warning",
              category: "geometry",
              title: "Tiny Brush Mask Fragment",
              message: `${nf.label} has only ${fgMaskPixels} foreground pixels.`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 0.9,
              suggestedFixes: [],
              fingerprint: `BITMAP_TINY_FRAGMENT:${fig.figureId}`,
            }),
          );
        }
      } else if (fig.geometryType === "polyline") {
        const pts = fig.points?.exterior ?? [];
        if (pts.length < profile.geometryRules.minPolylineVertices) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "LINE_TOO_FEW_VERTICES",
              severity: "blocker",
              category: "geometry",
              title: "Polyline Too Few Vertices",
              message: `${nf.label} requires at least ${profile.geometryRules.minPolylineVertices} vertices.`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 1.0,
              suggestedFixes: [],
              fingerprint: `LINE_TOO_FEW_VERTICES:${fig.figureId}`,
            }),
          );
        } else if (hasPolylineSelfIntersection(pts)) {
          findings.push(
            makeFinding(W, H, {
              ruleId: "LINE_SELF_INTERSECTION",
              severity: "warning",
              category: "geometry",
              title: "Self-Intersecting Polyline",
              message: `${nf.label} crosses itself.`,
              figureIds: [fig.figureId],
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: nf.outsideViewport,
              focusRect: nf.bbox,
              confidence: 0.95,
              suggestedFixes: [],
              fingerprint: `LINE_SELF_INTERSECTION:${fig.figureId}`,
            }),
          );
        }
      } else if (fig.geometryType === "graph") {
        const clsDef = classesById.get(String(fig.classId)) ?? classesByTitle.get(fig.classTitle);
        const tplNodes = clsDef?.geometryConfig?.nodes ?? {};
        const userNodes = fig.nodes ?? {};
        for (const nid of Object.keys(userNodes)) {
          if (Object.keys(tplNodes).length > 0 && !(nid in tplNodes)) {
            findings.push(
              makeFinding(W, H, {
                ruleId: "KP_UNKNOWN_TEMPLATE_NODE",
                severity: "blocker",
                category: "keypoints",
                title: "Unknown Skeleton Node ID",
                message: `${nf.label} contains unknown template node '${nid}'.`,
                figureIds: [fig.figureId],
                imageTagNames: [],
                missedObjectIds: [],
                outsideViewport: nf.outsideViewport,
                focusRect: nf.bbox,
                confidence: 1.0,
                suggestedFixes: [],
                fingerprint: `KP_UNKNOWN_TEMPLATE_NODE:${fig.figureId}:${nid}`,
              }),
            );
          }
        }
        // Bilateral L/R inversion check on limbs with eyes facing direction
        if (Object.keys(tplNodes).length >= 4) {
          const sem: Record<string, Point2D> = {};
          for (const [nid, nv] of Object.entries(userNodes)) {
            if (nv.disabled || !(nid in tplNodes)) continue;
            const parsed = parseBilateral(tplNodes[nid]!.label);
            if (parsed) sem[`${parsed.side}:${parsed.part}`] = nv.loc;
          }
          const lEye = sem["L:eye"];
          const rEye = sem["R:eye"];
          const lSh = sem["L:shoulder"];
          const rSh = sem["R:shoulder"];
          const torso = sem["L:hip"] && sem["R:hip"] && lSh && rSh
            ? Math.hypot(0.5 * (lSh[0] + rSh[0]) - 0.5 * (sem["L:hip"]![0] + sem["R:hip"]![0]), 0.5 * (lSh[1] + rSh[1]) - 0.5 * (sem["L:hip"]![1] + sem["R:hip"]![1]))
            : 100;
          const nose = userNodes["nose"]?.loc;
          const shSign = lSh && rSh ? Math.sign(lSh[0] - rSh[0]) : 0;
          const eyeSign = lEye && rEye ? Math.sign(lEye[0] - rEye[0]) : 0;
          const noseBehindHead = !nose || (lEye && rEye && nose[1] <= Math.min(lEye[1], rEye[1]));
          if (lSh && rSh && lEye && rEye && !noseBehindHead && shSign !== 0 && eyeSign !== 0 && shSign === eyeSign) {
            const lAnk = sem["L:ankle"];
            const rAnk = sem["R:ankle"];
            if (lAnk && rAnk && Math.abs(lAnk[0] - rAnk[0]) > 0.12 * Math.max(torso, 40) && Math.sign(lAnk[0] - rAnk[0]) !== shSign) {
              findings.push(
                makeFinding(W, H, {
                  ruleId: "KP_ANATOMICAL_LR_INVERSION",
                  severity: "warning",
                  category: "keypoints",
                  title: "Suspected Left/Right Limb Swap",
                  message: `${nf.label} ankles appear swapped relative to facing shoulders.`,
                  figureIds: [fig.figureId],
                  imageTagNames: [],
                  missedObjectIds: [],
                  outsideViewport: nf.outsideViewport,
                  focusRect: nf.bbox,
                  confidence: 0.78,
                  suggestedFixes: [],
                  fingerprint: `KP_ANATOMICAL_LR_INVERSION:${fig.figureId}:ankle`,
                }),
              );
            }
          }
        }
      }
    }

    // Duplicate detection across all 5 primitives
    for (let i = 0; i < normFigs.length; i += 1) {
      const a = normFigs[i]!;
      for (let j = i + 1; j < normFigs.length; j += 1) {
        const b = normFigs[j]!;
        if (
          a.fig.classTitle !== b.fig.classTitle ||
          a.fig.geometryType !== b.fig.geometryType
        ) {
          continue;
        }
        let isDup = false;
        if (a.fig.geometryType === "rectangle" || a.fig.geometryType === "polygon" || a.fig.geometryType === "bitmap") {
          const { iou } = bboxIouAndIos(a.bbox, b.bbox);
          if (iou >= 0.9) isDup = true;
        } else if (a.fig.geometryType === "polyline" && b.fig.geometryType === "polyline") {
          const pa = a.fig.points?.exterior ?? [];
          const pb = b.fig.points?.exterior ?? [];
          const la = polylineLength(pa);
          const lb = polylineLength(pb);
          if (Math.max(la, lb) > 0 && Math.min(la, lb) / Math.max(la, lb) >= 0.9) {
            const sa = samplePolyline(pa);
            const sb = samplePolyline(pb);
            const dab = sa.reduce((s, p) => s + distToPolyline(p, pb), 0) / Math.max(sa.length, 1);
            const dba = sb.reduce((s, p) => s + distToPolyline(p, pa), 0) / Math.max(sb.length, 1);
            if (0.5 * (dab + dba) <= 4.0) isDup = true;
          }
        } else if (a.fig.geometryType === "point") {
          const p0 = a.vertices[0];
          const p1 = b.vertices[0];
          if (p0 && p1 && Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) <= 6.0) isDup = true;
        } else if (a.fig.geometryType === "graph" && b.fig.geometryType === "graph") {
          const na = a.fig.nodes ?? {};
          const nb = b.fig.nodes ?? {};
          const keys = Object.keys(na).filter((k) => k in nb);
          if (keys.length >= 2) {
            const avg =
              keys.reduce(
                (s, k) =>
                  s + Math.hypot(na[k]!.loc[0] - nb[k]!.loc[0], na[k]!.loc[1] - nb[k]!.loc[1]),
                0,
              ) / keys.length;
            if (avg <= 6.0) isDup = true;
          }
        }
        if (isDup) {
          const ids = [a.fig.figureId, b.fig.figureId].sort();
          findings.push(
            makeFinding(W, H, {
              ruleId: "DUPLICATE_OBJECT",
              severity: "warning",
              category: "geometry",
              title: "Duplicate Overlapping Annotation",
              message: `${a.label} and ${b.label} nearly identically duplicate the same ${a.fig.classTitle}.`,
              figureIds: ids,
              imageTagNames: [],
              missedObjectIds: [],
              outsideViewport: a.outsideViewport && b.outsideViewport,
              focusRect: a.bbox,
              confidence: 0.96,
              suggestedFixes: [],
              fingerprint: `DUPLICATE_OBJECT:${ids[0]}:${ids[1]}`,
            }),
          );
        }
      }
    }
  }

  // Deduplicate & score deterministically
  const byFp = new Map<string, QCFinding>();
  for (const f of findings) {
    byFp.set(f.fingerprint, f);
  }
  const rank: Record<string, number> = { blocker: 0, warning: 1, info: 2 };
  const sorted = Array.from(byFp.values()).sort(
    (x, y) =>
      (rank[x.severity] ?? 9) - (rank[y.severity] ?? 9) ||
      x.ruleId.localeCompare(y.ruleId) ||
      x.fingerprint.localeCompare(y.fingerprint),
  );

  const summaryCounts: SummaryCounts = { blocker: 0, warning: 0, info: 0 };
  for (const f of sorted) {
    summaryCounts[f.severity] += 1;
  }
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100 -
          25 * summaryCounts.blocker -
          Math.min(45, 8 * summaryCounts.warning) -
          Math.min(10, 2 * summaryCounts.info),
      ),
    ),
  );
  const readiness: QCResponse["readiness"] =
    summaryCounts.blocker > 0
      ? "blocked"
      : summaryCounts.warning > 0
        ? "needs_review"
        : "ready";

  const elapsed = Math.round((performance.now() - t0) * 100) / 100;
  return {
    analysisId: `qc_offline_${Date.now().toString(36)}`,
    requestId: req.requestId,
    jobId: null,
    status: "completed",
    imageId: req.image.imageId,
    snapshotSeq: req.snapshotSeq,
    mode: "rules",
    profileId: profile.profileId,
    overallScore: score,
    readiness,
    summaryCounts,
    findings: sorted,
    missedObjects: [],
    timingMs: { rules: elapsed, vision: 0, total: elapsed },
    engineCapabilities: {
      device: "none",
      modelsUsed: [],
      degradedReason: "BACKEND_OFFLINE",
    },
    error: null,
  };
}
