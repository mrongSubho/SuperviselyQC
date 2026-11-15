import { createElement } from "react";
import type {
  AnnotationFigure,
  BoundingBoxTuple,
  CanvasTransformMetadata,
  DomFigureSummary,
  DrawerDockMode,
  ExtensionSettings,
  MissedObjectOverlay,
  QCAnalyzeRequest,
  QCFinding,
  QCMode,
  QCResponse,
  QuickFixAction,
  RuleProfileSummary,
  SceneSimulationPlan,
  ViewportMetadata,
} from "../shared/types";
import { computeEffectiveSummary } from "../shared/storage";
import { executeQuickFix } from "./domObserver";
import { AutoDrawConfirmModal } from "./ui/AutoDrawConfirmModal";
import { CanvasOverlay } from "./ui/CanvasOverlay";
import { ConfirmGuardModal, type ConfirmGuardDecision } from "./ui/ConfirmGuard";
import { QcDrawer } from "./ui/QcDrawer";
import type { ShadowMountHandle } from "./ui/shadowHost";
import { TopBarWidget } from "./ui/TopBarWidget";

export interface CoordinatorRenderInput {
  mounts: {
    topbarMount: ShadowMountHandle | null;
    overlayMount: ShadowMountHandle | null;
    drawerMount: ShadowMountHandle | null;
    modalMount: ShadowMountHandle | null;
  };
  state: {
    assistantClosed: boolean;
    drawerOpen: boolean;
    mode: QCMode;
    running: boolean;
    offline: boolean;
    device: "mps" | "cpu" | "none";
    staleSnapshot: boolean;
    settings: ExtensionSettings;
    response: QCResponse | null;
    liveSceneSimulation: SceneSimulationPlan | null;
    dismissedFingerprints: Set<string>;
    simulateAllActive: boolean;
    simulatedCandidateIds: Set<string>;
    locatedCandidateId: string | null;
    focusedFindingId: string | null;
    highlightedRect: BoundingBoxTuple | null;
    highlightedLabel: string | null;
    profiles: RuleProfileSummary[];
    guardOpen: boolean;
    guardDecision: ConfirmGuardDecision;
    pendingAutoDraw: {
      cand: { simIndex: number; confidence: number; bbox: BoundingBoxTuple };
      classTitle: string;
      resolve: (ok: boolean) => void;
    } | null;
    toastMessage: string | null;
  };
  dom: {
    imgW: number;
    imgH: number;
    canvasRect: DOMRect | null;
    minimapRect: DOMRect | null;
    viewport: ViewportMetadata;
    canvasTransform: CanvasTransformMetadata | null;
    activeClassTitle: string | null;
    domFigureSummaries: DomFigureSummary[];
    figures: AnnotationFigure[];
    lastRequestSnapshot: QCAnalyzeRequest | null;
  };
  handlers: {
    onChangeMode: (nextMode: QCMode) => void;
    onChangeFloatingTopbarPos: (pos: { x: number; y: number }) => void;
    onRunQc: () => void;
    onToggleOverlay: () => void;
    onToggleDrawer: () => void;
    onOpenOptions?: () => void;
    onCloseAssistant: () => void;
    onCloseDrawer: () => void;
    onChangeDockMode: (dock: DrawerDockMode) => void;
    onChangeFloatingDrawerPos: (pos: { x: number; y: number }) => void;
    onFloatDrawerAtPos: (pos: { x: number; y: number }) => void;
    onChangeProfile: (pid: string) => void;
    onSelectFinding: (f: QCFinding) => void;
    onStepFinding: (dir: -1 | 1) => void;
    onFocusMissedObject: (m: MissedObjectOverlay) => void;
    onFocusFindingOverlay: (f: QCFinding) => void;
    onLocateSimulatedCandidate: (cand: SceneSimulationPlan["candidates"][number]) => void;
    onToggleBlueprintGuides: () => void;
    onToggleSimCandidate: (cand: SceneSimulationPlan["candidates"][number]) => void;
    onLocateRect: (bbox: BoundingBoxTuple) => void;
    onAutoDrawCandidate?: (
      cand: SceneSimulationPlan["candidates"][number],
      overrideClassTitle: string | null,
    ) => void;
    onDismissFinding: (f: QCFinding) => void;
    onFocusQuickFixRect: (rect: BoundingBoxTuple, finding: QCFinding, fix: QuickFixAction) => void;
    onToast: (msg: string) => void;
    onClearPendingAutoDraw: (accepted: boolean) => void;
    onGuardCancel: () => void;
    onGuardFixFirst: () => void;
    onGuardReRunQc: () => void;
    onGuardConfirmAnyway: () => void;
    onRender: () => void;
  };
}

