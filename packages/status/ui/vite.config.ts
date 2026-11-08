import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// The status service serves the build at /status/ (directly on :9100, or behind nginx).
// `npm run dev:ui` runs this with a proxy to a locally running workstation-status (`npm run dev` or `npm run demo`).
export default defineConfig({
  root: here("."),
  base: "/status/",
  build: {
    outDir: here("../dist/ui"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5174,
    proxy: { "/status/api": { target: process.env.WORKSTATION_STATUS_URL ?? "http://127.0.0.1:9100", changeOrigin: true } },
  },
});
