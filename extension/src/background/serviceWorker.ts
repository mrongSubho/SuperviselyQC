import { loadSettings } from "../shared/storage";
import type {
  ExtensionSettings,
  QCResponse,
  SwJobPushMessage,
  SwRequestMessage,
  SwUploadPortMessage,
} from "../shared/types";
import {
  base64ToUint8Array,
  concatUploadChunks,
  fetchSameOriginAndUpload,
  headBackendImageCache,
  putBytesToBackendCache,
  type PendingChunkUpload,
} from "./imageCacheRelay";

const SESSION_JOBS_KEY = "sly_qc_pending_jobs_v1";
const JOB_ALARM_NAME = "sly_qc_job_poll";

interface PendingJobRecord {
  jobId: string;
  tabId: number;
  imageId: string;
  snapshotSeq: number;
  createdAt: number;
}

let activeWs: WebSocket | null = null;
const wsClientId = `ext_${Math.random().toString(36).slice(2, 10)}`;

function buildHeaders(settings: ExtensionSettings, json = true): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (settings.bridgeToken) h["X-QC-Bridge-Token"] = settings.bridgeToken;
  return h;
}

async function getPendingJobs(): Promise<Record<string, PendingJobRecord>> {
  if (!chrome.storage?.session) return {};
  const data = await chrome.storage.session.get(SESSION_JOBS_KEY);
  return (data?.[SESSION_JOBS_KEY] as Record<string, PendingJobRecord> | undefined) ?? {};
}

async function savePendingJobs(jobs: Record<string, PendingJobRecord>): Promise<void> {
  if (!chrome.storage?.session) return;
  await chrome.storage.session.set({ [SESSION_JOBS_KEY]: jobs });
  if (Object.keys(jobs).length === 0) {
    await chrome.alarms?.clear(JOB_ALARM_NAME);
  } else {
    chrome.alarms?.create(JOB_ALARM_NAME, { periodInMinutes: 0.5 });
  }
}

async function trackPendingJob(record: PendingJobRecord): Promise<void> {
  const jobs = await getPendingJobs();
  jobs[record.jobId] = record;
  await savePendingJobs(jobs);
  void ensureWebSocketConnected();
}

async function untrackPendingJob(jobId: string): Promise<PendingJobRecord | undefined> {
  const jobs = await getPendingJobs();
  const removed = jobs[jobId];
  if (removed) {
    delete jobs[jobId];
    await savePendingJobs(jobs);
  }
  return removed;
}

async function pushToTab(tabId: number, msg: SwJobPushMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Tab may have closed or navigated
  }
}

async function ensureWebSocketConnected(): Promise<void> {
  if (activeWs && (activeWs.readyState === WebSocket.OPEN || activeWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const settings = await loadSettings();
  if (!settings.bridgeToken) return;
  const wsBase = settings.backendUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
  const url = `${wsBase}/api/v1/qc/ws/${encodeURIComponent(wsClientId)}?token=${encodeURIComponent(settings.bridgeToken)}`;

  try {
    const ws = new WebSocket(url);
    activeWs = ws;
    ws.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(String(evt.data)) as SwJobPushMessage["event"];
        void handleWsEvent(parsed);
      } catch {
        // Ignore non-JSON frame
      }
    };
    ws.onclose = () => {
      if (activeWs === ws) activeWs = null;
    };
    ws.onerror = () => {
      if (activeWs === ws) activeWs = null;
    };
  } catch {
    activeWs = null;
  }
}

async function handleWsEvent(event: SwJobPushMessage["event"]): Promise<void> {
  if (!event.jobId) return;
  const jobs = await getPendingJobs();
  const rec = jobs[event.jobId];
  if (!rec) return;

  await pushToTab(rec.tabId, { type: "QC_JOB_EVENT", event });
  if (event.eventType === "job_completed" || event.eventType === "job_failed") {
    await untrackPendingJob(event.jobId);
  }
}

