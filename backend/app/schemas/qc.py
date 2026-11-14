from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Base Pydantic model enforcing camelCase JSON wire aliases and strict fields."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


Point2D = tuple[float, float]
BoundingBoxTuple = tuple[float, float, float, float]
NormRectTuple = tuple[float, float, float, float]


class RectanglePoints(CamelModel):
    exterior: tuple[Point2D, Point2D]
    interior: list[list[Point2D]] = Field(default_factory=list, max_length=0)


class RectangleGeometry(CamelModel):
    geometry_type: Literal["rectangle"]
    points: RectanglePoints


class PolygonPoints(CamelModel):
    exterior: list[Point2D] = Field(min_length=3)
    interior: list[list[Point2D]] = Field(default_factory=list)


class PolygonGeometry(CamelModel):
    geometry_type: Literal["polygon"]
    points: PolygonPoints


class BitmapData(CamelModel):
    data: str  # zlib-compressed base64 PNG mask
    origin: Point2D


class BitmapGeometry(CamelModel):
    geometry_type: Literal["bitmap"]
    bitmap: BitmapData


class PolylinePoints(CamelModel):
    exterior: list[Point2D] = Field(min_length=2)
    interior: list[list[Point2D]] = Field(default_factory=list, max_length=0)


class PolylineGeometry(CamelModel):
    geometry_type: Literal["polyline"]
    points: PolylinePoints


class SinglePointContainer(CamelModel):
    exterior: tuple[Point2D]
    interior: list[list[Point2D]] = Field(default_factory=list, max_length=0)


class PointGeometry(CamelModel):
    geometry_type: Literal["point"]
    points: SinglePointContainer


class GraphNodeValue(CamelModel):
    loc: Point2D
    disabled: bool = False


class GraphGeometry(CamelModel):
    geometry_type: Literal["graph"]
    nodes: dict[str, GraphNodeValue]


FigureGeometry = Annotated[
    RectangleGeometry | PolygonGeometry | BitmapGeometry | PolylineGeometry | PointGeometry | GraphGeometry,
    Field(discriminator="geometry_type"),
]

_FIGURE_GEOMETRY_ADAPTER = TypeAdapter(FigureGeometry)

GeometryType = Literal["rectangle", "polygon", "bitmap", "polyline", "point", "graph"]


class TagValue(CamelModel):
    tag_id: int | str
    name: str
    value: str | int | float | bool | None = None


class AnnotationFigure(CamelModel):
    figure_id: str
    class_id: int | str
    class_title: str
    geometry_type: GeometryType
    points: dict[str, Any] | None = None
    bitmap: BitmapData | None = None
    nodes: dict[str, GraphNodeValue] | None = None
    tags: list[TagValue] = Field(default_factory=list)
    label_index: int | None = None
    visible: bool = True
    created_at: str | None = None
    updated_at: str | None = None

    @model_validator(mode="after")
    def _validate_geometry_union(self) -> AnnotationFigure:
        """Enforces exact geometry shape parity per geometryType at request boundary."""
        self.to_geometry()
        return self

    def to_geometry(self) -> FigureGeometry:
        payload: dict[str, Any] = {"geometryType": self.geometry_type}
        if self.geometry_type == "bitmap":
            if self.bitmap is None or self.points is not None or self.nodes is not None:
                raise ValueError("bitmap geometry requires 'bitmap' and forbids 'points'/'nodes'")
            payload["bitmap"] = self.bitmap
        elif self.geometry_type == "graph":
            if self.nodes is None or self.points is not None or self.bitmap is not None:
                raise ValueError("graph geometry requires 'nodes' and forbids 'points'/'bitmap'")
            payload["nodes"] = self.nodes
        else:
            if self.points is None or self.bitmap is not None or self.nodes is not None:
                raise ValueError(
                    f"{self.geometry_type} geometry requires 'points' and forbids 'bitmap'/'nodes'"
                )
            payload["points"] = self.points
        return _FIGURE_GEOMETRY_ADAPTER.validate_python(payload)


class GraphNodeTemplate(CamelModel):
    label: str
    loc: Point2D | None = None
    color: str | None = None
    disabled: bool = False


