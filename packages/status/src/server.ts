/**
 * HTTP surface of workstation-status (Fastify 5). Routes follow STATUS_ROUTES from @agent-workstation/protocol:
 *
 *   GET  /status/api/metrics?range=1h|6h|24h|7d|30d   MetricsResponse
 *   GET  /status/api/health                            HealthResponse
 *   GET  /status/api/stream                            SSE: hello, metrics, health, probe
 *   POST /status/api/speedtest                         start a bandwidth probe (1/min), GET = state
 *   GET  /status/api/system                            server facts
 *   GET  /status/api/usage                             proxy of the hub's /api/usage/limits (as `[status] hub_user`)
 *
 * Everything under /status/api refuses cross-site requests (origin.ts).
 *
 * plus the static UI at /status/ and /status/* (SPA fallback), /healthz, and / -> /status/.
 */
import Fastify, { LogController, type FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import pino, { type Logger } from "pino";
import { metricUnit } from "./catalog.js";
import type { AppConfig } from "./config.js";
import type { HealthMonitor } from "./health/monitor.js";
import { registerOriginGuard, type OriginPolicy } from "./origin.js";
import type { BandwidthProbe } from "./probe.js";
import { isRange, RANGES, selectResolution, type Range } from "./ranges.js";
import { formatSse, type SseHub } from "./sse.js";
import type { Store } from "./store.js";
import type { SystemInfoProvider } from "./system.js";
import type { UsageProxy } from "./usage.js";

export interface ServerDeps {
  config: AppConfig;
  store: Store;
  monitor: HealthMonitor;
  probe: BandwidthProbe;
  sse: SseHub;
  system: SystemInfoProvider;
  usage: UsageProxy;
  /** Which web origins may call the API (cross-site protection); omit (tests of single routes) for no check. */
  origins?: OriginPolicy;
  statusVersion: string;
  /** Defaults to a silent logger (tests). */
  logger?: Logger;
  /** Directory with the built UI (dist/ui); null when it has not been built. */
  uiDir: string | null;
  nowMs?: () => number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const METRICS_TTL_MS: Record<Range, number> = { "1h": 4000, "6h": 20_000, "24h": 30_000, "7d": 60_000, "30d": 120_000 };

export type StatusApp = ReturnType<typeof buildServer>;

export function buildServer(d: ServerDeps) {
  // Request logging is off: the UI polls and streams constantly, which would drown the journal.
  const app = Fastify({
    loggerInstance: d.logger ?? pino({ level: "silent" }),
    logController: new LogController({ disableRequestLogging: true }),
  });
  const now = () => (d.nowMs ? d.nowMs() : Date.now());

  // Cross-site requests to the API (other web sites in a tailnet device's browser) are refused first.
  if (d.origins) registerOriginGuard(app, d.origins);

  // `curl -X POST -H 'content-type: application/json'` with no body must not be a 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // ---- misc ---------------------------------------------------------------
  const healthz = () => ({ ok: true, service: "workstation-status", version: d.statusVersion });
  app.get("/healthz", async () => healthz());
  app.get("/status/healthz", async () => healthz());
  app.get("/", async (_req, reply) => reply.redirect("/status/"));
  app.get("/status", async (_req, reply) => reply.redirect("/status/"));

  // ---- metrics ------------------------------------------------------------
  const metricsCache = new Map<Range, { at: number; body: unknown }>();
  app.get("/status/api/metrics", async (req, reply) => {
    const range = (req.query as { range?: string }).range ?? "1h";
    if (!isRange(range)) return reply.code(400).send({ error: `range must be one of ${RANGES.join(", ")}` });
    const t = now();
    const hit = metricsCache.get(range);
    reply.header("Cache-Control", "no-store");
    if (hit && t - hit.at < METRICS_TTL_MS[range]) return hit.body;
    const res = selectResolution(range, d.config.sampleIntervalS);
    const series = d.store.queryMetrics(res, Math.floor(t / 1000)).map((s) => ({ name: s.name, unit: metricUnit(s.name), points: s.points }));
    const body = { range, stepS: res.stepS, series };
    metricsCache.set(range, { at: t, body });
    return body;
  });

  // ---- health -------------------------------------------------------------
  app.get("/status/api/health", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return d.monitor.snapshot();
  });

  // ---- SSE ----------------------------------------------------------------
  app.get("/status/api/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    d.sse.attach(res, {
      event: "hello",
      data: { serverTime: new Date(now()).toISOString(), sampleIntervalS: d.config.sampleIntervalS, healthIntervalS: d.config.healthIntervalS },
    });
    // Late joiners get the current health and probe state immediately instead of waiting for the next tick.
    res.write(formatSse({ event: "health", data: d.monitor.snapshot() }));
    res.write(formatSse({ event: "probe", data: d.probe.state() }));
    req.raw.on("close", () => res.end());
  });

  // ---- speed test ---------------------------------------------------------
  app.get("/status/api/speedtest", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return d.probe.state();
  });
  app.post("/status/api/speedtest", async (_req, reply) => {
    const r = d.probe.requestManual();
    if (r.ok) return reply.code(202).send({ started: true, ...d.probe.state() });
    reply.header("Retry-After", String(r.retryAfterS));
    return reply.code(r.reason === "running" ? 409 : 429).send({
      error: r.reason === "running" ? "a speed test is already running" : "speed tests are limited to one per minute",
      reason: r.reason,
      retryAfterS: r.retryAfterS,
    });
  });

  // ---- system / usage -----------------------------------------------------
  app.get("/status/api/system", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return d.system.get();
  });
  // The hub is asked as the configured `[status] hub_user` only, never as the name a caller sends.
  app.get("/status/api/usage", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return d.usage.get();
  });

  // ---- UI -----------------------------------------------------------------
  app.get("/status/*", async (req, reply) => {
    const rel = (req.params as { "*": string })["*"] ?? "";
    if (rel === "api" || rel.startsWith("api/")) return reply.code(404).send({ error: "not found" });
    return serveUi(d.uiDir, rel, reply);
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));
  return app;
}

/** Resolve `rel` inside `uiDir` (never outside) and stream it; unknown extension-less paths get index.html (SPA). */
async function serveUi(uiDir: string | null, rel: string, reply: FastifyReply): Promise<FastifyReply> {
  if (!uiDir) {
    return reply.code(503).type("text/plain; charset=utf-8").send("workstation-status UI is not built. Run: npm run build -w packages/status");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return reply.code(400).send({ error: "bad path" });
  }
  if (decoded.includes("\0")) return reply.code(400).send({ error: "bad path" });

  const root = uiDir.endsWith(sep) ? uiDir : uiDir + sep;
  const candidate = join(uiDir, decoded === "" ? "index.html" : decoded);
  let file = candidate;
  let info = candidate.startsWith(root) ? await stat(candidate).catch(() => null) : null;
  if (!info || !info.isFile()) {
    const last = decoded.split("/").pop() ?? "";
    if (extname(last) !== "" && extname(last) !== ".html") return reply.code(404).send({ error: "not found" });
    file = join(uiDir, "index.html");
    info = await stat(file).catch(() => null);
    if (!info) return reply.code(503).type("text/plain; charset=utf-8").send("workstation-status UI is not built. Run: npm run build -w packages/status");
  }
  const isIndex = file.endsWith(`${sep}index.html`);
  reply
    .header("Content-Type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream")
    .header("Content-Length", info.size)
    .header("Cache-Control", isIndex ? "no-cache" : decoded.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300");
  return reply.send(createReadStream(file));
}
