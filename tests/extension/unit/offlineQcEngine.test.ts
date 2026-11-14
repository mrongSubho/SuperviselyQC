import { describe, expect, it } from "vitest";
import { runOfflineDeterministicQc } from "../../../extension/src/content/offlineQcEngine";
import type { QCAnalyzeRequest, RuleProfile } from "../../../extension/src/shared/types";

function makeProfile(overrides: Partial<RuleProfile> = {}): RuleProfile {
  return {
    profileId: "test-profile",
    name: "Test Profile",
    description: "Test",
    isBuiltin: true,
    matchers: { jobTitleRegex: ".*", projectIds: [], datasetIds: [] },
    workflowRules: {
      blockOnUnsavedSync: true,
      warnOnEmptyImageWithoutConfirm: true,
    },
    tagRules: {
      imageOnlyTags: [],
      objectOnlyTags: ["Occlusion"],
      occlusionOverlapIouThreshold: 0.1,
      occlusionCoverRatioThreshold: 0.15,
      flagForegroundOcclusionFalsePositive: true,
    },
    geometryRules: {
      minBoxAreaPx: 64,
      minPolygonVertices: 3,
      minPolylineVertices: 2,
      minMaskAreaPx: 32,
      maxDisconnectedMaskComponents: 8,
      edgeSnapMarginPx: 3,
      minBoxIouTightness: 0.72,
      requireRequiredGraphNodes: true,
    },
    visionRules: {
      missedObjectMinConfidence: 0.45,
      minLaplacianSharpness: 35,
      ignoreBackgroundBokeh: true,
      enableDepthOcclusionOrdering: true,
    },
    classOverrides: {},
    ...overrides,
  };
}

function makeBaseRequest(overrides: Partial<QCAnalyzeRequest> = {}): QCAnalyzeRequest {
  return {
    requestId: "req_1",
    snapshotSeq: 1,
    mode: "rules",
    asyncIfHeavy: false,
    image: {
      imageId: "img_1",
      datasetId: "ds_1",
      fileName: "sample.jpg",
      width: 1000,
      height: 800,
      imageHash: "sha256:abc",
    },
    ontology: {
      projectId: "proj_1",
      classes: [
        { classId: 1, title: "car", shape: "rectangle", color: "#ff0000" },
        { classId: 2, title: "lane", shape: "polyline", color: "#00ff00" },
        { classId: 3, title: "zone", shape: "polygon", color: "#0000ff" },
        { classId: 4, title: "landmark", shape: "point", color: "#ffff00" },
        {
          classId: 5,
          title: "person_pose",
          shape: "graph",
          color: "#00ffff",
          geometryConfig: {
            nodes: {
              nose: { label: "nose" },
              l_eye: { label: "left_eye" },
              r_eye: { label: "right_eye" },
              l_sh: { label: "left_shoulder" },
              r_sh: { label: "right_shoulder" },
              l_ank: { label: "left_ankle" },
              r_ank: { label: "right_ankle" },
            },
            edges: [],
          },
        },
      ],
      tags: [
        {
          tagId: 10,
          name: "Occlusion",
          valueType: "none",
          applicableType: "objectsOnly",
          classes: [],
          values: [],
        },
        {
          tagId: 11,
          name: "weather",
          valueType: "oneof_string",
          applicableType: "imagesOnly",
          classes: [],
          values: ["clear", "rain"],
        },
      ],
    },
    imageTags: [],
    figures: [],
    domFigureSummaries: [],
    viewport: {
      zoomPercent: 100,
      visibleNormRect: [0, 0, 1, 1],
      visiblePixelRect: [0, 0, 1000, 800],
      canvasSize: { width: 1000, height: 800 },
      source: "fallback_full",
    },
    uiState: {
      synchronizeDirty: false,
      confirmButtonEnabled: true,
      isConfirmed: false,
      activeTool: null,
      activeClassTitle: null,
      stateSource: "store",
      partialGeometry: false,
    },
    ...overrides,
  };
}

