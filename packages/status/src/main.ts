/** workstation-status entry point: wires collector, health monitor, probe and HTTP server together. */
import dns from "node:dns/promises";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { LinuxCollector } from "./collect/collector.js";
import { realReaders } from "./collect/readers.js";
import { loadConfig } from "./config.js";
import { backfillDemo, createDemoCollector, demoChecks, demoFetch } from "./demo.js";
import { realExec } from "./health/exec.js";
import { defaultChecks } from "./health/checks.js";
import { HealthMonitor } from "./health/monitor.js";
import type { CheckContext } from "./health/types.js";
import { OriginPolicy, tailscaleSelfFromExec } from "./origin.js";
import { BandwidthProbe } from "./probe.js";
import { hubAwareFetch } from "./hubFetch.js";
import { listenStatus } from "./listen.js";
import { buildServer } from "./server.js";
import { StatusService } from "./service.js";
import { SseHub } from "./sse.js";
import { Store } from "./store.js";
import { SystemInfoProvider } from "./system.js";
import { UsageProxy } from "./usage.js";

function packageVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function findUiDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "ui"), join(here, "..", "dist", "ui")].find((p) => existsSync(join(p, "index.html"))) ?? null;
}

async function main(): Promise<void> {
  const demo = process.env.WORKSTATION_STATUS_DEMO === "1";
  const log = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { svc: "workstation-status" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  let config = loadConfig();
  if (demo) {
    const dataDir = mkdtempSync(join(tmpdir(), "workstation-status-demo-"));
    config = { ...config, listen: "tcp", host: "127.0.0.1", dataDir, dbPath: join(dataDir, "status.sqlite") };
  }
  for (const w of config.warnings) log.warn(w);
  log.info({ config: config.source ?? "defaults", listen: config.listen, socket: config.listen === "unix" ? config.socket : undefined, host: config.host, port: config.port, hub: config.hubSocket ?? config.hubUrl, db: config.dbPath, demo }, "starting workstation-status");

  const store = new Store(config.dbPath);
  const statusVersion = packageVersion();
  const sse = new SseHub();

  const collector = demo
    ? createDemoCollector()
    : new LinuxCollector(realReaders, {
        interfaces: config.interfaces,
        usersRoot: config.usersRoot,
        blockDevice: config.nvmeDevice,
      });
  if (demo) backfillDemo(store, Math.floor(Date.now() / 1000));

  // Calls to the hub go through its local socket; every other URL (the internet checks) uses plain fetch.
  const fetchHub = hubAwareFetch(config);
  const ctx: CheckContext = {
    config,
    exec: realExec,
    fetch: fetchHub,
    readers: realReaders,
    lookupHost: async (host) => (await dns.lookup(host, { all: true, family: 4 })).map((a) => a.address),
  };
  const monitor = new HealthMonitor({
    checks: demo ? demoChecks() : defaultChecks(config),
    ctx,
    store,
    defaultIntervalS: config.healthIntervalS,
  });
  const probe = new BandwidthProbe({
    store,
    fetch: demo ? demoFetch : undefined,
    onChange: (state) => sse.broadcast("probe", state),
    log: (msg, err) => log.warn({ err }, msg),
  });
  const system = new SystemInfoProvider({ config, readers: realReaders, exec: realExec, fetch: fetchHub, statusVersion });
  const usage = new UsageProxy({ hubUrl: config.hubUrl, defaultUser: config.hubUser, fetch: fetchHub });

  const origins = new OriginPolicy(config, demo ? null : tailscaleSelfFromExec(realExec), log);
  const app = buildServer({ config, store, monitor, probe, sse, system, usage, origins, statusVersion, logger: log, uiDir: findUiDir() });
  const service = new StatusService({ config, store, collector, monitor, probe, sse, log });

  const listening = await listenStatus(app, config);
  await service.start();
  log.info(config.listen === "unix" ? { socket: config.socket } : { url: `http://${config.host}:${config.port}/status/` }, "workstation-status listening");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    setTimeout(() => process.exit(1), 8000).unref();
    await service.stop();
    await listening.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
