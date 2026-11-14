import type { ConfirmGuardStrictness, QCFinding, QCResponse } from "../../shared/types";
import { computeEffectiveSummary } from "../../shared/storage";

export interface ConfirmGuardDecision {
  allowed: boolean;
  reasons: string[];
  blockingFindings: QCFinding[];
}

export function evaluateConfirmGuard(params: {
  enabled: boolean;
  strictness: ConfirmGuardStrictness;
  synchronizeDirty: boolean;
  response: QCResponse | null;
  dismissedFingerprints: Set<string>;
}): ConfirmGuardDecision {
  const { enabled, strictness, synchronizeDirty, response, dismissedFingerprints } = params;
  if (!enabled || strictness === "off") {
    return { allowed: true, reasons: [], blockingFindings: [] };
  }

  const reasons: string[] = [];
  let blockingFindings: QCFinding[] = [];

  if (strictness === "blockers_and_dirty_sync" && synchronizeDirty) {
    reasons.push("Unsaved annotations (Synchronize button is still dirty).");
  }

  if (response) {
    const eff = computeEffectiveSummary(response, dismissedFingerprints);
    blockingFindings = eff.activeFindings.filter((f) => f.severity === "blocker");
    if (blockingFindings.length > 0) {
      reasons.push(`${blockingFindings.length} blocking QC issue(s) remain unresolved.`);
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    blockingFindings,
  };
}

export function isConfirmTargetElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target.closest("#sly-qc-topbar-host, #sly-qc-drawer-host, #sly-qc-modal-host")) {
    return null;
  }
  const btn = target.closest('button, [role="button"]') as HTMLElement | null;
  if (!btn) return null;
  const label = (btn.textContent ?? "").trim();
  if (/\bconfirm\b/i.test(label) && !/\bconfirmed\b/i.test(label)) {
    return btn;
  }
  return null;
}

export interface ConfirmGuardModalProps {
  open: boolean;
  decision: ConfirmGuardDecision;
  onFixFirst: () => void;
  onReRunQc: () => void;
  onConfirmAnyway: () => void;
  onCancel: () => void;
}

export function ConfirmGuardModal({
  open,
  decision,
  onFixFirst,
  onReRunQc,
  onConfirmAnyway,
  onCancel,
}: ConfirmGuardModalProps) {
  if (!open) return null;

  return (
    <div
      className="qc-modal-backdrop"
      data-testid="qc-confirm-guard-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qc-guard-title"
    >
      <div className="qc-modal">
        <h3 id="qc-guard-title">QC Pre-Confirm Hold</h3>
        <div style={{ fontSize: "12px", color: "#cbd5e1", lineHeight: 1.45 }}>
          Blocking checks failed for this image. Fix issues or re-run QC before confirming:
        </div>

        <ul className="qc-modal-list">
          {decision.reasons.map((r, i) => (
            <li key={`reason_${i}`} className="qc-modal-item">
              {r}
            </li>
          ))}
          {decision.blockingFindings.slice(0, 5).map((f) => (
            <li key={f.findingId} className="qc-modal-item">
              <strong>{f.title}</strong> — {f.message}
            </li>
          ))}
        </ul>

        <div className="qc-modal-footer">
          <button
            type="button"
            className="qc-btn"
            data-testid="qc-guard-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="qc-btn"
            data-testid="qc-guard-fix-first"
            onClick={onFixFirst}
          >
            Fix First
          </button>
          <button
            type="button"
            className="qc-btn qc-btn-primary"
            data-testid="qc-guard-rerun"
            onClick={onReRunQc}
          >
            Re-Run QC
          </button>
          <button
            type="button"
            className="qc-btn qc-btn-danger"
            data-testid="qc-guard-anyway"
            onClick={onConfirmAnyway}
          >
            Confirm Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
