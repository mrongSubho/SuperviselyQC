// ============================================================================
// Primitives & Supervisely Geometry Union (All 5 Annotation Primitives)
// ============================================================================

export type Point2D = [number, number]; // [x, y] in full-res image pixels
export type BoundingBoxTuple = [number, number, number, number]; // [xMin, yMin, xMax, yMax]
export type NormRectTuple = [number, number, number, number]; // [xMin, yMin, xMax, yMax] in 0..1

export interface RectangleGeometry {
  geometryType: "rectangle";
  /** Exactly 2 points: [[xMin, yMin], [xMax, yMax]] */
  points: {
    exterior: [Point2D, Point2D];
    interior: [];
  };
}

export interface PolygonGeometry {
  geometryType: "polygon";
  /** exterior: outer ring (>=3 points); interior: 0 or more hole rings */
  points: {
    exterior: Point2D[];
    interior: Point2D[][];
  };
}

export interface BitmapGeometry {
  geometryType: "bitmap";
  /** Supervisely native format: zlib-compressed base64 PNG mask + [x, y] top-left origin */
  bitmap: {
    data: string;
    origin: Point2D;
  };
}

export interface PolylineGeometry {
  geometryType: "polyline";
  /** Open path (>=2 ordered vertices) */
  points: {
    exterior: Point2D[];
    interior: [];
  };
}

export interface PointGeometry {
  geometryType: "point";
  points: {
    exterior: [Point2D];
    interior: [];
  };
}

export interface GraphNodeValue {
  loc: Point2D;
  disabled?: boolean;
}

export interface GraphGeometry {
  geometryType: "graph";
  /** Keyed by node template UUID from ClassDefinition.geometryConfig.nodes */
  nodes: Record<string, GraphNodeValue>;
}

export type FigureGeometry =
  | RectangleGeometry
  | PolygonGeometry
  | BitmapGeometry
  | PolylineGeometry
  | PointGeometry
  | GraphGeometry;

export type GeometryType = FigureGeometry["geometryType"];

// ============================================================================
// Tags, Ontology & Active Annotations
// ============================================================================

export interface TagValue {
  tagId: number | string;
  name: string;
  value: string | number | boolean | null;
}

