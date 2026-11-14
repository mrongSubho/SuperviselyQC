import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@ext": path.resolve(__dirname, "extension/src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/extension/unit/**/*.test.{ts,tsx}"],
  },
});
