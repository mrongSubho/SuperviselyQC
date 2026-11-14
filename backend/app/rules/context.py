from __future__ import annotations

import base64
import binascii
import math
import struct
import zlib
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.base import BaseGeometry

from app.config import EngineTunables
from app.schemas.qc import (
    AnnotationFigure,
    BoundingBoxTuple,
    ClassDefinition,
    ClassRuleOverride,
    QCAnalyzeRequest,
    QCFinding,
    RuleProfile,
    TagDefinition,
    TagValue,
    ViewportEdgeDirection,
)

MAX_BITMAP_B64_CHARS = 16 * 1024 * 1024
MAX_BITMAP_PNG_BYTES = 32_000_000
_PNG_SIG = b"\x89PNG\r\n\x1a\n"


@dataclass
class DecodedBitmap:
    mask: np.ndarray | None
    origin_x: int
    origin_y: int
    width: int
    height: int
    fg_pixels: int
    error_code: str | None = None
    error_message: str | None = None


def decode_supervisely_bitmap(
    data_b64: str,
    origin: tuple[float, float],
    img_w: int,
    img_h: int,
) -> DecodedBitmap:
    """Safely decode Supervisely base64(zlib(PNG)) with pre-decode IHDR bomb protection."""
    x0 = int(round(origin[0]))
    y0 = int(round(origin[1]))

    if len(data_b64) > MAX_BITMAP_B64_CHARS:
        return DecodedBitmap(
            mask=None,
            origin_x=x0,
            origin_y=y0,
            width=0,
            height=0,
            fg_pixels=0,
            error_code="BITMAP_PAYLOAD_TOO_LARGE",
            error_message="Encoded bitmap string exceeds 16 MB safety cap.",
        )

    try:
        raw_zlib = base64.b64decode(data_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        return DecodedBitmap(
            mask=None,
            origin_x=x0,
            origin_y=y0,
            width=0,
            height=0,
            fg_pixels=0,
            error_code="BITMAP_DECODE_ERROR",
            error_message=f"Invalid base64 bitmap payload: {exc}",
        )

    try:
        decompressor = zlib.decompressobj()
        png_bytes = decompressor.decompress(raw_zlib, max_length=MAX_BITMAP_PNG_BYTES)
        if not decompressor.eof or decompressor.unconsumed_tail:
            return DecodedBitmap(
                mask=None,
                origin_x=x0,
                origin_y=y0,
                width=0,
                height=0,
                fg_pixels=0,
                error_code="BITMAP_DECODE_ERROR",
                error_message="Bitmap zlib stream truncated or exceeds 32 MB decompression safety cap.",
            )
    except zlib.error as exc:
        return DecodedBitmap(
            mask=None,
            origin_x=x0,
            origin_y=y0,
            width=0,
            height=0,
            fg_pixels=0,
            error_code="BITMAP_DECODE_ERROR",
            error_message=f"Bitmap zlib decompression failed: {exc}",
        )

    if len(png_bytes) < 24 or png_bytes[:8] != _PNG_SIG or png_bytes[12:16] != b"IHDR":
        return DecodedBitmap(
            mask=None,
            origin_x=x0,
            origin_y=y0,
            width=0,
            height=0,
            fg_pixels=0,
            error_code="BITMAP_DECODE_ERROR",
            error_message="Decoded bitmap stream is not a valid PNG with IHDR header.",
        )

    w, h = struct.unpack(">II", png_bytes[16:24])
    if w <= 0 or h <= 0 or w > img_w + 2 or h > img_h + 2:
        return DecodedBitmap(
            mask=None,
            origin_x=x0,
            origin_y=y0,
            width=int(w),
            height=int(h),
            fg_pixels=0,
            error_code="BITMAP_DECODE_ERROR",
            error_message=f"PNG IHDR dimensions ({w}x{h}) are invalid or exceed image bounds ({img_w}x{img_h}).",
        )

    img = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None or img.shape[:2] != (h, w):
        return DecodedBitmap(
            mask=None,
            origin_x=x0,
            origin_y=y0,
            width=int(w),
            height=int(h),
            fg_pixels=0,
            error_code="BITMAP_DECODE_ERROR",
            error_message="OpenCV failed to decode bitmap PNG or dimensions did not match IHDR.",
        )

    if img.ndim == 3 and img.shape[2] == 4:
        alpha = img[:, :, 3]
        if int(alpha.min()) < 255:
            mask = alpha > 0
        else:
            mask = np.any(img[:, :, :3] > 0, axis=2)
    elif img.ndim == 3 and img.shape[2] >= 3:
        mask = np.any(img[:, :, :3] > 0, axis=2)
    else:
        mask = img > 0

    fg_pixels = int(np.count_nonzero(mask))
    return DecodedBitmap(
        mask=mask,
        origin_x=x0,
        origin_y=y0,
        width=int(w),
        height=int(h),
        fg_pixels=fg_pixels,
    )


@dataclass
class NormalizedFigure:
    figure: AnnotationFigure
    bbox: BoundingBoxTuple
    bbox_area: float
    geom_area: float
    inverted_box_coords: bool
    shapely_geom: BaseGeometry | None
    decoded_bitmap: DecodedBitmap | None
    outside_viewport: bool
    viewport_edge_direction: ViewportEdgeDirection | None
    tag_map: dict[str, TagValue]
    vertices_for_bounds: list[tuple[float, float]] = field(default_factory=list)


def compute_viewport_status(
    bbox: BoundingBoxTuple,
    visible_pixel_rect: BoundingBoxTuple,
    visible_norm_rect: tuple[float, float, float, float],
    zoom_percent: float,
) -> tuple[bool, ViewportEdgeDirection | None]:
    vx1, vy1, vx2, vy2 = visible_pixel_rect
    bx1, by1, bx2, by2 = bbox

    is_cropped_norm = (
        abs(visible_norm_rect[0]) > 1e-3
        or abs(visible_norm_rect[1]) > 1e-3
        or abs(visible_norm_rect[2] - 1.0) > 1e-3
        or abs(visible_norm_rect[3] - 1.0) > 1e-3
    )
    if zoom_percent >= 98.0 and not is_cropped_norm:
        return False, None

    ix1 = max(bx1, vx1)
    iy1 = max(by1, vy1)
    ix2 = min(bx2, vx2)
    iy2 = min(by2, vy2)
    inter_area = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    bbox_area = max((bx2 - bx1) * (by2 - by1), 1e-6)
    vis_ratio = inter_area / bbox_area
    if vis_ratio >= 0.15:
        return False, None

    cx = 0.5 * (bx1 + bx2)
    cy = 0.5 * (by1 + by2)
    horiz = "left" if cx < vx1 else ("right" if cx > vx2 else "")
    vert = "top" if cy < vy1 else ("bottom" if cy > vy2 else "")
    if vert and horiz:
        direction: ViewportEdgeDirection = f"{vert}-{horiz}"  # type: ignore[assignment]
    elif vert:
        direction = vert  # type: ignore[assignment]
    elif horiz:
        direction = horiz  # type: ignore[assignment]
    else:
        direction = "right"
    return True, direction


def bbox_iou_and_ios(a: BoundingBoxTuple, b: BoundingBoxTuple) -> tuple[float, float, float, float]:
    """Return (iou, ios_a_in_b, ios_b_in_a, inter_area)."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0.0:
        return 0.0, 0.0, 0.0, 0.0
    area_a = max((ax2 - ax1) * (ay2 - ay1), 1e-6)
    area_b = max((bx2 - bx1) * (by2 - by1), 1e-6)
    union = max(area_a + area_b - inter, 1e-6)
    return inter / union, inter / area_a, inter / area_b, inter


def clamp_focus_rect(rect: BoundingBoxTuple, img_w: int, img_h: int) -> BoundingBoxTuple:
    x1, y1, x2, y2 = rect
    return (
        max(0.0, min(float(img_w), min(x1, x2))),
        max(0.0, min(float(img_h), min(y1, y2))),
        max(0.0, min(float(img_w), max(x1, x2))),
        max(0.0, min(float(img_h), max(y1, y2))),
    )


@dataclass
class RuleContext:
    request: QCAnalyzeRequest
    profile: RuleProfile
    tunables: EngineTunables
    width: int
    height: int
    s_min: float
    is_partial_geometry: bool
    classes_by_title: dict[str, ClassDefinition]
    classes_by_id: dict[str, ClassDefinition]
    tags_by_name: dict[str, TagDefinition]
    normalized_figures: list[NormalizedFigure]
    figures_by_id: dict[str, NormalizedFigure]

    @classmethod
    def build(
        cls,
        request: QCAnalyzeRequest,
        profile: RuleProfile,
        tunables: EngineTunables,
    ) -> RuleContext:
        w = request.image.width
        h = request.image.height
        s_min = min(tunables.micro_click_min_side_px, max(8.0, 0.025 * min(w, h)))
        is_partial = (
            request.ui_state.state_source == "dom_fallback"
            or request.ui_state.partial_geometry
        )

        classes_by_title = {c.title: c for c in request.ontology.classes}
        classes_by_id = {str(c.class_id): c for c in request.ontology.classes}
        tags_by_name = {t.name: t for t in request.ontology.tags}

        norm_figs: list[NormalizedFigure] = []
        figs_by_id: dict[str, NormalizedFigure] = {}

        if not is_partial:
            for fig in request.figures:
                nf = cls._normalize_figure(fig, request, w, h)
                norm_figs.append(nf)
                figs_by_id[fig.figure_id] = nf

        return cls(
            request=request,
            profile=profile,
            tunables=tunables,
            width=w,
            height=h,
            s_min=s_min,
            is_partial_geometry=is_partial,
            classes_by_title=classes_by_title,
            classes_by_id=classes_by_id,
            tags_by_name=tags_by_name,
            normalized_figures=norm_figs,
            figures_by_id=figs_by_id,
        )

    @staticmethod
    def _normalize_figure(
        fig: AnnotationFigure,
        request: QCAnalyzeRequest,
        w: int,
        h: int,
    ) -> NormalizedFigure:
        geom = fig.to_geometry()
        inverted = False
        shapely_geom: BaseGeometry | None = None
        decoded_bitmap: DecodedBitmap | None = None
        vertices_for_bounds: list[tuple[float, float]] = []
        geom_area = 0.0

        if geom.geometry_type == "rectangle":
            (x1, y1), (x2, y2) = geom.points.exterior
            inverted = x1 > x2 or y1 > y2
            bx1, by1, bx2, by2 = min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)
            bbox: BoundingBoxTuple = (bx1, by1, bx2, by2)
            geom_area = max(0.0, (bx2 - bx1) * (by2 - by1))
            shapely_geom = Polygon([(bx1, by1), (bx2, by1), (bx2, by2), (bx1, by2)])
            vertices_for_bounds = [(x1, y1), (x2, y2)]

        elif geom.geometry_type == "polygon":
            ext = list(geom.points.exterior)
            holes = list(geom.points.interior)
            all_pts = ext + [pt for ring in holes for pt in ring]
            vertices_for_bounds = [(p[0], p[1]) for p in all_pts]
            xs = [p[0] for p in all_pts] or [0.0]
            ys = [p[1] for p in all_pts] or [0.0]
            bbox = (min(xs), min(ys), max(xs), max(ys))
            try:
                poly = Polygon(ext, holes)
                shapely_geom = poly
                geom_area = abs(float(poly.area))
            except Exception:
                shapely_geom = None
                geom_area = 0.0

        elif geom.geometry_type == "bitmap":
            decoded_bitmap = decode_supervisely_bitmap(
                geom.bitmap.data,
                geom.bitmap.origin,
                w,
                h,
            )
            ox, oy = decoded_bitmap.origin_x, decoded_bitmap.origin_y
            bw, bh = decoded_bitmap.width, decoded_bitmap.height
            bbox = (float(ox), float(oy), float(ox + max(bw, 0)), float(oy + max(bh, 0)))
            geom_area = float(decoded_bitmap.fg_pixels)
            vertices_for_bounds = [
                (float(ox), float(oy)),
                (float(ox + max(bw, 0)), float(oy + max(bh, 0))),
            ]

        elif geom.geometry_type == "polyline":
            pts = list(geom.points.exterior)
            vertices_for_bounds = [(p[0], p[1]) for p in pts]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            bbox = (min(xs), min(ys), max(xs), max(ys))
            try:
                line = LineString(pts)
                shapely_geom = line
                geom_area = float(line.length)
            except Exception:
                shapely_geom = None
                geom_area = 0.0

        elif geom.geometry_type == "point":
            pt = geom.points.exterior[0]
            vertices_for_bounds = [(pt[0], pt[1])]
            bbox = (pt[0], pt[1], pt[0], pt[1])
            shapely_geom = Point(pt)
            geom_area = 1.0

        else:  # graph
            active_pts = [
                (node.loc[0], node.loc[1])
                for node in geom.nodes.values()
                if not node.disabled
            ]
            vertices_for_bounds = active_pts
            if active_pts:
                xs = [p[0] for p in active_pts]
                ys = [p[1] for p in active_pts]
                bbox = (min(xs), min(ys), max(xs), max(ys))
            else:
                bbox = (0.0, 0.0, 0.0, 0.0)
            geom_area = float(max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])))

        bbox_area = max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
        outside, direction = compute_viewport_status(
            bbox,
            request.viewport.visible_pixel_rect,
            request.viewport.visible_norm_rect,
            request.viewport.zoom_percent,
        )
        tag_map = {t.name: t for t in fig.tags}
        return NormalizedFigure(
            figure=fig,
            bbox=bbox,
            bbox_area=bbox_area,
            geom_area=geom_area,
            inverted_box_coords=inverted,
            shapely_geom=shapely_geom,
            decoded_bitmap=decoded_bitmap,
            outside_viewport=outside,
            viewport_edge_direction=direction,
            tag_map=tag_map,
            vertices_for_bounds=vertices_for_bounds,
        )

    def class_override(self, class_title: str) -> ClassRuleOverride | None:
        return self.profile.class_overrides.get(class_title)

    def effective_min_area(self, class_title: str, base_min_area: float) -> float:
        ov = self.class_override(class_title)
        ov_area = float(ov.min_area_px) if (ov and ov.min_area_px is not None) else 0.0
        return max(
            float(base_min_area),
            ov_area,
            self.tunables.min_relative_area * float(self.width) * float(self.height),
        )

    def figure_display_label(self, fig: AnnotationFigure) -> str:
        if fig.label_index is not None:
            return f"{fig.class_title} #{fig.label_index}"
        return f"{fig.class_title} ({fig.figure_id})"

    def make_finding(
        self,
        *,
        rule_id: str,
        severity: str,
        category: str,
        title: str,
        message: str,
        fingerprint: str,
        figure_ids: list[str] | None = None,
        image_tag_names: list[str] | None = None,
        missed_object_ids: list[str] | None = None,
        outside_viewport: bool = False,
        focus_rect: BoundingBoxTuple | None = None,
        confidence: float = 1.0,
        suggested_fixes: list[Any] | None = None,
    ) -> QCFinding:
        finding_idx = abs(hash(fingerprint)) % 1_000_000
        return QCFinding(
            finding_id=f"f_{rule_id.lower()}_{finding_idx:06d}",
            rule_id=rule_id,
            severity=severity,  # type: ignore[arg-type]
            category=category,  # type: ignore[arg-type]
            title=title,
            message=message,
            figure_ids=figure_ids or [],
            image_tag_names=image_tag_names or [],
            missed_object_ids=missed_object_ids or [],
            outside_viewport=outside_viewport,
            focus_rect=clamp_focus_rect(focus_rect, self.width, self.height) if focus_rect else None,
            confidence=confidence,
            suggested_fixes=suggested_fixes or [],
            fingerprint=fingerprint,
        )


def _point_dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])
