import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, chromium, type BrowserContext } from "@playwright/test";
import { startMockSuperviselyServer, type MockSuperviselyHandle } from "./mockSuperviselyServer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXT_DIST = path.join(REPO_ROOT, "extension/dist");
const VENV_PY = path.join(REPO_ROOT, "backend/.venv/bin/python");
const BACKEND_MAIN = path.join(REPO_ROOT, "backend/main.py");

async function allocateFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to allocate port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/api/v1/health`);
      if (resp.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for backend health at ${url}`);
}

async function stopBackendProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 3_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function launchExtensionContext(): Promise<{
  context: BrowserContext;
  extensionId: string;
  cleanup: () => Promise<void>;
}> {
  if (!fs.existsSync(path.join(EXT_DIST, "manifest.json"))) {
    throw new Error(`Missing built extension bundle at ${EXT_DIST}`);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sly-qc-e2e-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_DIST}`,
      `--load-extension=${EXT_DIST}`,
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  }
  const extensionId = new URL(sw.url()).host;

  return {
    context,
    extensionId,
    cleanup: async () => {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function configureExtensionOptions(
  context: BrowserContext,
  extensionId: string,
  backendUrl: string,
  bridgeToken: string,
  expectConnected: boolean,
): Promise<void> {
  const optPage = await context.newPage();
  await optPage.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await optPage.locator("#opt-url").fill(backendUrl);
  await optPage.locator("#opt-token").fill(bridgeToken);
  await optPage.getByRole("button", { name: "Test Connection" }).click();
  if (expectConnected) {
    await expect(optPage.locator("text=/Connected \\(/")).toBeVisible();
  }
  await optPage.close();
}

test.describe("Supervisely Hybrid QC Extension E2E", () => {
  let mockServer: MockSuperviselyHandle;
  let backendProc: ChildProcess | null = null;
  let backendTempDir: string;
  let backendPort: number;
  let backendUrl: string;
  let bridgeToken: string;

  test.beforeAll(async () => {
    mockServer = await startMockSuperviselyServer();
    backendPort = await allocateFreePort();
    backendUrl = `http://127.0.0.1:${backendPort}`;
    bridgeToken = "e2e_test_bridge_token_0123456789abcdef0123456789abcdef";
    backendTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sly-qc-e2e-backend-"));

    backendProc = spawn(VENV_PY, [BACKEND_MAIN], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SLY_QC_HOST: "127.0.0.1",
        SLY_QC_PORT: String(backendPort),
        SLY_QC_CONFIG_DIR: path.join(backendTempDir, "config"),
        SLY_QC_CACHE_DIR: path.join(backendTempDir, "cache"),
        SLY_QC_MODELS_DIR: path.join(backendTempDir, "models"),
        SLY_QC_USER_PROFILES_DIR: path.join(backendTempDir, "profiles"),
        SLY_QC_BRIDGE_TOKEN: bridgeToken,
      },
      stdio: "pipe",
    });

    await waitForHealth(backendUrl);
  });

  test.afterAll(async () => {
    await stopBackendProcess(backendProc);
    backendProc = null;
    await mockServer?.close();
    if (backendTempDir) {
      fs.rmSync(backendTempDir, { recursive: true, force: true });
    }
  });

  test("1-3: live hybrid QC, image cache upload, dismiss persistence, ConfirmGuard & Shadow DOM isolation", async () => {
    const ext = await launchExtensionContext();
    try {
      await configureExtensionOptions(ext.context, ext.extensionId, backendUrl, bridgeToken, true);

      const page = await ext.context.newPage();
      await page.setViewportSize({ width: 1360, height: 900 });
      await page.goto(`${mockServer.baseUrl}/app/images2/100`);

      // TopBar mounts in Shadow DOM with Standard mode default (manual trigger, no auto-run)
      const topbar = page.getByTestId("qc-topbar");
      await expect(topbar).toBeVisible();
      await expect(page.getByTestId("qc-mode-cycle")).toHaveText("Standard");
      await expect(page.getByTestId("qc-score-pill")).toHaveText("QC --");

      // Test 1: Run QC via Option+Q -> image HEAD/PUT upload + backend analysis + Drawer + Overlay
      await page.keyboard.press("Alt+KeyQ");
      await expect(page.getByTestId("qc-drawer")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("qc-finding-card-GEOM_OUT_OF_BOUNDS")).toBeVisible();
      await expect(page.getByTestId("qc-finding-card-WORKFLOW_UNSAVED_SYNC")).toBeVisible();
      await expect(page.getByTestId("qc-finding-card-TAG_SCOPE_IMAGE_MISPLACED")).toBeVisible();
      await expect(page.getByTestId("qc-run-btn")).toBeEnabled();
      await expect(page.getByTestId("qc-canvas-overlay")).toBeVisible();
      await expect(page.locator("#sly-qc-overlay-host svg rect")).not.toHaveCount(0);

      // Verify full-res 1200x900 PNG was uploaded to backend image cache during standard-mode QC
      const headResp = await fetch(
        `${backendUrl}/api/v1/qc/images/img_100?hash=${encodeURIComponent("sha256:mock_img_100")}&width=1200&height=900`,
        {
          method: "HEAD",
          headers: { "X-QC-Bridge-Token": bridgeToken },
        },
      );
      expect(headResp.status).toBe(200);

      // Dismiss one finding & verify dismissal persists across page reload
      await page.getByTestId("qc-dismiss-GEOM_OUT_OF_BOUNDS").click();
      await expect(page.getByTestId("qc-finding-card-GEOM_OUT_OF_BOUNDS")).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId("qc-topbar")).toBeVisible();
      await page.getByTestId("qc-run-btn").click();
      await expect(page.getByTestId("qc-drawer")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("qc-finding-card-GEOM_OUT_OF_BOUNDS")).toHaveCount(0);
      await expect(page.getByTestId("qc-finding-card-WORKFLOW_UNSAVED_SYNC")).toBeVisible();

      // Test 3: Shadow DOM & Hotkey Isolation inside Drawer search input
      const searchInput = page.getByTestId("qc-drawer-search");
      await searchInput.click();
      await searchInput.pressSequentially("rpbl ");
      const leakedKeys = await page.evaluate(
        () => (window as unknown as { __slyPageKeyEvents: unknown[] }).__slyPageKeyEvents,
      );
      expect(leakedKeys).toHaveLength(0);

      // Clear search, blur back to page, step findings with Option+] and close drawer with Escape
      await searchInput.fill("");
      await page.locator('[data-qc-role="zoom"]').click();
      await page.keyboard.press("Alt+BracketRight");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("qc-drawer")).toHaveCount(0);

      // Test 2: Confirm Guard intercepts click even after React replaces CONFIRM -> DOM node
      await page.evaluate(() =>
        (window as unknown as { __replaceConfirmButton: () => void }).__replaceConfirmButton(),
      );
      await page.getByTestId("confirm-btn").click();
      await expect(page.getByTestId("qc-confirm-guard-modal")).toBeVisible();
      expect(
        await page.evaluate(
          () => (window as unknown as { __slyConfirmClicks: number }).__slyConfirmClicks,
        ),
      ).toBe(0);

      // Resolve issues, Re-Run QC from modal, then confirm cleanly
      await page.evaluate(() =>
        (window as unknown as { __fixAllBlockingIssues: () => void }).__fixAllBlockingIssues(),
      );
      await page.getByTestId("qc-guard-rerun").click();
      await expect(page.getByTestId("qc-confirm-guard-modal")).toHaveCount(0);
      await expect(page.getByTestId("qc-score-pill")).toHaveText("QC 100");

      await page.getByTestId("confirm-btn").click();
      expect(
        await page.evaluate(
          () => (window as unknown as { __slyConfirmClicks: number }).__slyConfirmClicks,
        ),
      ).toBe(1);
    } finally {
      await ext.cleanup();
    }
  });

  test("4: offline fallback runs deterministic TypeScript rules when daemon is unreachable", async () => {
    // Stop backend so daemon is guaranteed unreachable
    await stopBackendProcess(backendProc);
    backendProc = null;

    const ext = await launchExtensionContext();
    try {
      await configureExtensionOptions(
        ext.context,
        ext.extensionId,
        backendUrl,
        bridgeToken,
        false,
      );

      const page = await ext.context.newPage();
      await page.setViewportSize({ width: 1360, height: 900 });
      await page.goto(`${mockServer.baseUrl}/app/images2/100`);

      await expect(page.getByTestId("qc-topbar")).toContainText("Offline · Rules");
      await page.getByTestId("qc-run-btn").click();

      await expect(page.getByTestId("qc-drawer")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("qc-offline-banner")).toBeVisible();
      await expect(page.getByTestId("qc-finding-card-GEOM_OUT_OF_BOUNDS")).toBeVisible();
      await expect(page.getByTestId("qc-finding-card-WORKFLOW_UNSAVED_SYNC")).toBeVisible();
    } finally {
      await ext.cleanup();
    }
  });

  test("5: scene blueprint auto-opens on 0-target simulation, toggles via Option+B, and switches sidebar class", async () => {
    let capturedActiveClass: string | null = null;
    const stubServer = http.createServer((req, res) => {
      const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, HEAD, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (urlPath === "/api/v1/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            version: "1.0.0",
            device: "cpu",
            loadedModels: ["yolo11s.pt"],
            cacheStats: { imageCount: 1, diskBytes: 0, maxDiskBytes: 1024 },
            uptimeSeconds: 1.0,
          }),
        );
        return;
      }
      if (urlPath === "/api/v1/profiles") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ profiles: [], matchedProfileId: "default" }));
        return;
      }
      if (urlPath.startsWith("/api/v1/qc/images/")) {
        res.writeHead(req.method === "HEAD" ? 200 : 201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            imageId: "img_100",
            imageHash: "sha256:mock_img_100",
            width: 1200,
            height: 900,
            bytesStored: 128,
            cached: true,
          }),
        );
        return;
      }
      if (urlPath === "/api/v1/qc/analyze" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
            requestId: string;
            snapshotSeq: number;
            image: { imageId: string };
            uiState?: { activeClassTitle?: string | null };
          };
          capturedActiveClass = parsed.uiState?.activeClassTitle ?? null;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              analysisId: "qc_blueprint_e2e",
              requestId: parsed.requestId,
              jobId: null,
              status: "completed",
              imageId: parsed.image.imageId,
              snapshotSeq: parsed.snapshotSeq,
              mode: "standard",
              profileId: "default",
              overallScore: 86,
              readiness: "needs_review",
              summaryCounts: { blocker: 0, warning: 1, info: 0 },
              findings: [
                {
                  findingId: "f_switch_cls",
                  ruleId: "WORKFLOW_WRONG_ACTIVE_CLASS_OR_TOOL",
                  severity: "warning",
                  category: "workflow",
                  title: "Switch Sidebar to Horse",
                  message: "Active sidebar class is 'car', expected 'Horse' (rectangle).",
                  figureIds: [],
                  imageTagNames: [],
                  missedObjectIds: [],
                  outsideViewport: false,
                  focusRect: null,
                  confidence: 0.95,
                  suggestedFixes: [
                    {
                      actionId: "fix_sel_horse",
                      label: "Switch Sidebar to Horse",
                      actionType: "select_sidebar_class",
                      classTitle: "Horse",
                    },
                  ],
                  fingerprint: "fp_e2e_switch_horse",
                },
              ],
              missedObjects: [],
              sceneSimulation: {
                totalTargetObjects: 2,
                completedTargetObjects: 0,
                primaryTargetClasses: ["Horse"],
                classSummaries: [
                  {
                    classTitle: "Horse",
                    recommendedShape: "rectangle",
                    totalCount: 2,
                    completedCount: 0,
                    remainingCount: 2,
                    foregroundClearCount: 1,
                    occludedCount: 1,
                    borderTruncatedCount: 0,
                    tagCounts: { Occlusion: 1 },
                  },
                ],
                candidates: [
                  {
                    simId: "sim_01",
                    simIndex: 1,
                    classTitle: "Horse",
                    recommendedShape: "rectangle",
                    bbox: [80, 120, 420, 720],
                    confidence: 0.94,
                    sharpnessScore: 42.0,
                    visibilityStatus: "foreground_clear",
                    occludedBySimIndices: [],
                    overlapIouMax: 0.2,
                    overlapCoverRatio: 0.08,
                    recommendedObjectTags: [],
                    outsideViewport: false,
                    matchedFigureId: null,
                  },
                  {
                    simId: "sim_02",
                    simIndex: 2,
                    classTitle: "Horse",
                    recommendedShape: "rectangle",
                    bbox: [280, 150, 620, 680],
                    confidence: 0.89,
                    sharpnessScore: 39.5,
                    visibilityStatus: "occluded",
                    occludedBySimIndices: [1],
                    overlapIouMax: 0.2,
                    overlapCoverRatio: 0.34,
                    recommendedObjectTags: [
                      {
                        tagName: "Occlusion",
                        value: null,
                        reason: "Occluded behind foreground Horse (#1)",
                        confidence: 0.9,
                      },
                    ],
                    outsideViewport: false,
                    matchedFigureId: null,
                  },
                ],
                recommendedImageTags: [],
                misplacedImageTags: ["Occlusion"],
                ignoredOntologyClasses: ["Animal", "car"],
                disambiguationNotes: [
                  "Ontology has both 'Horse' and 'Animal' — using specific class 'Horse'.",
                ],
                activeSidebarClassWarning:
                  "Active sidebar class is 'car', expected 'Horse' (rectangle).",
              },
              timingMs: { rules: 2, vision: 20, total: 24 },
              engineCapabilities: { device: "cpu", modelsUsed: ["yolo11s.pt"] },
              error: null,
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", () => resolve()));
    const stubAddr = stubServer.address() as net.AddressInfo;
    const stubUrl = `http://127.0.0.1:${stubAddr.port}`;

    const ext = await launchExtensionContext();
    try {
      await configureExtensionOptions(ext.context, ext.extensionId, stubUrl, bridgeToken, true);
      const page = await ext.context.newPage();
      await page.setViewportSize({ width: 1360, height: 900 });
      await page.goto(`${mockServer.baseUrl}/app/images2/100`);

      await expect(page.getByTestId("qc-topbar")).toBeVisible();
      await page.keyboard.press("Alt+KeyQ");

      await expect(page.getByTestId("qc-drawer")).toBeVisible({ timeout: 10_000 });
      expect(capturedActiveClass).toBe("car");
      await expect(page.getByTestId("qc-tab-blueprint")).toContainText("Blueprint (0/2)");
      await expect(page.getByTestId("qc-blueprint-panel")).toBeVisible();

      // Clean-by-default after Run QC: no whole-image sim guides and Auto-Draw hidden by default
      await expect(page.getByTestId("qc-sim-guide-1")).toHaveCount(0);
      await expect(page.getByTestId("qc-sim-guide-2")).toHaveCount(0);
      await expect(page.getByTestId("qc-bp-autodraw-1")).toHaveCount(0);

      // Simulate All button toggles whole-image simulation guides ON & OFF (and Option+B syncs)
      await page.getByTestId("qc-bp-simulate-all").click();
      await expect(page.getByTestId("qc-sim-guide-1")).toBeVisible();
      await expect(page.getByTestId("qc-sim-guide-2")).toBeVisible();
      await expect(page.locator('[data-testid="qc-sim-guide-1"] rect').first()).toHaveAttribute(
        "stroke",
        "#38bdf8",
      );
      await expect(page.locator('[data-testid="qc-sim-guide-2"] rect').first()).toHaveAttribute(
        "stroke",
        "#f59e0b",
      );
      await expect(page.getByTestId("qc-bp-simulate-all")).toContainText("Hide All Sim");

      await page.getByTestId("qc-bp-simulate-all").click();
      await expect(page.getByTestId("qc-sim-guide-1")).toHaveCount(0);
      await expect(page.getByTestId("qc-bp-simulate-all")).toContainText("Simulate All");

      await page.locator('[data-qc-role="zoom"]').click();
      await page.keyboard.press("Alt+KeyB");
      await expect(page.getByTestId("qc-sim-guide-1")).toBeVisible();
      await page.keyboard.press("Alt+KeyB");
      await expect(page.getByTestId("qc-sim-guide-1")).toHaveCount(0);

      // Individual row Sim toggles just that single candidate ON & OFF
      await page.getByTestId("qc-bp-sim-1").click();
      await expect(page.getByTestId("qc-sim-guide-1")).toBeVisible();
      await expect(page.getByTestId("qc-sim-guide-2")).toHaveCount(0);
      await page.getByTestId("qc-bp-sim-1").click();
      await expect(page.getByTestId("qc-sim-guide-1")).toHaveCount(0);

      // Individual row Locate toggles Visual Target Mark ON & OFF
      await page.getByTestId("qc-bp-locate-2").click();
      await expect(page.getByTestId("qc-locate-highlight")).toBeVisible();
      await expect(page.getByTestId("qc-locate-highlight")).toContainText("🎯 #2 Horse");
      await page.getByTestId("qc-bp-locate-2").click();
      await expect(page.getByTestId("qc-locate-highlight")).toHaveCount(0);

      // Switch Sidebar to Horse selects Horse row in Definitions -> CLASSES
      await page.getByTestId("qc-bp-switch-class-btn").click();
      await expect(
        page.locator('[data-qc-role="classes"] [data-class-title="Horse"]'),
      ).toHaveAttribute("data-active", "true");
      await expect(
        page.locator('[data-qc-role="classes"] [data-class-title="car"]'),
      ).toHaveAttribute("data-active", "false");
    } finally {
      await ext.cleanup();
      await new Promise<void>((resolve) => stubServer.close(() => resolve()));
    }
  });
});