class GraphEdgeTemplate(CamelModel):
    src: str
    dst: str
    color: str | None = None


class GraphConfig(CamelModel):
    nodes: dict[str, GraphNodeTemplate] = Field(default_factory=dict)
    edges: list[GraphEdgeTemplate] = Field(default_factory=list)


class ClassDefinition(CamelModel):
    class_id: int | str
    title: str
    shape: GeometryType
    color: str
    geometry_config: GraphConfig | None = None


class TagDefinition(CamelModel):
    tag_id: int | str
    name: str
    value_type: Literal["none", "any_number", "any_string", "oneof_string"]
    applicable_type: Literal["imagesOnly", "objectsOnly", "all"]
    classes: list[str] = Field(default_factory=list)
    values: list[str] = Field(default_factory=list)


class ProjectOntology(CamelModel):
    project_id: int | str
    project_name: str | None = None
    classes: list[ClassDefinition]
    tags: list[TagDefinition]
    job_classes_to_label: list[str] | None = None
    job_tags_to_label: list[str] | None = None


class ImageContext(CamelModel):
    image_id: str
    entity_id: str | None = None
    dataset_id: str
    job_id: str | None = None
    job_title: str | None = None
    file_name: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    image_hash: str
    image_url: str | None = None


class CanvasSize(CamelModel):
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class ViewportMetadata(CamelModel):
    zoom_percent: float = Field(gt=0)
    visible_norm_rect: NormRectTuple
    visible_pixel_rect: BoundingBoxTuple
    canvas_size: CanvasSize
    source: Literal["minimap", "transform", "fallback_full"]


class UiStateSnapshot(CamelModel):
    synchronize_dirty: bool
    confirm_button_enabled: bool
    is_confirmed: bool
    active_tool: str | None = None
    active_class_title: str | None = None
    state_source: Literal["store", "network_interceptor", "dom_fallback"]
    partial_geometry: bool = False


class DomFigureSummary(CamelModel):
    class_title: str
    figure_count: int = Field(ge=0)
    tagged_count: int = Field(ge=0)
    visible: bool = True


QCMode = Literal["rules", "standard", "deep"]
QCSeverity = Literal["blocker", "warning", "info"]
QCCategory = Literal[
    "workflow", "tags", "geometry", "missed_objects", "classification", "keypoints"
]
QuickFixActionType = Literal[
    "highlight_synchronize",
    "move_tag_image_to_object",
    "add_object_tag",
    "remove_object_tag",
    "remove_image_tag",
    "focus_viewport",
    "inspect_figure",
    "confirm_delete_figure",
    "toggle_class_visibility",
    "select_sidebar_class",
]
ViewportEdgeDirection = Literal[
    "left",
    "right",
    "top",
    "bottom",
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
]


class QCAnalyzeRequest(CamelModel):
    request_id: str
    snapshot_seq: int = Field(ge=0)
    mode: QCMode = "standard"
    profile_id: str | None = None
    async_if_heavy: bool = True
    image: ImageContext
    ontology: ProjectOntology
    image_tags: list[TagValue] = Field(default_factory=list)
    figures: list[AnnotationFigure] = Field(default_factory=list)
    dom_figure_summaries: list[DomFigureSummary] = Field(default_factory=list)
    viewport: ViewportMetadata
    ui_state: UiStateSnapshot

    @model_validator(mode="after")
    def _validate_dom_fallback_figures(self) -> QCAnalyzeRequest:
        if self.ui_state.state_source == "dom_fallback" and self.figures:
            raise ValueError(
                "dom_fallback must send figures=[] and pass counts via domFigureSummaries"
            )
        return self


class QuickFixAction(CamelModel):
    action_id: str
    label: str
    action_type: QuickFixActionType
    target_figure_ids: list[str] | None = None
    class_title: str | None = None
    tag_name: str | None = None
    tag_value: str | int | float | bool | None = None
    focus_rect: BoundingBoxTuple | None = None


