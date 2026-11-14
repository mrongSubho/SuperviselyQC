import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { QCMode, QCResponse } from "../../shared/types";

export interface TopBarWidgetProps {
  visible?: boolean;
  mode: QCMode;
  running: boolean;
  offline: boolean;
  device: "mps" | "cpu" | "none";
  overlayVisible: boolean;
  drawerOpen: boolean;
  effectiveScore: number | null;
  effectiveReadiness: "ready" | "needs_review" | "blocked" | null;
  compact: boolean;
  floatingPos?: { x: number; y: number } | null;
  response: QCResponse | null;
  onChangeMode: (nextMode: QCMode) => void;
  onChangeFloatingPos?: (pos: { x: number; y: number }) => void;
  onRunQc: () => void;
  onToggleOverlay: () => void;
  onToggleDrawer: () => void;
  onCloseAssistant?: () => void;
}

const MODE_LABELS: Record<QCMode, string> = {
  rules: "Rules",
  standard: "Standard",
  deep: "Deep",
};

export function TopBarWidget({
  visible = true,
  mode,
  running,
  offline,
  device,
  overlayVisible,
  drawerOpen,
  effectiveScore,
  effectiveReadiness,
  compact,
  floatingPos = null,
  onChangeMode,
  onChangeFloatingPos,
  onRunQc,
  onToggleOverlay,
  onToggleDrawer,
  onCloseAssistant,
}: TopBarWidgetProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  if (!visible) return null;

  const statusDotColor = offline
    ? "#fbbf24"
    : running
      ? "#38bdf8"
      : device === "mps" || device === "cpu"
        ? "#2ce1b4"
        : "#2ce1b4";

  const statusText = offline
    ? "Offline · Rules"
    : device === "mps"
      ? "Local CV · MPS"
      : device === "cpu"
        ? "Local CV · CPU"
        : "Local CV";

  const readinessClass = effectiveReadiness ?? "ready";
  const scoreDisplay = effectiveScore !== null ? `${effectiveScore}` : "--";

  const cycleMode = () => {
    const order: QCMode[] = ["standard", "deep", "rules"];
    const idx = order.indexOf(mode);
    const next = order[(idx + 1) % order.length]!;
    onChangeMode(next);
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, select, input, a")) return;
    const rect = barRef.current?.getBoundingClientRect();
    const origX = floatingPos?.x ?? rect?.left ?? (typeof window !== "undefined" ? Math.max(8, window.innerWidth - 620) : 200);
    const origY = floatingPos?.y ?? rect?.top ?? 8;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragState({
      startX: e.clientX,
      startY: e.clientY,
      origX,
      origY,
    });
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState || !onChangeFloatingPos) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const maxW = typeof window !== "undefined" ? Math.max(120, window.innerWidth - 160) : 2000;
    const maxH = typeof window !== "undefined" ? Math.max(60, window.innerHeight - 48) : 2000;
    onChangeFloatingPos({
      x: Math.min(maxW, Math.max(8, Math.round(dragState.origX + dx))),
      y: Math.min(maxH, Math.max(8, Math.round(dragState.origY + dy))),
    });
  };

  const handlePointerUp = () => {
    setDragState(null);
  };

  const positionStyle = floatingPos
    ? { left: `${floatingPos.x}px`, top: `${floatingPos.y}px`, right: "auto" }
    : { top: "8px", right: compact ? "12px" : "220px" };

  return (
    <div
      ref={barRef}
      className={`qc-topbar ${compact ? "compact" : ""} ${dragState ? "dragging" : ""}`}
      style={positionStyle}
      data-testid="qc-topbar"
      role="region"
      aria-label="Supervisely Hybrid QC Assistant"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <span
        className="qc-drag-grip"
        data-testid="qc-topbar-drag-handle"
        title="Drag to move QC toolbar"
        aria-hidden="true"
      >
        ⋮⋮
      </span>
      <span
        className="qc-dot"
        style={{ backgroundColor: statusDotColor }}
        title={statusText}
      />
      {!compact && <span className="qc-status-label">{statusText}</span>}

      <button
        type="button"
        className={`qc-score-pill ${readinessClass}`}
        data-testid="qc-score-pill"
        onClick={onToggleDrawer}
        title="Open QC Drawer (Option + D)"
      >
        <span>QC {scoreDisplay}</span>
      </button>

      <button
        type="button"
        className="qc-btn"
        data-testid="qc-mode-cycle"
        onClick={cycleMode}
        title="Cycle QC Mode (Rules / Standard / Deep)"
      >
        {MODE_LABELS[mode]}
      </button>

      <button
        type="button"
        className="qc-btn qc-btn-primary"
        data-testid="qc-run-btn"
        disabled={running}
        onClick={onRunQc}
        title="Run QC Inspection (Option + Q)"
      >
        {running ? "Running…" : compact ? "QC" : "Run QC"}
      </button>

      <button
        type="button"
        className={`qc-btn ${overlayVisible ? "qc-btn-active" : ""}`}
        data-testid="qc-overlay-toggle"
        onClick={onToggleOverlay}
        title="Toggle Canvas Overlays (Option + O)"
      >
        {compact ? "👁" : overlayVisible ? "Overlay On" : "Overlay Off"}
      </button>

      <button
        type="button"
        className={`qc-btn ${drawerOpen ? "qc-btn-active" : ""}`}
        data-testid="qc-drawer-toggle"
        onClick={onToggleDrawer}
        title="Toggle QC Drawer (Option + D)"
      >
        {compact ? "☰" : "Drawer"}
      </button>

      {onCloseAssistant && (
        <button
          type="button"
          className="qc-btn qc-btn-icon qc-topbar-close"
          data-testid="qc-topbar-close"
          onClick={onCloseAssistant}
          title="Close QC Assistant (reopen from extension icon or Option + D)"
          aria-label="Close QC Assistant"
        >
          ✕
        </button>
      )}
    </div>
  );
}