async function pollPendingJobs(): Promise<void> {
  const jobs = await getPendingJobs();
  const entries = Object.values(jobs);
  if (entries.length === 0) return;

  const settings = await loadSettings();
  const baseUrl = settings.backendUrl.replace(/\/+$/, "");

  for (const job of entries) {
    try {
      const resp = await fetch(`${baseUrl}/api/v1/qc/jobs/${encodeURIComponent(job.jobId)}`, {
        headers: buildHeaders(settings, false),
      });
      if (!resp.ok) {
        if (resp.status === 404) {
          await untrackPendingJob(job.jobId);
        }
        continue;
      }
      const data = (await resp.json()) as QCResponse;
      if (data.status === "completed") {
        await pushToTab(job.tabId, {
          type: "QC_JOB_EVENT",
          event: { eventType: "job_completed", jobId: job.jobId, result: data },
        });
        await untrackPendingJob(job.jobId);
      } else if (data.status === "failed") {
        await pushToTab(job.tabId, {
          type: "QC_JOB_EVENT",
          event: {
            eventType: "job_failed",
            jobId: job.jobId,
            error: data.error?.message ?? "Deep QC job failed",
            result: data,
          },
        });
        await untrackPendingJob(job.jobId);
      }
    } catch {
      // Backend might have restarted or offline; leave tracked for brief retry window
      if (Date.now() - job.createdAt > 120_000) {
        await untrackPendingJob(job.jobId);
      }
    }
  }
}

async function handleMessage(
  msg: SwRequestMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const settings = await loadSettings();
  const baseUrl = settings.backendUrl.replace(/\/+$/, "");

  if (msg.type === "QC_GET_HEALTH") {
    try {
      const resp = await fetch(`${baseUrl}/api/v1/health`);
      if (!resp.ok) {
        return { online: false, status: resp.status };
      }
      const data = await resp.json();
      return { online: true, data };
    } catch {
      return { online: false };
    }
  }

  if (msg.type === "QC_LIST_PROFILES") {
    const qs = new URLSearchParams();
    if (msg.projectId !== undefined) qs.set("projectId", String(msg.projectId));
    if (msg.datasetId !== undefined) qs.set("datasetId", String(msg.datasetId));
    if (msg.jobTitle) qs.set("jobTitle", msg.jobTitle);
    const queryStr = qs.toString() ? `?${qs.toString()}` : "";
    try {
      const resp = await fetch(`${baseUrl}/api/v1/profiles${queryStr}`, {
        headers: buildHeaders(settings, false),
      });
      if (!resp.ok) return { ok: false, status: resp.status };
      return { ok: true, data: await resp.json() };
    } catch (err) {
      return { ok: false, offline: true, error: String(err) };
    }
  }

  if (msg.type === "QC_UPSERT_PROFILE") {
    try {
      const resp = await fetch(
        `${baseUrl}/api/v1/profiles/${encodeURIComponent(msg.profile.profileId)}`,
        {
          method: "PUT",
          headers: buildHeaders(settings, true),
          body: JSON.stringify(msg.profile),
        },
      );
      if (!resp.ok) return { ok: false, status: resp.status, error: await resp.text() };
      return { ok: true, data: await resp.json() };
    } catch (err) {
      return { ok: false, offline: true, error: String(err) };
    }
  }

  if (msg.type === "QC_DELETE_PROFILE") {
    try {
      const resp = await fetch(
        `${baseUrl}/api/v1/profiles/${encodeURIComponent(msg.profileId)}`,
        {
          method: "DELETE",
          headers: buildHeaders(settings, false),
        },
      );
      return { ok: resp.ok, status: resp.status };
    } catch (err) {
      return { ok: false, offline: true, error: String(err) };
    }
  }

  if (msg.type === "QC_IMAGE_HEAD") {
    return await headBackendImageCache(
      settings,
      msg.imageId,
      msg.imageHash,
      msg.width,
      msg.height,
    );
  }

  if (msg.type === "QC_FETCH_AND_CACHE_SAME_ORIGIN_IMAGE") {
    return await fetchSameOriginAndUpload(
      settings,
      msg.imageId,
      msg.imageHash,
      msg.imageUrl,
      msg.width,
      msg.height,
    );
  }

  if (msg.type === "QC_POLL_JOB") {
    try {
      const resp = await fetch(`${baseUrl}/api/v1/qc/jobs/${encodeURIComponent(msg.jobId)}`, {
        headers: buildHeaders(settings, false),
      });
      if (!resp.ok) return { ok: false, status: resp.status };
      return { ok: true, data: await resp.json() };
    } catch (err) {
      return { ok: false, offline: true, error: String(err) };
    }
  }

  if (msg.type === "QC_ANALYZE") {
    try {
      const resp = await fetch(`${baseUrl}/api/v1/qc/analyze`, {
        method: "POST",
        headers: buildHeaders(settings, true),
        body: JSON.stringify(msg.request),
      });
      if (resp.status === 401 || resp.status === 403) {
        return {
          ok: false,
          authError: true,
          status: resp.status,
          error: "Bridge token missing or unauthorized — check Extension Options.",
        };
      }
      if (resp.status === 424) {
        let message = "Backend image cache miss (424): original image was not cached before vision QC.";
        try {
          const errJson = (await resp.json()) as {
            error?: { message?: string };
            detail?: { message?: string };
          };
          message = errJson?.error?.message ?? errJson?.detail?.message ?? message;
        } catch {
          // ignore parse failure
        }
        return { ok: false, imageCacheMiss: true, status: 424, error: message };
      }
      if (!resp.ok) {
        const rawText = await resp.text();
        let message = rawText;
        try {
          const errJson = JSON.parse(rawText) as {
            error?: { message?: string };
            detail?: { message?: string };
          };
          message = errJson?.error?.message ?? errJson?.detail?.message ?? rawText;
        } catch {
          // keep text
        }
        return { ok: false, status: resp.status, error: message };
      }
      const data = (await resp.json()) as QCResponse;
      if ((resp.status === 202 || data.status === "queued") && data.jobId && sender.tab?.id) {
        await trackPendingJob({
          jobId: data.jobId,
          tabId: sender.tab.id,
          imageId: msg.request.image.imageId,
          snapshotSeq: msg.request.snapshotSeq,
          createdAt: Date.now(),
        });
      }
      return { ok: true, data };
    } catch {
      return { ok: false, offline: true, error: "BACKEND_OFFLINE" };
    }
  }

  if (msg.type === "QC_OPEN_OPTIONS_PAGE") {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }

  if (msg.type === "QC_TAB_COMMAND") {
    const count = await dispatchTabCommand(msg.command);
    return { ok: count > 0, count };
  }

  return { ok: false, error: "Unknown message type" };
}

