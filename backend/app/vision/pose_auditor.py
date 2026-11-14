from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.optimize import linear_sum_assignment

from app.rules.context import RuleContext, bbox_iou_and_ios
from app.rules.keypoint_rules import parse_bilateral_label
from app.schemas.qc import BoundingBoxTuple, QCFinding, QuickFixAction
from app.vision.model_manager import ModelManager

# Standard COCO-17 keypoint indices emitted by YOLO11s-pose
COCO17_KEYPOINTS: dict[int, tuple[str, str]] = {
    1: ("L", "eye"),
    2: ("R", "eye"),
    3: ("L", "ear"),
    4: ("R", "ear"),
    5: ("L", "shoulder"),
    6: ("R", "shoulder"),
    7: ("L", "elbow"),
    8: ("R", "elbow"),
    9: ("L", "wrist"),
    10: ("R", "wrist"),
    11: ("L", "hip"),
    12: ("R", "hip"),
    13: ("L", "knee"),
    14: ("R", "knee"),
    15: ("L", "ankle"),
    16: ("R", "ankle"),
}


@dataclass
class PredictedPoseInstance:
    bbox: BoundingBoxTuple
    keypoints: dict[tuple[str, str], tuple[float, float, float]]  # (side, part) -> (x, y, conf)


def audit_pose_instances(
    ctx: RuleContext,
    pred_instances: list[PredictedPoseInstance],
) -> list[QCFinding]:
    """Step 1: instance-level Hungarian matching. Step 2: semantic label-alias joint cross-check."""
    graph_figs = [
        nf for nf in ctx.normalized_figures if nf.figure.geometry_type == "graph"
    ]
    if not graph_figs or not pred_instances:
        return []

    # Build bipartite cost matrix over (1 - IoU) at the instance level ONLY
    cost = np.ones((len(graph_figs), len(pred_instances)), dtype=np.float64)
    for i, gf in enumerate(graph_figs):
        for j, pred in enumerate(pred_instances):
            iou, ios_g, _, _ = bbox_iou_and_ios(gf.bbox, pred.bbox)
            score = max(iou, 0.7 * ios_g)
            cost[i, j] = 1.0 - score

    row_ind, col_ind = linear_sum_assignment(cost)
    findings: list[QCFinding] = []

    for i, j in zip(row_ind, col_ind, strict=False):
        if cost[i, j] > 0.75:
            continue
        gf = graph_figs[i]
        pred = pred_instances[j]
        fig = gf.figure
        label = ctx.figure_display_label(fig)
        geom = fig.to_geometry()
        assert geom.geometry_type == "graph"
        cls_def = ctx.classes_by_id.get(str(fig.class_id)) or ctx.classes_by_title.get(
            fig.class_title
        )
        template_nodes = (
            cls_def.geometry_config.nodes
            if cls_def and cls_def.geometry_config and cls_def.geometry_config.nodes
            else {}
        )
        if not template_nodes:
            continue

        # Map user graph nodes strictly by semantic label alias (never spatial Hungarian across joints!)
        user_by_semantic: dict[tuple[str, str], tuple[str, tuple[float, float]]] = {}
        for nid, nval in geom.nodes.items():
            if nval.disabled or nid not in template_nodes:
                continue
            parsed = parse_bilateral_label(template_nodes[nid].label)
            if parsed is not None:
                user_by_semantic[parsed] = (template_nodes[nid].label, (nval.loc[0], nval.loc[1]))

        if not user_by_semantic:
            continue

        px1, py1, px2, py2 = pred.bbox
        bbox_diag = max(math.hypot(px2 - px1, py2 - py1), 1.0)

        # Check confirmed bilateral L/R swaps first
        parts = {part for _, part in user_by_semantic}
        swapped_parts: set[str] = set()
        for part in parts:
            ul = user_by_semantic.get(("L", part))
            ur = user_by_semantic.get(("R", part))
            pl = pred.keypoints.get(("L", part))
            pr = pred.keypoints.get(("R", part))
            if not (ul and ur and pl and pr):
                continue
            if pl[2] < 0.65 or pr[2] < 0.65:
                continue
            d_direct = math.hypot(ul[1][0] - pl[0], ul[1][1] - pl[1]) + math.hypot(
                ur[1][0] - pr[0], ur[1][1] - pr[1]
            )
            d_swap = math.hypot(ul[1][0] - pr[0], ul[1][1] - pr[1]) + math.hypot(
                ur[1][0] - pl[0], ur[1][1] - pl[1]
            )
            if d_direct > 12.0 and d_swap < 0.6 * d_direct:
                swapped_parts.add(part)
                findings.append(
                    ctx.make_finding(
                        rule_id="KP_AI_LR_SWAP_CONFIRMED",
                        severity="warning",
                        category="keypoints",
                        title="AI Confirmed Left/Right Keypoint Swap",
                        message=f"Pose model confirms Left/Right swap on ({ul[0]}, {ur[0]}) in {label}.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=gf.outside_viewport,
                        focus_rect=gf.bbox,
                        confidence=round(float(min(pl[2], pr[2])), 2),
                        fingerprint=f"KP_AI_LR_SWAP_CONFIRMED:{fig.figure_id}:{part}",
                        suggested_fixes=[
                            QuickFixAction(
                                action_id=f"fix_inspect_swap_{fig.figure_id}_{part}",
                                label=f"Inspect {label}",
                                action_type="inspect_figure",
                                target_figure_ids=[fig.figure_id],
                                focus_rect=gf.bbox,
                            )
                        ],
                    )
                )

        # Check individual semantic keypoint drift (> 0.10 * bbox_diag when conf >= 0.65)
        for sem_key, (node_label, u_pt) in user_by_semantic.items():
            if sem_key[1] in swapped_parts:
                continue
            p_kpt = pred.keypoints.get(sem_key)
            if p_kpt is None or p_kpt[2] < 0.65:
                continue
            err = math.hypot(p_kpt[0] - u_pt[0], p_kpt[1] - u_pt[1])
            if err > 0.10 * bbox_diag:
                k_rect: BoundingBoxTuple = (
                    u_pt[0] - 32.0,
                    u_pt[1] - 32.0,
                    u_pt[0] + 32.0,
                    u_pt[1] + 32.0,
                )
                findings.append(
                    ctx.make_finding(
                        rule_id="KP_AI_KEYPOINT_DRIFT",
                        severity="warning",
                        category="keypoints",
                        title="Keypoint Position Drift vs Pose Model",
                        message=f"Keypoint '{node_label}' in {label} drifts {err:.0f}px from predicted joint location.",
                        figure_ids=[fig.figure_id],
                        outside_viewport=gf.outside_viewport,
                        focus_rect=k_rect,
                        confidence=round(float(p_kpt[2]), 2),
                        fingerprint=f"KP_AI_KEYPOINT_DRIFT:{fig.figure_id}:{node_label}",
                    )
                )

    return findings


