from __future__ import annotations

import base64
import struct
import zlib

import numpy as np
import pytest

from app.config import EngineSettings
from app.rules.bitmap_rules import evaluate_bitmap_rules
from app.rules.context import RuleContext, decode_supervisely_bitmap
from app.schemas.qc import RuleProfile
from tests.backend.conftest import encode_mask_to_sly_bitmap, make_analyze_request


@pytest.mark.parametrize("mode", ["RGBA_ALPHA", "RGBA_OPAQUE", "RGB", "GRAY"])
def test_bitmap_decode_channel_variants(mode: str) -> None:
    mask = np.zeros((32, 32), dtype=bool)
    mask[6:26, 8:24] = True
    b64 = encode_mask_to_sly_bitmap(mask, mode=mode)
    decoded = decode_supervisely_bitmap(b64, (100.0, 200.0), 1000, 1000)
    assert decoded.error_code is None
    assert decoded.mask is not None
    assert np.array_equal(decoded.mask, mask)
    assert decoded.fg_pixels == int(np.count_nonzero(mask))


def test_bitmap_bomb_and_truncated_zlib_rejection() -> None:
    # Crafted fake PNG header claiming 20000x20000 in IHDR -> rejected before cv2.imdecode allocation
    fake_ihdr_data = struct.pack(">IIBBBBB", 20000, 20000, 8, 6, 0, 0, 0)
    fake_png = (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + b"IHDR"
        + fake_ihdr_data
        + b"\x00\x00\x00\x00"
    )
    b64_bomb = base64.b64encode(zlib.compress(fake_png)).decode("ascii")
    res_bomb = decode_supervisely_bitmap(b64_bomb, (0.0, 0.0), 5472, 3648)
    assert res_bomb.error_code == "BITMAP_DECODE_ERROR"
    assert res_bomb.mask is None

    # Truncated zlib stream
    valid_bytes = zlib.compress(b"\x89PNG\r\n\x1a\n" + b"0" * 100)
    b64_trunc = base64.b64encode(valid_bytes[:-6]).decode("ascii")
    res_trunc = decode_supervisely_bitmap(b64_trunc, (0.0, 0.0), 1000, 1000)
    assert res_trunc.error_code == "BITMAP_DECODE_ERROR"


def test_bitmap_border_touching_c_shape_vs_pinhole_and_islands(default_profile: RuleProfile) -> None:
    # Open C-shape touching left border of bitmap must NOT trigger internal hole!
    c_mask = np.zeros((60, 60), dtype=bool)
    c_mask[10:20, 0:45] = True
    c_mask[40:50, 0:45] = True
    c_mask[10:50, 35:45] = True

    # Solid block with a 4x4 pinhole and a 2x2 stray dot island far away
    bad_mask = np.zeros((180, 180), dtype=bool)
    bad_mask[10:80, 10:80] = True
    bad_mask[35:40, 35:40] = False  # 25px^2 pinhole
    bad_mask[170:173, 170:173] = True  # 9px^2 stray dot far away

    req = make_analyze_request(
        width=1000,
        height=1000,
        figures=[
            {
                "figureId": "bm_c",
                "classId": 105,
                "classTitle": "Car1",
                "geometryType": "bitmap",
                "bitmap": {"data": encode_mask_to_sly_bitmap(c_mask), "origin": [100, 100]},
                "tags": [],
            },
            {
                "figureId": "bm_bad",
                "classId": 105,
                "classTitle": "Car1",
                "geometryType": "bitmap",
                "bitmap": {"data": encode_mask_to_sly_bitmap(bad_mask), "origin": [400, 100]},
                "tags": [],
            },
        ],
    )
    ctx = RuleContext.build(req, default_profile, EngineSettings().tunables)
    findings = evaluate_bitmap_rules(ctx)

    c_findings = [f for f in findings if "bm_c" in f.figure_ids]
    assert c_findings == []

    bad_rules = {f.rule_id for f in findings if "bm_bad" in f.figure_ids}
    assert "BITMAP_UNEXPECTED_INTERNAL_HOLES" in bad_rules
    assert "BITMAP_DISCONNECTED_ISLANDS" in bad_rules
    assert "BITMAP_SPILLED_MASK" in bad_rules