async function dispatchTabCommand(
  command: "QC_TRIGGER_RUN_FROM_ACTION" | "QC_TOGGLE_PANEL_FROM_ACTION",
): Promise<number> {
  if (!chrome.tabs?.query || !chrome.tabs?.sendMessage) return 0;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  let delivered = 0;
  for (const tab of tabs) {
    if (tab.id == null) continue;
    if (tab.url?.startsWith("chrome-extension://") || tab.url?.startsWith("chrome://")) {
      continue;
    }
    const ok = await chrome.tabs
      .sendMessage(tab.id, { type: command })
      .then((res) => Boolean((res as { ok?: boolean } | undefined)?.ok ?? true))
      .catch(() => false);
    if (ok) delivered += 1;
  }
  return delivered;
}

chrome.runtime.onMessage.addListener((msg: SwRequestMessage, sender, sendResponse) => {
  void handleMessage(msg, sender).then(sendResponse);
  return true;
});

chrome.action?.onClicked?.addListener((tab) => {
  void (async () => {
    if (tab.id != null) {
      const delivered = await chrome.tabs
        .sendMessage(tab.id, { type: "QC_SHOW_TOPBAR_FROM_ACTION" })
        .then((res) => Boolean((res as { ok?: boolean } | undefined)?.ok ?? true))
        .catch(() => false);
      if (delivered) {
        return;
      }
    }
    await chrome.runtime.openOptionsPage();
  })();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sly-qc-upload") return;
  let session: PendingChunkUpload | null = null;

  port.onMessage.addListener((msg: SwUploadPortMessage) => {
    if (msg.type === "UPLOAD_INIT") {
      session = {
        imageId: msg.imageId,
        imageHash: msg.imageHash,
        width: msg.width,
        height: msg.height,
        contentType: msg.contentType,
        totalBytes: msg.totalBytes,
        chunks: new Map(),
        receivedBytes: 0,
      };
      return;
    }

    if (msg.type === "UPLOAD_CHUNK" && session) {
      try {
        const chunkBytes = base64ToUint8Array(msg.dataB64);
        session.chunks.set(msg.chunkIndex, chunkBytes);
        session.receivedBytes += chunkBytes.byteLength;
      } catch (err) {
        port.postMessage({ ok: false, error: `Invalid chunk base64: ${String(err)}` });
      }
      return;
    }

    if (msg.type === "UPLOAD_COMMIT") {
      if (!session) {
        port.postMessage({ ok: false, error: "UPLOAD_COMMIT without UPLOAD_INIT" });
        return;
      }
      const current = session;
      session = null;
      const merged = concatUploadChunks(current);
      void loadSettings()
        .then((settings) =>
          putBytesToBackendCache(
            settings,
            {
              imageId: current.imageId,
              imageHash: current.imageHash,
              width: current.width,
              height: current.height,
              contentType: current.contentType,
            },
            merged,
          ),
        )
        .then((res) => port.postMessage(res))
        .catch((err) => port.postMessage({ ok: false, error: String(err) }));
    }
  });
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === JOB_ALARM_NAME) {
    void pollPendingJobs();
  }
});

// Resume polling any pending jobs if Service Worker restarted mid-analysis
void pollPendingJobs();