class PoseAuditor:
    """YOLO11s-pose keypoint auditor executed only when graph skeletons exist."""

    def __init__(self, model_manager: ModelManager) -> None:
        self.model_manager = model_manager

    def audit(
        self,
        ctx: RuleContext,
        rgb: np.ndarray,
        device: str,
    ) -> tuple[list[QCFinding], str | None]:
        has_graph = any(nf.figure.geometry_type == "graph" for nf in ctx.normalized_figures)
        if not has_graph:
            return [], None

        weight_path = self.model_manager.has_weight_file("yolo11s-pose.pt")
        if weight_path is None:
            return [], None

        try:
            from ultralytics import YOLO  # noqa: PLC0415

            model: Any = self.model_manager.get_model("yolo11s-pose")
            if model is None:
                model = YOLO(str(weight_path))
                self.model_manager.register_model("yolo11s-pose", model, heavy=False)

            results = model.predict(
                source=rgb,
                conf=0.35,
                imgsz=1280,
                device=device,
                half=(device == "mps"),
                verbose=False,
            )
            preds: list[PredictedPoseInstance] = []
            if results and getattr(results[0], "keypoints", None) is not None and results[0].boxes is not None:
                boxes_xyxy = results[0].boxes.xyxy.detach().cpu().numpy()
                kpts_xy = results[0].keypoints.xy.detach().cpu().numpy()
                kpts_conf = (
                    results[0].keypoints.conf.detach().cpu().numpy()
                    if results[0].keypoints.conf is not None
                    else np.ones(kpts_xy.shape[:2], dtype=np.float32)
                )
                for b_idx in range(len(boxes_xyxy)):
                    bx1, by1, bx2, by2 = boxes_xyxy[b_idx]
                    kmap: dict[tuple[str, str], tuple[float, float, float]] = {}
                    for k_idx, sem in COCO17_KEYPOINTS.items():
                        if k_idx < kpts_xy.shape[1]:
                            kx, ky = float(kpts_xy[b_idx, k_idx, 0]), float(kpts_xy[b_idx, k_idx, 1])
                            kc = float(kpts_conf[b_idx, k_idx])
                            kmap[sem] = (kx, ky, kc)
                    preds.append(
                        PredictedPoseInstance(
                            bbox=(float(bx1), float(by1), float(bx2), float(by2)),
                            keypoints=kmap,
                        )
                    )
            return audit_pose_instances(ctx, preds), "yolo11s-pose"
        except Exception:
            return [], None
