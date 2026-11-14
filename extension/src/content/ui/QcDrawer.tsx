import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type {
  BoundingBoxTuple,
  DomFigureSummary,
  DrawerDockMode,
  QCFinding,
  QCMode,
  QCResponse,
  QCSeverity,
  QuickFixAction,
  RuleProfileSummary,
  SceneSimulationPlan,
  SimulatedObjectCandidate,
} from "../../shared/types";

export interface QcDrawerProps {
  open: boolean;
  dockMode: DrawerDockMode;
  floatingPos: { x: number; y: number } | null;
  mode: QCMode;
  running: boolean;
  offline: boolean;
  staleSnapshot: boolean;
  response: QCResponse | null;
  sceneSimulation?: SceneSimulationPlan | null;
  showBlueprintGuides?: boolean;
  simulatedCandidateIds?: string[];
  locatedCandidateId?: string | null;
  experimentalAutoDrawEnabled?: boolean;
  activeSidebarClass?: string | null;
  domFigureSummaries?: DomFigureSummary[];
  profiles: RuleProfileSummary[];
  selectedProfileId: string;
  activeFindings: QCFinding[];
  effectiveScore: number | null;
  effectiveReadiness: "ready" | "needs_review" | "blocked" | null;
  blockerCount: number;
  warningCount: number;
  infoCount: number;
  focusedFindingId: string | null;
  onClose: () => void;
  onChangeDockMode: (dock: DrawerDockMode) => void;
  onChangeFloatingPos: (pos: { x: number; y: number }) => void;
  onFloatAtPos?: (pos: { x: number; y: number }) => void;
  onChangeMode: (mode: QCMode) => void;
  onChangeProfile: (profileId: string) => void;
  onRunQc: () => void;
  onSelectFinding: (finding: QCFinding) => void;
  onStepFinding: (dir: -1 | 1) => void;
  onQuickFix: (fix: QuickFixAction, finding: QCFinding) => void;
  onDismissFinding: (finding: QCFinding) => void;
  onToggleBlueprintGuides?: () => void;
  onToggleSimCandidate?: (candidate: SimulatedObjectCandidate) => void;
  onLocateRect?: (bbox: BoundingBoxTuple) => void;
  onLocateCandidate?: (candidate: SimulatedObjectCandidate) => void;
  onAutoDrawCandidate?: (
    candidate: SimulatedObjectCandidate,
    overrideClassTitle: string | null,
  ) => void;
  onSelectSidebarClass?: (classTitle: string) => void;
}

type FilterTab = "all" | "blueprint" | QCSeverity | "missed";

