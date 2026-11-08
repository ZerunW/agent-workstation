import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // better-sqlite3 and node-pty are native; forks isolate them cleanly.
    pool: "forks",
  },
});
