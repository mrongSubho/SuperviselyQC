export const QC_DARK_CSS = `
:host {
  all: initial;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #eef0f6;
  --sly-bg-canvas: #0d0e17;
  --sly-bg-surface: #13141f;
  --sly-bg-elevated: #1c1e2e;
  --sly-border: #2a2c3c;
  --sly-text-primary: #eef0f6;
  --sly-text-secondary: #8c90a8;
  --sly-accent: #6b4eff;
  --sly-accent-hover: #7c62ff;
  --sly-pass: #2ce1b4;
  --sly-warn: #fbbf24;
  --sly-danger: #ef4444;
  --sly-info: #38bdf8;
}

*, *::before, *::after {
  box-sizing: border-box;
}

button, input, select {
  font-family: inherit;
  color: inherit;
}

.qc-topbar {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: var(--sly-bg-surface);
  border: 1px solid var(--sly-border);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.2;
  color: var(--sly-text-primary);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
  z-index: 2147483000;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.qc-topbar.dragging {
  cursor: grabbing;
}

.qc-topbar.compact {
  padding: 3px 6px;
  gap: 4px;
}

.qc-drag-grip {
  opacity: 0.72;
  font-size: 12px;
  letter-spacing: -1px;
  color: var(--sly-text-secondary);
  cursor: grab;
  padding: 0 2px;
  line-height: 1;
}

.qc-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}

.qc-status-label {
  font-size: 11px;
  color: var(--sly-text-secondary);
  white-space: nowrap;
}

.qc-score-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-weight: 700;
  font-size: 11px;
  background: var(--sly-bg-elevated);
  border: 1px solid var(--sly-border);
  cursor: pointer;
}

.qc-score-pill.ready {
  color: var(--sly-pass);
  border-color: rgba(44, 225, 180, 0.35);
}

.qc-score-pill.needs_review {
  color: var(--sly-warn);
  border-color: rgba(251, 191, 36, 0.35);
}

.qc-score-pill.blocked {
  color: var(--sly-danger);
  border-color: rgba(239, 68, 68, 0.45);
}

.qc-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 5px;
  border: 1px solid var(--sly-border);
  background: var(--sly-bg-elevated);
  color: var(--sly-text-primary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.qc-btn:hover {
  background: #252840;
  border-color: #3d405b;
}

.qc-btn-primary {
  background: var(--sly-accent);
  border-color: var(--sly-accent);
  color: #ffffff;
}

.qc-btn-primary:hover {
  background: var(--sly-accent-hover);
  border-color: var(--sly-accent-hover);
}

.qc-btn-primary:disabled {
  opacity: 0.65;
  cursor: wait;
}

.qc-btn-active {
  border-color: var(--sly-accent);
  color: #c4b5fd;
}

.qc-btn-danger {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.5);
  color: #fca5a5;
}

.qc-btn-icon {
  padding: 4px 6px;
  min-width: 24px;
  justify-content: center;
}

.qc-topbar-options {
  color: var(--sly-text-secondary);
}

.qc-topbar-options:hover {
  color: #c4b5fd;
  border-color: rgba(107, 78, 255, 0.55);
  background: rgba(107, 78, 255, 0.14);
}

.qc-topbar-close {
  color: var(--sly-text-secondary);
}

.qc-topbar-close:hover {
  color: #fca5a5;
  border-color: rgba(239, 68, 68, 0.55);
  background: rgba(239, 68, 68, 0.14);
}

.qc-drawer {
  position: fixed;
  width: 348px;
  max-height: calc(100vh - 110px);
  display: flex;
  flex-direction: column;
  background: var(--sly-bg-surface);
  border: 1px solid var(--sly-border);
  border-radius: 10px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
  color: var(--sly-text-primary);
  z-index: 2147483200;
  overflow: hidden;
  font-size: 12px;
}

.qc-drawer.over_sidebar {
  top: 56px;
  right: 12px;
  width: 364px;
}

.qc-drawer.below_minimap {
  top: 224px;
  right: 14px;
  width: 344px;
}

.qc-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--sly-bg-elevated);
  border-bottom: 1px solid var(--sly-border);
  gap: 8px;
}

.qc-drawer-header.draggable {
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.qc-drawer-header.draggable:active {
  cursor: grabbing;
}

.qc-drawer-title {
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.qc-drawer-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sly-border);
  background: #10111b;
  flex-wrap: wrap;
}

.qc-select, .qc-input {
  background: var(--sly-bg-elevated);
  border: 1px solid var(--sly-border);
  border-radius: 5px;
  padding: 4px 7px;
  font-size: 11px;
  color: var(--sly-text-primary);
  outline: none;
}

.qc-input:focus, .qc-select:focus {
  border-color: var(--sly-accent);
}

.qc-filter-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--sly-border);
  flex-wrap: wrap;
}

.qc-chip {
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--sly-border);
  background: var(--sly-bg-canvas);
  color: var(--sly-text-secondary);
  cursor: pointer;
}

.qc-chip.active {
  background: rgba(107, 78, 255, 0.22);
  border-color: var(--sly-accent);
  color: #eef0f6;
}

.qc-findings-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.qc-banner {
  margin: 8px 10px 0;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 11px;
  border: 1px solid rgba(251, 191, 36, 0.4);
  background: rgba(251, 191, 36, 0.12);
  color: #fde68a;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.qc-card {
  background: var(--sly-bg-elevated);
  border: 1px solid var(--sly-border);
  border-left-width: 3px;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.qc-card:hover {
  background: #22253a;
}

.qc-card.focused {
  border-color: var(--sly-accent);
  box-shadow: 0 0 0 1px rgba(107, 78, 255, 0.5);
}

.qc-card.sev-blocker {
  border-left-color: var(--sly-danger);
}

.qc-card.sev-warning {
  border-left-color: var(--sly-warn);
}

.qc-card.sev-info {
  border-left-color: var(--sly-info);
}

.qc-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 4px;
}

.qc-card-title {
  font-weight: 600;
  font-size: 12px;
}

.qc-rule-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--sly-text-secondary);
}

.qc-card-msg {
  color: #cbd5e1;
  font-size: 11px;
  line-height: 1.4;
  margin-bottom: 6px;
}

.qc-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.qc-overlay-root {
  position: fixed;
  pointer-events: none;
  z-index: 2147482900;
  overflow: hidden;
}

.qc-edge-pill {
  position: absolute;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(13, 14, 23, 0.92);
  border: 1px solid #38bdf8;
  color: #bae6fd;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  cursor: pointer;
}

.qc-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(6, 7, 13, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483500;
}

.qc-modal {
  width: 440px;
  max-width: calc(100vw - 32px);
  background: var(--sly-bg-surface);
  border: 1px solid #ef4444;
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.65);
}

.qc-modal h3 {
  margin: 0 0 8px;
  font-size: 15px;
  color: #fca5a5;
}

.qc-modal-list {
  margin: 10px 0 14px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
}

.qc-modal-item {
  background: var(--sly-bg-elevated);
  border: 1px solid var(--sly-border);
  border-left: 3px solid var(--sly-danger);
  border-radius: 5px;
  padding: 6px 8px;
  font-size: 11px;
}

.qc-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.qc-toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: var(--sly-bg-elevated);
  border: 1px solid var(--sly-accent);
  color: var(--sly-text-primary);
  padding: 8px 12px;
  border-radius: 7px;
  font-size: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  z-index: 2147483600;
}

.qc-bp-summary {
  background: rgba(56, 189, 248, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.35);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
}

.qc-bp-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.qc-bp-header-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.qc-bp-header-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #7dd3fc;
}

.qc-bp-progress-pill {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(56, 189, 248, 0.25);
  color: #cbd5e1;
  white-space: nowrap;
}

.qc-switch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid var(--sly-border);
  background: rgba(13, 14, 23, 0.72);
  color: var(--sly-text-secondary);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.qc-switch-btn:hover {
  border-color: #475569;
  color: var(--sly-text-primary);
}

.qc-switch-btn.on {
  border-color: rgba(56, 189, 248, 0.55);
  color: #e0f2fe;
}

.qc-switch-track {
  position: relative;
  width: 24px;
  height: 13px;
  border-radius: 999px;
  background: #2a2c3c;
  transition: background 0.15s ease;
  display: inline-block;
  flex-shrink: 0;
}

.qc-switch-btn.on .qc-switch-track {
  background: #0284c7;
}

.qc-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #f8fafc;
  transition: transform 0.15s ease;
}

.qc-switch-btn.on .qc-switch-thumb {
  transform: translateX(11px);
}

.qc-bp-summary-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.qc-bp-prescription-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.qc-bp-prescription {
  font-weight: 600;
  color: #e0f2fe;
  font-size: 11px;
  line-height: 1.35;
}

.qc-bp-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(56, 189, 248, 0.16);
}

.qc-mini-pill {
  background: rgba(107, 78, 255, 0.14);
  border: 1px solid rgba(107, 78, 255, 0.4);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 600;
  color: #ddd6fe;
  cursor: pointer;
  white-space: nowrap;
}

.qc-mini-pill:hover {
  background: rgba(107, 78, 255, 0.26);
}

.qc-bp-progress {
  font-size: 11px;
  color: var(--sly-text-secondary);
}

.qc-bp-item-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.qc-bp-simall-btn.active {
  background: rgba(56, 189, 248, 0.22);
  border-color: #38bdf8;
  color: #e0f2fe;
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.25);
}

.qc-btn-locate-active {
  background: rgba(107, 78, 255, 0.28);
  border-color: #a78bfa;
  color: #f3e8ff;
  box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.35);
}

.qc-btn-sim-active {
  background: rgba(56, 189, 248, 0.22);
  border-color: #38bdf8;
  color: #e0f2fe;
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.28);
}

.qc-bp-warning {
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid #f59e0b;
  border-radius: 7px;
  padding: 8px 10px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: #fde68a;
  font-size: 11px;
}

.qc-bp-note {
  background: var(--sly-bg-elevated);
  border: 1px solid var(--sly-border);
  border-left: 3px solid #38bdf8;
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 8px;
  font-size: 11px;
  color: var(--sly-text-muted);
}

.qc-bp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.qc-bp-item {
  background: var(--sly-bg-elevated);
  border: 1px solid var(--sly-border);
  border-left: 3px solid #38bdf8;
  border-radius: 6px;
  padding: 7px 9px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.qc-bp-item.occluded {
  border-left-color: #f59e0b;
}

.qc-bp-item.truncated {
  border-left-color: #fb923c;
}

.qc-bp-item.completed {
  border-left-color: #34d399;
  opacity: 0.85;
}

.qc-bp-item-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.qc-bp-badge-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.qc-bp-item-title {
  font-weight: 700;
  font-size: 12px;
  color: var(--sly-text-primary);
}

.qc-bp-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 700;
  width: fit-content;
}

.qc-bp-badge.clear {
  background: rgba(56, 189, 248, 0.16);
  color: #7dd3fc;
}

.qc-bp-badge.occluded {
  background: rgba(245, 158, 11, 0.18);
  color: #fcd34d;
}

.qc-bp-badge.truncated {
  background: rgba(251, 146, 60, 0.18);
  color: #fdba74;
}

.qc-bp-badge.completed {
  background: rgba(52, 211, 153, 0.18);
  color: #6ee7b7;
}
`;
