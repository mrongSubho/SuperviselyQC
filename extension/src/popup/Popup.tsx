import { useEffect, useState } from "react";
import { loadSettings, saveSettings } from "../shared/storage";
import {
  DEFAULT_EXTENSION_SETTINGS,
  type ExtensionSettings,
  type HealthResponse,
  type QCMode,
} from "../shared/types";

export function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_EXTENSION_SETTINGS);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [online, setOnline] = useState<boolean>(false);

  const refreshHealth = async () => {
    try {
      const res = (await chrome.runtime.sendMessage({ type: "QC_GET_HEALTH" })) as {
        online?: boolean;
        data?: HealthResponse;
      };
      setOnline(Boolean(res?.online));
      setHealth(res?.data ?? null);
    } catch {
      setOnline(false);
      setHealth(null);
    }
  };

  useEffect(() => {
    void loadSettings().then(setSettings);
    void refreshHealth();
  }, []);

  const update = async (patch: Partial<ExtensionSettings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
  };

  const runActiveTabQc = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, { type: "QC_TRIGGER_RUN_FROM_POPUP" }).catch(() => undefined);
    }
    window.close();
  };

  const toggleFloatingBar = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, { type: "QC_TOGGLE_PANEL_FROM_POPUP" }).catch(() => undefined);
    }
    window.close();
  };

  const cacheMb = health
    ? (health.cacheStats.diskBytes / (1024 * 1024)).toFixed(1)
    : "0.0";

  return (
    <div
      style={{
        width: "320px",
        padding: "14px",
        background: "#13141f",
        color: "#eef0f6",
        fontFamily: "Inter, -apple-system, sans-serif",
        fontSize: "12px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <strong style={{ fontSize: "13px" }}>Supervisely Hybrid QC</strong>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: "999px",
            fontSize: "11px",
            background: online ? "rgba(44,225,180,0.16)" : "rgba(251,191,36,0.16)",
            color: online ? "#2ce1b4" : "#fbbf24",
            border: `1px solid ${online ? "rgba(44,225,180,0.4)" : "rgba(251,191,36,0.4)"}`,
          }}
        >
          {online ? `Local CV · ${health?.device.toUpperCase() ?? "CPU"}` : "Offline · Rules"}
        </span>
      </div>

      <div
        style={{
          background: "#1c1e2e",
          border: "1px solid #2a2c3c",
          borderRadius: "8px",
          padding: "10px",
          marginBottom: "10px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "#8c90a8" }}>QC Mode</span>
          <select
            value={settings.defaultMode}
            onChange={(e) => void update({ defaultMode: e.target.value as QCMode })}
            style={{
              background: "#0d0e17",
              color: "#eef0f6",
              border: "1px solid #2a2c3c",
              borderRadius: "5px",
              padding: "3px 6px",
            }}
          >
            <option value="standard">Standard (Recommended)</option>
            <option value="deep">Deep (+ SAM + YOLO-World)</option>
            <option value="rules">Rules Only</option>
          </select>
        </label>

        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
          <span style={{ color: "#8c90a8" }}>Auto-run on image switch</span>
          <input
            type="checkbox"
            checked={settings.autoRunOnImageSwitch}
            onChange={(e) => void update({ autoRunOnImageSwitch: e.target.checked })}
          />
        </label>

        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
          <span style={{ color: "#8c90a8" }}>Pre-Confirm Guard</span>
          <input
            type="checkbox"
            checked={settings.confirmGuardEnabled}
            onChange={(e) => void update({ confirmGuardEnabled: e.target.checked })}
          />
        </label>

        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
          <span style={{ color: "#8c90a8" }}>Show Canvas Overlays</span>
          <input
            type="checkbox"
            checked={settings.overlayVisible}
            onChange={(e) => void update({ overlayVisible: e.target.checked })}
          />
        </label>
      </div>

      {online && health && (
        <div style={{ fontSize: "11px", color: "#8c90a8", marginBottom: "10px" }}>
          Cache: {health.cacheStats.imageCount} image(s) ({cacheMb} MB) · Models:{" "}
          {health.loadedModels.length > 0 ? health.loadedModels.join(", ") : "Lazy (idle)"}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          onClick={() => void runActiveTabQc()}
          style={{
            flex: 1,
            padding: "7px 10px",
            borderRadius: "6px",
            border: "none",
            background: "#6b4eff",
            color: "#ffffff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Run QC Now (⌥Q)
        </button>
        <button
          type="button"
          onClick={() => void toggleFloatingBar()}
          style={{
            padding: "7px 9px",
            borderRadius: "6px",
            border: "1px solid #2a2c3c",
            background: "#1c1e2e",
            color: "#eef0f6",
            fontWeight: 600,
            cursor: "pointer",
          }}
          title="Show or hide the QC toolbar on the active tab"
        >
          Show/Hide Bar
        </button>
        <button
          type="button"
          onClick={() => chrome.runtime.openOptionsPage()}
          style={{
            padding: "7px 10px",
            borderRadius: "6px",
            border: "1px solid #2a2c3c",
            background: "#1c1e2e",
            color: "#eef0f6",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Options
        </button>
      </div>
    </div>
  );
}
