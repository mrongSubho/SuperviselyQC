import { deflateSync } from "node:zlib";
import { createElement, act } from "react";
import type { MissedObjectOverlay } from "../../../extension/src/shared/types";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeQuickFix, extractDomState } from "../../../extension/src/content/domObserver";
import { reconcileSimulationWithFigures } from "../../../extension/src/content/index";
import { warmBitmapBoundingBoxes } from "../../../extension/src/content/simulationMatch";
import { CanvasOverlay } from "../../../extension/src/content/ui/CanvasOverlay";
import { QcDrawer } from "../../../extension/src/content/ui/QcDrawer";
import { TopBarWidget } from "../../../extension/src/content/ui/TopBarWidget";
import type {
  AnnotationFigure,
  QCResponse,
  SceneSimulationPlan,
} from "../../../extension/src/shared/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function buildHorseSimulation(completedCount = 0): SceneSimulationPlan {
  const candidates = Array.from({ length: 10 }, (_, idx) => {
    const simIndex = idx + 1;
    const occluded = simIndex === 2 || simIndex === 4 || simIndex === 6 || simIndex === 9;
    const offscreen = simIndex === 10;
    const matched = idx < completedCount ? `fig_h${simIndex}` : null;
    return {
      simId: `sim_${String(simIndex).padStart(2, "0")}`,
      simIndex,
      classTitle: "Horse",
      recommendedShape: "rectangle" as const,
      bbox: [100 + idx * 320, 820, 400 + idx * 320, occluded ? 1440 : 1700] as [
        number,
        number,
        number,
        number,
      ],
      confidence: 0.92,
      sharpnessScore: 44.5,
      visibilityStatus: occluded ? ("occluded" as const) : ("foreground_clear" as const),
      occludedBySimIndices: occluded ? [simIndex - 1] : [],
      overlapIouMax: occluded ? 0.24 : 0.0,
      overlapCoverRatio: occluded ? 0.38 : 0.0,
      recommendedObjectTags: occluded
        ? [
            {
              tagName: "Occlusion",
              value: null,
              reason: `Occluded behind foreground Horse (#${simIndex - 1})`,
              confidence: 0.9,
            },
          ]
        : [],
      outsideViewport: offscreen,
      viewportEdgeDirection: offscreen ? ("right" as const) : undefined,
      matchedFigureId: matched,
    };
  });

  return {
    totalTargetObjects: 10,
    completedTargetObjects: completedCount,
    primaryTargetClasses: ["Horse"],
    classSummaries: [
      {
        classTitle: "Horse",
        recommendedShape: "rectangle",
        totalCount: 10,
        completedCount,
        remainingCount: 10 - completedCount,
        foregroundClearCount: 6,
        occludedCount: 4,
        borderTruncatedCount: 0,
        tagCounts: { Occlusion: 4 },
      },
    ],
    candidates,
    recommendedImageTags: [],
    misplacedImageTags: ["Occlusion"],
    ignoredOntologyClasses: ["Animal", "Boat", "Car"],
    disambiguationNotes: ["Ontology has both 'Horse' and 'Animal' — using specific class 'Horse'."],
    activeSidebarClassWarning: "Active sidebar class is 'Boat', expected 'Horse' (rectangle).",
  };
}

function buildMockResponse(sim: SceneSimulationPlan): QCResponse {
  return {
    analysisId: `qc_${sim.completedTargetObjects}`,
    requestId: "req_bp_1",
    jobId: null,
    status: "completed",
    imageId: "img_horses",
    snapshotSeq: 1,
    mode: "standard",
    profileId: "default",
    overallScore: 84,
    readiness: "needs_review",
    summaryCounts: { blocker: 0, warning: 2, info: 0 },
    findings: [],
    missedObjects: [],
    sceneSimulation: sim,
    timingMs: { rules: 4, vision: 95, total: 101 },
    engineCapabilities: { device: "cpu", modelsUsed: ["yolo11s.pt"] },
    error: null,
  };
}

