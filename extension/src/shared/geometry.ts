import type {
  AnnotationFigure,
  BoundingBoxTuple,
  Point2D,
} from "./types";

export const MAX_BITMAP_B64_CHARS = 16 * 1024 * 1024;
export const MAX_BITMAP_PNG_BYTES = 32_000_000;

export interface DecodedBitmapTs {
  mask: Uint8Array | null;
  originX: number;
  originY: number;
  width: number;
  height: number;
  fgPixels: number;
  errorCode?: string;
  errorMessage?: string;
}

export function clamp(val: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, val));
}

export function shoelacePolygonArea(pts: Point2D[]): number {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) * 0.5;
}

export function pointInPolygon(pt: Point2D, ring: Point2D[]): boolean {
  let inside = false;
  const x = pt[0];
  const y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function bboxIouAndIos(
  a: BoundingBoxTuple,
  b: BoundingBoxTuple,
): { iou: number; iosAInB: number; iosBInA: number; interArea: number } {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter <= 0) {
    return { iou: 0, iosAInB: 0, iosBInA: 0, interArea: 0 };
  }
  const areaA = Math.max((a[2] - a[0]) * (a[3] - a[1]), 1e-6);
  const areaB = Math.max((b[2] - b[0]) * (b[3] - b[1]), 1e-6);
  const union = Math.max(areaA + areaB - inter, 1e-6);
  return {
    iou: inter / union,
    iosAInB: inter / areaA,
    iosBInA: inter / areaB,
    interArea: inter,
  };
}

