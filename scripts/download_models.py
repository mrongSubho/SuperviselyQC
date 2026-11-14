#!/usr/bin/env python3
"""Provision local Apple Silicon vision model weights into ~/.cache/supervisely-qc/models/."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

DEFAULT_MODELS_DIR = Path.home() / ".cache" / "supervisely-qc" / "models"


def download_standard_tier(models_dir: Path) -> None:
    models_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Standard tier weights to {models_dir} ...")

    from ultralytics import YOLO  # noqa: PLC0415

    yolo_target = models_dir / "yolo11s.pt"
    if not yolo_target.exists():
        model = YOLO("yolo11s.pt")
        src = Path(getattr(model, "ckpt_path", None) or "yolo11s.pt")
        if src.exists() and src.resolve() != yolo_target.resolve():
            shutil.copy2(src, yolo_target)
        print(f"Ready: {yolo_target}")

    from huggingface_hub import snapshot_download  # noqa: PLC0415

    depth_dir = models_dir / "depth-anything-v2-small"
    if not depth_dir.exists():
        snapshot_download(
            repo_id="depth-anything/Depth-Anything-V2-Small-hf",
            local_dir=str(depth_dir),
        )
        print(f"Ready: {depth_dir}")


def download_deep_tier(models_dir: Path) -> None:
    download_standard_tier(models_dir)
    print(f"Downloading Deep tier weights to {models_dir} ...")

    from ultralytics import SAM, YOLO  # noqa: PLC0415

    for name, loader in (
        ("yolov8s-worldv2.pt", YOLO),
        ("yolo11s-pose.pt", YOLO),
        ("sam2.1_t.pt", SAM),
    ):
        target = models_dir / name
        if not target.exists():
            inst = loader(name)
            src = Path(getattr(inst, "ckpt_path", None) or name)
            if src.exists() and src.resolve() != target.resolve():
                shutil.copy2(src, target)
            print(f"Ready: {target}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-download Supervisely QC vision models.")
    parser.add_argument(
        "--tier",
        choices=["standard", "deep"],
        default="standard",
        help="Model tier to download locally (default: standard).",
    )
    parser.add_argument(
        "--models-dir",
        type=Path,
        default=DEFAULT_MODELS_DIR,
        help=f"Target local cache directory (default: {DEFAULT_MODELS_DIR}).",
    )
    args = parser.parse_args()

    try:
        if args.tier == "standard":
            download_standard_tier(args.models_dir)
        else:
            download_deep_tier(args.models_dir)
    except ImportError as exc:
        print(
            f"Missing optional vision packages ({exc}). Install with: "
            'uv pip install --python backend/.venv/bin/python -e "backend[vision]"',
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
