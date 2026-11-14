import yaml from "js-yaml";
import { useEffect, useState } from "react";
import { loadSettings, saveSettings } from "../shared/storage";
import {
  DEFAULT_EXTENSION_SETTINGS,
  type ConfirmGuardStrictness,
  type ExtensionSettings,
  type HealthResponse,
  type QCMode,
  type RuleProfile,
  type RuleProfileSummary,
} from "../shared/types";

export function Options() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_EXTENSION_SETTINGS);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [profiles, setProfiles] = useState<RuleProfileSummary[]>([]);
  const [yamlDraft, setYamlDraft] = useState<string>("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");

  const testBackend = async () => {
    setStatusMsg("Checking local QC daemon...");
    try {
      const hRes = (await chrome.runtime.sendMessage({ type: "QC_GET_HEALTH" })) as {
        online?: boolean;
        data?: HealthResponse;
      };
      if (!hRes?.online || !hRes.data) {
        setHealth(null);
        setStatusMsg("Offline — start backend on 127.0.0.1:8765 or use Offline Rules.");
        return;
      }
      setHealth(hRes.data);
      const pRes = (await chrome.runtime.sendMessage({ type: "QC_LIST_PROFILES" })) as {
        ok?: boolean;
        data?: { profiles: RuleProfileSummary[] };
      };
      if (pRes?.ok && pRes.data) {
        setProfiles(pRes.data.profiles);
        setStatusMsg(`Connected (${hRes.data.device.toUpperCase()}) · ${pRes.data.profiles.length} profiles loaded.`);
      } else {
        setStatusMsg("Connected to /health, but bridge token is invalid or missing for /profiles.");
      }
    } catch (err) {
      setStatusMsg(`Error: ${String(err)}`);
    }
  };

  useEffect(() => {
    void loadSettings().then((loaded) => {
      setSettings(loaded);
      void testBackend();
    });
  }, []);

  const persist = async (patch: Partial<ExtensionSettings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
    setStatusMsg("Saved settings.");
  };

  const handleExportYaml = async () => {
    if (!selectedProfileId) return;
    const prof = (await chrome.runtime.sendMessage({
      type: "QC_LIST_PROFILES",
    })) as { ok?: boolean; data?: { profiles: RuleProfileSummary[] } };
    const found = prof?.data?.profiles.find((p) => p.profileId === selectedProfileId);
    if (!found) return;

    const base = settings.backendUrl.replace(/\/+$/, "");
    const resp = await fetch(`${base}/api/v1/profiles/${encodeURIComponent(found.profileId)}`, {
      headers: settings.bridgeToken ? { "X-QC-Bridge-Token": settings.bridgeToken } : undefined,
    });
    if (resp.ok) {
      const full = (await resp.json()) as RuleProfile;
      setYamlDraft(yaml.dump(full));
      setStatusMsg(`Exported "${found.profileId}" to YAML editor.`);
    }
  };

  const handleImportYaml = async () => {
    try {
      const parsed = yaml.load(yamlDraft) as RuleProfile;
      if (!parsed || typeof parsed !== "object" || !parsed.profileId) {
        setStatusMsg("YAML must define a valid RuleProfile with profileId.");
        return;
      }
      const res = (await chrome.runtime.sendMessage({
        type: "QC_UPSERT_PROFILE",
        profile: parsed,
      })) as { ok?: boolean; error?: string };
      if (res?.ok) {
        setStatusMsg(`Saved profile "${parsed.profileId}" to backend.`);
        await testBackend();
      } else {
        setStatusMsg(`Profile save failed: ${res?.error ?? "unknown error"}`);
      }
    } catch (err) {
      setStatusMsg(`Invalid YAML: ${String(err)}`);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: "#13141f",
    border: "1px solid #2a2c3c",
    borderRadius: "10px",
    padding: "16px",
    marginBottom: "16px",
  };
  const inputStyle: React.CSSProperties = {
    background: "#1c1e2e",
    border: "1px solid #2a2c3c",
    borderRadius: "6px",
    padding: "6px 10px",
    color: "#eef0f6",
    fontSize: "13px",
  };

  return (
    <div
      style={{
        maxWidth: "860px",
        margin: "0 auto",
        padding: "28px 20px",
        fontFamily: "Inter, -apple-system, sans-serif",
        fontSize: "13px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "20px" }}>Supervisely Hybrid QC Assistant Settings</h1>
          <p style={{ margin: "4px 0 0", color: "#8c90a8" }}>
            Local-only Apple Silicon CV daemon + Quantigo dark-mode annotation guardrails.
          </p>
        </div>
        {statusMsg && (
          <span
            style={{
              padding: "5px 10px",
              borderRadius: "6px",
              background: "#1c1e2e",
              border: "1px solid #6b4eff",
              fontSize: "12px",
            }}
          >
            {statusMsg}
          </span>
        )}
      </div>

      {/* Section 1: Local Engine Connection & Bridge Token */}
      <section style={cardStyle}>
        <h2 style={{ margin: "0 0 10px", fontSize: "15px" }}>1. Local Engine Connection & Token</h2>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "10px", alignItems: "center" }}>
          <label htmlFor="opt-url">Backend URL</label>
          <input
            id="opt-url"
            style={inputStyle}
            value={settings.backendUrl}
            onChange={(e) => void persist({ backendUrl: e.target.value })}
          />

          <label htmlFor="opt-token">Bridge Token</label>
          <input
            id="opt-token"
            type="password"
            style={inputStyle}
            placeholder="Paste token from ~/.config/supervisely-qc/bridge_token"
            value={settings.bridgeToken}
            onChange={(e) => void persist({ bridgeToken: e.target.value })}
          />
        </div>
        <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            type="button"
            onClick={() => void testBackend()}
            style={{
              padding: "7px 14px",
              borderRadius: "6px",
              border: "none",
              background: "#6b4eff",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Test Connection
          </button>
          <span style={{ color: "#8c90a8", fontSize: "12px" }}>
            Token file on macOS: <code>~/.config/supervisely-qc/bridge_token</code>
          </span>
        </div>
      </section>

      {/* Section 2: Execution Behavior, Pre-Confirm Guard & Shortcuts */}
      <section style={cardStyle}>
        <h2 style={{ margin: "0 0 10px", fontSize: "15px" }}>2. Execution Behavior & macOS Shortcuts</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Default AI Mode</span>
            <select
              style={inputStyle}
              value={settings.defaultMode}
              onChange={(e) => void persist({ defaultMode: e.target.value as QCMode })}
            >
              <option value="standard">Standard (YOLO11s + Bokeh Gate + Depth)</option>
              <option value="deep">Deep (Standard + SAM 2.1 + YOLO-Worldv2)</option>
              <option value="rules">Rules Only (Fast Deterministic)</option>
            </select>
          </label>

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Pre-Confirm Guard Strictness</span>
            <select
              style={inputStyle}
              value={settings.confirmGuardStrictness}
              onChange={(e) =>
                void persist({ confirmGuardStrictness: e.target.value as ConfirmGuardStrictness })
              }
            >
              <option value="blockers_and_dirty_sync">Block on Blockers + Dirty Synchronize (Default)</option>
              <option value="blockers_only">Block on QC Blockers Only</option>
              <option value="off">Disabled</option>
            </select>
          </label>

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <span>Auto-run QC on image switch</span>
            <input
              type="checkbox"
              checked={settings.autoRunOnImageSwitch}
              onChange={(e) => void persist({ autoRunOnImageSwitch: e.target.checked })}
            />
          </label>

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <span>Auto-run QC after Synchronize save</span>
            <input
              type="checkbox"
              checked={settings.autoRunAfterSync}
              onChange={(e) => void persist({ autoRunAfterSync: e.target.checked })}
            />
          </label>

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <span>Enable Offline Rules Fallback when daemon is stopped</span>
            <input
              type="checkbox"
              checked={settings.offlineFallbackEnabled}
              onChange={(e) => void persist({ offlineFallbackEnabled: e.target.checked })}
            />
          </label>

          <label
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "12px",
              cursor: "pointer",
              paddingTop: "4px",
              borderTop: "1px solid #26293d",
            }}
          >
            <div>
              <div>Enable Auto-Draw on Canvas (Experimental)</div>
              <div style={{ fontSize: "11px", color: "#8c90a8", marginTop: "2px" }}>
                Off by default. Shows a separate Auto-Draw button &amp; class selector in Blueprint
                rows to draw synthetic rectangles onto Supervisely&apos;s canvas; visual Simulation (
                <code>Simulate All</code> / <code>Sim</code> / <code>Locate</code>) remains strictly
                read-only.
              </div>
            </div>
            <input
              type="checkbox"
              data-testid="opt-experimental-autodraw"
              checked={settings.experimentalAutoDrawEnabled}
              onChange={(e) => void persist({ experimentalAutoDrawEnabled: e.target.checked })}
            />
          </label>
        </div>

        <div
          style={{
            marginTop: "12px",
            padding: "10px",
            background: "#0d0e17",
            borderRadius: "6px",
            fontSize: "12px",
            color: "#8c90a8",
          }}
        >
          <strong>Safe Keyboard Shortcuts (matched by physical key, ignoring Shadow DOM inputs):</strong>
          <div>
            <code>Option + Q</code> Run QC · <code>Option + D</code> Toggle Drawer ·{" "}
            <code>Option + O</code> Toggle Overlays · <code>Option + [</code> /{" "}
            <code>Option + ]</code> Prev/Next Issue
          </div>
        </div>
      </section>

      {/* Section 3: Job Rule Profiles (YAML Import / Export) */}
      <section style={cardStyle}>
        <h2 style={{ margin: "0 0 10px", fontSize: "15px" }}>3. Job Rule Profiles (YAML)</h2>
        <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
          <select
            style={{ ...inputStyle, flex: 1 }}
            value={selectedProfileId}
            onChange={(e) => setSelectedProfileId(e.target.value)}
          >
            <option value="">-- Select Profile --</option>
            {profiles.map((p) => (
              <option key={p.profileId} value={p.profileId}>
                {p.name} ({p.profileId}){p.isBuiltin ? " [Built-in]" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleExportYaml()}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #2a2c3c",
              background: "#1c1e2e",
              color: "#eef0f6",
              cursor: "pointer",
            }}
          >
            Load YAML
          </button>
          <button
            type="button"
            onClick={() => void handleImportYaml()}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "none",
              background: "#6b4eff",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Save / Upsert YAML
          </button>
        </div>
        <textarea
          rows={10}
          value={yamlDraft}
          onChange={(e) => setYamlDraft(e.target.value)}
          placeholder="Load a built-in profile above or paste a custom RuleProfile YAML here..."
          style={{
            ...inputStyle,
            width: "100%",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "12px",
          }}
        />
      </section>

      {/* Section 4: Local Cache & Diagnostics */}
      <section style={cardStyle}>
        <h2 style={{ margin: "0 0 10px", fontSize: "15px" }}>4. Local Diagnostics</h2>
        {health ? (
          <pre
            style={{
              margin: 0,
              padding: "10px",
              background: "#0d0e17",
              borderRadius: "6px",
              fontSize: "11px",
              overflowX: "auto",
            }}
          >
            {JSON.stringify(health, null, 2)}
          </pre>
        ) : (
          <div style={{ color: "#8c90a8" }}>Backend offline or not yet probed.</div>
        )}
      </section>
    </div>
  );
}
