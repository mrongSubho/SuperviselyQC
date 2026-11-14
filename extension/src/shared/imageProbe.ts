export interface RasterProbeResult {
  valid: boolean;
  width: number;
  height: number;
}

/**
 * Inspect downloaded image bytes via createImageBitmap when available (Chrome Content Script / SW).
 * Rejects non-image payloads (e.g. HTML login redirects) and returns true raster dimensions so
 * PUT /api/v1/qc/images never triggers 400 width/height mismatches against fallback guesses.
 */
export async function probeRasterDimensions(
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<RasterProbeResult> {
  if (/text\/html|application\/json|application\/xml|text\/plain/i.test(contentType)) {
    return { valid: false, width: 0, height: 0 };
  }
  if (typeof createImageBitmap !== "function" || typeof Blob !== "function") {
    return { valid: true, width: 0, height: 0 };
  }
  try {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    const blob = new Blob([copy], { type: contentType || "image/jpeg" });
    const bmp = await createImageBitmap(blob);
    try {
      return {
        valid: bmp.width > 0 && bmp.height > 0,
        width: bmp.width,
        height: bmp.height,
      };
    } finally {
      bmp.close();
    }
  } catch {
    return { valid: false, width: 0, height: 0 };
  }
}