export type AnnotationFigure = FigureGeometry & {
  figureId: string;
  classId: number | string;
  classTitle: string;
  tags: TagValue[];
  /** Optional UI ordering / label index shown in Objects By Classes (e.g. #1..#6) */
  labelIndex?: number;
  visible?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export interface GraphNodeTemplate {
  label: string;
  loc?: Point2D;
  color?: string;
  disabled?: boolean;
}

export interface GraphEdgeTemplate {
  src: string;
  dst: string;
  color?: string;
}

export interface ClassDefinition {
  classId: number | string;
  title: string;
  shape: GeometryType;
  color: string;
  geometryConfig?: {
    nodes?: Record<string, GraphNodeTemplate>;
    edges?: GraphEdgeTemplate[];
  };
}

export interface TagDefinition {
  tagId: number | string;
  name: string;
  valueType: "none" | "any_number" | "any_string" | "oneof_string";
  applicableType: "imagesOnly" | "objectsOnly" | "all";
  classes: string[]; // empty = all classes
  values: string[];
}

export interface ProjectOntology {
  projectId: number | string;
  projectName?: string;
  classes: ClassDefinition[];
  tags: TagDefinition[];
  /** Subset of classes/tags explicitly assigned in this labeling job, if restricted */
  jobClassesToLabel?: string[];
  jobTagsToLabel?: string[];
}

// ============================================================================
// Viewport, UI State & Request Envelope
// ============================================================================

export interface ImageContext {
  imageId: string;
  entityId?: string;
  datasetId: string;
  jobId?: string;
  jobTitle?: string;
  fileName: string;
  width: number;
  height: number;
  /** Stable content hash or URL-derived fingerprint for cache lookup */
  imageHash: string;
  imageUrl?: string;
}

export interface ViewportMetadata {
  zoomPercent: number;
  visibleNormRect: NormRectTuple;
  visiblePixelRect: BoundingBoxTuple;
  canvasSize: { width: number; height: number };
  source: "minimap" | "transform" | "fallback_full";
}

export interface UiStateSnapshot {
  synchronizeDirty: boolean;
  confirmButtonEnabled: boolean;
  isConfirmed: boolean;
  activeTool: string | null;
  activeClassTitle: string | null;
  stateSource: "store" | "network_interceptor" | "dom_fallback";
  partialGeometry: boolean;
}

export interface DomFigureSummary {
  classTitle: string;
  figureCount: number;
  taggedCount: number;
  visible: boolean;
}

export type QCMode = "rules" | "standard" | "deep";

export interface QCAnalyzeRequest {
  requestId: string;
  snapshotSeq: number;
  mode: QCMode;
  profileId?: string;
  asyncIfHeavy?: boolean;
  image: ImageContext;
  ontology: ProjectOntology;
  imageTags: TagValue[];
  /** Must be [] when uiState.stateSource === "dom_fallback" (never coordinate-less stubs) */
  figures: AnnotationFigure[];
  /** Optional Objects-By-Classes summary populated under dom_fallback */
  domFigureSummaries?: DomFigureSummary[];
  viewport: ViewportMetadata;
  uiState: UiStateSnapshot;
}

// ============================================================================
// QC Response, Findings, Ghost Overlays & Quick Fixes
// ============================================================================

export type QCSeverity = "blocker" | "warning" | "info";
export type QCCategory =
  | "workflow"
  | "tags"
  | "geometry"
  | "missed_objects"
  | "classification"
  | "keypoints";

export type QuickFixActionType =
  | "highlight_synchronize"
  | "move_tag_image_to_object"
  | "add_object_tag"
  | "remove_object_tag"
  | "remove_image_tag"
  | "focus_viewport"
  | "inspect_figure"
  | "confirm_delete_figure"
  | "toggle_class_visibility"
  | "select_sidebar_class";

export interface QuickFixAction {
  actionId: string;
  label: string;
  actionType: QuickFixActionType;
  /** Non-destructive UI guidance vs explicit annotator action prompt */
  targetFigureIds?: string[];
  classTitle?: string;
  tagName?: string;
  tagValue?: string | number | boolean | null;
  focusRect?: BoundingBoxTuple;
}

export interface QCFinding {
  findingId: string;
  ruleId: string;
  severity: QCSeverity;
  category: QCCategory;
  title: string;
  message: string;
  figureIds: string[];
  imageTagNames: string[];
  missedObjectIds: string[];
  outsideViewport: boolean;
  focusRect: BoundingBoxTuple | null;
  confidence: number; // 0.0 .. 1.0 (1.0 for deterministic rules)
  suggestedFixes: QuickFixAction[];
  /** Stable deterministic fingerprint so dismissed findings survive unrelated edits */
  fingerprint: string;
}

export type ViewportEdgeDirection =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface MissedObjectOverlay {
  missedId: string;
  classTitle: string;
  geometryType: "rectangle" | "polygon" | "bitmap";
  bbox: BoundingBoxTuple; // [xMin, yMin, xMax, yMax] full-res pixels
  /** Optional simplified contour polygons for Standard/Deep mask hints */
  polygonPoints?: Point2D[][];
  confidence: number;
  sharpnessScore: number; // Laplacian variance score proving non-bokeh foreground
  outsideViewport: boolean;
  viewportEdgeDirection?: ViewportEdgeDirection;
  detectorModel: string;
}

export interface SimulatedTagRecommendation {
  tagName: string;
  value?: string | number | boolean | null;
  reason: string;
  confidence: number;
}

export interface SimulatedObjectCandidate {
  simId: string;
  simIndex: number;
  classTitle: string;
  recommendedShape: GeometryType;
  bbox: BoundingBoxTuple;
  polygonPoints?: Point2D[][];
  confidence: number;
  sharpnessScore: number;
  visibilityStatus: "foreground_clear" | "occluded" | "border_truncated";
  occludedBySimIndices: number[];
  overlapIouMax: number;
  overlapCoverRatio: number;
  recommendedObjectTags: SimulatedTagRecommendation[];
  outsideViewport: boolean;
  viewportEdgeDirection?: ViewportEdgeDirection;
  matchedFigureId?: string | null;
}

export interface SimulatedClassSummary {
  classTitle: string;
  recommendedShape: GeometryType;
  totalCount: number;
  completedCount: number;
  remainingCount: number;
  foregroundClearCount: number;
  occludedCount: number;
  borderTruncatedCount: number;
  tagCounts: Record<string, number>;
}

export interface SceneSimulationPlan {
  totalTargetObjects: number;
  completedTargetObjects: number;
  primaryTargetClasses: string[];
  classSummaries: SimulatedClassSummary[];
  candidates: SimulatedObjectCandidate[];
  recommendedImageTags: SimulatedTagRecommendation[];
  misplacedImageTags: string[];
  ignoredOntologyClasses: string[];
  disambiguationNotes: string[];
  activeSidebarClassWarning?: string | null;
}

export interface QCResponse {
  analysisId: string;
  requestId: string;
  jobId: string | null;
  status: "completed" | "queued" | "running" | "failed";
  imageId: string;
  snapshotSeq: number;
  mode: QCMode;
  profileId: string;
  overallScore: number; // 0 .. 100
  readiness: "ready" | "needs_review" | "blocked";
  summaryCounts: {
    blocker: number;
    warning: number;
    info: number;
  };
  findings: QCFinding[];
  missedObjects: MissedObjectOverlay[];
  sceneSimulation?: SceneSimulationPlan | null;
  timingMs: Record<string, number>;
  engineCapabilities: {
    device: "mps" | "cpu" | "none";
    modelsUsed: string[];
    degradedReason?: string | null;
  };
  error?: {
    code: string;
    message: string;
  } | null;
}

// ============================================================================
// Health, Image Cache, WS & Rule Profiles
// ============================================================================

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  device: "mps" | "cpu";
  loadedModels: string[];
  cacheStats: {
    imageCount: number;
    diskBytes: number;
    maxDiskBytes: number;
  };
  uptimeSeconds: number;
}

