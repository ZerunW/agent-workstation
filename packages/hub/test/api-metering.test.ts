/**
 * API spend metered in the key proxy: SSE and JSON usage parsing (complete, client abort, upstream failure mid-stream,
 * compressed bodies), no row for non-2xx / count_tokens / models, the stream is not delayed, nothing secret is stored;
 * the hub prices each request with the table (5m / 1h cache writes, web search, fast mode); API spend = metered requests
 * only; a turn killed before its result is still counted; the usage estimates of turns stay out of the API credits.
 */
import { writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { KeyProxy, UsageMeter, type MeteredRequest } from "../src/keyProxy.js";
import type { Logger } from "../src/util/log.js";
import { hubFixture, msgBody, until, type HubFixture } from "./helpers.js";

const FAKE_KEY = "sk-ant-api03-METERKEY-not-a-real-key-000000";
const PROMPT = "secret prompt text ✓";

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const rec = (obj: unknown, msg?: string) => void lines.push(JSON.stringify(obj) + " " + (msg ?? ""));
  return { lines, debug: rec, info: rec, warn: rec, error: rec };
}

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const START = sse("message_start", {
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    usage: { input_tokens: 1000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }, cache_read_input_tokens: 50_000, output_tokens: 1 },
  },
});
const DELTA_TEXT = sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } });
const DELTA_END = sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500, server_tool_use: { web_search_requests: 2 } } });
const STOP = sse("message_stop", {});

/** A fake api.anthropic.com whose `handler` answers. */
async function fakeUpstream() {
  const u = {
    url: "",
    server: null as unknown as Server,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    },
  };
  u.server = createServer((req, res) => {
    req.resume();
    req.on("end", () => u.handler(req, res));
  });
  await new Promise<void>((r) => u.server.listen(0, "127.0.0.1", r));
  u.url = `http://127.0.0.1:${(u.server.address() as AddressInfo).port}`;
  return u;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const up = await fakeUpstream();
  const log = recordingLogger();
  const rows: MeteredRequest[] = [];
  const proxy = new KeyProxy({ key: () => FAKE_KEY, log, upstream: up.url, onMetered: (r) => void rows.push(r) });
  await proxy.start();
  cleanups.push(
    () => new Promise<void>((r) => up.server.close(() => r())),
    () => up.server.closeAllConnections(),
    () => proxy.stop(),
  );
  return { up, proxy, log, rows, base: proxy.baseUrl! };
}

function call(base: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method: o.method ?? "POST", headers: o.headers }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