export function QcDrawer({
  open,
  dockMode,
  floatingPos,
  mode,
  running,
  offline,
  staleSnapshot,
  response,
  sceneSimulation,
  showBlueprintGuides = false,
  simulatedCandidateIds = [],
  locatedCandidateId = null,
  experimentalAutoDrawEnabled = false,
  activeSidebarClass = null,
  domFigureSummaries = [],
  profiles,
  selectedProfileId,
  activeFindings,
  effectiveScore,
  effectiveReadiness,
  blockerCount,
  warningCount,
  infoCount,
  focusedFindingId,
  onClose,
  onChangeDockMode,
  onChangeFloatingPos,
  onFloatAtPos,
  onChangeMode,
  onChangeProfile,
  onRunQc,
  onSelectFinding,
  onStepFinding,
  onQuickFix,
  onDismissFinding,
  onToggleBlueprintGuides,
  onToggleSimCandidate,
  onLocateRect,
  onLocateCandidate,
  onAutoDrawCandidate,
  onSelectSidebarClass,
}: QcDrawerProps) {
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [searchText, setSearchText] = useState("");
  const [simulateUseActive, setSimulateUseActive] = useState(false);
  const lastAutoSwitchedAnalysisRef = useRef<string | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const sim = sceneSimulation ?? response?.sceneSimulation ?? null;
  const simulatedCandidateSet = useMemo(
    () => new Set(simulatedCandidateIds),
    [simulatedCandidateIds],
  );

  useEffect(() => {
    if (!response) {
      lastAutoSwitchedAnalysisRef.current = null;
      return;
    }
    if (
      sim &&
      sim.totalTargetObjects > 0 &&
      sim.completedTargetObjects === 0 &&
      lastAutoSwitchedAnalysisRef.current !== response.analysisId
    ) {
      lastAutoSwitchedAnalysisRef.current = response.analysisId;
      setFilterTab("blueprint");
    }
  }, [response, sim]);
  const [dragState, setDragState] = useState<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const visibleFindings = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return activeFindings.filter((f) => {
      if (filterTab === "missed") {
        if (f.category !== "missed_objects" && f.missedObjectIds.length === 0) return false;
      } else if (filterTab !== "all" && f.severity !== filterTab) {
        return false;
      }
      if (!q) return true;
      return (
        f.title.toLowerCase().includes(q) ||
        f.message.toLowerCase().includes(q) ||
        f.ruleId.toLowerCase().includes(q)
      );
    });
  }, [activeFindings, filterTab, searchText]);

  if (!open) return null;

  const floatingStyle =
    dockMode === "floating"
      ? {
          left: `${floatingPos?.x ?? 24}px`,
          top: `${floatingPos?.y ?? 72}px`,
        }
      : undefined;

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, select, input")) return;
    const rect = drawerRef.current?.getBoundingClientRect();
    const fallbackLeft =
      typeof window !== "undefined" ? Math.max(24, window.innerWidth - 368) : 24;
    const origX = dockMode === "floating" ? (floatingPos?.x ?? rect?.left ?? 24) : (rect?.left ?? fallbackLeft);
    const origY = dockMode === "floating" ? (floatingPos?.y ?? rect?.top ?? 72) : (rect?.top ?? 72);
    const snapped = {
      x: Math.max(8, Math.round(origX)),
      y: Math.max(8, Math.round(origY)),
    };
    if (dockMode !== "floating") {
      if (onFloatAtPos) {
        onFloatAtPos(snapped);
      } else {
        onChangeDockMode("floating");
        onChangeFloatingPos(snapped);
      }
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragState({
      startX: e.clientX,
      startY: e.clientY,
      origX: snapped.x,
      origY: snapped.y,
    });
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const maxW = typeof window !== "undefined" ? Math.max(120, window.innerWidth - 120) : 2000;
    const maxH = typeof window !== "undefined" ? Math.max(80, window.innerHeight - 60) : 2000;
    const nextPos = {
      x: Math.min(maxW, Math.max(8, Math.round(dragState.origX + dx))),
      y: Math.min(maxH, Math.max(8, Math.round(dragState.origY + dy))),
    };
    if (onFloatAtPos) {
      onFloatAtPos(nextPos);
    } else {
      onChangeFloatingPos(nextPos);
    }
  };

  const handlePointerUp = () => {
    setDragState(null);
  };

  const readinessText =
    effectiveReadiness === "blocked"
      ? "Blocked"
      : effectiveReadiness === "needs_review"
        ? "Needs Review"
        : "Ready";

  return (
    <aside
      ref={drawerRef}
      className={`qc-drawer ${dockMode}`}
      style={floatingStyle}
      data-testid="qc-drawer"
      aria-label="QC Inspection Drawer"
    >
      <div
        className="qc-drawer-header draggable"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="qc-drawer-title">
          <span
            className="qc-drag-grip"
            data-testid="qc-drawer-drag-handle"
            title="Drag to move drawer"
            aria-hidden="true"
          >
            ⋮⋮
          </span>
          <span>QC Report</span>
          <span className={`qc-score-pill ${effectiveReadiness ?? "ready"}`}>
            {effectiveScore !== null ? `${effectiveScore} · ${readinessText}` : "Not Run"}
          </span>
        </div>
        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
          <button
            type="button"
            className="qc-btn"
            data-testid="qc-prev-finding"
            onClick={() => onStepFinding(-1)}
            title="Previous Finding (Option + [)"
          >
            ◀
          </button>
          <button
            type="button"
            className="qc-btn"
            data-testid="qc-next-finding"
            onClick={() => onStepFinding(1)}
            title="Next Finding (Option + ])"
          >
            ▶
          </button>
          <button
            type="button"
            className="qc-btn"
            data-testid="qc-drawer-close"
            onClick={onClose}
            title="Close Drawer (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="qc-drawer-controls">
        <select
          className="qc-select"
          data-testid="qc-drawer-mode-select"
          aria-label="QC Mode"
          value={mode}
          onChange={(e) => onChangeMode(e.target.value as QCMode)}
        >
          <option value="standard">Standard (YOLO + Bokeh + Depth)</option>
          <option value="deep">Deep (+ SAM + YOLO-World)</option>
          <option value="rules">Rules Only (Fast)</option>
        </select>

        <select
          className="qc-select"
          data-testid="qc-drawer-profile-select"
          aria-label="Rule Profile"
          value={selectedProfileId}
          onChange={(e) => onChangeProfile(e.target.value)}
        >
          <option value="auto">Auto Profile</option>
          {profiles.map((p) => (
            <option key={p.profileId} value={p.profileId}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          className="qc-select"
          data-testid="qc-drawer-dock-select"
          aria-label="Dock Mode"
          value={dockMode}
          onChange={(e) => onChangeDockMode(e.target.value as DrawerDockMode)}
        >
          <option value="below_minimap">Dock: Minimap</option>
          <option value="over_sidebar">Dock: Sidebar</option>
          <option value="floating">Dock: Floating</option>
        </select>

        <button
          type="button"
          className="qc-btn qc-btn-primary"
          disabled={running}
          onClick={onRunQc}
        >
          {running ? "Running…" : "Re-Run"}
        </button>
      </div>

      {offline && (
        <div className="qc-banner" data-testid="qc-offline-banner">
          <span>Local CV offline — showing deterministic rules audit.</span>
        </div>
      )}

      {staleSnapshot && !offline && (
        <div className="qc-banner" data-testid="qc-stale-banner">
          <span>Annotations edited since last QC run.</span>
          <button type="button" className="qc-btn qc-btn-primary" onClick={onRunQc}>
            Re-Run QC
          </button>
        </div>
      )}

      {response?.engineCapabilities.degradedReason &&
        response.engineCapabilities.degradedReason !== "BACKEND_OFFLINE" && (
          <div className="qc-banner">
            <span>Degraded: {response.engineCapabilities.degradedReason}</span>
          </div>
        )}

      <div className="qc-filter-row">
        <button
          type="button"
          data-testid="qc-tab-blueprint"
          className={`qc-chip ${filterTab === "blueprint" ? "active" : ""}`}
          onClick={() => setFilterTab("blueprint")}
        >
          {sim ? `Blueprint (${sim.completedTargetObjects}/${sim.totalTargetObjects})` : "Blueprint"}
        </button>
        <button
          type="button"
          className={`qc-chip ${filterTab === "all" ? "active" : ""}`}
          onClick={() => setFilterTab("all")}
        >
          All ({activeFindings.length})
        </button>
        <button
          type="button"
          className={`qc-chip ${filterTab === "blocker" ? "active" : ""}`}
          onClick={() => setFilterTab("blocker")}
        >
          Blockers ({blockerCount})
        </button>
        <button
          type="button"
          className={`qc-chip ${filterTab === "warning" ? "active" : ""}`}
          onClick={() => setFilterTab("warning")}
        >
          Warnings ({warningCount})
        </button>
        <button
          type="button"
          className={`qc-chip ${filterTab === "missed" ? "active" : ""}`}
          onClick={() => setFilterTab("missed")}
        >
          Missed ({activeFindings.filter((f) => f.category === "missed_objects").length})
        </button>
        <button
          type="button"
          className={`qc-chip ${filterTab === "info" ? "active" : ""}`}
          onClick={() => setFilterTab("info")}
        >
          Info ({infoCount})
        </button>
      </div>

      <div style={{ padding: "6px 10px 0" }}>
        <input
          type="text"
          className="qc-input"
          data-testid="qc-drawer-search"
          style={{ width: "100%" }}
          placeholder="Filter by rule, label, message..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
      </div>

      <div className="qc-findings-list" data-testid="qc-findings-list">
        {filterTab === "blueprint" && !sim ? (
          <div data-testid="qc-blueprint-panel">
            <div className="qc-bp-summary">
              <div className="qc-bp-summary-top">
                <span className="qc-bp-prescription">Pre-Annotation Scene Simulation</span>
              </div>
              <div className="qc-bp-progress">
                Run Standard or Deep QC to detect target objects, depth-ordered occlusion/border tags, and guided canvas overlays before drawing.
              </div>
              <div style={{ marginTop: "8px" }}>
                <button
                  type="button"
                  className="qc-btn qc-btn-primary"
                  data-testid="qc-bp-run-btn"
                  disabled={running}
                  onClick={onRunQc}
                >
                  {running ? "Running…" : "Simulate & Guide"}
                </button>
              </div>
            </div>
          </div>
        ) : filterTab === "blueprint" && sim ? (
          <div data-testid="qc-blueprint-panel">
            <div className="qc-bp-summary">
              <div className="qc-bp-header-row">
                <div className="qc-bp-header-left">
                  <span className="qc-bp-header-title">Scene Blueprint</span>
                  <span className="qc-bp-progress-pill" data-testid="qc-bp-progress">
                    {`Completed ${sim.completedTargetObjects} / ${sim.totalTargetObjects}`}
                  </span>
                </div>
                <button
                  type="button"
                  aria-pressed={showBlueprintGuides}
                  className={`qc-btn qc-bp-simall-btn ${showBlueprintGuides ? "active" : ""}`}
                  data-testid="qc-bp-simulate-all"
                  title="Toggle whole-image Visual Target Marks on Canvas (⌥B)"
                  onClick={() => onToggleBlueprintGuides?.()}
                >
                  {showBlueprintGuides ? "Hide All Sim" : "Simulate All"}
                </button>
              </div>
              <div className="qc-bp-prescription-list">
                {sim.classSummaries.length > 0 ? (
                  sim.classSummaries.map((cs) => {
                    const occTxt =
                      cs.occludedCount > 0 ? ` · ${cs.occludedCount} 🏷 Occlusion` : "";
                    const truncTxt =
                      cs.borderTruncatedCount > 0
                        ? ` · ${cs.borderTruncatedCount} Border`
                        : "";
                    return (
                      <div key={cs.classTitle} className="qc-bp-prescription">
                        {`${cs.totalCount} × ${cs.classTitle} (${cs.recommendedShape}) · ${cs.foregroundClearCount} Clear${occTxt}${truncTxt}`}
                      </div>
                    );
                  })
                ) : (
                  <div className="qc-bp-prescription">No target objects detected</div>
                )}
              </div>
              {sim.completedTargetObjects === 0 && domFigureSummaries.length > 0 && (
                <div className="qc-bp-progress" style={{ marginTop: "4px", color: "#fbbf24" }}>
                  {`Objects panel reports ${domFigureSummaries.reduce((a, b) => a + b.figureCount, 0)} annotation(s) — click Re-Run if newly drawn.`}
                </div>
              )}
              {experimentalAutoDrawEnabled && onAutoDrawCandidate && (
                <div className="qc-bp-meta-row">
                  <span className="qc-bp-progress">
                    {activeSidebarClass ? `Sidebar: ${activeSidebarClass}` : "Auto-Draw Class"}
                  </span>
                  <button
                    type="button"
                    className="qc-mini-pill"
                    data-testid="qc-bp-sim-class-mode"
                    title="Choose whether Auto-Draw draws the candidate's detected class or your currently selected sidebar class"
                    onClick={() => setSimulateUseActive((prev) => !prev)}
                  >
                    {simulateUseActive && activeSidebarClass
                      ? `Class: ${activeSidebarClass}`
                      : "Class: Auto (Detected)"}
                  </button>
                </div>
              )}
            </div>

            {sim.activeSidebarClassWarning && (
              <div className="qc-bp-warning" data-testid="qc-bp-sidebar-warning">
                <span>{sim.activeSidebarClassWarning}</span>
                {sim.primaryTargetClasses[0] && onSelectSidebarClass && (
                  <button
                    type="button"
                    className="qc-btn qc-btn-primary"
                    data-testid="qc-bp-switch-class-btn"
                    onClick={() => onSelectSidebarClass(sim.primaryTargetClasses[0]!)}
                  >
                    {`Switch Sidebar to ${sim.primaryTargetClasses[0]}`}
                  </button>
                )}
              </div>
            )}

            {sim.misplacedImageTags.length > 0 && (
              <div className="qc-bp-note" data-testid="qc-bp-misplaced-tags">
                {`Misplaced in CURRENT IMAGE TAGS: ${sim.misplacedImageTags.join(", ")} — apply to occluded objects instead.`}
              </div>
            )}

            {(sim.disambiguationNotes.length > 0 || sim.ignoredOntologyClasses.length > 0) && (
              <div className="qc-bp-note" data-testid="qc-bp-disambiguation">
                {sim.disambiguationNotes.map((note, idx) => (
                  <div key={idx}>{note}</div>
                ))}
                {sim.ignoredOntologyClasses.length > 0 && (
                  <div>{`Ignored classes: ${sim.ignoredOntologyClasses.join(", ")}`}</div>
                )}
              </div>
            )}

            <div className="qc-bp-list">
              {sim.candidates
                .filter((cand) => {
                  const q = searchText.trim().toLowerCase();
                  if (!q) return true;
                  return (
                    cand.classTitle.toLowerCase().includes(q) ||
                    `#${cand.simIndex}`.includes(q) ||
                    cand.visibilityStatus.toLowerCase().includes(q)
                  );
                })
                .map((cand) => {
                  const done = Boolean(cand.matchedFigureId);
                  const occluded = cand.visibilityStatus === "occluded";
                  const coverPct = Math.round(cand.overlapCoverRatio * 100);
                  const rowCls = done ? "completed" : occluded ? "occluded" : "";
                  const isLocated = locatedCandidateId === cand.simId;
                  const isSimActive =
                    showBlueprintGuides || simulatedCandidateSet.has(cand.simId);
                  return (
                    <div
                      key={cand.simId}
                      className={`qc-bp-item ${rowCls}`}
                      data-testid={`qc-bp-item-${cand.simIndex}`}
                    >
                      <div className="qc-bp-item-main">
                        <span className="qc-bp-item-title">
                          {`${done ? "[✓]" : "[ ]"} #${cand.simIndex} ${cand.classTitle}`}
                        </span>
                        {done ? (
                          <span className="qc-bp-badge completed">{`Done (${cand.matchedFigureId})`}</span>
                        ) : occluded ? (
                          <span className="qc-bp-badge occluded">
                            {`🏷 Occlusion (${
                              cand.occludedBySimIndices.length > 0
                                ? `behind ${cand.occludedBySimIndices.map((i) => `#${i}`).join(", ")}`
                                : "occluded"
                            }${coverPct > 0 ? ` · ${coverPct}%` : ""})`}
                          </span>
                        ) : cand.visibilityStatus === "border_truncated" ? (
                          <span className="qc-bp-badge clear">
                            {cand.recommendedObjectTags.length > 0
                              ? `Border · 🏷 ${cand.recommendedObjectTags.map((t) => t.tagName).join(", ")}`
                              : "Border Truncated"}
                          </span>
                        ) : (
                          <span className="qc-bp-badge clear">Clear — No Tag</span>
                        )}
                      </div>
                      <div className="qc-bp-item-actions">
                        {(onLocateCandidate || onLocateRect) && (
                          <button
                            type="button"
                            aria-pressed={isLocated}
                            className={`qc-btn ${isLocated ? "qc-btn-locate-active" : ""}`}
                            data-testid={`qc-bp-locate-${cand.simIndex}`}
                            title={
                              isLocated
                                ? "Click to hide Visual Target Mark"
                                : "Show Visual Target Mark on canvas"
                            }
                            onClick={() =>
                              onLocateCandidate ? onLocateCandidate(cand) : onLocateRect?.(cand.bbox)
                            }
                          >
                            Locate
                          </button>
                        )}
                        {onToggleSimCandidate && (
                          <button
                            type="button"
                            aria-pressed={isSimActive}
                            className={`qc-btn ${isSimActive ? "qc-btn-sim-active" : ""}`}
                            data-testid={`qc-bp-sim-${cand.simIndex}`}
                            title={
                              isSimActive
                                ? "Click to hide individual canvas simulation"
                                : "Preview visual box and recommended tags on canvas"
                            }
                            onClick={() => onToggleSimCandidate(cand)}
                          >
                            Sim
                          </button>
                        )}
                        {experimentalAutoDrawEnabled &&
                          !done &&
                          cand.recommendedShape === "rectangle" &&
                          onAutoDrawCandidate && (
                            <button
                              type="button"
                              className="qc-btn qc-btn-primary"
                              data-testid={`qc-bp-autodraw-${cand.simIndex}`}
                              title={`Attempt canvas auto-draw (${simulateUseActive && activeSidebarClass ? activeSidebarClass : cand.classTitle})`}
                              onClick={() =>
                                onAutoDrawCandidate(
                                  cand,
                                  simulateUseActive && activeSidebarClass ? activeSidebarClass : null,
                                )
                              }
                            >
                              Auto-Draw
                            </button>
                          )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        ) : !response ? (
          <div style={{ color: "#8c90a8", padding: "16px 6px", textAlign: "center" }}>
            Click <strong>Run QC</strong> (<code>Option + Q</code>) to inspect this image.
          </div>
        ) : visibleFindings.length === 0 ? (
          <div style={{ color: "#2ce1b4", padding: "16px 6px", textAlign: "center" }}>
            No active findings matching filter.
          </div>
        ) : (
          visibleFindings.map((finding) => {
            const focused = finding.findingId === focusedFindingId;
            return (
              <div
                key={finding.findingId}
                className={`qc-card sev-${finding.severity} ${focused ? "focused" : ""}`}
                data-testid={`qc-finding-card-${finding.ruleId}`}
                onClick={() => onSelectFinding(finding)}
              >
                <div className="qc-card-top">
                  <span className="qc-card-title">{finding.title}</span>
                  <span className="qc-rule-id">{finding.ruleId}</span>
                </div>
                <div className="qc-card-msg">{finding.message}</div>
                <div className="qc-card-actions">
                  {finding.suggestedFixes.map((fix) => (
                    <button
                      key={fix.actionId}
                      type="button"
                      className="qc-btn qc-btn-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        onQuickFix(fix, finding);
                      }}
                    >
                      {fix.label}
                    </button>
                  ))}
                  {finding.focusRect && finding.suggestedFixes.length === 0 && (
                    <button
                      type="button"
                      className="qc-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectFinding(finding);
                      }}
                    >
                      Locate
                    </button>
                  )}
                  <button
                    type="button"
                    className="qc-btn"
                    data-testid={`qc-dismiss-${finding.ruleId}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismissFinding(finding);
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