export function computeFigureBbox(fig: AnnotationFigure): {
  bbox: BoundingBoxTuple;
  invertedBoxCoords: boolean;
  vertices: Point2D[];
} {
  if (fig.geometryType === "rectangle") {
    const ext = fig.points?.exterior ?? [];
    if (ext.length < 2) {
      return { bbox: [0, 0, 0, 0], invertedBoxCoords: false, vertices: [] };
    }
    const p1 = ext[0]!;
    const p2 = ext[1]!;
    const inverted = p1[0] > p2[0] || p1[1] > p2[1];
    const x1 = Math.min(p1[0], p2[0]);
    const y1 = Math.min(p1[1], p2[1]);
    const x2 = Math.max(p1[0], p2[0]);
    const y2 = Math.max(p1[1], p2[1]);
    return {
      bbox: [x1, y1, x2, y2],
      invertedBoxCoords: inverted,
      vertices: [
        [x1, y1],
        [x2, y2],
      ],
    };
  }

  if (fig.geometryType === "polygon" || fig.geometryType === "polyline" || fig.geometryType === "point") {
    const ext = fig.points?.exterior ?? [];
    const interior = fig.points?.interior ?? [];
    const all = [...ext, ...interior.flat()];
    if (all.length === 0) {
      return { bbox: [0, 0, 0, 0], invertedBoxCoords: false, vertices: [] };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ext) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return {
      bbox: [minX, minY, maxX, maxY],
      invertedBoxCoords: false,
      vertices: all,
    };
  }

  if (fig.geometryType === "bitmap") {
    const origin = fig.bitmap?.origin ?? [0, 0];
    return {
      bbox: [origin[0], origin[1], origin[0], origin[1]],
      invertedBoxCoords: false,
      vertices: [[origin[0], origin[1]]],
    };
  }

  const pts: Point2D[] = [];
  for (const val of Object.values(fig.nodes ?? {})) {
    if (!val.disabled) {
      pts.push(val.loc);
    }
  }
  if (pts.length === 0) {
    return { bbox: [0, 0, 0, 0], invertedBoxCoords: false, vertices: [] };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { bbox: [minX, minY, maxX, maxY], invertedBoxCoords: false, vertices: pts };
}

function readU32BE(buf: Uint8Array, off: number): number {
  return (
    ((buf[off]! << 24) |
      (buf[off + 1]! << 16) |
      (buf[off + 2]! << 8) |
      buf[off + 3]!) >>>
    0
  );
}

async function decompressDeflateWithCap(
  compressed: Uint8Array,
  maxOutputBytes: number,
  format: "deflate" | "deflate-raw",
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream unavailable");
  }
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const copy = new Uint8Array(new ArrayBuffer(compressed.byteLength));
  copy.set(compressed);
  void writer
    .write(copy)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel("BITMAP_BOMB_GUARD");
        throw new Error(`Decompressed stream exceeds ${maxOutputBytes} byte safety cap`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterPngScanlines(
  raw: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  const rowLen = 1 + stride;
  if (raw.byteLength < height * rowLen) {
    throw new Error("Truncated PNG scanline data");
  }
  for (let y = 0; y < height; y += 1) {
    const srcOff = y * rowLen;
    const dstOff = y * stride;
    const filter = raw[srcOff]!;
    for (let x = 0; x < stride; x += 1) {
      const xByte = raw[srcOff + 1 + x]!;
      const left = x >= bpp ? out[dstOff + x - bpp]! : 0;
      const up = y > 0 ? out[dstOff - stride + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? out[dstOff - stride + x - bpp]! : 0;
      let val = xByte;
      if (filter === 1) val = (xByte + left) & 0xff;
      else if (filter === 2) val = (xByte + up) & 0xff;
      else if (filter === 3) val = (xByte + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) val = (xByte + paethPredictor(left, up, upLeft)) & 0xff;
      out[dstOff + x] = val;
    }
  }
  return out;
}

export async function decodeSuperviselyBitmapPng(
  dataB64: string,
  origin: [number, number],
  imgW: number,
  imgH: number,
): Promise<DecodedBitmapTs> {
  const originX = Math.round(origin[0]);
  const originY = Math.round(origin[1]);

  if (dataB64.length > MAX_BITMAP_B64_CHARS) {
    return {
      mask: null,
      originX,
      originY,
      width: 0,
      height: 0,
      fgPixels: 0,
      errorCode: "BITMAP_PAYLOAD_TOO_LARGE",
      errorMessage: "Encoded bitmap string exceeds 16 MB safety cap.",
    };
  }

  let zlibBytes: Uint8Array;
  try {
    const bin = atob(dataB64);
    zlibBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      zlibBytes[i] = bin.charCodeAt(i);
    }
  } catch (err) {
    return {
      mask: null,
      originX,
      originY,
      width: 0,
      height: 0,
      fgPixels: 0,
      errorCode: "BITMAP_DECODE_ERROR",
      errorMessage: `Invalid base64 bitmap payload: ${String(err)}`,
    };
  }

  let pngBytes: Uint8Array;
  try {
    pngBytes = await decompressDeflateWithCap(zlibBytes, MAX_BITMAP_PNG_BYTES, "deflate");
  } catch (err) {
    return {
      mask: null,
      originX,
      originY,
      width: 0,
      height: 0,
      fgPixels: 0,
      errorCode: "BITMAP_DECODE_ERROR",
      errorMessage: `Bitmap zlib decode failed: ${String(err)}`,
    };
  }

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngBytes.byteLength < 33 || PNG_SIG.some((b, idx) => pngBytes[idx] !== b)) {
    return {
      mask: null,
      originX,
      originY,
      width: 0,
      height: 0,
      fgPixels: 0,
      errorCode: "BITMAP_DECODE_ERROR",
      errorMessage: "Decoded stream is not a valid PNG.",
    };
  }

  const ihdrType = String.fromCharCode(
    pngBytes[12]!,
    pngBytes[13]!,
    pngBytes[14]!,
    pngBytes[15]!,
  );
  if (ihdrType !== "IHDR") {
    return {
      mask: null,
      originX,
      originY,
      width: 0,
      height: 0,
      fgPixels: 0,
      errorCode: "BITMAP_DECODE_ERROR",
      errorMessage: "Missing PNG IHDR header.",
    };
  }

  const width = readU32BE(pngBytes, 16);
  const height = readU32BE(pngBytes, 20);
  const bitDepth = pngBytes[24]!;
  const colorType = pngBytes[25]!;
  const interlace = pngBytes[28]!;

  if (
    width <= 0 ||
    height <= 0 ||
    width > Math.max(imgW * 2, 16384) ||
    height > Math.max(imgH * 2, 16384) ||
    width * height > 64_000_000
  ) {
    return {
      mask: null,
      originX,
      originY,
      width,
      height,
      fgPixels: 0,
      errorCode: "BITMAP_DECODE_ERROR",
      errorMessage: `Bitmap dimensions (${width}x${height}) exceed safety limit.`,
    };
  }

  // Fallback gracefully if non-8-bit or interlaced PNG (handled cleanly by backend Python OpenCV)
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels || bitDepth !== 8 || interlace !== 0) {
    return {
      mask: null,
      originX,
      originY,
      width,
      height,
      fgPixels: 0,
      errorCode: "BITMAP_UNSUPPORTED_OFFLINE_FORMAT",
      errorMessage: "Non-8-bit or interlaced PNG deferred to Python backend.",
    };
  }

  const idatParts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= pngBytes.byteLength) {
    const chunkLen = readU32BE(pngBytes, offset);
    const chunkType = String.fromCharCode(
      pngBytes[offset + 4]!,
      pngBytes[offset + 5]!,
      pngBytes[offset + 6]!,
      pngBytes[offset + 7]!,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (dataEnd + 4 > pngBytes.byteLength) break;
    if (chunkType === "IDAT") {
      idatParts.push(pngBytes.subarray(dataStart, dataEnd));
    } else if (chunkType === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  const idatLen = idatParts.reduce((acc, p) => acc + p.byteLength, 0);
  const idatBuf = new Uint8Array(idatLen);
  let pos = 0;
  for (const part of idatParts) {
    idatBuf.set(part, pos);
    pos += part.byteLength;
  }

  try {
    const rawScanlines = await decompressDeflateWithCap(
      idatBuf,
      height * (1 + width * channels) + 1024,
      "deflate",
    );
    const pixels = unfilterPngScanlines(rawScanlines, width, height, channels);
    const mask = new Uint8Array(width * height);
    let fgPixels = 0;

    if (colorType === 6) {
      // Check if alpha varies across image; if uniformly opaque 255, fallback to RGB > 0
      let minA = 255;
      let maxA = 0;
      for (let i = 3; i < pixels.byteLength; i += 4) {
        const a = pixels[i]!;
        if (a < minA) minA = a;
        if (a > maxA) maxA = a;
      }
      const useAlpha = minA !== maxA;
      for (let p = 0; p < width * height; p += 1) {
        const idx = p * 4;
        const on = useAlpha
          ? pixels[idx + 3]! > 0
          : pixels[idx]! > 0 || pixels[idx + 1]! > 0 || pixels[idx + 2]! > 0;
        if (on) {
          mask[p] = 1;
          fgPixels += 1;
        }
      }
    } else if (colorType === 4) {
      let minA = 255;
      let maxA = 0;
      for (let i = 1; i < pixels.byteLength; i += 2) {
        const a = pixels[i]!;
        if (a < minA) minA = a;
        if (a > maxA) maxA = a;
      }
      const useAlpha = minA !== maxA;
      for (let p = 0; p < width * height; p += 1) {
        const idx = p * 2;
        const on = useAlpha ? pixels[idx + 1]! > 0 : pixels[idx]! > 0;
        if (on) {
          mask[p] = 1;
          fgPixels += 1;
        }
      }
    } else if (colorType === 2) {
      for (let p = 0; p < width * height; p += 1) {
        const idx = p * 3;
        if (pixels[idx]! > 0 || pixels[idx + 1]! > 0 || pixels[idx + 2]! > 0) {
          mask[p] = 1;
          fgPixels += 1;
        }
      }
    } else {
      for (let p = 0; p < width * height; p += 1) {
        if (pixels[p]! > 0) {
          mask[p] = 1;
          fgPixels += 1;
        }
      }
    }

    return {
      mask,
      originX,
      originY,
      width,
      height,
      fgPixels,
    };
  } catch (err) {
    return {
      mask: null,
      originX,
      originY,
      width,
      height,
      fgPixels: 0,
      errorCode: "BITMAP_DECODE_ERROR",
      errorMessage: `PNG scanline decode failed: ${String(err)}`,
    };
  }
}
