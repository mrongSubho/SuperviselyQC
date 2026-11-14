import { probeRasterDimensions } from "../shared/imageProbe";
import {
  isNonWorkspaceImageUrl,
  isPermittedServiceWorkerFetchUrl,
} from "../shared/imageUrlFilter";
import type { ImageContext, SwRequestMessage, SwUploadPortMessage } from "../shared/types";

export const UPLOAD_CHUNK_BYTES = 1024 * 1024; // 1 MiB binary chunk per message (~1.33 MiB base64)

export interface FetchAndCacheDependencies {
  pageOrigin: string;
  sendMessage: <T = unknown>(msg: SwRequestMessage) => Promise<T>;
  openUploadPort: () => {
    postMessage: (msg: SwUploadPortMessage) => void;
    onAck: () => Promise<{ ok: boolean; error?: string }>;
    disconnect: () => void;
  };
  fetchFn?: typeof fetch;
  fallbackCaptureFn?: () => Promise<{
    buffer: ArrayBuffer;
    contentType: string;
    width: number;
    height: number;
    source?: "dom_img" | "canvas";
  } | null>;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const SLICE = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += SLICE) {
    const sub = bytes.subarray(i, Math.min(i + SLICE, bytes.byteLength));
    parts.push(String.fromCharCode(...sub));
  }
  return btoa(parts.join(""));
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < bytes.byteLength; i += 1) {
      hex += bytes[i]!.toString(16).padStart(2, "0");
    }
    return `sha256:${hex}`;
  }
  // Fallback deterministic fast FNV/length fingerprint if crypto.subtle unavailable in non-HTTPS test
  const bytes = new Uint8Array(buffer);
  let h1 = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.byteLength / 4096));
  for (let i = 0; i < bytes.byteLength; i += step) {
    h1 ^= bytes[i]!;
    h1 = Math.imul(h1, 0x01000193);
  }
  return `fnv:${bytes.byteLength}:${(h1 >>> 0).toString(16)}`;
}

export function isExternalCdnUrl(imageUrl: string, pageOrigin: string): boolean {
  try {
    const parsed = new URL(imageUrl, pageOrigin);
    return parsed.origin !== pageOrigin;
  } catch {
    return false;
  }
}

export async function streamBytesOverUploadPort(
  deps: FetchAndCacheDependencies,
  meta: {
    imageId: string;
    imageHash: string;
    width: number;
    height: number;
    contentType: string;
  },
  buffer: ArrayBuffer,
): Promise<{ ok: boolean; error?: string }> {
  const bytes = new Uint8Array(buffer);
  const port = deps.openUploadPort();
  try {
    port.postMessage({
      type: "UPLOAD_INIT",
      imageId: meta.imageId,
      imageHash: meta.imageHash,
      width: meta.width,
      height: meta.height,
      contentType: meta.contentType || "image/jpeg",
      totalBytes: bytes.byteLength,
    });

    let chunkIndex = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
      const slice = bytes.subarray(
        offset,
        Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.byteLength),
      );
      port.postMessage({
        type: "UPLOAD_CHUNK",
        chunkIndex,
        dataB64: uint8ArrayToBase64(slice),
      });
      chunkIndex += 1;
    }

    port.postMessage({ type: "UPLOAD_COMMIT" });
    return await port.onAck();
  } finally {
    port.disconnect();
  }
}

