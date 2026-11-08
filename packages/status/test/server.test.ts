import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthResponse, MetricsResponse, UsageLimits } from "@agent-workstation/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HealthMonitor } from "../src/health/monitor.js";
import type { CheckDef } from "../src/health/types.js";
import { OriginPolicy } from "../src/origin.js";
import { BandwidthProbe } from "../src/probe.js";
import { buildServer, type StatusApp } from "../src/server.js";
import { SseHub } from "../src/sse.js";
import { Store } from "../src/store.js";
import { SystemInfoProvider } from "../src/system.js";
import { UsageProxy } from "../src/usage.js";
import { fakeExec, fakeReaders, makeCtx, ok, testConfig } from "./helpers.js";

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

interface Rig {
  app: StatusApp;
  store: Store;
  sse: SseHub;
  probe: BandwidthProbe;
  monitor: HealthMonitor;
  uiDir: string;
  hubCalls: Array<{ url: string; user: string | null }>;
  /** Make the fake speed-test endpoint block until the returned function is called. */
  holdProbe(): () => void;
  setHub(fn: (url: string) => Response | Promise<Response>): void;
  dispose(): Promise<void>;
}

async function makeRig(opts: { withUi?: boolean; checks?: CheckDef[] } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "workstation-status-test-"));
  const uiDir = join(dir, "ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>Agent Workstation status</title><div id=app></div>");
  writeFileSync(join(uiDir, "assets", "app-abc123.js"), "console.log('hi')");
  writeFileSync(join(uiDir, "assets", "app-abc123.css"), "body{}");
  writeFileSync(join(dir, "secret.txt"), "TOP SECRET");

  const config = testConfig({ server: { public_url: "http://100.64.0.1:9000" } });
  const store = new Store(":memory:");
  // 10 minutes of 10 s samples, a gap-free cpu series and a missing interface
  for (let t = NOW_S - 600; t <= NOW_S; t += 10) store.insertSamples(t, { cpu_total_pct: 20 + ((t / 10) % 5), net_tailscale0_rx_bps: null });
  store.rollup(NOW_S);

  const checks: CheckDef[] = opts.checks ?? [
    { id: "hub", label: "workstation-hub API (/healthz)", run: async () => ({ state: "ok", detail: "HTTP 200", latencyMs: 4 }) },
    { id: "unit-extra", label: "Extra service", run: async () => ({ state: "unknown", detail: "not installed" }) },
  ];
  const monitor = new HealthMonitor({ checks, ctx: makeCtx({ config }), store, defaultIntervalS: 60, nowMs: () => NOW_MS });
  await monitor.runDue(true);

  const sse = new SseHub();
  let wall = NOW_MS;
  let gate: Promise<void> | null = null;
  const probeFetch = (async (url: string) => {
    if (gate) await gate;
    return String(url).includes("__down") ? new Response(new Uint8Array(1000)) : new Response("ok");
  }) as unknown as typeof fetch;
  const probe = new BandwidthProbe({ store, fetch: probeFetch, now: () => wall, uploadBytes: 1000 });

  const hubCalls: Rig["hubCalls"] = [];
  let hub: (url: string) => Response | Promise<Response> = () => new Response("{}", { status: 404 });
  const hubFetch = (async (input: string, init?: RequestInit) => {
    hubCalls.push({ url: String(input), user: new Headers(init?.headers).get("x-workstation-user") });
    return hub(String(input));
  }) as unknown as typeof fetch;

  const readers = fakeReaders({
    files: { "/proc/device-tree/model": "Example Server\0", "/proc/cpuinfo": [0, 1, 2, 3].map((i) => `processor\t: ${i}\nCPU part\t: 0xd08\n`).join("\n") },
    statfs: {
      "/": { totalBytes: 100 * 4096, freeBytes: 60 * 4096, availBytes: 55 * 4096 },
      [config.usersRoot]: { totalBytes: 100 * 4096, freeBytes: 60 * 4096, availBytes: 55 * 4096 },
    },
  });
  const system = new SystemInfoProvider({
    config,
    readers,
    exec: fakeExec({ "nginx -v": ok("", "nginx version: nginx/1.24.0 (Ubuntu)\n") }),
    fetch: hubFetch,
    statusVersion: "9.9.9",
    nowMs: () => NOW_MS,
  });
  const usage = new UsageProxy({ hubUrl: config.hubUrl, defaultUser: config.hubUser, fetch: hubFetch, nowMs: () => wall });
  const origins = new OriginPolicy(config, async () => ({ dnsName: "workstation.tailnet.ts.net", ips: ["100.64.0.9", "fd7a:115c:a1e0::9"] }));

  const app = buildServer({ config, store, monitor, probe, sse, system, usage, origins, statusVersion: "9.9.9", uiDir: opts.withUi === false ? null : uiDir, nowMs: () => NOW_MS });
  await app.ready();
  return {
    app,
    store,
    sse,
    probe,
    monitor,
    uiDir,
    hubCalls,
    holdProbe() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    setHub: (fn) => {
      hub = fn;
    },
    async dispose() {
      sse.closeAll();
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let rig: Rig;
beforeEach(async () => {
  rig = await makeRig();
});
afterEach(async () => {
  await rig.dispose();
});

describe("GET /status/api/metrics", () => {
  it("returns a MetricsResponse for every range", async () => {
    for (const range of ["1h", "6h", "24h", "7d", "30d"]) {
      const res = await rig.app.inject({ url: `/status/api/metrics?range=${range}` });
      expect(res.statusCode).toBe(200);
      const body = MetricsResponse.parse(res.json());
      expect(body.range).toBe(range);
      expect(body.series.map((s) => s.name)).toEqual(["cpu_total_pct", "net_tailscale0_rx_bps"]);
    }
  });

  it("defaults to 1h at the sample interval and carries units and null points", async () => {
    const body = MetricsResponse.parse((await rig.app.inject({ url: "/status/api/metrics" })).json());
    expect(body.range).toBe("1h");
    expect(body.stepS).toBe(10);
    const cpu = body.series.find((s) => s.name === "cpu_total_pct")!;
    expect(cpu.unit).toBe("%");
    expect(cpu.points).toHaveLength(361); // now is on the grid, so both ends of the hour are included
    expect(cpu.points.at(-1)?.t).toBe(NOW_S);
    expect(cpu.points.at(-1)?.v).not.toBeNull();
    expect(cpu.points[0]?.v).toBeNull(); // before the first sample
    const ts = body.series.find((s) => s.name === "net_tailscale0_rx_bps")!;
    expect(ts.unit).toBe("bytes/s");
    expect(ts.points.every((p) => p.v === null)).toBe(true);
  });

  it("serves 6h from the 1-minute tier at a 60 s step", async () => {
    const body = MetricsResponse.parse((await rig.app.inject({ url: "/status/api/metrics?range=6h" })).json());
    expect(body.stepS).toBe(60);
    const cpu = body.series.find((s) => s.name === "cpu_total_pct")!;
    expect(cpu.points).toHaveLength(361);
    expect(cpu.points.filter((p) => p.v !== null).length).toBeGreaterThanOrEqual(9);
  });

  it("rejects unknown ranges", async () => {
    const res = await rig.app.inject({ url: "/status/api/metrics?range=2h" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("1h, 6h, 24h, 7d, 30d");
  });
});

describe("GET /status/api/health", () => {
  it("returns a HealthResponse with the latest events", async () => {
    const body = HealthResponse.parse((await rig.app.inject({ url: "/status/api/health" })).json());
    expect(body.checks.map((c) => [c.id, c.state])).toEqual([
      ["hub", "ok"],
      ["unit-extra", "unknown"],
    ]);
    expect(body.checks[0]).toMatchObject({ detail: "HTTP 200", latencyMs: 4, label: "workstation-hub API (/healthz)" });
    expect(body.events).toEqual([]);
  });

  it("exposes at most the last 100 events, newest first", async () => {
    for (let i = 0; i < 130; i++) rig.store.recordEvent({ at: new Date(NOW_MS + i * 1000).toISOString(), id: "hub", from: "ok", to: "fail", detail: String(i) });
    const body = HealthResponse.parse((await rig.app.inject({ url: "/status/api/health" })).json());
    expect(body.events).toHaveLength(100);
    expect(body.events[0]?.detail).toBe("129");
  });
});

describe("speed test routes", () => {
  it("POST starts a probe (202); while it runs another POST is 409; afterwards 429 + Retry-After", async () => {
    const release = rig.holdProbe();
    const first = await rig.app.inject({ method: "POST", url: "/status/api/speedtest" });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ started: true, running: true });
    const during = await rig.app.inject({ method: "POST", url: "/status/api/speedtest" });
    expect(during.statusCode).toBe(409);
    expect(during.json().reason).toBe("running");
    release();
    await new Promise((r) => setTimeout(r, 50));
    const again = await rig.app.inject({ method: "POST", url: "/status/api/speedtest" });
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    expect(again.json()).toMatchObject({ reason: "rate_limited", retryAfterS: 60 });
  });

  it("accepts a JSON content type with an empty body", async () => {
    const res = await rig.app.inject({ method: "POST", url: "/status/api/speedtest", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(202);
  });

  it("GET reports the probe state including the last result", async () => {
    await rig.probe.run("manual");
    const body = (await rig.app.inject({ url: "/status/api/speedtest" })).json();
    expect(body.running).toBe(false);
    expect(body.last.trigger).toBe("manual");
    expect(typeof body.last.downMbps === "number" || body.last.downMbps === null).toBe(true);
  });
});

describe("GET /status/api/system", () => {
  it("describes the server", async () => {
    rig.setHub((url) =>
      url.endsWith("/api/health")
        ? new Response(JSON.stringify({ ok: true, version: "0.7.1", protocolVersion: 1, uptimeS: 9, serverTime: "2026-10-31T12:00:00Z", agents: { claude: "2.1.314 (Claude Code)" }, processes: { claude: 2 } }))
        : new Response("{}", { status: 404 }),
    );
    const body = (await rig.app.inject({ url: "/status/api/system" })).json();
    expect(body.model).toBe("Example Server"); // trailing NUL from the device tree is stripped
    expect(body.node).toBe(process.version);
    expect(body.versions.status).toBe("9.9.9");
    // hub and Claude Code versions come from the hub's /api/health
    expect(body.versions).toMatchObject({ hub: "0.7.1", claude: "2.1.314 (Claude Code)", tailscale: null, proxy: "nginx 1.24.0" });
    expect(body.cpu).toBe("4× Cortex-A72");
    expect(body.interfaces).toEqual(["tailscale0"]);
    expect(body.thresholds).toEqual({ diskWarnPercent: 80, diskBlockPercent: 95 });
    expect(body.intervals).toEqual({ sampleS: 10, healthS: 60, speedProbeMin: 60 });
    expect(body.links).toEqual({ hubPublicUrl: "http://100.64.0.1:9000", hubPort: 9000 });
    expect(body.disks).toHaveLength(2);
    expect(body.disks[0]).toMatchObject({ path: "/", usedBytes: 40 * 4096, totalBytes: 100 * 4096 });
    expect(body.disks[1].label).toContain("same filesystem");
    expect(body.uptimeS).toBeGreaterThan(0);
  });
});

describe("GET /status/api/usage", () => {
  const apiBlock = { spentUsd: 12, limitUsd: 100, percent: 12, periodStart: "2026-12-15T00:00:00Z", resetsAt: "2027-01-15T00:00:00Z", severity: "normal" };
  const good = { api: apiBlock };

  it("proxies the hub's limits and validates them against the protocol schema", async () => {
    rig.setHub(() => new Response(JSON.stringify(good), { headers: { "content-type": "application/json" } }));
    const res = await rig.app.inject({ url: "/status/api/usage" });
    expect(res.statusCode).toBe(200);
    expect(UsageLimits.parse(res.json())).toEqual(good);
    expect(rig.hubCalls[0]?.url).toBe("http://127.0.0.1:9000/api/usage/limits");
  });

  it("passes the API-credits block through untouched (null = not set up stays null)", async () => {
    rig.setHub(() => new Response(JSON.stringify(good)));
    expect(UsageLimits.parse((await rig.app.inject({ url: "/status/api/usage" })).json()).api).toEqual(apiBlock);

    await rig.dispose();
    rig = await makeRig();
    rig.setHub(() => new Response(JSON.stringify({ ...good, api: null })));
    expect((await rig.app.inject({ url: "/status/api/usage" })).json().api).toBeNull();
  });

  it("asks the hub as the configured hub_user only, never as the name the caller sends (the hub creates users for names it sees)", async () => {
    rig.setHub(() => new Response(JSON.stringify(good)));
    await rig.app.inject({ url: "/status/api/usage", headers: { "x-workstation-user": "alice" } });
    await rig.app.inject({ url: "/status/api/usage", headers: { "x-workstation-user": "Not A User!" } });
    await rig.app.inject({ url: "/status/api/usage?user=mallory", headers: { "x-workstation-user": "mallory" } });
    expect(rig.hubCalls.map((c) => c.user)).toEqual(["status"]); // one call: the answer is cached, whoever asks
    rig.hubCalls.length = 0;
    await rig.dispose();
    rig = await makeRig();
    rig.setHub(() => new Response(JSON.stringify(good)));
    await rig.app.inject({ url: "/status/api/usage", headers: { "x-workstation-user": "alice" } });
    expect(rig.hubCalls.map((c) => c.user)).toEqual(["status"]);
  });

  it("sends no user at all when hub_user is empty", async () => {
    const calls: Array<string | null> = [];
    const proxy = new UsageProxy({
      hubUrl: "http://127.0.0.1:9000",
      defaultUser: null,
      fetch: (async (_u: string, init?: RequestInit) => {
        calls.push(new Headers(init?.headers).get("x-workstation-user"));
        return new Response(JSON.stringify(good));
      }) as unknown as typeof fetch,
    });
    await proxy.get();
    expect(calls).toEqual([null]);
  });

  it("degrades to an error notice when the hub is down or answers garbage", async () => {
    rig.setHub(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const down = (await rig.app.inject({ url: "/status/api/usage" })).json();
    expect(down).toMatchObject({ api: null, error: "hub unreachable: connection refused" });

    await rig.dispose();
    rig = await makeRig();
    rig.setHub(() => new Response("<html>", { status: 502 }));
    expect((await rig.app.inject({ url: "/status/api/usage" })).json().error).toBe("hub answered HTTP 502");

    await rig.dispose();
    rig = await makeRig();
    rig.setHub(() => new Response(JSON.stringify({ nonsense: true })));
    expect((await rig.app.inject({ url: "/status/api/usage" })).json().error).toBe("hub returned an unexpected usage payload");
  });
});

describe("cross-site protection of the API", () => {
  const evil = { origin: "https://evil.example" };
  const api = ["/status/api/metrics", "/status/api/health", "/status/api/system", "/status/api/usage", "/status/api/speedtest", "/status/api/stream"];

  it("refuses a disallowed Origin or Sec-Fetch-Site: cross-site on every API route and method, with code cross_site", async () => {
    for (const url of api) {
      for (const headers of [evil, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { ...evil, "sec-fetch-site": "same-origin" }]) {
        const r = await rig.app.inject({ method: "GET", url, headers });
        expect(r.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(403);
        expect(r.json().code).toBe("cross_site");
      }
    }
    for (const headers of [evil, { "sec-fetch-site": "cross-site" }]) {
      const r = await rig.app.inject({ method: "POST", url: "/status/api/speedtest", headers });
      expect(r.statusCode).toBe(403);
    }
    expect(rig.probe.state().running).toBe(false);
  });

  it("refuses percent-encoded and double-slash spellings of the API path", async () => {
    for (const url of ["/status/%61pi/metrics", "//status/api/metrics", "/status/./api/metrics", "/x/../status/api/metrics", "/status/api%2fmetrics"]) {
      const r = await rig.app.inject({ method: "GET", url, headers: { "sec-fetch-site": "cross-site" } });
      expect(r.statusCode, url).toBe(403);
    }
  });

  it("allows same-origin, the server's own origins and requests without either header", async () => {
    for (const headers of [
      {},
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { origin: "http://100.64.0.1:9000" },
      { origin: "https://workstation.tailnet.ts.net" },
      { origin: "http://100.64.0.9" },
      { origin: "http://[fd7a:115c:a1e0::9]" },
      { origin: "http://127.0.0.1:9100" },
      { origin: "http://localhost:9000" },
    ]) {
      const r = await rig.app.inject({ method: "GET", url: "/status/api/health", headers });
      expect(r.statusCode, JSON.stringify(headers)).toBe(200);
    }
    expect((await rig.app.inject({ method: "POST", url: "/status/api/speedtest", headers: { origin: "https://workstation.tailnet.ts.net" } })).statusCode).toBe(202);
  });

  it("the page and the health route are not guarded", async () => {
    expect((await rig.app.inject({ url: "/status/", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } })).statusCode).toBe(200);
    expect((await rig.app.inject({ url: "/healthz", headers: evil })).statusCode).toBe(200);
  });

  it("with tailscaled unreadable only the fixed origins are allowed", async () => {
    const policy = new OriginPolicy(testConfig({ server: { public_url: "https://ws.example.com" } }), async () => Promise.reject(new Error("down")));
    expect(await policy.allowed("https://ws.example.com")).toBe(true);
    expect(await policy.allowed("https://workstation.tailnet.ts.net")).toBe(false);
  });
});

describe("static UI", () => {
  it("serves index.html at /status/ without caching", async () => {
    const res = await rig.app.inject({ url: "/status/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toContain("<title>Agent Workstation status</title>");
  });

  it("serves hashed assets as immutable", async () => {
    const js = await rig.app.inject({ url: "/status/assets/app-abc123.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const css = await rig.app.inject({ url: "/status/assets/app-abc123.css" });
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
  });

  it("falls back to index.html for app routes (SPA) but 404s missing files", async () => {
    const route = await rig.app.inject({ url: "/status/some/deep/route" });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("<title>Agent Workstation status</title>");
    expect((await rig.app.inject({ url: "/status/assets/missing.js" })).statusCode).toBe(404);
    expect((await rig.app.inject({ url: "/status/api/nope" })).statusCode).toBe(404);
  });

  it("never serves files outside the UI directory", async () => {
    for (const url of ["/status/..%2Fsecret.txt", "/status/%2e%2e/secret.txt", "/status/assets/..%2f..%2fsecret.txt", "/status/%2e%2e%2f%2e%2e%2fetc%2fpasswd"]) {
      const res = await rig.app.inject({ url });
      expect(res.body).not.toContain("TOP SECRET");
      expect(res.body).not.toContain("root:");
    }
    expect((await rig.app.inject({ url: "/status/%00" })).statusCode).toBe(400);
    expect((await rig.app.inject({ url: "/status/%E0%A4%A" })).statusCode).toBe(400);
  });

  it("redirects / and /status to /status/", async () => {
    for (const url of ["/", "/status"]) {
      const res = await rig.app.inject({ url });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/status/");
    }
  });

  it("explains itself when the UI has not been built", async () => {
    await rig.dispose();
    rig = await makeRig({ withUi: false });
    const res = await rig.app.inject({ url: "/status/" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("npm run build -w packages/status");
  });

  it("has a health endpoint of its own", async () => {
    expect((await rig.app.inject({ url: "/healthz" })).json()).toEqual({ ok: true, service: "workstation-status", version: "9.9.9" });
  });
});

describe("GET /status/api/stream (SSE over a real socket)", () => {
  async function readFrames(res: Response, count: number, timeoutMs = 3000): Promise<string[]> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const frames: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (frames.length < count && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 500))]);
      if (value) buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        frames.push(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
      if (done && frames.length < count && !value) break;
    }
    await reader.cancel().catch(() => undefined);
    return frames;
  }

  it("sends hello, current health and probe state, then live broadcasts", async () => {
    const addr = await rig.app.listen({ host: "127.0.0.1", port: 0 });
    const ac = new AbortController();
    const res = await fetch(`${addr}/status/api/stream`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    setTimeout(() => rig.sse.broadcast("metrics", { t: NOW_S + 10, values: { cpu_total_pct: 12.5 } }), 100);
    const frames = await readFrames(res, 4);
    ac.abort();

    expect(frames[0]).toMatch(/^retry: 3000\nevent: hello\ndata: \{.*"sampleIntervalS":10.*\}$/);
    const events = frames.map((f) => /^event: (\w+)/m.exec(f)?.[1]);
    expect(events).toEqual(["hello", "health", "probe", "metrics"]);
    const health = JSON.parse(/^data: (.*)$/m.exec(frames[1]!)![1]!);
    expect(HealthResponse.parse(health).checks).toHaveLength(2);
    expect(JSON.parse(/^data: (.*)$/m.exec(frames[3]!)![1]!)).toEqual({ t: NOW_S + 10, values: { cpu_total_pct: 12.5 } });
  });
});
