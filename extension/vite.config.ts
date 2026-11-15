import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(extRoot, "..");

export default defineConfig({
  root: extRoot,
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@shared": path.resolve(repoRoot, "shared"),
      "@ext": path.resolve(extRoot, "src"),
    },
  },
  build: {
    outDir: path.resolve(extRoot, "dist"),
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        options: path.resolve(extRoot, "src/options/index.html"),
      },
    },
  },
});
