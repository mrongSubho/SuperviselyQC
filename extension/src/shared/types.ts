export * from "@shared/types/qc-contract";

import type {
  AnnotationFigure,
  BoundingBoxTuple,
  DomFigureSummary,
  ImageContext,
  ProjectOntology,
  QCAnalyzeRequest,
  QCFinding,
  QCMode,
  QCResponse,
  QuickFixAction,
  RuleProfile,
  TagValue,
  UiStateSnapshot,
  ViewportMetadata,
} from "@shared/types/qc-contract";

export type SummaryCounts = QCResponse["summaryCounts"];
export type RuleProfileSummary = RuleProfile;

export type ConfirmGuardStrictness = "blockers_and_dirty_sync" | "blockers_only" | "off";
export type DrawerDockMode = "below_minimap" | "over_sidebar" | "floating";

export interface ExtensionSettings {
  backendUrl: string;
  bridgeToken: string;
  defaultMode: QCMode;
  selectedProfileId: string | "auto";
  autoRunOnImageSwitch: boolean;
  autoRunAfterSync: boolean;
  confirmGuardEnabled: boolean;
  confirmGuardStrictness: ConfirmGuardStrictness;
  overlayVisible: boolean;
  assistantClosed: boolean;
  drawerDockMode: DrawerDockMode;
  floatingDrawerPos: { x: number; y: number } | null;
  floatingTopbarPos: { x: number; y: number } | null;
  offlineFallbackEnabled: boolean;
  experimentalAutoDrawEnabled: boolean;
  customProfiles: RuleProfile[];
}

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  backendUrl: "http://127.0.0.1:8765",
  bridgeToken: "",
  defaultMode: "standard",
  selectedProfileId: "auto",
  autoRunOnImageSwitch: true,
  autoRunAfterSync: false,
  confirmGuardEnabled: true,
  confirmGuardStrictness: "blockers_and_dirty_sync",
  overlayVisible: true,
  assistantClosed: false,
  drawerDockMode: "below_minimap",
  floatingDrawerPos: null,
  floatingTopbarPos: null,
  offlineFallbackEnabled: true,
  experimentalAutoDrawEnabled: false,
  customProfiles: [],
};

export interface CanvasTransformMetadata {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  source: "konva_or_viewport" | "dom_rect_fallback";
}

export interface PageBridgeSnapshot {
  snapshotSeq: number;
  capturedAtMs: number;
  image: ImageContext | null;
  originalImageUrl: string | null;
  ontology: ProjectOntology | null;
  imageTags: TagValue[];
  figures: AnnotationFigure[];
  domFigureSummaries?: DomFigureSummary[];
  uiState: Partial<UiStateSnapshot>;
  canvasTransform?: CanvasTransformMetadata | null;
  rawStateSource: "store" | "intercepted" | "empty";
  partialGeometry: boolean;
}

export type PageToContentMessage =
  | {
      source: "SLY_QC_PAGE";
      type: "SLY_QC_BRIDGE_READY";
      nonce: string;
    }
  | {
      source: "SLY_QC_PAGE";
      type: "SLY_QC_SNAPSHOT";
      nonce: string;
      payload: PageBridgeSnapshot;
    };

export type ContentToPageMessage =
  | {
      source: "SLY_QC_CONTENT";
      type: "SLY_QC_HELLO";
      nonce: string;
    }
  | {
      source: "SLY_QC_CONTENT";
      type: "SLY_QC_HANDSHAKE_ACK";
      nonce: string;
    }
  | {
      source: "SLY_QC_CONTENT";
      type: "SLY_QC_REQUEST_SNAPSHOT";
      nonce: string;
    }
  | {
      source: "SLY_QC_CONTENT";
      type: "SLY_QC_SIMULATE_RECT_DRAW";
      nonce: string;
      clientRect: { x1: number; y1: number; x2: number; y2: number };
    };

export type SwRequestMessage =
  | { type: "QC_GET_HEALTH" }
  | {
      type: "QC_LIST_PROFILES";
      projectId?: string | number;
      datasetId?: string | number;
      jobTitle?: string;
    }
  | { type: "QC_UPSERT_PROFILE"; profile: RuleProfile }
  | { type: "QC_DELETE_PROFILE"; profileId: string }
  | {
      type: "QC_IMAGE_HEAD";
      imageId: string;
      imageHash: string;
      width?: number;
      height?: number;
    }
  | {
      type: "QC_FETCH_AND_CACHE_SAME_ORIGIN_IMAGE";
      imageId: string;
      imageHash: string;
      imageUrl: string;
      width: number;
      height: number;
    }
  | {
      type: "QC_ANALYZE";
      request: QCAnalyzeRequest;
    }
  | {
      type: "QC_POLL_JOB";
      jobId: string;
    }
  | { type: "QC_OPEN_OPTIONS_PAGE" }
  | {
      type: "QC_TAB_COMMAND";
      command: "QC_TRIGGER_RUN_FROM_ACTION" | "QC_TOGGLE_PANEL_FROM_ACTION";
    };

export type SwUploadPortMessage =
  | {
      type: "UPLOAD_INIT";
      imageId: string;
      imageHash: string;
      width: number;
      height: number;
      contentType: string;
      totalBytes: number;
    }
  | {
      type: "UPLOAD_CHUNK";
      chunkIndex: number;
      dataB64: string;
    }
  | {
      type: "UPLOAD_COMMIT";
    };

export interface SwJobPushMessage {
  type: "QC_JOB_EVENT";
  event: {
    eventType: "job_progress" | "job_completed" | "job_failed" | "ping";
    jobId?: string | null;
    stage?: string | null;
    progressPct?: number | null;
    result?: QCResponse | null;
    error?: string | null;
  };
}

export interface ExtractedDomState {
  synchronizeDirty: boolean;
  synchronizeButton: HTMLElement | null;
  confirmButtonEnabled: boolean;
  isConfirmed: boolean;
  confirmButton: HTMLElement | null;
  topBarAnchor: HTMLElement | null;
  viewport: ViewportMetadata;
  canvasElement: HTMLCanvasElement | null;
  canvasRect: DOMRect | null;
  minimapRect: DOMRect | null;
  domFigureSummaries: DomFigureSummary[];
  imageTagNamesDom: string[];
  activeTool: string | null;
  activeClassTitle: string | null;
}

export interface LocalQcRunContext {
  request: QCAnalyzeRequest;
  response: QCResponse;
  isOfflineResult: boolean;
  dismissedFingerprints: string[];
  focusedFindingId: string | null;
  highlightedRect: BoundingBoxTuple | null;
  highlightedFigureIds: string[];
}

export interface QuickFixExecutionResult {
  executed: boolean;
  feedback: string;
  focusRect?: BoundingBoxTuple | null;
  highlightFigureIds?: string[];
  action?: QuickFixAction;
  highlightedFinding?: QCFinding;
}