describe("UsageMeter", () => {
  it("SSE: keeps the latest usage of message_start / message_delta, across any chunk boundaries and CRLF", () => {
    const text = (START + DELTA_TEXT + DELTA_END + STOP).replace(/\n/g, "\r\n");
    const bytes = Buffer.from(text + "", "utf8");
    for (const size of [1, 3, 7, 64, bytes.length]) {
      const m = new UsageMeter("sse");
      for (let i = 0; i < bytes.length; i += size) m.push(bytes.subarray(i, i + size));
      m.end();
      expect(m.complete, `chunk ${size}`).toBe(true);
      expect(m.usage(), `chunk ${size}`).toEqual({ model: "claude-opus-5-5", input: 1000, cacheWrite5m: 1000, cacheWrite1h: 2000, cacheRead: 50_000, output: 500, webSearchRequests: 2, speed: null });
    }
  });

  it("SSE: without message_stop it is incomplete; cache writes without a TTL split count as 5-minute; speed and repeated input fields", () => {
    const m = new UsageMeter("sse");
    m.push(Buffer.from(sse("message_start", { message: { model: "claude-opus-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: 400, output_tokens: 1, speed: "fast" } } })));
    m.push(Buffer.from(sse("message_delta", { usage: { input_tokens: 12, output_tokens: 30, cache_read_input_tokens: null } })));
    m.push(Buffer.from('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4'));
    m.end();
    expect(m.complete).toBe(false);
    expect(m.usage()).toEqual({ model: "claude-opus-5-5", input: 12, cacheWrite5m: 400, cacheWrite1h: 0, cacheRead: 0, output: 30, webSearchRequests: 0, speed: "fast" });
  });

  it("JSON: model and usage of the body; a cut-off or oversized body has no usage", () => {
    const body = JSON.stringify({ id: "m", model: "claude-haiku-5-5", content: [{ type: "text", text: PROMPT }], usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 9 } });
    const m = new UsageMeter("json");
    m.push(Buffer.from(body.slice(0, 20)));
    m.push(Buffer.from(body.slice(20)));
    m.end();
    expect(m.complete).toBe(true);
    expect(m.usage()).toMatchObject({ model: "claude-haiku-5-5", input: 7, cacheRead: 3, output: 9 });
    const cut = new UsageMeter("json");
    cut.push(Buffer.from(body.slice(0, 40)));
    cut.end();
    expect(cut.complete).toBe(false);
    expect(cut.usage()).toMatchObject({ model: null, input: 0, output: 0 });
    const big = new UsageMeter("json");
    big.push(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    big.end();
    expect(big.overflow).toBe(true);
    expect(big.complete).toBe(false);
  });
});

describe("metering in the key proxy", () => {
  it("SSE: bytes reach the client as they arrive; one complete row when the stream ends", async () => {
    const { up, proxy, rows, base, log } = await setup();
    const { token } = proxy.issue("sess-1");
    let upRes: ServerResponse | null = null;
    up.handler = (_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(START);
      upRes = res;
    };
    const got: string[] = [];
    let ended = false;
    const req = request(`${base}/v1/messages?beta=true`, { method: "POST", headers: { "x-api-key": token } }, (res) => {
      res.on("data", (d: Buffer) => got.push(d.toString("utf8")));
      res.on("end", () => (ended = true));
    });
    req.end(JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: PROMPT }] }));
    await until(() => got.join("") === START, 3000, "message_start reaches the client");
    expect(rows).toHaveLength(0); // still streaming
    upRes!.write(DELTA_TEXT);
    await until(() => got.join("").includes("hello"), 3000, "delta reaches the client");
    upRes!.end(DELTA_END + STOP);
    await until(() => ended && rows.length === 1, 3000, "row recorded");
    expect(got.join("")).toBe(START + DELTA_TEXT + DELTA_END + STOP);
    expect(rows[0]).toMatchObject({ owner: "sess-1", model: "claude-opus-5-5", input: 1000, cacheWrite5m: 1000, cacheWrite1h: 2000, cacheRead: 50_000, output: 500, webSearchRequests: 2, complete: true });
    const logged = log.lines.join("\n");
    expect(logged).not.toContain(token.slice(4));
    expect(logged).not.toContain(FAKE_KEY);
    expect(logged).not.toContain(PROMPT);
  });

  it("client disconnect mid-stream: the usage seen so far is recorded as incomplete", async () => {
    const { up, proxy, rows, base } = await setup();
    const { token } = proxy.issue("sess-2");
    let upstreamClosed = false;
    up.handler = (_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(START + sse("message_delta", { usage: { output_tokens: 120 } }));
      res.on("close", () => (upstreamClosed = true));
    };
    let first = false;
    const req = request(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": token } }, (res) => {
      res.on("data", (d: Buffer) => (first = first || d.toString().includes("message_delta")));
      res.on("error", () => undefined);
    });
    req.on("error", () => undefined);
    req.end("{}");
    await until(() => first, 3000, "events arrive");
    req.destroy();
    await until(() => upstreamClosed && rows.length === 1, 3000, "row after abort");
    expect(rows[0]).toMatchObject({ owner: "sess-2", model: "claude-opus-5-5", input: 1000, output: 120, complete: false });
  });

  it("upstream fails mid-stream: recorded as incomplete with what was seen", async () => {
    const { up, proxy, rows, base } = await setup();
    const { token } = proxy.issue("sess-3");
    up.handler = (_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(START, () => setTimeout(() => res.socket?.destroy(), 30));
    };
    await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: "{}" }).catch(() => null);
    await until(() => rows.length === 1, 3000, "row after upstream failure");
    expect(rows[0]).toMatchObject({ owner: "sess-3", input: 1000, output: 1, cacheRead: 50_000, complete: false });
  });

  it("JSON responses (gzip too); no row for errors, count_tokens and model lookups", async () => {
    const { up, proxy, rows, base } = await setup();
    const { token } = proxy.issue("sess-4");
    const headers = { "x-api-key": token };
    const body = JSON.stringify({ id: "m", model: "claude-sonnet-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 70, output_tokens: 9, cache_read_input_tokens: 0 } });
    up.handler = (req, res) => {
      if (req.url!.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end('{"input_tokens":99,"usage":{"input_tokens":99}}');
      }
      if (req.url!.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end('{"data":[]}');
      }
      if (req.headers["x-fail"]) {
        res.writeHead(529, { "content-type": "application/json" });
        return void res.end('{"type":"error","error":{"type":"overloaded_error"},"usage":{"input_tokens":5}}');
      }
      if (req.headers["accept-encoding"] === "gzip") {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        return void res.end(gzipSync(Buffer.from(body)));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    };
    expect((await call(base, "/v1/messages", { headers, body: "{}" })).body).toBe(body);
    await until(() => rows.length === 1);
    const zipped = await new Promise<Buffer>((resolve) => {
      const req = request(`${base}/v1/messages`, { method: "POST", headers: { ...headers, "accept-encoding": "gzip" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.end("{}");
    });
    expect(zipped.equals(gzipSync(Buffer.from(body)))).toBe(true); // passed through still compressed
    await until(() => rows.length === 2);
    expect(rows.map((r) => [r.model, r.input, r.output, r.complete])).toEqual([
      ["claude-sonnet-5-5", 70, 9, true],
      ["claude-sonnet-5-5", 70, 9, true],
    ]);
    expect((await call(base, "/v1/messages", { headers: { ...headers, "x-fail": "1" }, body: "{}" })).status).toBe(529);
    expect((await call(base, "/v1/messages/count_tokens", { headers, body: "{}" })).status).toBe(200);
    expect((await call(base, "/v1/models", { method: "GET", headers })).status).toBe(200);
    expect((await call(base, "/v1/messages", { headers: { "x-api-key": "hsk-nope" }, body: "{}" })).status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect(rows).toHaveLength(2);
  });
});

describe("API spend in the hub", () => {
  let h: HubFixture | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  async function apiHub() {
    const up = await fakeUpstream();
    cleanups.push(
      () => new Promise<void>((r) => up.server.close(() => r())),
      () => up.server.closeAllConnections(),
    );
    h = await hubFixture({}, (dir) => {
      writeFileSync(join(dir, "anthropic.env"), `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
      return { billing: { upstream: up.url } };
    });
    return { h, up };
  }

  const stream = (up: Awaited<ReturnType<typeof fakeUpstream>>, events: string) => {
    up.handler = (_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events);
    };
  };

  it("prices each request with the table (5m / 1h cache writes, web search, fast mode); spend and admin per-user figures use them", async () => {
    const { h, up } = await apiHub();
    const s = (await h.app.inject({ method: "POST", url: "/api/sessions", headers: h.as("alice"), payload: { kind: "chat" } })).json() as { id: string };
    const { token } = h.hub.apiProxy.issue(s.id);
    const base = h.hub.apiProxy.baseUrl!;
    const send = () => call(base, "/v1/messages", { headers: { "x-api-key": token }, body: JSON.stringify({ messages: [{ role: "user", content: PROMPT }] }) });
    stream(up, START + DELTA_END + STOP);
    await send();
    stream(up, sse("message_start", { message: { model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0, speed: "fast" } } }) + sse("message_delta", { usage: { output_tokens: 1_000_000 } }) + STOP);
    await send();
    await until(() => h.hub.store.listApiRequests("2000", "3000").length === 2, 3000, "two rows");
    const rows = h.hub.store.listApiRequests("2000", "3000");
    // Opus 5.5: 1000 in × $4 + 1000 5m-writes × $5 + 2000 1h-writes × $8 + 50K reads × $0.20 + 500 out × $20, + 2 searches × $0.01.
    const first = (1000 * 4 + 1000 * 5 + 2000 * 8 + 50_000 * 0.2 + 500 * 20) / 1e6 + 0.02;
    expect(rows[0]).toMatchObject({ sessionId: s.id, user: "alice", model: "claude-opus-5-5", input: 1000, cacheWrite5m: 1000, cacheWrite1h: 2000, cacheRead: 50_000, output: 500, webSearchRequests: 2, speed: null, complete: true });
    expect(rows[0]!.costUsd).toBeCloseTo(first, 9);
    expect(rows[1]).toMatchObject({ speed: "fast", complete: true });
    expect(rows[1]!.costUsd).toBeCloseTo(8 + 40, 9); // fast mode: 2×
    // Nothing secret stored.
    const dump = JSON.stringify(h.hub.store.db.prepare("SELECT * FROM api_requests").all());
    expect(dump).not.toContain(token.slice(4));
    expect(dump).not.toContain(FAKE_KEY);
    expect(dump).not.toContain(PROMPT);
    // The API credits are the metered sum; admins see it per user.
    expect(h.hub.billing.spentUsd()).toBeCloseTo(first + 48, 9);
    expect(h.hub.usageLimits.current().api).toMatchObject({ spentUsd: Math.round((first + 48) * 10_000) / 10_000 });
    const admin = (await h.app.inject({ url: "/api/admin/usage?range=today", headers: h.as("admin") })).json() as { users: { user: string; apiSpentUsd: number }[] };
    expect(admin.users.find((u) => u.user === "alice")!.apiSpentUsd).toBeCloseTo(first + 48, 4);
  });

  it("a turn killed before its result is still counted; its SDK cost never was", async () => {
    const { h, up } = await apiHub();
    const s = (await h.app.inject({ method: "POST", url: "/api/sessions", headers: h.as("alice"), payload: { kind: "chat" } })).json() as { id: string };
    let token = "";
    h.sdk.behavior = () => undefined; // the turn never reaches a result
    expect((await h.app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: h.as("alice"), payload: msgBody("hi") })).statusCode).toBe(200);
    await until(() => h!.sdk.queries.length > 0);
    token = h.sdk.last.options.env!.ANTHROPIC_API_KEY!;
    // The Claude process makes a request through the proxy, then dies.
    stream(up, START + DELTA_END);
    await call(h.hub.apiProxy.baseUrl!, "/v1/messages", { headers: { "x-api-key": token }, body: "{}" });
    await until(() => h!.hub.store.listApiRequests("2000", "3000").length === 1, 3000, "metered");
    h.sdk.last.end();
    await until(() => h!.hub.apiProxy.liveTokens === 0, 3000, "process gone (token revoked)");
    expect(h.hub.store.db.prepare("SELECT COUNT(*) FROM turns").pluck().get()).toBe(0);
    const row = h.hub.store.listApiRequests("2000", "3000")[0]!;
    expect(row).toMatchObject({ complete: false, output: 500 });
    expect(h.hub.billing.spentUsd()).toBeCloseTo(row.costUsd, 9);
    expect(row.costUsd).toBeGreaterThan(0);
  });

  it("usage estimates of turns; API credits count only metered requests", async () => {
    const { h } = await apiHub();
    const now = new Date().toISOString();
    const turn = (model: string, costUsd = 0) =>
      h.hub.store.insertTurn({ sessionId: "s", user: "alice", kind: "chat", model, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd, durationMs: 1, at: now });
    expect(turn("claude-sonnet-5-5")).toBeCloseTo(2 + 1, 9); // list-price estimate from the table
    expect(turn("claude-opus-5-5", 0.5)).toBe(0.5); // the SDK's own figure is kept
    expect(turn("claude-haiku-5-5")).toBeCloseTo(0.1 + 0.05, 9); // a turn row: base tier
    // Credits = the metered requests, whatever the turn rows say.
    h.hub.store.insertApiRequest({ at: new Date(Date.now() - 1000).toISOString(), sessionId: "s", user: "alice", model: "claude-opus-5-5", input: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, webSearchRequests: 0, speed: null, costUsd: 0.004, complete: true });
    expect(turn("claude-opus-5-5", 0.9)).toBe(0.9);
    expect(h.hub.billing.spentUsd()).toBeCloseTo(0.004, 9);
    const me = (await h.app.inject({ url: "/api/usage/me?range=today", headers: h.as("alice") })).json() as { buckets: { model: string; costUsd: number }[] };
    const cost = (model: string) => me.buckets.filter((b) => b.model === model).reduce((s, b) => s + b.costUsd, 0);
    expect(cost("claude-sonnet-5-5")).toBeCloseTo(3, 9);
    expect(cost("claude-opus-5-5")).toBeCloseTo(1.4, 9);
    const admin = (await h.app.inject({ url: "/api/admin/usage?range=today", headers: h.as("admin") })).json() as { users: { user: string; costUsd: number; apiSpentUsd: number }[] };
    const alice = admin.users.find((u) => u.user === "alice")!;
    expect(alice.costUsd).toBeCloseTo(3 + 0.5 + 0.15 + 0.9, 6);
    expect(alice.apiSpentUsd).toBeCloseTo(0.004, 6);
  });
});

describe("API spend = metered requests", () => {
  it("sums the api_requests of the period, per user and in total", () => {
    const store = new Store(":memory:");
    try {
      const req = (user: string, at: string, cost: number, purpose: string | null = null) =>
        store.insertApiRequest({ at, sessionId: purpose ? null : "s", user, purpose, model: "claude-opus-5-5", input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, webSearchRequests: 0, speed: null, costUsd: cost, complete: true });
      req("alice", "2026-10-05T10:00:00.000Z", 1.25);
      req("bob", "2026-10-06T10:00:00.000Z", 0.5); // e.g. a killed turn: no turn row at all
      req("alice", "2026-10-07T10:00:00.000Z", 0.25, "summary"); // the hub's own helper call
      req("alice", "2026-09-20T10:00:00.000Z", 100); // earlier period
      expect(store.apiSpend("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z")).toBeCloseTo(2, 9);
      expect(store.apiSpend("2026-10-06T00:00:00.000Z", "2026-11-01T00:00:00.000Z")).toBeCloseTo(0.75, 9);
      const byUser = store.apiSpendByUser("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
      expect(byUser.get("alice")).toBeCloseTo(1.5, 9);
      expect(byUser.get("bob")).toBeCloseTo(0.5, 9);
    } finally {
      store.close();
    }
  });
});