class QCFinding(CamelModel):
    finding_id: str
    rule_id: str
    severity: QCSeverity
    category: QCCategory
    title: str
    message: str
    figure_ids: list[str] = Field(default_factory=list)
    image_tag_names: list[str] = Field(default_factory=list)
    missed_object_ids: list[str] = Field(default_factory=list)
    outside_viewport: bool = False
    focus_rect: BoundingBoxTuple | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    suggested_fixes: list[QuickFixAction] = Field(default_factory=list)
    fingerprint: str


class MissedObjectOverlay(CamelModel):
    missed_id: str
    class_title: str
    geometry_type: Literal["rectangle", "polygon", "bitmap"]
    bbox: BoundingBoxTuple
    polygon_points: list[list[Point2D]] | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    sharpness_score: float = Field(ge=0.0)
    outside_viewport: bool
    viewport_edge_direction: ViewportEdgeDirection | None = None
    detector_model: str


class SimulatedTagRecommendation(CamelModel):
    tag_name: str
    value: str | int | float | bool | None = None
    reason: str
    confidence: float = Field(ge=0.0, le=1.0)


class SimulatedObjectCandidate(CamelModel):
    sim_id: str
    sim_index: int = Field(ge=1)
    class_title: str
    recommended_shape: GeometryType
    bbox: BoundingBoxTuple
    polygon_points: list[list[Point2D]] | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    sharpness_score: float = Field(ge=0.0)
    visibility_status: Literal["foreground_clear", "occluded", "border_truncated"]
    occluded_by_sim_indices: list[int] = Field(default_factory=list)
    overlap_iou_max: float = Field(ge=0.0, le=1.0)
    overlap_cover_ratio: float = Field(ge=0.0, le=1.0)
    recommended_object_tags: list[SimulatedTagRecommendation] = Field(default_factory=list)
    outside_viewport: bool
    viewport_edge_direction: ViewportEdgeDirection | None = None
    matched_figure_id: str | None = None


class SimulatedClassSummary(CamelModel):
    class_title: str
    recommended_shape: GeometryType
    total_count: int = Field(ge=0)
    completed_count: int = Field(ge=0)
    remaining_count: int = Field(ge=0)
    foreground_clear_count: int = Field(ge=0)
    occluded_count: int = Field(ge=0)
    border_truncated_count: int = Field(ge=0)
    tag_counts: dict[str, int] = Field(default_factory=dict)


class SceneSimulationPlan(CamelModel):
    total_target_objects: int = Field(ge=0)
    completed_target_objects: int = Field(ge=0)
    primary_target_classes: list[str] = Field(default_factory=list)
    class_summaries: list[SimulatedClassSummary] = Field(default_factory=list)
    candidates: list[SimulatedObjectCandidate] = Field(default_factory=list)
    recommended_image_tags: list[SimulatedTagRecommendation] = Field(default_factory=list)
    misplaced_image_tags: list[str] = Field(default_factory=list)
    ignored_ontology_classes: list[str] = Field(default_factory=list)
    disambiguation_notes: list[str] = Field(default_factory=list)
    active_sidebar_class_warning: str | None = None


class SummaryCounts(CamelModel):
    blocker: int = 0
    warning: int = 0
    info: int = 0


class EngineCapabilities(CamelModel):
    device: Literal["mps", "cpu", "none"]
    models_used: list[str] = Field(default_factory=list)
    degraded_reason: str | None = None


class QCErrorDetail(CamelModel):
    code: str
    message: str


class QCResponse(CamelModel):
    analysis_id: str
    request_id: str
    job_id: str | None = None
    status: Literal["completed", "queued", "running", "failed"]
    image_id: str
    snapshot_seq: int
    mode: QCMode
    profile_id: str
    overall_score: int = Field(ge=0, le=100)
    readiness: Literal["ready", "needs_review", "blocked"]
    summary_counts: SummaryCounts
    findings: list[QCFinding] = Field(default_factory=list)
    missed_objects: list[MissedObjectOverlay] = Field(default_factory=list)
    scene_simulation: SceneSimulationPlan | None = None
    timing_ms: dict[str, float] = Field(default_factory=dict)
    engine_capabilities: EngineCapabilities
    error: QCErrorDetail | None = None


