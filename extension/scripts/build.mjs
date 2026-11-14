import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { build as viteBuild } from "vite";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(extDir, "..");
const distDir = path.resolve(extDir, "dist");

const aliasPlugin = {
  name: "repo-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => {
      const sub = args.path.slice("@shared/".length);
      const base = path.resolve(repoRoot, "shared", sub);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { path: candidate };
        }
      }
      return { path: base };
    });
    build.onResolve({ filter: /^@ext\// }, (args) => {
      const sub = args.path.slice("@ext/".length);
      const base = path.resolve(extDir, "src", sub);
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, "index.ts"),
        path.join(base, "index.tsx"),
      ]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { path: candidate };
        }
      }
      return { path: base };
    });
  },
};

function copyStaticAssets() {
  fs.mkdirSync(distDir, { recursive: true });
  fs.copyFileSync(
    path.resolve(extDir, "manifest.json"),
    path.resolve(distDir, "manifest.json"),
  );
  const iconsSrc = path.resolve(extDir, "public/icons");
  const iconsDst = path.resolve(distDir, "icons");
  if (fs.existsSync(iconsSrc)) {
    fs.mkdirSync(iconsDst, { recursive: true });
    for (const entry of fs.readdirSync(iconsSrc)) {
      fs.copyFileSync(path.join(iconsSrc, entry), path.join(iconsDst, entry));
    }
  }
}

async function run() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Build React HTML pages (Popup + Options) via Vite
  await viteBuild({
    configFile: path.resolve(extDir, "vite.config.ts"),
  });

  // 2. Build self-contained MAIN world page interceptor (IIFE, synchronous document_start)
  await esbuild.build({
    entryPoints: [path.resolve(extDir, "src/page/interceptor.ts")],
    outfile: path.resolve(distDir, "src/page/interceptor.js"),
    bundle: true,
    format: "iife",
    target: ["chrome120"],
    platform: "browser",
    plugins: [aliasPlugin],
    minify: false,
  });

  // 3. Build ISOLATED world content script bundle (IIFE with React Shadow UI)
  await esbuild.build({
    entryPoints: [path.resolve(extDir, "src/content/index.ts")],
    outfile: path.resolve(distDir, "src/content/index.js"),
    bundle: true,
    format: "iife",
    target: ["chrome120"],
    platform: "browser",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    plugins: [aliasPlugin],
    minify: false,
  });

  // 4. Build MV3 module Service Worker
  await esbuild.build({
    entryPoints: [path.resolve(extDir, "src/background/serviceWorker.ts")],
    outfile: path.resolve(distDir, "src/background/serviceWorker.js"),
    bundle: true,
    format: "esm",
    target: ["chrome120"],
    platform: "browser",
    plugins: [aliasPlugin],
    minify: false,
  });

  // 5. Copy manifest.json & icons
  copyStaticAssets();
  console.log("Built Chrome MV3 extension bundle ->", distDir);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
