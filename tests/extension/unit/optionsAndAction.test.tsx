import fs from "node:fs";
import path from "node:path";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Options } from "../../../extension/src/options/Options";
import { DEFAULT_EXTENSION_SETTINGS, type HealthResponse } from "../../../extension/src/shared/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("Toolbar Popup removal & Options relocation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalChrome: unknown;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalChrome = (globalThis as Record<string, unknown>).chrome;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    (globalThis as Record<string, unknown>).chrome = originalChrome;
  });

  it("removes action.default_popup from manifest so clicking extension icon uses onClicked", () => {
    const manifestRaw = fs.readFileSync(
      path.resolve(process.cwd(), "extension/manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(manifestRaw) as {
      action?: { default_popup?: string; default_title?: string };
      options_ui?: { page?: string };
    };
    expect(manifest.action).toBeDefined();
    expect(manifest.action?.default_popup).toBeUndefined();
    expect(manifest.options_ui?.page).toBe("src/options/index.html");
  });

  it("relocates Pre-Confirm Guard toggle, Canvas Overlay toggle, Cache/Models summary, and Tab Actions to Options", async () => {
    const storedState: Record<string, unknown> = {
      sly_qc_settings_v1: { ...DEFAULT_EXTENSION_SETTINGS },
    };
    const sendMessage = vi.fn(async (msg: { type: string; command?: string }) => {
      if (msg.type === "QC_GET_HEALTH") {
        const health: HealthResponse = {
          status: "ok",
          version: "1.0.0",
          device: "mps",
          loadedModels: ["depth-anything-v2-small", "yolo11s"],
          cacheStats: {
            imageCount: 12,
            diskBytes: 27.1 * 1024 * 1024,
            maxDiskBytes: 2048 * 1024 * 1024,
          },
          uptimeSeconds: 42,
        };
        return { online: true, data: health };
      }
      if (msg.type === "QC_LIST_PROFILES") {
        return { ok: true, data: { profiles: [] } };
      }
      if (msg.type === "QC_TAB_COMMAND") {
        return { ok: true, count: 1 };
      }
      return { ok: true };
    });

    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storedState[key] })),
          set: vi.fn(async (patch: Record<string, unknown>) => {
            Object.assign(storedState, patch);
          }),
        },
      },
      runtime: {
        sendMessage,
      },
    };

    await act(async () => {
      root.render(createElement(Options));
    });
    await flushUi();

    const pill = container.querySelector('[data-testid="opt-backend-status-pill"]');
    expect(pill?.textContent).toBe("Local CV · MPS");

    const cacheSummary = container.querySelector('[data-testid="opt-cache-summary"]');
    expect(cacheSummary?.textContent).toContain("Cache: 12 image(s) (27.1 MB)");
    expect(cacheSummary?.textContent).toContain("Models: depth-anything-v2-small, yolo11s");

    const guardToggle = container.querySelector(
      '[data-testid="opt-confirm-guard-enabled"]',
    ) as HTMLInputElement;
    const guardStrictness = container.querySelector(
      '[data-testid="opt-confirm-guard-strictness"]',
    ) as HTMLSelectElement;
    const overlayToggle = container.querySelector(
      '[data-testid="opt-overlay-visible"]',
    ) as HTMLInputElement;

    expect(guardToggle.checked).toBe(true);
    expect(guardStrictness.disabled).toBe(false);
    expect(overlayToggle.checked).toBe(true);

    await act(async () => {
      guardToggle.click();
    });
    await flushUi();
    expect(guardToggle.checked).toBe(false);
    expect(guardStrictness.disabled).toBe(true);
    expect((storedState.sly_qc_settings_v1 as { confirmGuardEnabled: boolean }).confirmGuardEnabled).toBe(
      false,
    );

    await act(async () => {
      overlayToggle.click();
    });
    await flushUi();
    expect(overlayToggle.checked).toBe(false);
    expect((storedState.sly_qc_settings_v1 as { overlayVisible: boolean }).overlayVisible).toBe(
      false,
    );

    const runBtn = container.querySelector('[data-testid="opt-run-qc"]') as HTMLButtonElement;
    const toggleBarBtn = container.querySelector(
      '[data-testid="opt-toggle-topbar"]',
    ) as HTMLButtonElement;
    await act(async () => {
      runBtn.click();
      toggleBarBtn.click();
    });
    await flushUi();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "QC_TAB_COMMAND",
      command: "QC_TRIGGER_RUN_FROM_ACTION",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "QC_TAB_COMMAND",
      command: "QC_TOGGLE_PANEL_FROM_ACTION",
    });
  });
});
