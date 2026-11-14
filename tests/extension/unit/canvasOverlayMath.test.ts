import { deflateSync } from "node:zlib";
import { DecompressionStream as NodeDecompressionStream } from "node:stream/web";
import { beforeAll, describe, expect, it } from "vitest";
import {
  computeCanvasAffineTransform,
  projectBboxToCssRect,
  projectImagePointToCss,
} from "../../../extension/src/content/ui/CanvasOverlay";
import { decodeSuperviselyBitmapPng } from "../../../extension/src/shared/geometry";

beforeAll(() => {
  if (typeof globalThis.DecompressionStream === "undefined") {
    globalThis.DecompressionStream =
      NodeDecompressionStream as unknown as typeof DecompressionStream;
  }
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i]!;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

function buildMinimalGrayPng(
  width: number,
  height: number,
  pixels?: Uint8Array,
  overrideWidth?: number,
  overrideHeight?: number,
): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, overrideWidth ?? width, false);
  dv.setUint32(4, overrideHeight ?? height, false);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawScanlines = new Uint8Array(height * (1 + width));
  if (pixels) {
    for (let y = 0; y < height; y += 1) {
      rawScanlines[y * (1 + width)] = 0; // filter 0
      rawScanlines.set(
        pixels.subarray(y * width, (y + 1) * width),
        y * (1 + width) + 1,
      );
    }
  }
  const compressedScanlines = new Uint8Array(deflateSync(rawScanlines));

  const c1 = makePngChunk("IHDR", ihdr);
  const c2 = makePngChunk("IDAT", compressedScanlines);
  const c3 = makePngChunk("IEND", new Uint8Array(0));
  const full = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let pos = 0;
  for (const part of [sig, c1, c2, c3]) {
    full.set(part, pos);
    pos += part.length;
  }
  return full;
}

describe("CanvasOverlay affine math & bitmap decoder", () => {
  it("projects 5472x3648 fit canvas inside 980x653 using Tier 3 fit invariant to DPR", () => {
    const tf = computeCanvasAffineTransform({
      imageWidth: 5472,
      imageHeight: 3648,
      canvasCssWidth: 980,
      canvasCssHeight: 653,
      viewport: {
        zoomPercent: 100,
        visibleNormRect: [0, 0, 1, 1],
        visiblePixelRect: [0, 0, 5472, 3648],
        canvasSize: { width: 980, height: 653 },
        source: "fallback_full",
      },
      canvasTransform: null,
    });

    expect(tf.tier).toBe("tier3_fit");
    const expectedScale = Math.min(980 / 5472, 653 / 3648);
    expect(tf.scaleX).toBeCloseTo(expectedScale, 5);
    expect(tf.scaleY).toBeCloseTo(expectedScale, 5);

    const [p1x, p1y] = projectImagePointToCss([2736, 1824], tf);
    expect(p1x).toBeCloseTo(490, 1);
    expect(p1y).toBeCloseTo(326.5, 1);
  });

  it("activates Tier 2 minimap crop on single-axis crop even when zoomPercent=100", () => {
    const tf = computeCanvasAffineTransform({
      imageWidth: 1000,
      imageHeight: 1000,
      canvasCssWidth: 800,
      canvasCssHeight: 500,
      viewport: {
        zoomPercent: 100,
        visibleNormRect: [0, 0.1, 1, 0.81],
        visiblePixelRect: [0, 100, 1000, 810],
        canvasSize: { width: 800, height: 500 },
        source: "minimap",
      },
    });

    expect(tf.tier).toBe("tier2_minimap_zoom");
    const [topX, topY] = projectImagePointToCss([500, 100], tf);
    expect(topX).toBeCloseTo(400, 2);
    expect(topY).toBeCloseTo(0, 2);
  });

  it("uses Tier 1 Konva transform when present and normalizes inverted bounding boxes", () => {
    const tf = computeCanvasAffineTransform({
      imageWidth: 1000,
      imageHeight: 1000,
      canvasCssWidth: 800,
      canvasCssHeight: 600,
      viewport: {
        zoomPercent: 150,
        visibleNormRect: [0, 0, 1, 1],
        visiblePixelRect: [0, 0, 1000, 1000],
        canvasSize: { width: 800, height: 600 },
        source: "fallback_full",
      },
      canvasTransform: {
        scaleX: 0.5,
        scaleY: 0.5,
        offsetX: 40,
        offsetY: 20,
        source: "konva_or_viewport",
      },
    });

    expect(tf.tier).toBe("tier1_konva");
    const rectA = projectBboxToCssRect([300, 400, 100, 200], tf);
    const rectB = projectBboxToCssRect([100, 200, 300, 400], tf);
    expect(rectA).toEqual(rectB);
    expect(rectA).toEqual({ x: 90, y: 120, width: 100, height: 100 });
  });

  it("decodes Supervisely zlib(PNG) bitmap via DecompressionStream and rejects IHDR bombs", async () => {
    const pixels = new Uint8Array([
      255, 255, 0, 0,
      255, 0, 0, 0,
      0, 0, 255, 255,
      0, 0, 0, 255,
    ]);
    const pngBytes = buildMinimalGrayPng(4, 4, pixels);
    const wrapped = deflateSync(pngBytes);
    const b64 = Buffer.from(wrapped).toString("base64");

    const decoded = await decodeSuperviselyBitmapPng(b64, [12, 34], 1000, 800);
    expect(decoded.errorCode).toBeUndefined();
    expect(decoded.originX).toBe(12);
    expect(decoded.originY).toBe(34);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    expect(decoded.fgPixels).toBe(6);
    expect(decoded.mask?.[0]).toBe(1);
    expect(decoded.mask?.[2]).toBe(0);

    // Crafted IHDR claiming 100000x100000 should fail safely before allocating huge buffer
    const bombPng = buildMinimalGrayPng(1, 1, new Uint8Array([255]), 100_000, 100_000);
    const bombB64 = Buffer.from(deflateSync(bombPng)).toString("base64");
    const rejected = await decodeSuperviselyBitmapPng(bombB64, [0, 0], 1000, 800);
    expect(rejected.mask).toBeNull();
    expect(rejected.errorCode).toBe("BITMAP_DECODE_ERROR");
  });
});
