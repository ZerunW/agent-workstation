import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the protocol sources so they do not need `npm run build -w packages/protocol` first.
      "@agent-workstation/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    // A test process started under systemd (CI runners are) carries INVOCATION_ID, which config.ts reads as production.
    env: { INVOCATION_ID: "" },
  },
});
