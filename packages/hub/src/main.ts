/** workstation-hub entry point: `node dist/main.js` (or `tsx watch src/main.ts`). */
import pino from "pino";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createHub, startHub, stopHub } from "./hub.js";
import { listenHub } from "./listen.js";
import { loadRealSdk } from "./sessions/sdk.js";
import { startupChecks } from "./startupChecks.js";

async function main(): Promise<void> {
  const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "workstation-hub" } });
  const config = loadConfig();
  const report = await startupChecks(config);
  for (const w of report.warnings) log.warn(w);
  if (report.errors.length > 0) {
    for (const e of report.errors) log.fatal(e);
    process.exit(1);
  }
  // With [agents] run_as the transcripts are in the agent account's ~/.claude (group-readable through workstation-work);
  // the SDK's getSessionMessages() reads them in this process from CLAUDE_CONFIG_DIR.
  if (config.agents.runAs) process.env.CLAUDE_CONFIG_DIR = config.paths.claudeHome;
  const sdk = await loadRealSdk();
  const hub = createHub(config, { log, sdk });
  const app = await buildApp(hub, { logger: log });
  await startHub(hub);
  const listening = await listenHub(app, config, log);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      log.error("shutdown timed out; exiting");
      process.exit(1);
    }, 20_000);
    force.unref();
    try {
      hub.ws.closeAll();
      await listening.close();
      await stopHub(hub);
      log.info("bye");
      process.exit(0);
    } catch (err) {
      log.error({ err: String(err) }, "shutdown failed");
      process.exit(1);
    }
  };
  // SIGHUP: re-read the Anthropic API key file now (it is also re-read when its mtime changes, checked every 60 s).
  process.on("SIGHUP", () => {
    log.info("SIGHUP: reloading the Anthropic API key file");
    hub.apiKeys.reload();
  });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error({ err: String(err) }, "unhandled rejection"));
}

main().catch((err) => {
  console.error("workstation-hub failed to start:", err);
  process.exit(1);
});