describe("Scene Simulation Blueprint UI, Overlays & Sidebar DOM Quick Fix", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  it("auto-opens Blueprint [0/10] tab on fresh 0-figure image and renders prescription, warnings & checklist", async () => {
    const sim = buildHorseSimulation(0);
    const resp = buildMockResponse(sim);
    const onSelectSidebarClass = vi.fn();
    const onLocateRect = vi.fn();
    const onToggleBlueprintGuides = vi.fn();

    await act(async () => {
      root.render(
        createElement(QcDrawer, {
          open: true,
          dockMode: "below_minimap",
          floatingPos: null,
          mode: "standard",
          running: false,
          offline: false,
          staleSnapshot: false,
          response: resp,
          sceneSimulation: sim,
          showBlueprintGuides: false,
          profiles: [],
          selectedProfileId: "auto",
          activeFindings: [],
          effectiveScore: 84,
          effectiveReadiness: "needs_review",
          blockerCount: 0,
          warningCount: 2,
          infoCount: 0,
          focusedFindingId: null,
          onClose: vi.fn(),
          onChangeDockMode: vi.fn(),
          onChangeFloatingPos: vi.fn(),
          onChangeMode: vi.fn(),
          onChangeProfile: vi.fn(),
          onRunQc: vi.fn(),
          onSelectFinding: vi.fn(),
          onStepFinding: vi.fn(),
          onQuickFix: vi.fn(),
          onDismissFinding: vi.fn(),
          onToggleBlueprintGuides,
          onLocateRect,
          onSelectSidebarClass,
        }),
      );
    });

    const bpTab = container.querySelector('[data-testid="qc-tab-blueprint"]') as HTMLButtonElement;
    expect(bpTab).not.toBeNull();
    expect(bpTab.textContent).toContain("Blueprint (0/10)");
    expect(bpTab.className).toContain("active");

    const panel = container.querySelector('[data-testid="qc-blueprint-panel"]')!;
    expect(panel.textContent).toContain("10 × Horse (rectangle)");
    expect(panel.textContent).toContain("6 Clear · 4 🏷 Occlusion");

    expect(container.querySelector('[data-testid="qc-bp-misplaced-tags"]')?.textContent).toContain(
      "Occlusion",
    );
    expect(container.querySelector('[data-testid="qc-bp-disambiguation"]')?.textContent).toContain(
      "using specific class 'Horse'",
    );

    const item1 = container.querySelector('[data-testid="qc-bp-item-1"]')!;
    const item2 = container.querySelector('[data-testid="qc-bp-item-2"]')!;
    expect(item1.textContent).toContain("Clear — No Tag");
    expect(item2.textContent).toContain("🏷 Occlusion (behind #1 · 38%)");

    const switchBtn = container.querySelector(
      '[data-testid="qc-bp-switch-class-btn"]',
    ) as HTMLButtonElement;
    expect(switchBtn.textContent).toContain("Switch Sidebar to Horse");
    await act(async () => {
      switchBtn.click();
    });
    expect(onSelectSidebarClass).toHaveBeenCalledWith("Horse");

    const toggleBtn = container.querySelector(
      '[data-testid="qc-bp-simulate-all"]',
    ) as HTMLButtonElement;
    expect(toggleBtn.textContent).toContain("Simulate All");
    await act(async () => {
      toggleBtn.click();
    });
    expect(onToggleBlueprintGuides).toHaveBeenCalledTimes(1);

    const locateBtn = container.querySelector(
      '[data-testid="qc-bp-locate-2"]',
    ) as HTMLButtonElement;
    await act(async () => {
      locateBtn.click();
    });
    expect(onLocateRect).toHaveBeenCalledWith(sim.candidates[1]!.bbox);
  });

  it("renders partial 4/10 completion progress cleanly in Blueprint tab", async () => {
    const sim = buildHorseSimulation(4);
    const resp = buildMockResponse(sim);

    await act(async () => {
      root.render(
        createElement(QcDrawer, {
          open: true,
          dockMode: "below_minimap",
          floatingPos: null,
          mode: "standard",
          running: false,
          offline: false,
          staleSnapshot: false,
          response: resp,
          sceneSimulation: sim,
          showBlueprintGuides: false,
          profiles: [],
          selectedProfileId: "auto",
          activeFindings: [],
          effectiveScore: 92,
          effectiveReadiness: "needs_review",
          blockerCount: 0,
          warningCount: 1,
          infoCount: 0,
          focusedFindingId: null,
          onClose: vi.fn(),
          onChangeDockMode: vi.fn(),
          onChangeFloatingPos: vi.fn(),
          onChangeMode: vi.fn(),
          onChangeProfile: vi.fn(),
          onRunQc: vi.fn(),
          onSelectFinding: vi.fn(),
          onStepFinding: vi.fn(),
          onQuickFix: vi.fn(),
          onDismissFinding: vi.fn(),
        }),
      );
    });

    const bpTab = container.querySelector('[data-testid="qc-tab-blueprint"]') as HTMLButtonElement;
    expect(bpTab.textContent).toContain("Blueprint (4/10)");
    await act(async () => {
      bpTab.click();
    });
    expect(container.querySelector('[data-testid="qc-bp-item-1"]')?.textContent).toContain(
      "Done (fig_h1)",
    );
    expect(container.querySelector('[data-testid="qc-bp-item-5"]')?.textContent).toContain(
      "[ ] #5 Horse",
    );
  });

  it("renders numbered Cyan/Amber dashed guides, matched ✓ pills, edge pills and hides when toggled off", async () => {
    const sim = buildHorseSimulation(1); // #1 matched, #2..#9 in viewport (#2/#4/#6/#9 amber, #3/#5/#7/#8 cyan), #10 off-viewport right
    const onClickSimCandidate = vi.fn();

    const baseProps = {
      visible: true,
      canvasRect: { left: 0, top: 0, width: 960, height: 540 },
      minimapRect: { left: 1000, top: 20, width: 180, height: 120 },
      imageWidth: 3840,
      imageHeight: 2160,
      viewport: {
        zoomPercent: 100,
        visibleNormRect: [0, 0, 1, 1] as [number, number, number, number],
        visiblePixelRect: [0, 0, 3840, 2160] as [number, number, number, number],
        canvasSize: { width: 960, height: 540 },
        source: "fallback_full" as const,
      },
      activeFindings: [],
      activeMissedObjects: [],
      sceneSimulation: sim,
      showBlueprintGuides: true,
      focusedFindingId: null,
      highlightedRect: null,
      figures: [],
      onClickMissedOverlay: vi.fn(),
      onClickFindingOverlay: vi.fn(),
      onClickSimCandidate,
    };

    await act(async () => {
      root.render(createElement(CanvasOverlay, baseProps));
    });

    const done1 = container.querySelector('[data-testid="qc-sim-done-1"]');
    expect(done1?.textContent).toContain("✓ #1");

    const guide2Rect = container.querySelector('[data-testid="qc-sim-guide-2"] rect');
    const guide2Text = container.querySelector('[data-testid="qc-sim-guide-2"] text');
    expect(guide2Rect?.getAttribute("stroke")).toBe("#f59e0b");
    expect(guide2Text?.textContent).toContain("#2 Horse · 🏷 Occ (behind #1)");

    const guide3Rect = container.querySelector('[data-testid="qc-sim-guide-3"] rect');
    const guide3Text = container.querySelector('[data-testid="qc-sim-guide-3"] text');
    expect(guide3Rect?.getAttribute("stroke")).toBe("#38bdf8");
    expect(guide3Text?.textContent).toContain("#3 Horse · Clear");

    const edgePill10 = container.querySelector(
      '[data-testid="qc-sim-edge-pill-10"]',
    ) as HTMLButtonElement;
    expect(edgePill10).not.toBeNull();
    expect(edgePill10.textContent).toContain("→#10 Horse");
    await act(async () => {
      edgePill10.click();
    });
    expect(onClickSimCandidate).toHaveBeenCalledWith(sim.candidates[9]);

    // Clean-by-default after Run QC: showBlueprintGuides=false hides whole-image guides
    await act(async () => {
      root.render(createElement(CanvasOverlay, { ...baseProps, showBlueprintGuides: false }));
    });
    expect(container.querySelector('[data-testid="qc-sim-guide-2"]')).toBeNull();
    expect(container.querySelector('[data-testid="qc-sim-done-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="qc-sim-edge-pill-10"]')).toBeNull();

    // Toggling individual candidate #3 Sim renders ONLY candidate #3 without cluttering others
    await act(async () => {
      root.render(
        createElement(CanvasOverlay, {
          ...baseProps,
          showBlueprintGuides: false,
          simulatedCandidateIds: [sim.candidates[2]!.simId],
        }),
      );
    });
    expect(container.querySelector('[data-testid="qc-sim-guide-3"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="qc-sim-guide-2"]')).toBeNull();
  });

  it("extracts active sidebar class & tool and executes select_sidebar_class click cleanly", () => {
    document.body.innerHTML = `
      <aside>
        <div data-qc-role="classes">
          <div class="class-row active" data-class-title="Boat" data-shape="rectangle" data-active="true">Boat</div>
          <div class="class-row" data-class-title="Horse" data-shape="rectangle" data-active="false">Horse</div>
        </div>
        <button data-qc-tool="rectangle" class="active">Rectangle</button>
      </aside>
    `;

    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-qc-role="classes"] .class-row'));
    for (const r of rows) {
      r.addEventListener("click", () => {
        for (const other of rows) {
          other.classList.remove("active");
          other.dataset.active = "false";
        }
        r.classList.add("active");
        r.dataset.active = "true";
      });
    }

    const domBefore = extractDomState(3840, 2160);
    expect(domBefore.activeClassTitle).toBe("Boat");
    expect(domBefore.activeTool).toBe("rectangle");

    const onToast = vi.fn();
    const res = executeQuickFix(
      {
        actionId: "fix_sel",
        label: "Switch Sidebar to Horse",
        actionType: "select_sidebar_class",
        classTitle: "Horse",
      },
      undefined,
      { onFocusRect: vi.fn(), onToast },
    );

    expect(res.executed).toBe(true);
    expect(onToast).toHaveBeenCalledWith(
      'Selected class "Horse" in Definitions -> CLASSES. Use Rectangle tool (R).',
    );
    const domAfter = extractDomState(3840, 2160);
    expect(domAfter.activeClassTitle).toBe("Horse");
  });

  it("shows Blueprint tab before Run QC and supports dragging both TopBarWidget and docked QcDrawer", async () => {
    const onRunQc = vi.fn();
    const onFloatAtPos = vi.fn();
    const onChangeTopbarPos = vi.fn();

    await act(async () => {
      root.render(
        createElement("div", null, [
          createElement(TopBarWidget, {
            key: "tb",
            mode: "standard",
            running: false,
            offline: false,
            device: "mps",
            overlayVisible: true,
            drawerOpen: true,
            effectiveScore: null,
            effectiveReadiness: null,
            compact: false,
            floatingPos: { x: 200, y: 12 },
            response: null,
            onChangeMode: vi.fn(),
            onChangeFloatingPos: onChangeTopbarPos,
            onRunQc,
            onToggleOverlay: vi.fn(),
            onToggleDrawer: vi.fn(),
          }),
          createElement(QcDrawer, {
            key: "dr",
            open: true,
            dockMode: "below_minimap",
            floatingPos: null,
            mode: "standard",
            running: false,
            offline: false,
            staleSnapshot: false,
            response: null,
            sceneSimulation: null,
            showBlueprintGuides: true,
            profiles: [],
            selectedProfileId: "auto",
            activeFindings: [],
            effectiveScore: null,
            effectiveReadiness: null,
            blockerCount: 0,
            warningCount: 0,
            infoCount: 0,
            focusedFindingId: null,
            onClose: vi.fn(),
            onChangeDockMode: vi.fn(),
            onChangeFloatingPos: vi.fn(),
            onFloatAtPos,
            onChangeMode: vi.fn(),
            onChangeProfile: vi.fn(),
            onRunQc,
            onSelectFinding: vi.fn(),
            onStepFinding: vi.fn(),
            onQuickFix: vi.fn(),
            onDismissFinding: vi.fn(),
          }),
        ]),
      );
    });

    // Blueprint tab is discoverable before Run QC and exposes Simulate & Guide CTA
    const bpTab = container.querySelector('[data-testid="qc-tab-blueprint"]') as HTMLButtonElement;
    expect(bpTab).not.toBeNull();
    expect(bpTab.textContent).toBe("Blueprint");
    await act(async () => {
      bpTab.click();
    });
    const bpRunBtn = container.querySelector('[data-testid="qc-bp-run-btn"]') as HTMLButtonElement;
    expect(bpRunBtn.textContent).toContain("Simulate & Guide");
    await act(async () => {
      bpRunBtn.click();
    });
    expect(onRunQc).toHaveBeenCalledTimes(1);

    // Drag TopBarWidget via drag handle
    const topbar = container.querySelector('[data-testid="qc-topbar"]') as HTMLElement;
    await act(async () => {
      topbar.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 210, clientY: 20 }),
      );
    });
    await act(async () => {
      topbar.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 310, clientY: 85 }),
      );
      topbar.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(onChangeTopbarPos).toHaveBeenCalledWith({ x: 300, y: 77 });

    // Drag docked QcDrawer header -> snaps to floating via onFloatAtPos and tracks movement
    const drawerHeader = container.querySelector(".qc-drawer-header") as HTMLElement;
    await act(async () => {
      drawerHeader.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 900, clientY: 240 }),
      );
    });
    expect(onFloatAtPos).toHaveBeenCalledTimes(1);
    await act(async () => {
      drawerHeader.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 780, clientY: 140 }),
      );
      drawerHeader.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(onFloatAtPos).toHaveBeenCalledTimes(2);
  });

  it("supports hiding TopBarWidget via exit button and opening Options via options icon", async () => {
    const onCloseAssistant = vi.fn();
    const onOpenOptions = vi.fn();
    await act(async () => {
      root.render(
        createElement(TopBarWidget, {
          visible: true,
          mode: "standard",
          running: false,
          offline: false,
          device: "mps",
          overlayVisible: true,
          drawerOpen: true,
          effectiveScore: 92,
          effectiveReadiness: "needs_review",
          compact: false,
          floatingPos: null,
          response: null,
          onChangeMode: vi.fn(),
          onRunQc: vi.fn(),
          onToggleOverlay: vi.fn(),
          onToggleDrawer: vi.fn(),
          onOpenOptions,
          onCloseAssistant,
        }),
      );
    });

    const optionsBtn = container.querySelector(
      '[data-testid="qc-topbar-options"]',
    ) as HTMLButtonElement;
    expect(optionsBtn).not.toBeNull();
    await act(async () => {
      optionsBtn.click();
    });
    expect(onOpenOptions).toHaveBeenCalledTimes(1);

    const closeBtn = container.querySelector('[data-testid="qc-topbar-close"]') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    await act(async () => {
      closeBtn.click();
    });
    expect(onCloseAssistant).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        createElement(TopBarWidget, {
          visible: false,
          mode: "standard",
          running: false,
          offline: false,
          device: "mps",
          overlayVisible: true,
          drawerOpen: false,
          effectiveScore: 92,
          effectiveReadiness: "needs_review",
          compact: false,
          floatingPos: null,
          response: null,
          onChangeMode: vi.fn(),
          onRunQc: vi.fn(),
          onToggleOverlay: vi.fn(),
          onToggleDrawer: vi.fn(),
          onCloseAssistant,
        }),
      );
    });
    expect(container.querySelector('[data-testid="qc-topbar"]')).toBeNull();
  });

  it("renders Simulate All, per-row Locate/Sim toggles, gates Auto-Draw behind experimental option, and renders locate reticle", async () => {
    const sim = buildHorseSimulation(2);
    const resp = buildMockResponse(sim);
    const onLocateCandidate = vi.fn();
    const onToggleSimCandidate = vi.fn();
    const onAutoDrawCandidate = vi.fn();

    // 1. Default mode: experimentalAutoDrawEnabled=false -> Auto-Draw controls stay hidden
    await act(async () => {
      root.render(
        createElement("div", null, [
          createElement(QcDrawer, {
            key: "drawer",
            open: true,
            dockMode: "floating",
            floatingPos: { x: 820, y: 120 },
            mode: "deep",
            running: false,
            offline: false,
            staleSnapshot: false,
            response: resp,
            sceneSimulation: sim,
            showBlueprintGuides: false,
            simulatedCandidateIds: [sim.candidates[2]!.simId],
            locatedCandidateId: sim.candidates[2]!.simId,
            experimentalAutoDrawEnabled: false,
            activeSidebarClass: "Horse",
            profiles: [],
            selectedProfileId: "auto",
            activeFindings: [],
            effectiveScore: 92,
            effectiveReadiness: "needs_review",
            blockerCount: 0,
            warningCount: 1,
            infoCount: 0,
            focusedFindingId: null,
            onClose: vi.fn(),
            onChangeDockMode: vi.fn(),
            onChangeFloatingPos: vi.fn(),
            onChangeMode: vi.fn(),
            onChangeProfile: vi.fn(),
            onRunQc: vi.fn(),
            onSelectFinding: vi.fn(),
            onStepFinding: vi.fn(),
            onQuickFix: vi.fn(),
            onDismissFinding: vi.fn(),
            onToggleSimCandidate,
            onLocateCandidate,
            onAutoDrawCandidate,
          }),
          createElement(CanvasOverlay, {
            key: "overlay",
            visible: true,
            canvasRect: { left: 0, top: 0, width: 960, height: 540 },
            minimapRect: null,
            imageWidth: 3840,
            imageHeight: 2160,
            viewport: {
              zoomPercent: 100,
              visibleNormRect: [0, 0, 1, 1],
              visiblePixelRect: [0, 0, 3840, 2160],
              canvasSize: { width: 960, height: 540 },
              source: "fallback_full",
            },
            activeFindings: [],
            activeMissedObjects: [],
            sceneSimulation: sim,
            showBlueprintGuides: false,
            simulatedCandidateIds: [sim.candidates[2]!.simId],
            focusedFindingId: null,
            highlightedRect: sim.candidates[2]!.bbox,
            highlightedLabel: "🎯 #3 Horse",
            figures: [],
            onClickMissedOverlay: vi.fn(),
            onClickFindingOverlay: vi.fn(),
          }),
        ]),
      );
    });

    const bpTab = container.querySelector('[data-testid="qc-tab-blueprint"]') as HTMLButtonElement;
    await act(async () => {
      bpTab.click();
    });

    const simAllBtn = container.querySelector(
      '[data-testid="qc-bp-simulate-all"]',
    ) as HTMLButtonElement;
    expect(simAllBtn.getAttribute("aria-pressed")).toBe("false");
    expect(simAllBtn.textContent).toContain("Simulate All");

    // Auto-Draw UI is hidden while experimentalAutoDrawEnabled=false
    expect(container.querySelector('[data-testid="qc-bp-sim-class-mode"]')).toBeNull();
    expect(container.querySelector('[data-testid="qc-bp-autodraw-3"]')).toBeNull();

    const locate3 = container.querySelector('[data-testid="qc-bp-locate-3"]') as HTMLButtonElement;
    const sim3 = container.querySelector('[data-testid="qc-bp-sim-3"]') as HTMLButtonElement;
    expect(locate3.getAttribute("aria-pressed")).toBe("true");
    expect(sim3.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      locate3.click();
      sim3.click();
    });
    expect(onLocateCandidate).toHaveBeenCalledWith(sim.candidates[2]);
    expect(onToggleSimCandidate).toHaveBeenCalledWith(sim.candidates[2]);

    const highlight = container.querySelector('[data-testid="qc-locate-highlight"]');
    expect(highlight).not.toBeNull();
    expect(highlight?.textContent).toContain("🎯 #3 Horse");

    // 2. Experimental Auto-Draw enabled: renders Auto-Draw only for uncompleted items + class switcher
    await act(async () => {
      root.render(
        createElement("div", null, [
          createElement(QcDrawer, {
            key: "drawer",
            open: true,
            dockMode: "floating",
            floatingPos: { x: 820, y: 120 },
            mode: "deep",
            running: false,
            offline: false,
            staleSnapshot: false,
            response: resp,
            sceneSimulation: sim,
            showBlueprintGuides: true,
            experimentalAutoDrawEnabled: true,
            activeSidebarClass: "Horse",
            profiles: [],
            selectedProfileId: "auto",
            activeFindings: [],
            effectiveScore: 92,
            effectiveReadiness: "needs_review",
            blockerCount: 0,
            warningCount: 1,
            infoCount: 0,
            focusedFindingId: null,
            onClose: vi.fn(),
            onChangeDockMode: vi.fn(),
            onChangeFloatingPos: vi.fn(),
            onChangeMode: vi.fn(),
            onChangeProfile: vi.fn(),
            onRunQc: vi.fn(),
            onSelectFinding: vi.fn(),
            onStepFinding: vi.fn(),
            onQuickFix: vi.fn(),
            onDismissFinding: vi.fn(),
            onToggleSimCandidate,
            onLocateCandidate,
            onAutoDrawCandidate,
          }),
        ]),
      );
    });

    const classModeBtn = container.querySelector(
      '[data-testid="qc-bp-sim-class-mode"]',
    ) as HTMLButtonElement;
    expect(classModeBtn.textContent).toContain("Class: Auto (Detected)");
    await act(async () => {
      classModeBtn.click();
    });
    expect(classModeBtn.textContent).toContain("Class: Horse");

    expect(container.querySelector('[data-testid="qc-bp-autodraw-1"]')).toBeNull();
    const autodraw3 = container.querySelector(
      '[data-testid="qc-bp-autodraw-3"]',
    ) as HTMLButtonElement;
    expect(autodraw3).not.toBeNull();
    await act(async () => {
      autodraw3.click();
    });
    expect(onAutoDrawCandidate).toHaveBeenCalledWith(sim.candidates[2], "Horse");
  });

  it("reconciles live SceneSimulationPlan completion counts with Store figures including Unknown-class IoU>=0.65", () => {
    const sim = buildHorseSimulation(0);
    expect(sim.completedTargetObjects).toBe(0);
    const c1 = sim.candidates[0]!.bbox;
    const c2 = sim.candidates[1]!.bbox;

    const figures: AnnotationFigure[] = [
      {
        figureId: "fig_exact",
        classId: 203,
        classTitle: "Horse",
        geometryType: "rectangle",
        points: {
          exterior: [
            [c1[0], c1[1]],
            [c1[2], c1[3]],
          ],
          interior: [],
        },
        tags: [],
      },
      {
        figureId: "fig_unknown_hi_iou",
        classId: 0,
        classTitle: "Unknown",
        geometryType: "rectangle",
        points: {
          exterior: [
            [c2[0] + 4, c2[1] + 4],
            [c2[2] - 4, c2[3] - 4],
          ],
          interior: [],
        },
        tags: [],
      },
      {
        figureId: "fig_wrong_cls",
        classId: 99,
        classTitle: "Sofa",
        geometryType: "rectangle",
        points: {
          exterior: [
            [sim.candidates[2]!.bbox[0], sim.candidates[2]!.bbox[1]],
            [sim.candidates[2]!.bbox[2], sim.candidates[2]!.bbox[3]],
          ],
          interior: [],
        },
        tags: [],
      },
    ];

    const updated = reconcileSimulationWithFigures(sim, figures);
    expect(updated.completedTargetObjects).toBe(2);
    expect(updated.classSummaries[0]?.completedCount).toBe(2);
    expect(updated.classSummaries[0]?.remainingCount).toBe(8);
    expect(updated.candidates[0]?.matchedFigureId).toBe("fig_exact");
    expect(updated.candidates[1]?.matchedFigureId).toBe("fig_unknown_hi_iou");
    expect(updated.candidates[2]?.matchedFigureId).toBeNull();
  });

  it("hides all unclicked activeMissedObjects marks on canvas when Simulate All / Sim / Locate are off and toggles visible safely", async () => {
    const sim = buildHorseSimulation(3);
    const missed = [
      {
        missedId: "miss_horse_4",
        classTitle: "Horse",
        geometryType: "rectangle" as const,
        bbox: sim.candidates[3]!.bbox,
        confidence: 0.88,
        sharpnessScore: 41.0,
        outsideViewport: false,
        detectorModel: "yolo11s",
      },
      {
        missedId: "miss_horse_10",
        classTitle: "Horse",
        geometryType: "rectangle" as const,
        bbox: sim.candidates[9]!.bbox,
        confidence: 0.79,
        sharpnessScore: 39.0,
        outsideViewport: true,
        viewportEdgeDirection: "right" as const,
        detectorModel: "yolo11s",
      },
    ];

    const overlayProps = {
      visible: false,
      canvasRect: { left: 0, top: 0, width: 960, height: 540 },
      minimapRect: { left: 1000, top: 20, width: 180, height: 120 },
      imageWidth: 3840,
      imageHeight: 2160,
      viewport: {
        zoomPercent: 100,
        visibleNormRect: [0, 0, 1, 1] as [number, number, number, number],
        visiblePixelRect: [0, 0, 3840, 2160] as [number, number, number, number],
        canvasSize: { width: 960, height: 540 },
        source: "fallback_full" as const,
      },
      activeFindings: [],
      activeMissedObjects: missed,
      sceneSimulation: sim,
      showBlueprintGuides: false,
      simulatedCandidateIds: [],
      focusedFindingId: null,
      highlightedRect: null,
      figures: [],
      onClickMissedOverlay: vi.fn(),
      onClickFindingOverlay: vi.fn(),
    };

    // Mount with visible=false first, then toggle visible=true (verifies hook order invariant too)
    await act(async () => {
      root.render(createElement(CanvasOverlay, overlayProps));
    });
    await act(async () => {
      root.render(createElement(CanvasOverlay, { ...overlayProps, visible: true }));
    });

    expect(container.querySelector('[data-testid="qc-missed-box-miss_horse_4"]')).toBeNull();
    expect(container.querySelector('[data-testid="qc-edge-pill-miss_horse_10"]')).toBeNull();
    expect(container.querySelector('[data-testid="qc-sim-guide-4"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="qc-minimap-radar"] span')).toHaveLength(0);

    // Even when Simulate All is clicked, Scene Blueprint guides show once without duplicate Missed boxes
    await act(async () => {
      root.render(
        createElement(CanvasOverlay, {
          ...overlayProps,
          visible: true,
          showBlueprintGuides: true,
        }),
      );
    });
    expect(container.querySelector('[data-testid="qc-sim-guide-4"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="qc-missed-box-miss_horse_4"]')).toBeNull();
  });

  it("renders Truncation and combined Occlusion + Truncation tags in Blueprint and CanvasOverlay without 'Border' tag text", async () => {
    const sim: SceneSimulationPlan = {
      totalTargetObjects: 2,
      completedTargetObjects: 0,
      primaryTargetClasses: ["Boat"],
      classSummaries: [
        {
          classTitle: "Boat",
          recommendedShape: "rectangle",
          totalCount: 2,
          completedCount: 0,
          remainingCount: 2,
          foregroundClearCount: 0,
          occludedCount: 1,
          borderTruncatedCount: 2,
          tagCounts: { Occlusion: 1, Truncation: 2 },
        },
      ],
      candidates: [
        {
          simId: "sim_01",
          simIndex: 1,
          classTitle: "Boat",
          recommendedShape: "rectangle",
          bbox: [0, 300, 420, 720],
          confidence: 0.91,
          sharpnessScore: 42.0,
          visibilityStatus: "border_truncated",
          occludedBySimIndices: [],
          overlapIouMax: 0,
          overlapCoverRatio: 0,
          recommendedObjectTags: [
            {
              tagName: "Truncation",
              value: null,
              reason: "Cut off at image frame edge; apply Truncation tag.",
              confidence: 0.88,
            },
          ],
          outsideViewport: false,
        },
        {
          simId: "sim_02",
          simIndex: 2,
          classTitle: "Boat",
          recommendedShape: "rectangle",
          bbox: [3200, 340, 3836, 780],
          confidence: 0.9,
          sharpnessScore: 41.0,
          visibilityStatus: "occluded",
          occludedBySimIndices: [3],
          overlapIouMax: 0.22,
          overlapCoverRatio: 0.35,
          recommendedObjectTags: [
            {
              tagName: "Occlusion",
              value: null,
              reason: "Occluded behind foreground Boat (#3)",
              confidence: 0.89,
            },
            {
              tagName: "Truncation",
              value: null,
              reason: "Cut off at image frame edge; apply Truncation tag.",
              confidence: 0.88,
            },
          ],
          outsideViewport: false,
        },
      ],
      recommendedImageTags: [],
      misplacedImageTags: [],
      ignoredOntologyClasses: [],
      disambiguationNotes: [],
      activeSidebarClassWarning: null,
    };

    const resp = buildMockResponse(sim);
    await act(async () => {
      root.render(
        createElement("div", null, [
          createElement(QcDrawer, {
            key: "dr",
            open: true,
            dockMode: "floating",
            floatingPos: { x: 820, y: 120 },
            mode: "standard",
            running: false,
            offline: false,
            staleSnapshot: false,
            response: resp,
            sceneSimulation: sim,
            showBlueprintGuides: true,
            profiles: [],
            selectedProfileId: "auto",
            activeFindings: [],
            effectiveScore: 84,
            effectiveReadiness: "needs_review",
            blockerCount: 0,
            warningCount: 1,
            infoCount: 0,
            focusedFindingId: null,
            onClose: vi.fn(),
            onChangeDockMode: vi.fn(),
            onChangeFloatingPos: vi.fn(),
            onChangeMode: vi.fn(),
            onChangeProfile: vi.fn(),
            onRunQc: vi.fn(),
            onSelectFinding: vi.fn(),
            onStepFinding: vi.fn(),
            onQuickFix: vi.fn(),
            onDismissFinding: vi.fn(),
          }),
          createElement(CanvasOverlay, {
            key: "ov",
            visible: true,
            canvasRect: { left: 0, top: 0, width: 960, height: 540 },
            minimapRect: null,
            imageWidth: 3840,
            imageHeight: 2160,
            viewport: {
              zoomPercent: 100,
              visibleNormRect: [0, 0, 1, 1],
              visiblePixelRect: [0, 0, 3840, 2160],
              canvasSize: { width: 960, height: 540 },
              source: "fallback_full",
            },
            activeFindings: [],
            activeMissedObjects: [],
            sceneSimulation: sim,
            showBlueprintGuides: true,
            focusedFindingId: null,
            highlightedRect: null,
            figures: [],
            onClickMissedOverlay: vi.fn(),
            onClickFindingOverlay: vi.fn(),
          }),
        ]),
      );
    });

    const panel = container.querySelector('[data-testid="qc-blueprint-panel"]')!;
    expect(panel.textContent).toContain("1 🏷 Occlusion");
    expect(panel.textContent).toContain("2 🏷 Truncation");
    expect(panel.textContent).not.toContain("Border");

    const item1 = container.querySelector('[data-testid="qc-bp-item-1"]')!;
    const item2 = container.querySelector('[data-testid="qc-bp-item-2"]')!;
    expect(item1.textContent).toContain("🏷 Truncation");
    expect(item2.textContent).toContain("🏷 Occlusion (behind #3 · 35%)");
    expect(item2.textContent).toContain("🏷 Truncation");

    const guide1Rect = container.querySelector('[data-testid="qc-sim-guide-1"] rect');
    const guide1Text = container.querySelector('[data-testid="qc-sim-guide-1"] text');
    const guide2Text = container.querySelector('[data-testid="qc-sim-guide-2"] text');
    expect(guide1Rect?.getAttribute("stroke")).toBe("#fb923c");
    expect(guide1Text?.textContent).toContain("#1 Boat · 🏷 Truncation");
    expect(guide2Text?.textContent).toContain("#2 Boat · 🏷 Occ (behind #3) + Truncation");
  });

  it("matches bitmap Brush figures via warmBitmapBoundingBoxes and renders contour polygons in CanvasOverlay", async () => {
    const makePngChunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const tBuf = Buffer.from(type, "ascii");
      const body = Buffer.concat([tBuf, data]);
      let crc = 0xffffffff;
      for (const byte of body) {
        crc ^= byte;
        for (let b = 0; b < 8; b += 1) {
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
      }
      const cBuf = Buffer.alloc(4);
      cBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
      return Buffer.concat([len, body, cBuf]);
    };
    const makeBitmapData = (w: number, h: number): string => {
      const raw = Buffer.alloc(h * (1 + w * 4), 0);
      for (let y = 0; y < h; y += 1) {
        const rowOff = y * (1 + w * 4);
        raw[rowOff] = 0;
        for (let x = 0; x < w; x += 1) {
          const pxOff = rowOff + 1 + x * 4;
          raw[pxOff] = 255;
          raw[pxOff + 3] = 255;
        }
      }
      const ihdr = Buffer.alloc(13, 0);
      ihdr.writeUInt32BE(w, 0);
      ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8; // bitDepth
      ihdr[9] = 6; // RGBA
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        makePngChunk("IHDR", ihdr),
        makePngChunk("IDAT", deflateSync(raw)),
        makePngChunk("IEND", Buffer.alloc(0)),
      ]);
      return deflateSync(png).toString("base64");
    };

    const bmFig: AnnotationFigure = {
      figureId: "fig_bm_biscuit_1",
      classId: 801,
      classTitle: "Biscuit_B",
      geometryType: "bitmap",
      bitmap: {
        origin: [100, 120],
        data: makeBitmapData(320, 320),
      },
      tags: [],
    };
    const warmed = await warmBitmapBoundingBoxes([bmFig], 2000, 1600);
    expect(warmed).toBe(true);

    const sim: SceneSimulationPlan = {
      totalTargetObjects: 2,
      completedTargetObjects: 0,
      primaryTargetClasses: ["Biscuit_B"],
      classSummaries: [
        {
          classTitle: "Biscuit_B",
          recommendedShape: "bitmap",
          totalCount: 2,
          completedCount: 0,
          remainingCount: 2,
          foregroundClearCount: 2,
          occludedCount: 0,
          borderTruncatedCount: 0,
          tagCounts: {},
        },
      ],
      candidates: [
        {
          simId: "bp_bm_1",
          simIndex: 1,
          classTitle: "Biscuit_B",
          recommendedShape: "bitmap",
          bbox: [110, 130, 410, 430],
          confidence: 0.94,
          sharpnessScore: 80,
          visibilityStatus: "foreground_clear",
          occludedBySimIndices: [],
          overlapIouMax: 0,
          overlapCoverRatio: 0,
          recommendedObjectTags: [],
          outsideViewport: false,
          matchedFigureId: null,
        },
        {
          simId: "bp_bm_2",
          simIndex: 2,
          classTitle: "Biscuit_B",
          recommendedShape: "bitmap",
          bbox: [900, 200, 1400, 700],
          polygonPoints: [
            [
              [950, 240],
              [1360, 240],
              [1360, 660],
              [950, 660],
            ],
          ],
          confidence: 0.91,
          sharpnessScore: 80,
          visibilityStatus: "foreground_clear",
          occludedBySimIndices: [],
          overlapIouMax: 0,
          overlapCoverRatio: 0,
          recommendedObjectTags: [],
          outsideViewport: false,
          matchedFigureId: null,
        },
      ],
      recommendedImageTags: [],
      misplacedImageTags: [],
      ignoredOntologyClasses: [],
      disambiguationNotes: [],
      activeSidebarClassWarning: null,
    };

    const reconciled = reconcileSimulationWithFigures(sim, [bmFig])!;
    expect(reconciled.completedTargetObjects).toBe(1);
    expect(reconciled.candidates[0]?.matchedFigureId).toBe("fig_bm_biscuit_1");
    expect(reconciled.candidates[1]?.matchedFigureId).toBeNull();

    const missedBm: MissedObjectOverlay = {
      missedId: "miss_bm_2",
      classTitle: "Biscuit_B",
      geometryType: "bitmap",
      bbox: [1450, 850, 1850, 1250],
      polygonPoints: [
        [
          [1480, 880],
          [1820, 880],
          [1820, 1220],
          [1480, 1220],
        ],
      ],
      confidence: 0.91,
      sharpnessScore: 80,
      outsideViewport: false,
      detectorModel: "yolov8s-worldv2",
    };

    await act(async () => {
      root.render(
        createElement(CanvasOverlay, {
          visible: true,
          canvasRect: { left: 0, top: 0, width: 1000, height: 800 },
          minimapRect: null,
          imageWidth: 2000,
          imageHeight: 1600,
          viewport: {
            zoomPercent: 100,
            visibleNormRect: [0, 0, 1, 1],
            visiblePixelRect: [0, 0, 2000, 1600],
            canvasSize: { width: 1000, height: 800 },
            source: "fallback_full",
          },
          activeFindings: [],
          activeMissedObjects: [missedBm],
          sceneSimulation: reconciled,
          showBlueprintGuides: true,
          focusedFindingId: null,
          highlightedRect: null,
          figures: [bmFig],
          onClickMissedOverlay: vi.fn(),
          onClickFindingOverlay: vi.fn(),
        }),
      );
    });

    const simPoly = container.querySelector('[data-testid="qc-sim-guide-2"] polygon');
    expect(simPoly).not.toBeNull();

    // When sceneSimulation is null (pure missed-object overlay mode), CanvasOverlay renders polygon contours for missed Brush/Polygon objects
    await act(async () => {
      root.render(
        createElement(CanvasOverlay, {
          visible: true,
          canvasRect: { left: 0, top: 0, width: 1000, height: 800 },
          minimapRect: null,
          imageWidth: 2000,
          imageHeight: 1600,
          viewport: {
            zoomPercent: 100,
            visibleNormRect: [0, 0, 1, 1],
            visiblePixelRect: [0, 0, 2000, 1600],
            canvasSize: { width: 1000, height: 800 },
            source: "fallback_full",
          },
          activeFindings: [],
          activeMissedObjects: [missedBm],
          sceneSimulation: null,
          showBlueprintGuides: true,
          focusedFindingId: null,
          highlightedRect: null,
          figures: [bmFig],
          onClickMissedOverlay: vi.fn(),
          onClickFindingOverlay: vi.fn(),
        }),
      );
    });

    const missPoly = container.querySelector('[data-testid="qc-missed-box-miss_bm_2"] polygon');
    const missRect = container.querySelector('[data-testid="qc-missed-box-miss_bm_2"] rect');
    expect(missPoly).not.toBeNull();
    expect(missRect).toBeNull();
  });
});
