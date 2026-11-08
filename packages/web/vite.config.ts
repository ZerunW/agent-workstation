import { resolve } from "node:path";
import { loadEnv, type PluginOption } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: `npm run dev -w packages/web` proxies /api, /ws, /healthz, /status to VITE_HUB_URL.
// Embed bundle for the macOS app: `npm run build:embed` -> dist-embed/ with relative asset URLs.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const hub = env.VITE_HUB_URL || process.env.VITE_HUB_URL || "http://localhost:9000";
  const embedBundle = process.env.WORKSTATION_EMBED_BUNDLE === "1";
  return {
    base: embedBundle ? "./" : "/",
    plugins: [react(), tailwindcss() as unknown as PluginOption],
    resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
    server: {
      port: 5173,
      proxy: {
        "/api": { target: hub, changeOrigin: true },
        "/ws": { target: hub, changeOrigin: true, ws: true },
        "/healthz": { target: hub, changeOrigin: true },
        // the .dmg files (/download/<platform>/<version>); /download itself is the web page
        "/download/": { target: hub, changeOrigin: true },
        "/status": { target: hub, changeOrigin: true },
      },
    },
    preview: { port: 4173 },
    build: {
      outDir: embedBundle ? "dist-embed" : "dist",
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        input: (embedBundle
          ? { embed: resolve(import.meta.dirname, "embed.html") }
          : { index: resolve(import.meta.dirname, "index.html"), embed: resolve(import.meta.dirname, "embed.html") }) as Record<string, string>,
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      css: false,
    },
  };
});