export function renderCoordinatorUi(input: CoordinatorRenderInput): void {
  const { mounts, state, dom, handlers } = input;
  const compact = typeof window !== "undefined" && window.innerWidth < 1200;
  const eff = state.response
    ? computeEffectiveSummary(state.response, state.dismissedFingerprints)
    : null;
  const activeSimulation =
    state.liveSceneSimulation ?? state.response?.sceneSimulation ?? null;

  // 1. TopBar Widget
  mounts.topbarMount?.reactRoot.render(
    createElement(TopBarWidget, {
      visible: !state.assistantClosed,
      mode: state.mode,
      running: state.running,
      offline: state.offline,
      device: state.device,
      overlayVisible: state.settings.overlayVisible,
      drawerOpen: state.drawerOpen,
      effectiveScore: eff ? eff.overallScore : null,
      effectiveReadiness: eff ? eff.readiness : null,
      compact,
      floatingPos: state.settings.floatingTopbarPos,
      response: state.response,
      onChangeMode: handlers.onChangeMode,
      onChangeFloatingPos: handlers.onChangeFloatingTopbarPos,
      onRunQc: handlers.onRunQc,
      onToggleOverlay: handlers.onToggleOverlay,
      onToggleDrawer: handlers.onToggleDrawer,
      onOpenOptions: handlers.onOpenOptions,
      onCloseAssistant: handlers.onCloseAssistant,
    }),
  );

  // 2. CanvasOverlay
  mounts.overlayMount?.reactRoot.render(
    createElement(CanvasOverlay, {
      visible: !state.assistantClosed && state.settings.overlayVisible,
      canvasRect: dom.canvasRect
        ? {
            left: dom.canvasRect.left,
            top: dom.canvasRect.top,
            width: dom.canvasRect.width,
            height: dom.canvasRect.height,
          }
        : null,
      minimapRect: dom.minimapRect
        ? {
            left: dom.minimapRect.left,
            top: dom.minimapRect.top,
            width: dom.minimapRect.width,
            height: dom.minimapRect.height,
          }
        : null,
      imageWidth: dom.imgW,
      imageHeight: dom.imgH,
      viewport: dom.viewport,
      canvasTransform: dom.canvasTransform,
      activeFindings: eff?.activeFindings ?? [],
      activeMissedObjects: eff?.activeMissedObjects ?? [],
      sceneSimulation: activeSimulation,
      showBlueprintGuides: state.simulateAllActive,
      simulatedCandidateIds: Array.from(state.simulatedCandidateIds),
      focusedFindingId: state.focusedFindingId,
      highlightedRect: state.highlightedRect,
      highlightedLabel: state.highlightedLabel,
      figures: dom.figures,
      onClickMissedOverlay: handlers.onFocusMissedObject,
      onClickFindingOverlay: handlers.onFocusFindingOverlay,
      onClickSimCandidate: handlers.onLocateSimulatedCandidate,
    }),
  );

  // 3. Dockable QC Drawer
  mounts.drawerMount?.reactRoot.render(
    createElement(QcDrawer, {
      open: !state.assistantClosed && state.drawerOpen,
      dockMode: state.settings.drawerDockMode,
      floatingPos: state.settings.floatingDrawerPos,
      mode: state.mode,
      running: state.running,
      offline: state.offline,
      staleSnapshot: state.staleSnapshot,
      response: state.response,
      sceneSimulation: activeSimulation,
      showBlueprintGuides: state.simulateAllActive,
      simulatedCandidateIds: Array.from(state.simulatedCandidateIds),
      locatedCandidateId: state.locatedCandidateId,
      experimentalAutoDrawEnabled: state.settings.experimentalAutoDrawEnabled,
      activeSidebarClass: dom.activeClassTitle,
      domFigureSummaries: dom.domFigureSummaries,
      profiles: state.profiles,
      selectedProfileId: state.settings.selectedProfileId,
      activeFindings: eff?.activeFindings ?? [],
      effectiveScore: eff ? eff.overallScore : null,
      effectiveReadiness: eff ? eff.readiness : null,
      blockerCount: eff?.summaryCounts.blocker ?? 0,
      warningCount: eff?.summaryCounts.warning ?? 0,
      infoCount: eff?.summaryCounts.info ?? 0,
      focusedFindingId: state.focusedFindingId,
      hasActiveHighlight: state.highlightedRect !== null,
      onClose: handlers.onCloseDrawer,
      onChangeDockMode: handlers.onChangeDockMode,
      onChangeFloatingPos: handlers.onChangeFloatingDrawerPos,
      onFloatAtPos: handlers.onFloatDrawerAtPos,
      onChangeMode: handlers.onChangeMode,
      onChangeProfile: handlers.onChangeProfile,
      onRunQc: handlers.onRunQc,
      onSelectFinding: handlers.onSelectFinding,
      onStepFinding: handlers.onStepFinding,
      onQuickFix: (fix: QuickFixAction, finding: QCFinding) => {
        executeQuickFix(fix, finding, {
          onFocusRect: (rect) => handlers.onFocusQuickFixRect(rect, finding, fix),
          onToast: handlers.onToast,
        });
      },
      onDismissFinding: handlers.onDismissFinding,
      onToggleBlueprintGuides: handlers.onToggleBlueprintGuides,
      onToggleSimCandidate: handlers.onToggleSimCandidate,
      onLocateRect: handlers.onLocateRect,
      onLocateCandidate: handlers.onLocateSimulatedCandidate,
      onAutoDrawCandidate: handlers.onAutoDrawCandidate,
      onSelectSidebarClass: (classTitle) => {
        executeQuickFix(
          {
            actionId: `bp_select_${classTitle}`,
            label: `Switch Sidebar to ${classTitle}`,
            actionType: "select_sidebar_class",
            classTitle,
          },
          undefined,
          {
            onFocusRect: () => {},
            onToast: handlers.onToast,
          },
        );
        handlers.onRender();
      },
    }),
  );

  // 4. Modals + Toast Notification
  mounts.modalMount?.reactRoot.render(
    createElement("div", null, [
      createElement(AutoDrawConfirmModal, {
        key: "auto-draw-confirm-modal",
        open: Boolean(state.pendingAutoDraw),
        simIndex: state.pendingAutoDraw?.cand.simIndex ?? 0,
        classTitle: state.pendingAutoDraw?.classTitle ?? "",
        confidence: state.pendingAutoDraw?.cand.confidence ?? 0,
        bbox: state.pendingAutoDraw?.cand.bbox ?? [0, 0, 0, 0],
        onConfirm: () => handlers.onClearPendingAutoDraw(true),
        onCancel: () => handlers.onClearPendingAutoDraw(false),
      }),
      createElement(ConfirmGuardModal, {
        key: "confirm-guard-modal",
        open: state.guardOpen,
        decision: state.guardDecision,
        onCancel: handlers.onGuardCancel,
        onFixFirst: handlers.onGuardFixFirst,
        onReRunQc: handlers.onGuardReRunQc,
        onConfirmAnyway: handlers.onGuardConfirmAnyway,
      }),
      state.toastMessage
        ? createElement(
            "div",
            { key: "toast", className: "qc-toast", "data-testid": "qc-toast" },
            state.toastMessage,
          )
        : null,
    ]),
  );
}