describe("offlineQcEngine Layer-1 parity", () => {
  it("flags dirty synchronize blocker, empty unconfirmed image, and image tag scope/value issues", async () => {
    const req = makeBaseRequest({
      imageTags: [
        { tagId: 10, name: "Occlusion", value: null },
        { tagId: 11, name: "weather", value: "tornado" },
      ],
      uiState: {
        synchronizeDirty: true,
        confirmButtonEnabled: true,
        isConfirmed: false,
        activeTool: null,
        activeClassTitle: null,
        stateSource: "store",
        partialGeometry: false,
      },
    });

    const res = await runOfflineDeterministicQc(req, makeProfile());
    const ruleIds = res.findings.map((f) => f.ruleId);
    expect(ruleIds).toContain("WORKFLOW_UNSAVED_SYNC");
    expect(ruleIds).toContain("TAG_SCOPE_MISMATCH");
    expect(ruleIds).toContain("TAG_INVALID_VALUE");
    expect(res.readiness).toBe("blocked");

    const syncFinding = res.findings.find((f) => f.ruleId === "WORKFLOW_UNSAVED_SYNC");
    expect(syncFinding?.suggestedFixes[0]?.actionType).toBe("highlight_synchronize");
  });

  it("enforces [-1, W+1] x [-1, H+1] bounds tolerance cleanly", async () => {
    const req = makeBaseRequest({
      figures: [
        {
          figureId: "near_edge_ok",
          classId: 1,
          classTitle: "car",
          geometryType: "rectangle",
          points: { exterior: [[-0.5, -0.5], [1000.5, 800.5]], interior: [] },
          tags: [],
        },
        {
          figureId: "oob_bad",
          classId: 1,
          classTitle: "car",
          geometryType: "rectangle",
          points: { exterior: [[-2, 10], [100, 100]], interior: [] },
          tags: [],
        },
      ],
    });

    const res = await runOfflineDeterministicQc(req, makeProfile());
    const oobFindings = res.findings.filter((f) => f.ruleId === "GEOM_OUT_OF_BOUNDS");
    expect(oobFindings).toHaveLength(1);
    expect(oobFindings[0]?.figureIds).toEqual(["oob_bad"]);
  });

  it("applies scale-invariant s_min micro-click thresholds across 640x480 and 4000x3000 images", async () => {
    const smallImgReq = makeBaseRequest({
      image: {
        imageId: "img_s",
        datasetId: "ds_1",
        fileName: "s.jpg",
        width: 640,
        height: 480,
        imageHash: "sha256:s",
      },
      figures: [
        // min(640, 480)*0.025 = 12px -> 10x10 is micro click even though area=100 >= 64
        {
          figureId: "box_10",
          classId: 1,
          classTitle: "car",
          geometryType: "rectangle",
          points: { exterior: [[20, 20], [30, 30]], interior: [] },
          tags: [],
        },
        {
          figureId: "box_14",
          classId: 1,
          classTitle: "car",
          geometryType: "rectangle",
          points: { exterior: [[60, 60], [74, 74]], interior: [] },
          tags: [],
        },
      ],
    });

    const smallRes = await runOfflineDeterministicQc(smallImgReq, makeProfile());
    const smallMicroIds = smallRes.findings
      .filter((f) => f.ruleId === "GEOM_MICRO_CLICK")
      .flatMap((f) => f.figureIds);
    expect(smallMicroIds).toEqual(["box_10"]);

    // For 4000x3000, s_min = min(15, 0.025*3000) = 15px, so a 16x16 box is accepted
    const largeImgReq = makeBaseRequest({
      image: {
        imageId: "img_l",
        datasetId: "ds_1",
        fileName: "l.jpg",
        width: 4000,
        height: 3000,
        imageHash: "sha256:l",
      },
      figures: [
        {
          figureId: "box_16",
          classId: 1,
          classTitle: "car",
          geometryType: "rectangle",
          points: { exterior: [[100, 100], [116, 116]], interior: [] },
          tags: [],
        },
      ],
    });
    const largeRes = await runOfflineDeterministicQc(largeImgReq, makeProfile());
    expect(largeRes.findings.some((f) => f.ruleId === "GEOM_MICRO_CLICK")).toBe(false);
  });

  it("handles CW vs CCW polygons, bowtie self-intersection, and invalid holes", async () => {
    const req = makeBaseRequest({
      figures: [
        {
          figureId: "poly_cw",
          classId: 3,
          classTitle: "zone",
          geometryType: "polygon",
          points: {
            exterior: [
              [10, 10],
              [10, 60],
              [60, 60],
              [60, 10],
            ],
            interior: [],
          },
          tags: [],
        },
        {
          figureId: "poly_ccw_with_bad_hole",
          classId: 3,
          classTitle: "zone",
          geometryType: "polygon",
          points: {
            exterior: [
              [100, 100],
              [200, 100],
              [200, 200],
              [100, 200],
            ],
            interior: [
              [
                [10, 10],
                [20, 10],
                [20, 20],
              ],
            ],
          },
          tags: [],
        },
        {
          figureId: "poly_bowtie",
          classId: 3,
          classTitle: "zone",
          geometryType: "polygon",
          points: {
            exterior: [
              [300, 300],
              [400, 400],
              [400, 300],
              [300, 400],
            ],
            interior: [],
          },
          tags: [],
        },
      ],
    });

    const res = await runOfflineDeterministicQc(req, makeProfile());
    const ids = res.findings.map((f) => f.ruleId);
    expect(ids).toContain("POLY_SELF_INTERSECTION");
    expect(ids).toContain("POLY_INVALID_HOLE");
    expect(
      res.findings.filter((f) => f.figureIds.includes("poly_cw")),
    ).toHaveLength(0);
  });

  it("detects duplicates across rectangle, polygon, polyline, point, and graph primitives", async () => {
    const req = makeBaseRequest({
      figures: [
        {
          figureId: "r1",
          classId: 1,
          classTitle: "car",
          geometryType: "rectangle",
          points: { exterior: [[10, 10], [110, 110]], interior: [] },
          tags: [],
        },
        {
          figureId: "r2",
          classId: 1,
          classTitle: "car",
          geometryType: "rectangle",
          points: { exterior: [[11, 11], [110, 110]], interior: [] },
          tags: [],
        },
        {
          figureId: "pl1",
          classId: 2,
          classTitle: "lane",
          geometryType: "polyline",
          points: { exterior: [[20, 20], [120, 20], [220, 20]], interior: [] },
          tags: [],
        },
        {
          figureId: "pl2",
          classId: 2,
          classTitle: "lane",
          geometryType: "polyline",
          points: { exterior: [[21, 21], [120, 21], [220, 21]], interior: [] },
          tags: [],
        },
        {
          figureId: "pt1",
          classId: 4,
          classTitle: "landmark",
          geometryType: "point",
          points: { exterior: [[300, 300]], interior: [] },
          tags: [],
        },
        {
          figureId: "pt2",
          classId: 4,
          classTitle: "landmark",
          geometryType: "point",
          points: { exterior: [[302, 302]], interior: [] },
          tags: [],
        },
        {
          figureId: "g1",
          classId: 5,
          classTitle: "person_pose",
          geometryType: "graph",
          nodes: {
            nose: { loc: [500, 200] },
            l_eye: { loc: [510, 190] },
          },
          tags: [],
        },
        {
          figureId: "g2",
          classId: 5,
          classTitle: "person_pose",
          geometryType: "graph",
          nodes: {
            nose: { loc: [501, 201] },
            l_eye: { loc: [511, 191] },
          },
          tags: [],
        },
      ],
    });

    const res = await runOfflineDeterministicQc(req, makeProfile());
    const dupFindings = res.findings.filter((f) => f.ruleId === "DUPLICATE_OBJECT");
    expect(dupFindings).toHaveLength(4);
  });

  it("handles dom_fallback mode cleanly with partial warning and class scope checks", async () => {
    const profile = makeProfile({
      classOverrides: {
        deprecated_cls: {
          enabled: false,
          requiredTags: [],
        },
      },
    });
    const req = makeBaseRequest({
      ontology: {
        projectId: "proj_1",
        classes: [],
        tags: [],
        jobClassesToLabel: ["car"],
      },
      figures: [],
      domFigureSummaries: [
        { classTitle: "deprecated_cls", figureCount: 2, taggedCount: 0, visible: true },
      ],
      uiState: {
        synchronizeDirty: false,
        confirmButtonEnabled: true,
        isConfirmed: false,
        activeTool: null,
        activeClassTitle: null,
        stateSource: "dom_fallback",
        partialGeometry: true,
      },
    });

    const res = await runOfflineDeterministicQc(req, profile);
    const rules = res.findings.map((f) => f.ruleId);
    expect(rules).toContain("WORKFLOW_DOM_FALLBACK_PARTIAL");
    expect(rules).toContain("CLASS_DISABLED_IN_PROFILE");
    expect(rules).toContain("CLASS_OUT_OF_JOB_SCOPE");
    expect(rules).not.toContain("GEOM_OUT_OF_BOUNDS");
  });
});
