#!/usr/bin/env node
/**
 * Downloads the Chromium build that matches the bundled playwright-core into Playwright's cache
 * (~/.cache/ms-playwright on Linux; override with PLAYWRIGHT_BROWSERS_PATH). Run as the account that runs the hub.
 *
 *   npm run install-browser -w packages/browser              # chrome-headless-shell (the default flavor)
 *   npm run install-browser -w packages/browser -- chromium   # the full browser (flavor = "chromium")
 *   npm run install-browser -w packages/browser -- all        # both
 *
 * Never installs system packages (no --with-deps); see README for the apt list.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const req = createRequire(import.meta.url);
const mcpPkg = req.resolve("@playwright/mcp/package.json");
const coreCli = join(dirname(createRequire(mcpPkg).resolve("playwright-core/package.json")), "cli.js");
const arg = process.argv[2] ?? "headless-shell";
const browsers = arg === "all" ? ["chromium-headless-shell", "chromium"] : arg === "chromium" ? ["chromium"] : ["chromium-headless-shell"];
console.log(`Installing ${browsers.join(" + ")} with ${coreCli}`);
const r = spawnSync(process.execPath, [coreCli, "install", ...browsers], { stdio: "inherit" });
process.exit(r.status ?? 1);
