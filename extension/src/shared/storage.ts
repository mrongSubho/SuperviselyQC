import {
  DEFAULT_EXTENSION_SETTINGS,
  type ExtensionSettings,
  type QCResponse,
  type SummaryCounts,
} from "./types";

const SETTINGS_KEY = "sly_qc_settings_v1";
const DISMISSALS_PREFIX = "sly_qc_dismissals_";
const MAX_DISMISSAL_IMAGES = 100;
const DISMISSAL_INDEX_KEY = "sly_qc_dismissal_lru_v1";

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

export async function loadSettings(): Promise<ExtensionSettings> {
  if (!hasChromeStorage()) {
    return { ...DEFAULT_EXTENSION_SETTINGS };
  }
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (stored?.[SETTINGS_KEY] ?? {}) as Partial<ExtensionSettings>;
  return {
    ...DEFAULT_EXTENSION_SETTINGS,
    ...raw,
    customProfiles: Array.isArray(raw.customProfiles) ? raw.customProfiles : [],
  };
}

export async function saveSettings(
  partial: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const next: ExtensionSettings = {
    ...current,
    ...partial,
  };
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  }
  return next;
}

export function subscribeSettingsChanges(
  cb: (next: ExtensionSettings) => void,
): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) {
    return () => undefined;
  }
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== "local" || !changes[SETTINGS_KEY]) {
      return;
    }
    const raw = (changes[SETTINGS_KEY].newValue ?? {}) as Partial<ExtensionSettings>;
    cb({
      ...DEFAULT_EXTENSION_SETTINGS,
      ...raw,
      customProfiles: Array.isArray(raw.customProfiles) ? raw.customProfiles : [],
    });
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export async function loadDismissedFingerprints(imageId: string): Promise<string[]> {
  if (!hasChromeStorage() || !imageId) {
    return [];
  }
  const key = `${DISMISSALS_PREFIX}${imageId}`;
  const res = await chrome.storage.local.get(key);
  const arr = res?.[key];
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
}

export async function saveDismissedFingerprints(
  imageId: string,
  fingerprints: string[],
): Promise<void> {
  if (!hasChromeStorage() || !imageId) {
    return;
  }
  const unique = Array.from(new Set(fingerprints));
  const key = `${DISMISSALS_PREFIX}${imageId}`;
  const idxRes = await chrome.storage.local.get(DISMISSAL_INDEX_KEY);
  const lru = Array.isArray(idxRes?.[DISMISSAL_INDEX_KEY])
    ? (idxRes[DISMISSAL_INDEX_KEY] as string[]).filter((k) => k !== key)
    : [];
  lru.push(key);

  const toRemove: string[] = [];
  while (lru.length > MAX_DISMISSAL_IMAGES) {
    const oldKey = lru.shift();
    if (oldKey) {
      toRemove.push(oldKey);
    }
  }
  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove);
  }
  await chrome.storage.local.set({
    [key]: unique,
    [DISMISSAL_INDEX_KEY]: lru,
  });
}

export interface EffectiveSummaryResult {
  overallScore: number;
  readiness: "ready" | "needs_review" | "blocked";
  summaryCounts: SummaryCounts;
  activeFindings: QCResponse["findings"];
  activeMissedObjects: QCResponse["missedObjects"];
}

export function computeEffectiveSummary(
  response: QCResponse,
  dismissedFingerprints: Set<string>,
): EffectiveSummaryResult {
  const activeFindings = response.findings.filter(
    (f) => !dismissedFingerprints.has(f.fingerprint),
  );
  const dismissedMissedIds = new Set<string>();
  for (const f of response.findings) {
    if (dismissedFingerprints.has(f.fingerprint)) {
      for (const mid of f.missedObjectIds) {
        dismissedMissedIds.add(mid);
      }
    }
  }
  const activeMissedObjects = response.missedObjects.filter(
    (m) => !dismissedMissedIds.has(m.missedId),
  );

  let blocker = 0;
  let warning = 0;
  let info = 0;
  for (const f of activeFindings) {
    if (f.severity === "blocker") blocker += 1;
    else if (f.severity === "warning") warning += 1;
    else info += 1;
  }

  const rawScore = 100 - 25 * blocker - Math.min(45, 8 * warning) - Math.min(10, 2 * info);
  const overallScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  let readiness: "ready" | "needs_review" | "blocked" = "ready";
  if (blocker > 0) {
    readiness = "blocked";
  } else if (warning > 0 || activeMissedObjects.length > 0) {
    readiness = "needs_review";
  }

  return {
    overallScore,
    readiness,
    summaryCounts: { blocker, warning, info },
    activeFindings,
    activeMissedObjects,
  };
}
