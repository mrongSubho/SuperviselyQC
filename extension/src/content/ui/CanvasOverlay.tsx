import { useEffect, useMemo, useRef } from "react";
import { clamp, decodeSuperviselyBitmapPng } from "../../shared/geometry";
import type {
  AnnotationFigure,
  BoundingBoxTuple,
  CanvasTransformMetadata,
  MissedObjectOverlay,
  Point2D,
  QCFinding,
  SceneSimulationPlan,
  SimulatedObjectCandidate,
  ViewportMetadata,
} from "../../shared/types";

export interface ResolvedAffineTransform {
  tier: "tier1_konva" | "tier2_minimap_zoom" | "tier3_fit";
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

export function computeCanvasAffineTransform(params: {
  imageWidth: number;
  imageHeight: number;
  canvasCssWidth: number;
  canvasCssHeight: number;
  viewport: ViewportMetadata;
  canvasTransform?: CanvasTransformMetadata | null;
}): ResolvedAffineTransform {
  const {
    imageWidth,
    imageHeight,
    canvasCssWidth,
    canvasCssHeight,
    viewport,
    canvasTransform,
  } = params;

  const safeImgW = Math.max(1, imageWidth);
  const safeImgH = Math.max(1, imageHeight);
  const safeCanvasW = Math.max(1, canvasCssWidth);
  const safeCanvasH = Math.max(1, canvasCssHeight);

  // Tier 1: Direct live Konva / canvas transform when available
  if (
    canvasTransform &&
    canvasTransform.source === "konva_or_viewport" &&
    canvasTransform.scaleX > 0 &&
    canvasTransform.scaleY > 0
  ) {
    return {
      tier: "tier1_konva",
      scaleX: canvasTransform.scaleX,
      scaleY: canvasTransform.scaleY,
      offsetX: canvasTransform.offsetX,
      offsetY: canvasTransform.offsetY,
    };
  }

  // Tier 2: Zoomed or cropped single/dual-axis viewport from Minimap (never rely on zoomPercent alone)
  const [nx0, ny0, nx1, ny1] = viewport.visibleNormRect;
  const spanX = nx1 - nx0;
  const spanY = ny1 - ny0;
  const isZoomedOrCropped =
    viewport.zoomPercent < 98 || spanX < 0.995 || spanY < 0.995;

  if (isZoomedOrCropped) {
    const [vx0, vy0, vx1, vy1] = viewport.visiblePixelRect;
    const cropW = Math.max(1e-3, vx1 - vx0);
    const cropH = Math.max(1e-3, vy1 - vy0);
    const scaleX = safeCanvasW / cropW;
    const scaleY = safeCanvasH / cropH;
    return {
      tier: "tier2_minimap_zoom",
      scaleX,
      scaleY,
      offsetX: -vx0 * scaleX,
      offsetY: -vy0 * scaleY,
    };
  }

  // Tier 3: Aspect-preserving centered fit across full canvas
  const scale = Math.min(safeCanvasW / safeImgW, safeCanvasH / safeImgH);
  const offsetX = (safeCanvasW - safeImgW * scale) * 0.5;
  const offsetY = (safeCanvasH - safeImgH * scale) * 0.5;
  return {
    tier: "tier3_fit",
    scaleX: scale,
    scaleY: scale,
    offsetX,
    offsetY,
  };
}

export function projectImagePointToCss(
  pt: Point2D,
  transform: ResolvedAffineTransform,
): Point2D {
  return [
    pt[0] * transform.scaleX + transform.offsetX,
    pt[1] * transform.scaleY + transform.offsetY,
  ];
}

export function projectPolygonRingToSvgPoints(
  ring: Point2D[],
  transform: ResolvedAffineTransform,
): string {
  return ring
    .map((pt) => {
      const [px, py] = projectImagePointToCss(pt, transform);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
}

export function projectBboxToCssRect(
  bbox: BoundingBoxTuple,
  transform: ResolvedAffineTransform,
): { x: number; y: number; width: number; height: number } {
  const minX = Math.min(bbox[0], bbox[2]);
  const minY = Math.min(bbox[1], bbox[3]);
  const maxX = Math.max(bbox[0], bbox[2]);
  const maxY = Math.max(bbox[1], bbox[3]);
  const [x1, y1] = projectImagePointToCss([minX, minY], transform);
  const [x2, y2] = projectImagePointToCss([maxX, maxY], transform);
  return {
    x: x1,
    y: y1,
    width: Math.max(2, x2 - x1),
    height: Math.max(2, y2 - y1),
  };
}

function directionArrow(dir: MissedObjectOverlay["viewportEdgeDirection"]): string {
  switch (dir) {
    case "left":
      return "←";
    case "right":
      return "→";
    case "top":
      return "↑";
    case "bottom":
      return "↓";
    case "top-left":
      return "↖";
    case "top-right":
      return "↗";
    case "bottom-left":
      return "↙";
    case "bottom-right":
      return "↘";
    default:
      return "⌖";
  }
}

export interface CanvasOverlayProps {
  visible: boolean;
  canvasRect: { left: number; top: number; width: number; height: number } | null;
  minimapRect?: { left: number; top: number; width: number; height: number } | null;
  imageWidth: number;
  imageHeight: number;
  viewport: ViewportMetadata;
  canvasTransform?: CanvasTransformMetadata | null;
  activeFindings: QCFinding[];
  activeMissedObjects: MissedObjectOverlay[];
  sceneSimulation?: SceneSimulationPlan | null;
  showBlueprintGuides?: boolean;
  simulatedCandidateIds?: string[];
  focusedFindingId: string | null;
  highlightedRect: BoundingBoxTuple | null;
  highlightedLabel?: string | null;
  figures: AnnotationFigure[];
  onClickMissedOverlay: (missed: MissedObjectOverlay) => void;
  onClickFindingOverlay: (finding: QCFinding) => void;
  onClickSimCandidate?: (candidate: SimulatedObjectCandidate) => void;
}

export function CanvasOverlay({
  visible,
  canvasRect,
  minimapRect,
  imageWidth,
  imageHeight,
  viewport,
  canvasTransform,
  activeFindings,
  activeMissedObjects,
  sceneSimulation,
  showBlueprintGuides = false,
  simulatedCandidateIds = [],
  focusedFindingId,
  highlightedRect,
  highlightedLabel = null,
  figures,
  onClickMissedOverlay,
  onClickFindingOverlay,
  onClickSimCandidate,
}: CanvasOverlayProps) {
  const rasterCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const transform = useMemo(() => {
    if (!canvasRect) return null;
    return computeCanvasAffineTransform({
      imageWidth,
      imageHeight,
      canvasCssWidth: canvasRect.width,
      canvasCssHeight: canvasRect.height,
      viewport,
      canvasTransform,
    });
  }, [imageWidth, imageHeight, canvasRect, viewport, canvasTransform]);

  const activeSimSet = useMemo(
    () => new Set(simulatedCandidateIds),
    [simulatedCandidateIds],
  );
  const focusedMissedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!focusedFindingId) return ids;
    for (const f of activeFindings) {
      if (f.findingId === focusedFindingId) {
        for (const mid of f.missedObjectIds) {
          ids.add(mid);
        }
      }
    }
    return ids;
  }, [activeFindings, focusedFindingId]);

