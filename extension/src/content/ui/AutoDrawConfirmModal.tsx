import React from "react";

export interface AutoDrawConfirmProps {
  open: boolean;
  simIndex: number;
  classTitle: string;
  confidence: number;
  bbox: [number, number, number, number];
  onConfirm: () => void;
  onCancel: () => void;
}

export const AutoDrawConfirmModal: React.FC<AutoDrawConfirmProps> = ({
  open,
  simIndex,
  classTitle,
  confidence,
  bbox,
  onConfirm,
  onCancel,
}) => {
  if (!open) return null;

  const pct = Math.round(confidence * 100);
  const rounded = bbox.map((v) => Math.round(v)).join(", ");

  return (
    <div className="sly-qc-modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm Auto-Draw">
      <div className="sly-qc-modal">
        <div className="sly-qc-modal-header">
          <span>⚡ Confirm Auto-Draw #{simIndex}</span>
          <button type="button" className="sly-qc-btn-ghost" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="sly-qc-modal-body">
          <div className="sly-qc-modal-warning">
            <strong>Warning:</strong> This will create a <strong>real annotation</strong> in your
            Supervisely job using synthetic pointer events.
          </div>
          <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5 }}>
            <div>
              <strong>Class:</strong> {classTitle}
            </div>
            <div>
              <strong>Confidence:</strong> {pct}%
            </div>
            <div>
              <strong>BBox (px):</strong> [{rounded}]
            </div>
            <div style={{ marginTop: 6, opacity: 0.85 }}>
              <strong>Undo hint:</strong> If misplaced, press <code>Ctrl+Z</code> /{" "}
              <code>Cmd+Z</code> or delete the figure in Supervisely.
            </div>
          </div>
        </div>
        <div className="sly-qc-modal-footer">
          <button type="button" className="sly-qc-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="sly-qc-btn-primary" onClick={onConfirm}>
            Draw Annotation
          </button>
        </div>
      </div>
    </div>
  );
};
