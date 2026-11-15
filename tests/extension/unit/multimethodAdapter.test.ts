import { afterEach, describe, expect, it } from "vitest";
import { extractDomOntologyClasses } from "../../../extension/src/content/domObserver";
import {
  buildPageBridgeSnapshot,
  createInterceptorState,
  extractFromReactStore,
  ingestApiPayload,
} from "../../../extension/src/page/slyStoreAdapter";

describe("Multimethod Supervisely adapter & DOM ontology suffix support", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("preserves hi-res fileMeta dimensions against smaller 1023x979 wrapper/fiber payloads and resolves objects->figures classId/classTitle", () => {
    const state = createInterceptorState();
    ingestApiPayload(
      state,
      "https://quantigo.supervisely.com/public/api/v3/projects.meta?id=99",
      {
        classes: [
          { id: 801, title: "Biscuit_B", shape: "bitmap", color: "#f97316" },
          { id: 802, title: "Apple_B", shape: "bitmap", color: "#22c55e" },
        ],
      },
    );

    // Payload carries hi-res fileMeta (2196x1982) alongside a smaller wrapper preview (1023x979)
    ingestApiPayload(
      state,
      "https://quantigo.supervisely.com/public/api/v3/images.info?id=555001",
      {
        id: 555001,
        datasetId: 4401,
        name: "four_biscuits.jpg",
        width: 1023,
        height: 979,
        fileMeta: { width: 2196, height: 1982, mime: "image/jpeg" },
      },
    );

    // Subsequent preview-sized payload must not shrink already stored 2196x1982 dims
    ingestApiPayload(
      state,
      "https://quantigo.supervisely.com/public/api/v3/images.preview?id=555001",
      {
        id: 555001,
        width: 1023,
        height: 979,
      },
    );

    // Supervisely separated objects[] (classId/classTitle/tags) + figures[] referencing only objectId
    ingestApiPayload(
      state,
      "https://quantigo.supervisely.com/public/api/v3/annotations?imageId=555001",
      {
        imageId: 555001,
        objects: [
          {
            id: 193657081,
            classId: 801,
            classTitle: "Biscuit_B",
            tags: [{ tagId: 91, name: "Truncation" }],
          },
        ],
        figures: [
          {
            id: "fig_bm_api_1",
            objectId: 193657081,
            geometryType: "bitmap",
            geometry: {
              bitmap: { origin: [120, 140], data: "eJwBAQAAAA==" },
            },
          },
        ],
      },
    );
    state.currentImageId = "555001";

    // Before React fiber mounts, snapshot reads the ingested API annotation + fileMeta dims (2196x1982)
    const apiSnap = buildPageBridgeSnapshot(state, 1);
    expect(apiSnap.image).not.toBeNull();
    expect(apiSnap.image?.width).toBe(2196);
    expect(apiSnap.image?.height).toBe(1982);
    const apiFig = apiSnap.figures.find((f) => f.figureId === "fig_bm_api_1");
    expect(apiFig?.classId).toBe(801);
    expect(apiFig?.classTitle).toBe("Biscuit_B");
    expect(apiFig?.tags.map((t) => t.name)).toContain("Truncation");

    // Redux/React fiber also sees separated objectsById and a downscaled 1023x979 container box
    const host = document.createElement("div");
    (host as unknown as Record<string, unknown>).__reactContainer$qc = {
      memoizedProps: {
        store: {
          getState: () => ({
            annotationTool: {
              image: { id: 555001, width: 1023, height: 979 },
              objectsById: {
                "193657082": {
                  id: 193657082,
                  classId: 802,
                  tags: [{ name: "Occlusion" }],
                },
              },
              figuresById: {
                fig_bm_fiber_2: {
                  id: "fig_bm_fiber_2",
                  objectId: 193657082,
                  geometryType: "bitmap",
                  geometry: {
                    origin: [900, 140],
                    data: "eJwBAQAAAA==",
                  },
                },
              },
            },
          }),
        },
      },
      child: null,
      sibling: null,
    };
    document.body.appendChild(host);

    const slice = extractFromReactStore(state);
    expect(state.objectsById["193657082"]?.classTitle).toBe("Apple_B");
    const fiberFig = slice.figures.find((f) => f.figureId === "fig_bm_fiber_2");
    expect(fiberFig?.classId).toBe(802);
    expect(fiberFig?.classTitle).toBe("Apple_B");
    expect(fiberFig?.tags.map((t) => t.name)).toContain("Occlusion");

    const fiberSnap = buildPageBridgeSnapshot(state, 2);
    expect(fiberSnap.image).not.toBeNull();
    expect(fiberSnap.image?.width).toBe(2196);
    expect(fiberSnap.image?.height).toBe(1982);
    const snapFiberFig = fiberSnap.figures.find((f) => f.figureId === "fig_bm_fiber_2");
    expect(snapFiberFig?.classId).toBe(802);
    expect(snapFiberFig?.classTitle).toBe("Apple_B");
    expect(snapFiberFig?.tags.map((t) => t.name)).toContain("Occlusion");
  });

  it("infers Brush/Polygon/Polyline/Keypoint shapes from _B/_P/_L/_K suffixes and data attributes in DOM ontology", () => {
    document.body.innerHTML = `
      <aside>
        <div>Definitions</div>
        <div>CLASSES</div>
        <div class="class-row"><span>Biscuit_B</span></div>
        <div class="class-row"><span>Zone_P</span></div>
        <div class="class-row"><span>Lane_L</span></div>
        <div class="class-row"><span>Human_K</span></div>
        <div class="class-row" data-shape="bitmap"><span>Cup</span></div>
        <div class="class-row"><span>Car</span></div>
      </aside>
    `;
    const classes = extractDomOntologyClasses();
    const byTitle = Object.fromEntries(classes.map((c) => [c.title, c.shape]));
    expect(byTitle["Biscuit_B"]).toBe("bitmap");
    expect(byTitle["Zone_P"]).toBe("polygon");
    expect(byTitle["Lane_L"]).toBe("polyline");
    expect(byTitle["Human_K"]).toBe("graph");
    expect(byTitle["Cup"]).toBe("bitmap");
    expect(byTitle["Car"]).toBe("rectangle");
  });
});