export interface ImageCacheAck {
  imageId: string;
  imageHash: string;
  width: number;
  height: number;
  bytesStored: number;
  cached: true;
}

export interface WsEvent {
  eventType: "job_progress" | "job_completed" | "job_failed" | "ping";
  jobId?: string;
  stage?: string;
  progressPct?: number;
  result?: QCResponse;
  error?: string;
}

export interface ClassRuleOverride {
  enabled: boolean;
  minAreaPx?: number;
  minSharpness?: number;
  detectorConfidence?: number;
  requiredTags?: string[];
  forbiddenTags?: string[];
  suppressMissedObjectPrompts?: boolean;
}

export interface RuleProfile {
  profileId: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  matchers: {
    jobTitleRegex?: string | null;
    projectIds: Array<number | string>;
    datasetIds: Array<number | string>;
  };
  workflowRules: {
    blockOnUnsavedSync: boolean;
    warnOnEmptyImageWithoutConfirm: boolean;
  };
  tagRules: {
    imageOnlyTags: string[];
    objectOnlyTags: string[]; // e.g. ["Occlusion"]
    occlusionOverlapIouThreshold: number; // e.g. 0.10
    occlusionCoverRatioThreshold: number; // e.g. 0.15
    flagForegroundOcclusionFalsePositive: boolean;
  };
  geometryRules: {
    minBoxAreaPx: number;
    minPolygonVertices: number;
    minPolylineVertices: number;
    minMaskAreaPx: number;
    maxDisconnectedMaskComponents: number;
    edgeSnapMarginPx: number;
    minBoxIouTightness: number;
    requireRequiredGraphNodes: boolean;
  };
  visionRules: {
    missedObjectMinConfidence: number;
    minLaplacianSharpness: number; // rejects out-of-focus bokeh background Buildings
    ignoreBackgroundBokeh: boolean;
    enableDepthOcclusionOrdering: boolean;
  };
  classOverrides: Record<string, ClassRuleOverride>;
  detectorAliases?: Record<string, string[]>;
}

export interface ProfileListResponse {
  profiles: RuleProfile[];
  matchedProfileId?: string | null;
}

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "IMAGE_CACHE_MISS"
  | "INVALID_PAYLOAD"
  | "PROFILE_NOT_FOUND"
  | "JOB_NOT_FOUND"
  | "MODEL_EXECUTION_ERROR";

export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}
