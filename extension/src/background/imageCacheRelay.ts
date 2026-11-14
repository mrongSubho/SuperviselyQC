import { probeRasterDimensions } from "../shared/imageProbe";
import type { ExtensionSettings } from "../shared/types";

const MAX_UPLOAD_BYTES = 104_857_600; // 100 MiB

export function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", ab);
    const view = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < view.byteLength; i += 1) {
      hex += view[i]!.toString(16).padStart(2, "0");
    }
    return `sha256:${hex}`;
  }
  return `len:${bytes.byteLength}`;
}

export interface PendingChunkUpload {
  imageId: string;
  imageHash: string;
  width: number;
  height: number;
  contentType: string;
  totalBytes: number;
  chunks: Map<number, Uint8Array>;
  receivedBytes: number;
}

export function concatUploadChunks(session: PendingChunkUpload): Uint8Array {
  const orderedIndices = Array.from(session.chunks.keys()).sort((a, b) => a - b);
  let total = 0;
  for (const idx of orderedIndices) {
    total += session.chunks.get(idx)!.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const idx of orderedIndices) {
    const chunk = session.chunks.get(idx)!;
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function headBackendImageCache(
  settings: ExtensionSettings,
  imageId: string,
  imageHash: string,
  width?: number,
  height?: number,
): Promise<{ hit: boolean; offline?: boolean; error?: string }> {
  const baseUrl = settings.backendUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ hash: imageHash });
  if (width && width > 0) params.set("width", String(width));
  if (height && height > 0) params.set("height", String(height));

  try {
    const resp = await fetch(
      `${baseUrl}/api/v1/qc/images/${encodeURIComponent(imageId)}?${params.toString()}`,
      {
        method: "HEAD",
        headers: settings.bridgeToken
          ? { "X-QC-Bridge-Token": settings.bridgeToken }
          : undefined,
      },
    );
    return { hit: resp.status === 200 };
  } catch (err) {
    return { hit: false, offline: true, error: String(err) };
  }
}

export async function putBytesToBackendCache(
  settings: ExtensionSettings,
  meta: {
    imageId: string;
    imageHash: string;
    width: number;
    height: number;
    contentType: string;
  },
  bytes: Uint8Array,
): Promise<{ ok: boolean; offline?: boolean; error?: string }> {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `Upload size ${bytes.byteLength} outside (0, ${MAX_UPLOAD_BYTES}] byte limit.`,
    };
  }
  const baseUrl = settings.backendUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "X-Image-Hash": meta.imageHash,
    "Content-Type": meta.contentType || "image/jpeg",
  };
  if (meta.width > 0) headers["X-Image-Width"] = String(meta.width);
  if (meta.height > 0) headers["X-Image-Height"] = String(meta.height);
  if (settings.bridgeToken) headers["X-QC-Bridge-Token"] = settings.bridgeToken;

  try {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const resp = await fetch(
      `${baseUrl}/api/v1/qc/images/${encodeURIComponent(meta.imageId)}`,
      {
        method: "PUT",
        headers,
        body: ab,
      },
    );
    if (resp.ok) {
      return { ok: true };
    }
    const text = await resp.text().catch(() => resp.statusText);
    return { ok: false, error: `PUT /images failed (${resp.status}): ${text}` };
  } catch (err) {
    return { ok: false, offline: true, error: String(err) };
  }
}

export async function fetchSameOriginAndUpload(
  settings: ExtensionSettings,
  imageId: string,
  imageHash: string,
  imageUrl: string,
  width: number,
  height: number,
): Promise<{
  ok: boolean;
  offline?: boolean;
  imageHash: string;
  width?: number;
  height?: number;
  error?: string;
}> {
  try {
    let imgResp: Response;
    try {
      imgResp = await fetch(imageUrl, { credentials: "include" });
    } catch {
      // External CDNs returning Access-Control-Allow-Origin: * reject credentials: "include"
      imgResp = await fetch(imageUrl, { credentials: "omit" });
    }
    if (!imgResp.ok && imgResp.status === 403) {
      imgResp = await fetch(imageUrl, { credentials: "omit" }).catch(() => imgResp);
    }
    if (!imgResp.ok) {
      return {
        ok: false,
        imageHash,
        error: `Supervisely image fetch failed (${imgResp.status})`,
      };
    }
    const contentType = imgResp.headers.get("content-type") ?? "image/jpeg";
    const buf = await imgResp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const probe = await probeRasterDimensions(bytes, contentType);
    if (!probe.valid) {
      return {
        ok: false,
        imageHash,
        error: `Fetched payload is not a valid raster image (${contentType}).`,
      };
    }
    const actualWidth = probe.width > 0 ? probe.width : width;
    const actualHeight = probe.height > 0 ? probe.height : height;
    const resolvedHash = imageHash || (await sha256HexBytes(bytes));
    const head = await headBackendImageCache(
      settings,
      imageId,
      resolvedHash,
      actualWidth,
      actualHeight,
    );
    if (head.hit) {
      return { ok: true, imageHash: resolvedHash, width: actualWidth, height: actualHeight };
    }
    if (head.offline) {
      return { ok: false, offline: true, imageHash: resolvedHash, error: head.error };
    }
    const put = await putBytesToBackendCache(
      settings,
      {
        imageId,
        imageHash: resolvedHash,
        width: actualWidth,
        height: actualHeight,
        contentType,
      },
      bytes,
    );
    return {
      ok: put.ok,
      offline: put.offline,
      imageHash: resolvedHash,
      width: actualWidth,
      height: actualHeight,
      error: put.error,
    };
  } catch (err) {
    return { ok: false, imageHash, error: String(err) };
  }
}