export async function ensureImageCachedForVision(
  image: ImageContext,
  originalImageUrl: string | null,
  deps: FetchAndCacheDependencies,
): Promise<{
  cached: boolean;
  offline?: boolean;
  imageHash: string;
  width?: number;
  height?: number;
  fromCanvasCapture?: boolean;
  error?: string;
}> {
  const candidateHash = image.imageHash || `sly:${image.imageId}`;

  // 1. Fast HEAD check using metadata hash
  try {
    const headRes = (await deps.sendMessage({
      type: "QC_IMAGE_HEAD",
      imageId: image.imageId,
      imageHash: candidateHash,
      width: image.width,
      height: image.height,
    })) as { hit?: boolean; offline?: boolean; error?: string };
    if (headRes?.hit) {
      return { cached: true, imageHash: candidateHash };
    }
    if (headRes?.offline) {
      return {
        cached: false,
        offline: true,
        imageHash: candidateHash,
        error: headRes.error ?? "Backend daemon unreachable.",
      };
    }
  } catch {
    // Proceed to fetch attempt if HEAD transport failed
  }

  let urlError: string | undefined;

  if (originalImageUrl && !isNonWorkspaceImageUrl(originalImageUrl)) {
    let resolvedUrl = originalImageUrl;
    try {
      resolvedUrl = new URL(originalImageUrl, deps.pageOrigin).toString();
    } catch {
      resolvedUrl = originalImageUrl;
    }

    // 2. External CDN (S3/GCS/CloudFront) or same-origin blob: URL -> fetch in Content Script + 1 MiB chunk stream
    const fetchImpl = deps.fetchFn ?? fetch;
    const isBlobUrl = resolvedUrl.startsWith("blob:");
    if ((isBlobUrl || isExternalCdnUrl(resolvedUrl, deps.pageOrigin)) && !isNonWorkspaceImageUrl(resolvedUrl)) {
      try {
        const resp = await fetchImpl(
          resolvedUrl,
          isBlobUrl ? undefined : { credentials: "omit" },
        );
        if (resp.ok) {
          const buffer = await resp.arrayBuffer();
          const contentType = resp.headers.get("content-type") ?? "image/jpeg";
          const probe = await probeRasterDimensions(buffer, contentType);
          if (!probe.valid) {
            urlError = `External CDN payload is not a valid raster image (${contentType}).`;
          } else {
            const actualWidth = probe.width > 0 ? probe.width : image.width;
            const actualHeight = probe.height > 0 ? probe.height : image.height;
            const finalHash = image.imageHash || (await sha256Hex(buffer));
            if (finalHash !== candidateHash || actualWidth !== image.width || actualHeight !== image.height) {
              const headRes2 = (await deps.sendMessage({
                type: "QC_IMAGE_HEAD",
                imageId: image.imageId,
                imageHash: finalHash,
                width: actualWidth,
                height: actualHeight,
              })) as { hit?: boolean };
              if (headRes2?.hit) {
                return { cached: true, imageHash: finalHash, width: actualWidth, height: actualHeight };
              }
            }
            const uploadRes = await streamBytesOverUploadPort(
              deps,
              {
                imageId: image.imageId,
                imageHash: finalHash,
                width: actualWidth,
                height: actualHeight,
                contentType,
              },
              buffer,
            );
            if (uploadRes.ok) {
              return { cached: true, imageHash: finalHash, width: actualWidth, height: actualHeight };
            }
            urlError = uploadRes.error ?? "Chunked image upload rejected.";
          }
        } else {
          urlError = `External CDN HTTP ${resp.status}`;
        }
      } catch (err) {
        urlError = String(err);
      }
    }

    // 3. Same-origin / permitted Supervisely host path -> SW fetches and uploads directly to localhost PUT
    if (isPermittedServiceWorkerFetchUrl(resolvedUrl, deps.pageOrigin)) {
      try {
        const swFetch = (await deps.sendMessage({
          type: "QC_FETCH_AND_CACHE_SAME_ORIGIN_IMAGE",
          imageId: image.imageId,
          imageHash: candidateHash,
          imageUrl: resolvedUrl,
          width: image.width,
          height: image.height,
        })) as {
          ok?: boolean;
          offline?: boolean;
          imageHash?: string;
          width?: number;
          height?: number;
          error?: string;
        };
        if (swFetch?.ok) {
          return {
            cached: true,
            imageHash: swFetch.imageHash ?? candidateHash,
            width: swFetch.width && swFetch.width > 0 ? swFetch.width : image.width,
            height: swFetch.height && swFetch.height > 0 ? swFetch.height : image.height,
          };
        }
        if (swFetch?.offline) {
          return {
            cached: false,
            offline: true,
            imageHash: candidateHash,
            error: swFetch.error ?? "Backend daemon unreachable.",
          };
        }
        urlError = swFetch?.error ?? urlError ?? "SW image fetch failed.";
      } catch (err) {
        urlError = String(err);
      }
    }
  } else {
    urlError = "Original image URL unavailable from page bridge or DOM.";
  }

  // 4. DOM <img> / <canvas> raster capture fallback when URL unavailable or blocked by CORS
  if (deps.fallbackCaptureFn) {
    try {
      const captured = await deps.fallbackCaptureFn();
      if (captured && captured.buffer.byteLength > 0) {
        const finalHash = image.imageHash || (await sha256Hex(captured.buffer));
        const actualWidth = captured.width || image.width;
        const actualHeight = captured.height || image.height;
        const uploadRes = await streamBytesOverUploadPort(
          deps,
          {
            imageId: image.imageId,
            imageHash: finalHash,
            width: actualWidth,
            height: actualHeight,
            contentType: captured.contentType,
          },
          captured.buffer,
        );
        if (uploadRes.ok) {
          return {
            cached: true,
            imageHash: finalHash,
            width: actualWidth,
            height: actualHeight,
            fromCanvasCapture: captured.source === "canvas",
          };
        }
        return {
          cached: false,
          imageHash: finalHash,
          error: uploadRes.error ?? urlError ?? "Canvas fallback upload rejected.",
        };
      }
    } catch (err) {
      urlError = urlError ?? String(err);
    }
  }

  return {
    cached: false,
    imageHash: candidateHash,
    error: urlError ?? "Unable to cache image for vision QC.",
  };
}
