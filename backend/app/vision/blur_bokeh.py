from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from app.schemas.qc import BoundingBoxTuple


@dataclass
class SharpnessMetrics:
    sharpness_score: float
    edge_tenengrad_p90: float
    interior_lap_var: float
    relative_sharpness: float


class BokehScorer:
    """Native 1:1 resolution boundary-Tenengrad + top-50% Laplacian bokeh scorer."""

    def __init__(
        self,
        rgb: np.ndarray,
        coord_width: float | None = None,
        coord_height: float | None = None,
    ) -> None:
        self.rgb = rgb
        self.height, self.width = rgb.shape[:2]
        self._coord_scale_x = (
            float(self.width) / float(coord_width)
            if coord_width and coord_width > 0 and int(coord_width) != self.width
            else 1.0
        )
        self._coord_scale_y = (
            float(self.height) / float(coord_height)
            if coord_height and coord_height > 0 and int(coord_height) != self.height
            else 1.0
        )
        self._ref_score: float | None = None

    @staticmethod
    def _to_gray_f32(crop_rgb: np.ndarray) -> np.ndarray:
        return cv2.cvtColor(crop_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)

    @staticmethod
    def _edge_tenengrad_p90(gray: np.ndarray, band_mask: np.ndarray) -> float:
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        mag = np.sqrt(gx * gx + gy * gy)
        vals = mag[band_mask]
        if vals.size == 0:
            return 0.0
        return float(np.percentile(vals, 90))

    @staticmethod
    def _top50_laplacian_var(gray: np.ndarray) -> float:
        gh, gw = gray.shape[:2]
        if gh < 16 or gw < 16:
            lap = cv2.Laplacian(gray, cv2.CV_32F)
            return float(lap.var())

        grid = 4 if (gh >= 128 and gw >= 128) else 2
        tile_vars: list[float] = []
        for r in range(grid):
            y0 = (r * gh) // grid
            y1 = ((r + 1) * gh) // grid
            for c in range(grid):
                x0 = (c * gw) // grid
                x1 = ((c + 1) * gw) // grid
                tile = gray[y0:y1, x0:x1]
                if tile.shape[0] >= 8 and tile.shape[1] >= 8:
                    lap = cv2.Laplacian(tile, cv2.CV_32F)
                    tile_vars.append(float(lap.var()))
        if not tile_vars:
            return float(cv2.Laplacian(gray, cv2.CV_32F).var())
        tile_vars.sort(reverse=True)
        top_k = max(1, len(tile_vars) // 2)
        return float(sum(tile_vars[:top_k]) / top_k)

    def _raw_score_for_roi(self, bbox: BoundingBoxTuple) -> tuple[float, float, float]:
        sx = self._coord_scale_x
        sy = self._coord_scale_y
        bx1 = max(0, min(self.width - 1, int(round(bbox[0] * sx))))
        by1 = max(0, min(self.height - 1, int(round(bbox[1] * sy))))
        bx2 = max(bx1 + 1, min(self.width, int(round(bbox[2] * sx))))
        by2 = max(by1 + 1, min(self.height, int(round(bbox[3] * sy))))
        rw = bx2 - bx1
        rh = by2 - by1

        # Cap memory/latency on huge ROIs (>1024px) via native 1:1 512x512 perimeter/center samples
        if max(rw, rh) > 1024:
            return self._raw_score_large_roi(bx1, by1, bx2, by2)

        pad = 6
        ex1 = max(0, bx1 - pad)
        ey1 = max(0, by1 - pad)
        ex2 = min(self.width, bx2 + pad)
        ey2 = min(self.height, by2 + pad)

        crop = self.rgb[ey1:ey2, ex1:ex2]
        gray_ext = self._to_gray_f32(crop)

        # Build 12px perimeter band straddling [bx1..bx2, by1..by2] (inner 6px + outer 6px)
        eh, ew = gray_ext.shape[:2]
        band_mask = np.zeros((eh, ew), dtype=bool)
        ix1 = max(0, (bx1 + pad) - ex1)
        iy1 = max(0, (by1 + pad) - ey1)
        ix2 = min(ew, (bx2 - pad) - ex1)
        iy2 = min(eh, (by2 - pad) - ey1)
        band_mask[:, :] = True
        if ix2 > ix1 and iy2 > iy1:
            band_mask[iy1:iy2, ix1:ix2] = False

        e_edge = self._edge_tenengrad_p90(gray_ext, band_mask)

        roi_gray = self._to_gray_f32(self.rgb[by1:by2, bx1:bx2])
        l_var = self._top50_laplacian_var(roi_gray)
        s_raw = 0.6 * e_edge + 0.4 * float(np.sqrt(max(0.0, l_var)))
        return s_raw, e_edge, l_var

    def _raw_score_large_roi(self, bx1: int, by1: int, bx2: int, by2: int) -> tuple[float, float, float]:
        # Sample up to 4 native 512x512 boundary/interior patches without downsampling
        cx = (bx1 + bx2) // 2
        cy = (by1 + by2) // 2
        patches = [
            (bx1, by1, min(self.width, bx1 + 512), min(self.height, by1 + 512)),
            (max(0, bx2 - 512), by1, bx2, min(self.height, by1 + 512)),
            (bx1, max(0, by2 - 512), min(self.width, bx1 + 512), by2),
            (max(0, cx - 256), max(0, cy - 256), min(self.width, cx + 256), min(self.height, cy + 256)),
        ]
        edge_scores: list[float] = []
        lap_vars: list[float] = []
        for px1, py1, px2, py2 in patches:
            if px2 - px1 < 32 or py2 - py1 < 32:
                continue
            gray = self._to_gray_f32(self.rgb[py1:py2, px1:px2])
            mask = np.zeros(gray.shape, dtype=bool)
            mask[:12, :] = True
            mask[-12:, :] = True
            mask[:, :12] = True
            mask[:, -12:] = True
            edge_scores.append(self._edge_tenengrad_p90(gray, mask))
            lap_vars.append(self._top50_laplacian_var(gray))

        e_edge = max(edge_scores) if edge_scores else 0.0
        l_var = max(lap_vars) if lap_vars else 0.0
        s_raw = 0.6 * e_edge + 0.4 * float(np.sqrt(max(0.0, l_var)))
        return s_raw, e_edge, l_var

    def image_reference_sharpness(self) -> float:
        """Compute E_ref = P95(S_raw) identically across a 4x4 grid of native patches."""
        if self._ref_score is not None:
            return self._ref_score

        patch_scores: list[float] = []
        for r in range(4):
            y0 = (r * self.height) // 4
            y1 = ((r + 1) * self.height) // 4
            for c in range(4):
                x0 = (c * self.width) // 4
                x1 = ((c + 1) * self.width) // 4
                # Sample up to 384x384 native center patch per grid cell for <10ms runtime
                cx = (x0 + x1) // 2
                cy = (y0 + y1) // 2
                pw = min(384, x1 - x0)
                ph = min(384, y1 - y0)
                sx1 = max(0, cx - pw // 2)
                sy1 = max(0, cy - ph // 2)
                sx2 = min(self.width, sx1 + pw)
                sy2 = min(self.height, sy1 + ph)
                if sx2 - sx1 < 32 or sy2 - sy1 < 32:
                    continue
                s_raw, _, _ = self._raw_score_for_roi(
                    (float(sx1), float(sy1), float(sx2), float(sy2))
                )
                patch_scores.append(s_raw)

        self._ref_score = float(np.percentile(patch_scores, 95)) if patch_scores else 1.0
        return self._ref_score

    def score_roi(self, bbox: BoundingBoxTuple) -> SharpnessMetrics:
        s_raw, e_edge, l_var = self._raw_score_for_roi(bbox)
        e_ref = self.image_reference_sharpness()
        s_rel = s_raw / max(e_ref, 1.0)
        return SharpnessMetrics(
            sharpness_score=round(s_raw, 2),
            edge_tenengrad_p90=round(e_edge, 2),
            interior_lap_var=round(l_var, 2),
            relative_sharpness=round(s_rel, 3),
        )
