import { defineConfig, devices } from "@playwright/test";

// e2e specs run against a live hub that serves the built UI (or `vite preview` proxied to one).
// Usage:  E2E_BASE_URL=http://localhost:9000 npm run e2e -w packages/web
// Without E2E_BASE_URL every spec skips itself, so `npm run e2e` is always safe to run.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } }],
});