  // Rasterize highlighted bitmap masks cleanly onto HiDPI-scaled backing <canvas>
  useEffect(() => {
    const canvas = rasterCanvasRef.current;
    if (!canvas || !canvasRect || !transform || !visible) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.max(1, Math.round(canvasRect.width * dpr));
    canvas.height = Math.max(1, Math.round(canvasRect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasRect.width, canvasRect.height);

    const highlightedFigIds = new Set<string>();
    for (const f of activeFindings) {
      if (f.findingId === focusedFindingId || f.severity === "blocker") {
        for (const fid of f.figureIds) highlightedFigIds.add(fid);
      }
    }

    const bitmapFigs = figures.filter(
      (fig): fig is Extract<AnnotationFigure, { geometryType: "bitmap" }> =>
        fig.geometryType === "bitmap" &&
        highlightedFigIds.has(fig.figureId) &&
        Boolean(fig.bitmap?.data),
    );
    if (bitmapFigs.length === 0) return;

    let cancelled = false;
    void (async () => {
      for (const bmFig of bitmapFigs) {
        if (cancelled) break;
        const dec = await decodeSuperviselyBitmapPng(
          bmFig.bitmap.data,
          bmFig.bitmap.origin,
          imageWidth,
          imageHeight,
        );
        if (cancelled || !dec.mask || dec.width <= 0 || dec.height <= 0) continue;

        const imgData = new ImageData(dec.width, dec.height);
        for (let i = 0; i < dec.mask.length; i += 1) {
          if (dec.mask[i]) {
            const p = i * 4;
            imgData.data[p] = 239;
            imgData.data[p + 1] = 68;
            imgData.data[p + 2] = 68;
            imgData.data[p + 3] = 95;
          }
        }
        const off = document.createElement("canvas");
        off.width = dec.width;
        off.height = dec.height;
        const offCtx = off.getContext("2d");
        if (!offCtx) continue;
        offCtx.putImageData(imgData, 0, 0);
        const rect = projectBboxToCssRect(
          [dec.originX, dec.originY, dec.originX + dec.width, dec.originY + dec.height],
          transform,
        );
        ctx.drawImage(off, rect.x, rect.y, rect.width, rect.height);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    visible,
    canvasRect,
    transform,
    activeFindings,
    focusedFindingId,
    figures,
    imageWidth,
    imageHeight,
  ]);

  if (!visible || !canvasRect || !transform) {
    return null;
  }

  const hasSceneSimulation = Boolean(sceneSimulation && sceneSimulation.candidates.length > 0);
  const visibleMissedObjects = activeMissedObjects.filter((m) => {
    if (focusedMissedIds.has(m.missedId)) {
      return Boolean(m.outsideViewport);
    }
    // Suggested target boxes stay hidden after Run QC until Simulate All, Sim, or Locate is clicked.
    if (hasSceneSimulation) {
      return false;
    }
    return showBlueprintGuides;
  });
  const inViewportMissed = visibleMissedObjects.filter((m) => !m.outsideViewport);
  const offViewportMissed = visibleMissedObjects.filter((m) => m.outsideViewport);
  const findingsWithRect = activeFindings.filter((f) => Boolean(f.focusRect) && f.category !== "missed_objects");
  const simCandidates = sceneSimulation
    ? showBlueprintGuides
      ? sceneSimulation.candidates
      : sceneSimulation.candidates.filter((c) => activeSimSet.has(c.simId))
    : [];
  const inViewportSim = simCandidates.filter((c) => !c.outsideViewport);
  const offViewportSimUnmatched = simCandidates.filter(
    (c) => c.outsideViewport && !c.matchedFigureId,
  );

  return (
    <div
      className="qc-overlay-root"
      data-testid="qc-canvas-overlay"
      style={{
        left: `${canvasRect.left}px`,
        top: `${canvasRect.top}px`,
        width: `${canvasRect.width}px`,
        height: `${canvasRect.height}px`,
      }}
    >
      <canvas
        ref={rasterCanvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: `${canvasRect.width}px`,
          height: `${canvasRect.height}px`,
          pointerEvents: "none",
        }}
      />

      <svg
        width={canvasRect.width}
        height={canvasRect.height}
        viewBox={`0 0 ${canvasRect.width} ${canvasRect.height}`}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <defs>
          <pattern
            id="qc-overlap-hatch"
            width="8"
            height="8"
            patternTransform="rotate(45 0 0)"
            patternUnits="userSpaceOnUse"
          >
            <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(251, 191, 36, 0.16)" strokeWidth="1.25" />
          </pattern>
        </defs>

        {findingsWithRect.map((f) => {
          const rect = projectBboxToCssRect(f.focusRect!, transform);
          const color =
            f.severity === "blocker"
              ? "#ef4444"
              : f.severity === "warning"
                ? "#fbbf24"
                : "#38bdf8";
          const focused = f.findingId === focusedFindingId;
          const isOverlap = f.ruleId.includes("OCCLUSION") || f.ruleId.includes("DUPLICATE");
          return (
            <g key={f.findingId}>
              <rect
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                fill={isOverlap ? "url(#qc-overlap-hatch)" : "none"}
                stroke={color}
                strokeWidth={focused ? 3 : 2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}

        {highlightedRect && (
          (() => {
            const r = projectBboxToCssRect(highlightedRect, transform);
            const cx = r.x + r.width * 0.5;
            const cy = r.y + r.height * 0.5;
            const leg = Math.min(14, Math.max(6, Math.min(r.width, r.height) * 0.25));
            const labelText = highlightedLabel ?? "Located Target";
            return (
              <g data-testid="qc-locate-highlight">
                <rect
                  x={r.x - 2}
                  y={r.y - 2}
                  width={r.width + 4}
                  height={r.height + 4}
                  fill="rgba(168, 85, 247, 0.14)"
                  stroke="#a855f7"
                  strokeWidth={3}
                  strokeDasharray="6 3"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Corner target brackets for immediate visual lock */}
                <path
                  d={`M ${r.x - 4} ${r.y + leg} L ${r.x - 4} ${r.y - 4} L ${r.x + leg} ${r.y - 4} M ${r.x + r.width - leg} ${r.y - 4} L ${r.x + r.width + 4} ${r.y - 4} L ${r.x + r.width + 4} ${r.y + leg} M ${r.x - 4} ${r.y + r.height - leg} L ${r.x - 4} ${r.y + r.height + 4} L ${r.x + leg} ${r.y + r.height + 4} M ${r.x + r.width - leg} ${r.y + r.height + 4} L ${r.x + r.width + 4} ${r.y + r.height + 4} L ${r.x + r.width + 4} ${r.y + r.height - leg}`}
                  fill="none"
                  stroke="#facc15"
                  strokeWidth={3}
                  vectorEffect="non-scaling-stroke"
                />
                {/* Center target reticle mark */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={7}
                  fill="rgba(13, 14, 23, 0.6)"
                  stroke="#facc15"
                  strokeWidth={2}
                />
                <line x1={cx - 12} y1={cy} x2={cx + 12} y2={cy} stroke="#facc15" strokeWidth={2} />
                <line x1={cx} y1={cy - 12} x2={cx} y2={cy + 12} stroke="#facc15" strokeWidth={2} />
                {/* Target label pill */}
                <rect
                  x={Math.max(2, r.x - 2)}
                  y={Math.max(2, r.y - 22)}
                  width={Math.min(210, Math.max(96, labelText.length * 7.2 + 16))}
                  height={18}
                  rx={4}
                  fill="rgba(88, 28, 135, 0.92)"
                  stroke="#facc15"
                  strokeWidth={1}
                />
                <text
                  x={Math.max(8, r.x + 4)}
                  y={Math.max(14, r.y - 9)}
                  fill="#fef08a"
                  fontSize="11"
                  fontWeight="700"
                >
                  {labelText}
                </text>
              </g>
            );
          })()
        )}

        {inViewportMissed.map((m) => {
          const rect = projectBboxToCssRect(m.bbox, transform);
          const polyRings = (m.polygonPoints ?? []).filter((ring) => ring.length >= 3);
          return (
            <g key={m.missedId} data-testid={`qc-missed-box-${m.missedId}`}>
              {polyRings.length > 0 ? (
                polyRings.map((ring, rIdx) => (
                  <polygon
                    key={`${m.missedId}_ring_${rIdx}`}
                    points={projectPolygonRingToSvgPoints(ring, transform)}
                    fill="rgba(56, 189, 248, 0.12)"
                    stroke="#38bdf8"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    vectorEffect="non-scaling-stroke"
                  />
                ))
              ) : (
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  fill="rgba(56, 189, 248, 0.08)"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <text
                x={Math.max(4, rect.x)}
                y={Math.max(14, rect.y - 4)}
                fill="#38bdf8"
                fontSize="11"
                fontWeight="700"
              >
                {`Missed ${m.classTitle} (${Math.round(m.confidence * 100)}%)`}
              </text>
            </g>
          );
        })}

        {inViewportSim.map((cand) => {
          const rect = projectBboxToCssRect(cand.bbox, transform);
          if (cand.matchedFigureId) {
            return (
              <g key={cand.simId} data-testid={`qc-sim-done-${cand.simIndex}`}>
                <rect
                  x={Math.max(2, rect.x)}
                  y={Math.max(2, rect.y)}
                  width={48}
                  height={16}
                  rx={4}
                  fill="rgba(16, 185, 129, 0.9)"
                />
                <text
                  x={Math.max(6, rect.x + 5)}
                  y={Math.max(13, rect.y + 12)}
                  fill="#052e16"
                  fontSize="10"
                  fontWeight="700"
                >
                  {`✓ #${cand.simIndex}`}
                </text>
              </g>
            );
          }

          const truncTag = cand.recommendedObjectTags.find((t) => /^truncat/i.test(t.tagName));
          const isOccluded = cand.visibilityStatus === "occluded";
          const isTruncated =
            cand.visibilityStatus === "border_truncated" || Boolean(truncTag);
          const truncLabel = truncTag?.tagName ?? "Truncation";
          const stroke = isOccluded ? "#f59e0b" : isTruncated ? "#fb923c" : "#38bdf8";
          const fill = isOccluded
            ? "rgba(245, 158, 11, 0.08)"
            : isTruncated
              ? "rgba(251, 146, 60, 0.08)"
              : "rgba(56, 189, 248, 0.07)";
          const occDetail =
            cand.occludedBySimIndices.length > 0
              ? `behind ${cand.occludedBySimIndices.map((i) => `#${i}`).join(",")}`
              : "occ";
          const statusTag =
            isOccluded && isTruncated
              ? `🏷 Occ (${occDetail}) + ${truncLabel}`
              : isOccluded
                ? `🏷 Occ (${occDetail})`
                : isTruncated
                  ? `🏷 ${truncLabel}`
                  : "Clear";
          const label = `#${cand.simIndex} ${cand.classTitle} · ${statusTag}`;
          const labelX = Math.max(4, rect.x);
          const labelY = Math.max(20, rect.y);
          const pillW = Math.min(340, Math.max(72, Math.round(label.length * 6.3 + 12)));

          const polyRings = (cand.polygonPoints ?? []).filter((ring) => ring.length >= 3);
          return (
            <g key={cand.simId} data-testid={`qc-sim-guide-${cand.simIndex}`}>
              {polyRings.length > 0 ? (
                <>
                  <rect
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    rx={3}
                    fill="none"
                    stroke={stroke}
                    strokeOpacity={0.28}
                    strokeWidth={1}
                    strokeDasharray="3 4"
                    vectorEffect="non-scaling-stroke"
                  />
                  {polyRings.map((ring, rIdx) => (
                    <polygon
                      key={`${cand.simId}_poly_${rIdx}`}
                      points={projectPolygonRingToSvgPoints(ring, transform)}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </>
              ) : (
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  rx={3}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <rect
                x={labelX}
                y={labelY - 18}
                width={pillW}
                height={16}
                rx={4}
                fill="rgba(13, 15, 24, 0.90)"
                stroke={stroke}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={labelX + 6}
                y={labelY - 6}
                fill={stroke}
                fontSize="10.5"
                fontWeight="700"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>

      {offViewportSimUnmatched.map((cand) => {
        const cx = 0.5 * (cand.bbox[0] + cand.bbox[2]);
        const cy = 0.5 * (cand.bbox[1] + cand.bbox[3]);
        const [px, py] = projectImagePointToCss([cx, cy], transform);
        const clampedX = clamp(px, 12, Math.max(12, canvasRect.width - 155));
        const clampedY = clamp(py, 12, Math.max(12, canvasRect.height - 34));
        const isOccluded = cand.visibilityStatus === "occluded";
        const isTruncated =
          cand.visibilityStatus === "border_truncated" ||
          cand.recommendedObjectTags.some((t) => /^truncat/i.test(t.tagName));
        return (
          <button
            key={`edge_sim_${cand.simId}`}
            type="button"
            className="qc-edge-pill"
            data-testid={`qc-sim-edge-pill-${cand.simIndex}`}
            style={{
              left: `${clampedX}px`,
              top: `${clampedY}px`,
              borderColor: isOccluded ? "#f59e0b" : isTruncated ? "#fb923c" : "#38bdf8",
            }}
            onClick={() => onClickSimCandidate?.(cand)}
          >
            <span>{directionArrow(cand.viewportEdgeDirection)}</span>
            <span>{`#${cand.simIndex} ${cand.classTitle}`}</span>
          </button>
        );
      })}

      {offViewportMissed.map((m) => {
        const cx = 0.5 * (m.bbox[0] + m.bbox[2]);
        const cy = 0.5 * (m.bbox[1] + m.bbox[3]);
        const [px, py] = projectImagePointToCss([cx, cy], transform);
        const clampedX = clamp(px, 12, Math.max(12, canvasRect.width - 150));
        const clampedY = clamp(py, 12, Math.max(12, canvasRect.height - 34));
        return (
          <button
            key={m.missedId}
            type="button"
            className="qc-edge-pill"
            data-testid={`qc-edge-pill-${m.missedId}`}
            style={{ left: `${clampedX}px`, top: `${clampedY}px` }}
            onClick={() => onClickMissedOverlay(m)}
          >
            <span>{directionArrow(m.viewportEdgeDirection)}</span>
            <span>{`Missed ${m.classTitle}`}</span>
          </button>
        );
      })}

      {findingsWithRect
        .filter((f) => f.outsideViewport)
        .map((f) => {
          const r = f.focusRect!;
          const [px, py] = projectImagePointToCss(
            [0.5 * (r[0] + r[2]), 0.5 * (r[1] + r[3])],
            transform,
          );
          const clampedX = clamp(px, 12, Math.max(12, canvasRect.width - 160));
          const clampedY = clamp(py, 12, Math.max(12, canvasRect.height - 34));
          return (
            <button
              key={`off_${f.findingId}`}
              type="button"
              className="qc-edge-pill"
              style={{
                left: `${clampedX}px`,
                top: `${clampedY}px`,
                borderColor: f.severity === "blocker" ? "#ef4444" : "#fbbf24",
              }}
              onClick={() => onClickFindingOverlay(f)}
            >
              <span>⌖</span>
              <span>{f.title}</span>
            </button>
          );
        })}

      {minimapRect && minimapRect.width > 16 && minimapRect.height > 16 && (
        <div
          data-testid="qc-minimap-radar"
          style={{
            position: "fixed",
            left: `${minimapRect.left}px`,
            top: `${minimapRect.top}px`,
            width: `${minimapRect.width}px`,
            height: `${minimapRect.height}px`,
            pointerEvents: "none",
          }}
        >
          {visibleMissedObjects.map((m) => {
            const cx = clamp((0.5 * (m.bbox[0] + m.bbox[2])) / Math.max(1, imageWidth), 0, 1);
            const cy = clamp((0.5 * (m.bbox[1] + m.bbox[3])) / Math.max(1, imageHeight), 0, 1);
            return (
              <span
                key={`radar_m_${m.missedId}`}
                style={{
                  position: "absolute",
                  left: `${cx * minimapRect.width - 2.5}px`,
                  top: `${cy * minimapRect.height - 2.5}px`,
                  width: "5px",
                  height: "5px",
                  borderRadius: "50%",
                  background: "#38bdf8",
                }}
              />
            );
          })}
          {simCandidates
            .filter((cand) => !cand.matchedFigureId)
            .map((cand) => {
              const cx = clamp((0.5 * (cand.bbox[0] + cand.bbox[2])) / Math.max(1, imageWidth), 0, 1);
              const cy = clamp((0.5 * (cand.bbox[1] + cand.bbox[3])) / Math.max(1, imageHeight), 0, 1);
              return (
                <span
                  key={`radar_sim_${cand.simId}`}
                  style={{
                    position: "absolute",
                    left: `${cx * minimapRect.width - 2.5}px`,
                    top: `${cy * minimapRect.height - 2.5}px`,
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    background: cand.visibilityStatus === "occluded" ? "#f59e0b" : "#38bdf8",
                  }}
                />
              );
            })}
          {findingsWithRect
            .filter((f) => f.severity === "blocker" && f.focusRect)
            .map((f) => {
              const r = f.focusRect!;
              const cx = clamp((0.5 * (r[0] + r[2])) / Math.max(1, imageWidth), 0, 1);
              const cy = clamp((0.5 * (r[1] + r[3])) / Math.max(1, imageHeight), 0, 1);
              return (
                <span
                  key={`radar_b_${f.findingId}`}
                  style={{
                    position: "absolute",
                    left: `${cx * minimapRect.width - 2.5}px`,
                    top: `${cy * minimapRect.height - 2.5}px`,
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    background: "#ef4444",
                  }}
                />
              );
            })}
        </div>
      )}
    </div>
  );
}