class CacheStats(CamelModel):
    image_count: int = 0
    disk_bytes: int = 0
    max_disk_bytes: int = 1_073_741_824


class HealthResponse(CamelModel):
    status: Literal["ok", "degraded"]
    version: str
    device: Literal["mps", "cpu"]
    loaded_models: list[str] = Field(default_factory=list)
    cache_stats: CacheStats
    uptime_seconds: float = Field(ge=0.0)


class ImageCacheAck(CamelModel):
    image_id: str
    image_hash: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    bytes_stored: int = Field(gt=0)
    cached: Literal[True] = True


class WsEvent(CamelModel):
    event_type: Literal["job_progress", "job_completed", "job_failed", "ping"]
    job_id: str | None = None
    stage: str | None = None
    progress_pct: float | None = Field(default=None, ge=0.0, le=100.0)
    result: QCResponse | None = None
    error: str | None = None


class ClassRuleOverride(CamelModel):
    enabled: bool = True
    min_area_px: int | None = Field(default=None, ge=0)
    min_sharpness: float | None = Field(default=None, ge=0.0)
    detector_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    required_tags: list[str] | None = None
    forbidden_tags: list[str] | None = None
    suppress_missed_object_prompts: bool | None = None


class ProfileMatchers(CamelModel):
    job_title_regex: str | None = None
    project_ids: list[int | str] = Field(default_factory=list)
    dataset_ids: list[int | str] = Field(default_factory=list)


class WorkflowRulesConfig(CamelModel):
    block_on_unsaved_sync: bool = True
    warn_on_empty_image_without_confirm: bool = True


class TagRulesConfig(CamelModel):
    image_only_tags: list[str] = Field(default_factory=list)
    object_only_tags: list[str] = Field(default_factory=lambda: ["Occlusion"])
    occlusion_overlap_iou_threshold: float = Field(default=0.10, ge=0.0, le=1.0)
    occlusion_cover_ratio_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    flag_foreground_occlusion_false_positive: bool = True


class GeometryRulesConfig(CamelModel):
    min_box_area_px: int = Field(default=64, ge=1)
    min_polygon_vertices: int = Field(default=3, ge=3)
    min_polyline_vertices: int = Field(default=2, ge=2)
    min_mask_area_px: int = Field(default=32, ge=1)
    max_disconnected_mask_components: int = Field(default=8, ge=1)
    edge_snap_margin_px: int = Field(default=3, ge=0)
    min_box_iou_tightness: float = Field(default=0.72, ge=0.0, le=1.0)
    require_required_graph_nodes: bool = True


class VisionRulesConfig(CamelModel):
    missed_object_min_confidence: float = Field(default=0.45, ge=0.0, le=1.0)
    min_laplacian_sharpness: float = Field(default=35.0, ge=0.0)
    ignore_background_bokeh: bool = True
    enable_depth_occlusion_ordering: bool = True


class RuleProfile(CamelModel):
    profile_id: str
    name: str
    description: str
    is_builtin: bool = False
    matchers: ProfileMatchers = Field(default_factory=ProfileMatchers)
    workflow_rules: WorkflowRulesConfig = Field(default_factory=WorkflowRulesConfig)
    tag_rules: TagRulesConfig = Field(default_factory=TagRulesConfig)
    geometry_rules: GeometryRulesConfig = Field(default_factory=GeometryRulesConfig)
    vision_rules: VisionRulesConfig = Field(default_factory=VisionRulesConfig)
    class_overrides: dict[str, ClassRuleOverride] = Field(default_factory=dict)


class ProfileListResponse(CamelModel):
    profiles: list[RuleProfile]
    matched_profile_id: str | None = None


ApiErrorCode = Literal[
    "UNAUTHORIZED",
    "IMAGE_CACHE_MISS",
    "INVALID_PAYLOAD",
    "PROFILE_NOT_FOUND",
    "JOB_NOT_FOUND",
    "MODEL_EXECUTION_ERROR",
]


class ApiErrorDetail(CamelModel):
    code: ApiErrorCode
    message: str
    details: dict[str, Any] | None = None


class ApiErrorEnvelope(CamelModel):
    error: ApiErrorDetail
