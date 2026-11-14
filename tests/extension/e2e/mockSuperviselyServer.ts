import http from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync } from "node:zlib";

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

function buildSolidRgbPng(width: number, height: number): Buffer {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = 1 + width * 3;
  const raw = new Uint8Array(height * rowStride);
  for (let y = 0; y < height; y += 1) {
    const base = y * rowStride;
    raw[base] = 0; // filter 0
    for (let x = 0; x < width; x += 1) {
      const p = base + 1 + x * 3;
      raw[p] = (40 + (x % 80)) & 0xff;
      raw[p + 1] = (55 + (y % 60)) & 0xff;
      raw[p + 2] = 95;
    }
  }
  const idatData = new Uint8Array(deflateSync(raw));
  const c1 = makePngChunk("IHDR", ihdr);
  const c2 = makePngChunk("IDAT", idatData);
  const c3 = makePngChunk("IEND", new Uint8Array(0));
  const total = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let pos = 0;
  for (const part of [sig, c1, c2, c3]) {
    total.set(part, pos);
    pos += part.length;
  }
  return Buffer.from(total);
}

const SAMPLE_PNG_1200X900 = buildSolidRgbPng(1200, 900);

const MOCK_PROJECT_META = {
  projectId: 11402,
  projectName: "Quantigo_Mock_Vehicles",
  classes: [
    {
      id: 1,
      title: "car",
      shape: "rectangle",
      color: "#2ce1b4",
    },
  ],
  tags: [
    {
      id: 10,
      name: "Occlusion",
      value_type: "none",
      applicable_type: "objectsOnly",
      classes: [],
      values: [],
    },
  ],
};

function renderMockHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Supervisely Mock Labeling Workspace</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%;
      background: #14171f; color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif;
      overflow: hidden;
    }
    header[data-qc-role="topbar"] {
      height: 52px; padding: 0 16px;
      display: flex; align-items: center; gap: 10px;
      background: #181b22; border-bottom: 1px solid #2b3140;
    }
    .btn {
      padding: 6px 12px; border-radius: 6px; border: 1px solid #394155;
      background: #252b37; color: #f8fafc; font-weight: 600; cursor: pointer;
    }
    .workspace {
      display: grid; grid-template-columns: 210px 1fr 240px; height: calc(100vh - 52px);
    }
    .left-panel, .right-panel {
      background: #1b2029; padding: 12px; border-color: #2b3140; border-style: solid;
      border-width: 0 1px 0 0;
    }
    .right-panel { border-width: 0 0 0 1px; position: relative; }
    .canvas-wrap {
      position: relative; display: flex; align-items: center; justify-content: center;
      background: #0f1218;
    }
    canvas { background: #1e2430; border: 1px solid #2d3446; }
    [data-qc-role="minimap"] {
      position: relative; width: 196px; height: 132px; background: #10141c;
      border: 1px solid #394155; margin-bottom: 12px;
    }
    [data-qc-role="minimap-viewport"] {
      position: absolute; inset: 0; border: 2px solid rgb(239, 68, 68);
    }
  </style>
</head>
<body>
  <header data-qc-role="topbar">
    <span style="font-weight:700; color:#94a3b8;">Quantigo &gt; Vehicles &gt;</span>
    <span data-qc-role="zoom">100%</span>
    <button
      id="sync-btn"
      data-testid="sync-btn"
      data-dirty="true"
      class="btn dirty"
      style="background-color: rgb(251, 191, 36); color: #111827;"
    >Synchronize</button>
    <button
      id="confirm-btn"
      data-testid="confirm-btn"
      class="btn"
    >CONFIRM -&gt;</button>
  </header>

  <div id="root" class="workspace">
    <aside class="left-panel">
      <div style="font-size:11px; color:#94a3b8; margin-bottom:6px;">CURRENT IMAGE TAGS</div>
      <div data-qc-role="image-tags">
        <span data-tag-name="Occlusion" class="tag-chip">Occlusion</span>
      </div>
      <div style="font-size:11px; color:#94a3b8; margin:12px 0 6px;">CLASSES</div>
      <div data-qc-role="classes">
        <div
          class="class-row active"
          data-class-title="car"
          data-shape="rectangle"
          data-active="true"
          style="padding:5px 8px; border:1px solid #2563eb; border-radius:4px; margin-bottom:4px; cursor:pointer;"
        >car</div>
        <div
          class="class-row"
          data-class-title="Horse"
          data-shape="rectangle"
          data-active="false"
          style="padding:5px 8px; border:1px solid #394155; border-radius:4px; cursor:pointer;"
        >Horse</div>
      </div>
      <div style="margin-top:8px;">
        <button type="button" class="btn active" data-qc-tool="rectangle" data-active="true">Rectangle</button>
      </div>
    </aside>

    <main class="canvas-wrap">
      <canvas data-testid="sly-canvas" width="980" height="653"></canvas>
    </main>

    <aside class="right-panel">
      <div data-qc-role="minimap">
        <div data-qc-role="minimap-viewport"></div>
      </div>
      <div style="font-size:11px; color:#94a3b8; margin-bottom:6px;">Objects By Classes</div>
      <div data-qc-role="objects-by-classes">
        <div class="class-row" data-class-title="car" data-count="3" data-visible="true">car (3)</div>
      </div>
    </aside>
  </div>

  <script>
    window.__slyConfirmClicks = 0;
    window.__slyPageKeyEvents = [];

    window.addEventListener("keydown", function (e) {
      window.__slyPageKeyEvents.push({ key: e.key, code: e.code });
    });

    function bindConfirmHandler(el) {
      el.addEventListener("click", function () {
        window.__slyConfirmClicks += 1;
        el.dataset.confirmed = "true";
        el.textContent = "CONFIRMED";
      });
    }
    bindConfirmHandler(document.getElementById("confirm-btn"));

    window.__replaceConfirmButton = function () {
      var oldBtn = document.querySelector('[data-testid="confirm-btn"]');
      var nextBtn = document.createElement("button");
      nextBtn.id = "confirm-btn";
      nextBtn.dataset.testid = "confirm-btn";
      nextBtn.className = "btn";
      nextBtn.textContent = "CONFIRM ->";
      bindConfirmHandler(nextBtn);
      oldBtn.replaceWith(nextBtn);
    };

    var mockStoreState = {
      classes: ${JSON.stringify(MOCK_PROJECT_META.classes)},
      currentImage: {
        imageId: "img_100",
        datasetId: "5501",
        name: "sample_1200x900.png",
        width: 1200,
        height: 900,
        hash: "sha256:mock_img_100",
        link: "/assets/sample_1200x900.png"
      },
      activeTool: "rectangle",
      activeClassTitle: "car",
      isConfirmed: false,
      annotations: {
        imageTags: [
          { tagId: 10, name: "Occlusion", value: null }
        ],
        figures: [
          {
            figureId: "fig_valid_car",
            classId: 1,
            classTitle: "car",
            geometryType: "rectangle",
            points: { exterior: [[100, 120], [320, 290]], interior: [] },
            tags: [],
            labelIndex: 1
          },
          {
            figureId: "fig_oob_car",
            classId: 1,
            classTitle: "car",
            geometryType: "rectangle",
            points: { exterior: [[-18, 40], [180, 160]], interior: [] },
            tags: [],
            labelIndex: 2
          },
          {
            figureId: "fig_micro_car",
            classId: 1,
            classTitle: "car",
            geometryType: "rectangle",
            points: { exterior: [[400, 400], [404, 404]], interior: [] },
            tags: [],
            labelIndex: 3
          }
        ]
      }
    };

    document.getElementById("root").__store = {
      getState: function () { return mockStoreState; }
    };

    window.__fixAllBlockingIssues = function () {
      var syncBtn = document.getElementById("sync-btn");
      syncBtn.dataset.dirty = "false";
      syncBtn.classList.remove("dirty");
      syncBtn.style.backgroundColor = "rgb(37, 43, 55)";
      syncBtn.style.color = "#f8fafc";
      var tagsPanel = document.querySelector('[data-qc-role="image-tags"]');
      if (tagsPanel) tagsPanel.innerHTML = "";
      var classRow = document.querySelector('[data-qc-role="objects-by-classes"] [data-class-title="car"]');
      if (classRow) {
        classRow.dataset.count = "1";
        classRow.textContent = "car (1)";
      }
      mockStoreState.annotations.imageTags = [];
      mockStoreState.annotations.figures = [
        {
          figureId: "fig_valid_car",
          classId: 1,
          classTitle: "car",
          geometryType: "rectangle",
          points: { exterior: [[100, 120], [320, 290]], interior: [] },
          tags: [],
          labelIndex: 1
        }
      ];
    };

    // Draw sample canvas frame and fire realistic Supervisely API reads for interceptor capture
    var canvas = document.querySelector("canvas");
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#263042";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#2ce1b4";
    ctx.lineWidth = 3;
    ctx.strokeRect(80, 90, 180, 120);

    var sidebarClassRows = Array.from(document.querySelectorAll('[data-qc-role="classes"] [data-class-title]'));
    sidebarClassRows.forEach(function (row) {
      row.addEventListener("click", function () {
        sidebarClassRows.forEach(function (other) {
          other.classList.remove("active");
          other.dataset.active = "false";
          other.style.borderColor = "#394155";
        });
        row.classList.add("active");
        row.dataset.active = "true";
        row.style.borderColor = "#2563eb";
        mockStoreState.activeClassTitle = row.dataset.classTitle;
      });
    });

    fetch("/api/projects/11402/meta").catch(function () {});
    fetch("/api/images/img_100").catch(function () {});
  </script>
</body>
</html>`;
}

export interface MockSuperviselyHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startMockSuperviselyServer(): Promise<MockSuperviselyHandle> {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";

    if (urlPath.startsWith("/app/images2/") || urlPath.startsWith("/labeling/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderMockHtml());
      return;
    }

    if (urlPath === "/api/projects/11402/meta") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MOCK_PROJECT_META));
      return;
    }

    if (urlPath === "/api/images/img_100") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          imageId: "img_100",
          datasetId: "5501",
          name: "sample_1200x900.png",
          width: 1200,
          height: 900,
          hash: "sha256:mock_img_100",
          link: "/assets/sample_1200x900.png",
        }),
      );
      return;
    }

    if (urlPath === "/assets/sample_1200x900.png") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(SAMPLE_PNG_1200X900.byteLength),
      });
      res.end(SAMPLE_PNG_1200X900);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
