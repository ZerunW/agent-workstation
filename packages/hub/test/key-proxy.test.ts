import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminSettings } from "@agent-workstation/protocol";
import { ApiKeyStore, BillingService } from "../src/billing.js";
import { KeyProxy, PROXY_TOKEN_RE, type ProxyGate } from "../src/keyProxy.js";
import { modelMatchesAllowlist } from "../src/sessions/models.js";
import { AgentExec, type AgentRunAs, type SpawnFn } from "../src/sessions/agentExec.js";
import type { Logger } from "../src/util/log.js";
import { hubFixture, msgBody, runtimeFixture, tempDir, until, type RuntimeFixture } from "./helpers.js";

/** Fake keys only. */
const FAKE_KEY = "sk-ant-api03-PROXYKEY-not-a-real-key-000000";
const OTHER_KEY = "sk-ant-api03-ROTATED-not-a-real-key-1111111";

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const rec = (obj: unknown, msg?: string) => void lines.push(JSON.stringify(obj) + " " + (msg ?? ""));
  return { lines, debug: rec, info: rec, warn: rec, error: rec };
}

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A stand-in for api.anthropic.com: records requests; `handler` answers (default: 200 JSON). */
async function fakeUpstream() {
  const seen: Seen[] = [];
  const u = {
    seen,
    url: "",
    server: null as unknown as Server,
    handler: (_req: Seen, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_1" });
      res.end('{"ok":true}');
    },
  };
  u.server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(s);
      u.handler(s, res);
    });
  });
  await new Promise<void>((r) => u.server.listen(0, "127.0.0.1", r));
  u.url = `http://127.0.0.1:${(u.server.address() as AddressInfo).port}`;
  return u;
}

/** One request to the proxy (the path goes out as is, not normalized); resolves with status, headers and body. */
function call(base: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: Number(new URL(base).port), path, method: o.method ?? "POST", headers: o.headers }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(key: () => string | null = () => FAKE_KEY) {
  const up = await fakeUpstream();
  const log = recordingLogger();
  const proxy = new KeyProxy({ key, log, upstream: up.url });
  await proxy.start();
  cleanups.push(
    () => new Promise<void>((r) => up.server.close(() => r())),
    () => up.server.closeAllConnections(),
    () => proxy.stop(),
  );
  return { up, proxy, log, base: proxy.baseUrl! };
}

describe("API key proxy", () => {
  it("listens on loopback, random port; tokens are hsk- + 32 random bytes", async () => {
    const { proxy, base } = await setup();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
    const a = proxy.issue("s1");
    const b = proxy.issue("s1");
    expect(a.baseUrl).toBe(base);
    expect(a.token).toMatch(PROXY_TOKEN_RE);
    expect(Buffer.from(a.token.slice(4), "base64url")).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
    await proxy.stop();
    expect(proxy.baseUrl).toBeNull();
    expect(proxy.liveTokens).toBe(0);
    expect(() => proxy.issue("s1")).toThrow(expect.objectContaining({ status: 503, code: "api_unavailable" }));
  });

  it("replaces the client's credential with the key; every other header, the query and the body pass through", async () => {
    const { up, proxy, base, log } = await setup();
    const { token } = proxy.issue("s1");
    const body = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 5, messages: [{ role: "user", content: "hi ✓" }] });
    const r = await call(base, "/v1/messages?beta=true", {
      headers: { "x-api-key": token, authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "a-2026-01-01,b-2026-02-02", "content-type": "application/json", "x-stainless-retry-count": "0", "user-agent": "claude-cli/2.1" },
      body,
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"ok":true}');
    expect(r.headers["request-id"]).toBe("req_1");
    const s = up.seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/v1/messages?beta=true");
    expect(s.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(s.headers.authorization).toBeUndefined();
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    expect(s.headers["anthropic-beta"]).toBe("a-2026-01-01,b-2026-02-02");
    expect(s.headers["x-stainless-retry-count"]).toBe("0");
    expect(s.headers["user-agent"]).toBe("claude-cli/2.1");
    expect(s.headers.host).toBe(new URL(up.url).host);
    expect(s.body).toBe(body);
    expect(JSON.stringify(s.headers)).not.toContain(token);

    // count_tokens and the model lookups, with Authorization: Bearer.
    expect((await call(base, "/v1/messages/count_tokens", { headers: { authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(200);
    expect((await call(base, "/v1/models?limit=1000", { method: "GET", headers: { "x-api-key": token } })).status).toBe(200);
    expect((await call(base, "/v1/models/claude-opus-5-5", { method: "GET", headers: { "x-api-key": token } })).status).toBe(200);
    expect(up.seen.map((x) => `${x.method} ${x.url} ${x.headers["x-api-key"] === FAKE_KEY}`)).toEqual([
      "POST /v1/messages?beta=true true",
      "POST /v1/messages/count_tokens true",
      "GET /v1/models?limit=1000 true",
      "GET /v1/models/claude-opus-5-5 true",
    ]);
    const logged = log.lines.join("\n");
    expect(logged).not.toContain("PROXYKEY");
    expect(logged).not.toContain(token.slice(4));
    expect(logged).not.toContain("hi ✓");
  });

  it("keeps upstream status codes and error bodies", async () => {
    const { up, proxy, base } = await setup();
    const { token } = proxy.issue("s1");
    up.handler = (_s, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
    };
    const r = await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: "{}" });
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("7");
    expect(JSON.parse(r.body)).toMatchObject({ error: { type: "rate_limit_error" } });
  });

  it("401 for a missing, unknown or revoked token; nothing reaches upstream", async () => {
    const { up, proxy, base } = await setup();
    const a = proxy.issue("s1");
    const b = proxy.issue("s2");
    const status = async (headers: Record<string, string>) => (await call(base, "/v1/messages", { headers, body: "{}" })).status;
    expect(await status({})).toBe(401);
    expect(await status({ "x-api-key": FAKE_KEY })).toBe(401);
    expect(await status({ "x-api-key": `hsk-${"A".repeat(43)}` })).toBe(401);
    expect(await status({ "x-api-key": a.token.slice(0, -1) })).toBe(401);
    expect(await status({ authorization: `Basic ${a.token}` })).toBe(401);
    expect(up.seen).toHaveLength(0);
    expect(await status({ "x-api-key": a.token })).toBe(200);
    proxy.revoke(a.token);
    expect(await status({ "x-api-key": a.token })).toBe(401);
    expect(await status({ "x-api-key": b.token })).toBe(200);
    proxy.issue("s2");
    proxy.revokeOwner("s2");
    expect(await status({ "x-api-key": b.token })).toBe(401);
    expect(proxy.liveTokens).toBe(0);
    expect(up.seen).toHaveLength(2);
    const r = await call(base, "/v1/messages", { headers: { "x-api-key": "nope" }, body: "{}" });
    expect(JSON.parse(r.body)).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });

  it("404 for every other method and path, even with a live token", async () => {
    const { up, proxy, base } = await setup();
    const { token } = proxy.issue("s1");
    const headers = { "x-api-key": token };
    for (const [method, path] of [
      ["GET", "/v1/messages"],
      ["PUT", "/v1/messages"],
      ["POST", "/v1/complete"],
      ["POST", "/v1/messages/batches"],
      ["GET", "/v1/files"],
      ["POST", "/v1/models"],
      ["GET", "/v1/organizations/users"],
      ["GET", "/api/hello"],
      ["GET", "/"],
      ["POST", "/v1/messages/"],
      ["POST", "/v1/messages/../complete"],
      ["POST", "/v1/messages/%2e%2e/complete"],
      ["POST", "//evil.example/v1/messages"],
      ["GET", "/v1/models/../organizations"],
      ["POST", "/v1/messages?x=<script>"],
    ] as const) {
      expect((await call(base, path, { method, headers, body: method === "GET" ? undefined : "{}" })).status, `${method} ${path}`).toBe(404);
    }
    expect(up.seen).toHaveLength(0);
  });

  it("streams the response chunk by chunk (SSE) without buffering", async () => {
    const { up, proxy, base } = await setup();
    const { token } = proxy.issue("s1");
    let upRes: ServerResponse | null = null;
    up.handler = (_s, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: message_start\ndata: {}\n\n");
      upRes = res;
    };
    const got: string[] = [];
    let status = 0;
    let ended = false;
    const req = request(`${base}/v1/messages?beta=true`, { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" } }, (res) => {
      status = res.statusCode!;
      expect(res.headers["content-type"]).toBe("text/event-stream");
      res.on("data", (d: Buffer) => got.push(d.toString("utf8")));
      res.on("end", () => (ended = true));
    });
    req.end('{"stream":true}');
    await until(() => got.length === 1, 3000, "first event");
    expect(status).toBe(200);
    expect(got[0]).toBe("event: message_start\ndata: {}\n\n");
    upRes!.write("event: content_block_delta\ndata: {\"text\":\"a\"}\n\n");
    await until(() => got.length === 2, 3000, "second event");
    expect(got[1]).toBe('event: content_block_delta\ndata: {"text":"a"}\n\n');
    expect(ended).toBe(false);
    upRes!.end("event: message_stop\ndata: {}\n\n");
    await until(() => ended, 3000, "end of stream");
    expect(got.join("")).toContain("message_stop");
  });

  it("aborts the upstream request when the client disconnects", async () => {
    const { up, proxy, base } = await setup();
    const { token } = proxy.issue("s1");
    let upstreamClosed = false;
    up.handler = (_s, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ping\ndata: {}\n\n");
      res.on("close", () => (upstreamClosed = true));
    };
    let first = false;
    const req = request(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": token } }, (res) => {
      res.on("data", () => (first = true));
      res.on("error", () => undefined);
    });
    req.on("error", () => undefined);
    req.end("{}");
    await until(() => first, 3000, "first event");
    expect(upstreamClosed).toBe(false);
    req.destroy();
    await until(() => upstreamClosed, 3000, "upstream aborted");
  });

  it("reads the key per request: a key file reload takes effect, no key = 401", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "anthropic.env");
    writeFileSync(file, `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
    const keys = new ApiKeyStore({ file, log: recordingLogger(), pollMs: 0 });
    keys.start();
    const { up, proxy, base } = await setup(() => keys.key());
    const { token } = proxy.issue("s1");
    const send = () => call(base, "/v1/messages", { headers: { "x-api-key": token }, body: "{}" });
    expect((await send()).status).toBe(200);
    writeFileSync(file, `ANTHROPIC_API_KEY=${OTHER_KEY}\n`);
    keys.reload();
    expect((await send()).status).toBe(200);
    expect(up.seen.map((s) => s.headers["x-api-key"])).toEqual([FAKE_KEY, OTHER_KEY]);
    writeFileSync(file, "# no key\n");
    keys.reload();
    expect((await send()).status).toBe(401);
    expect(up.seen).toHaveLength(2);
  });

  it("502 in the API's error shape when upstream is unreachable", async () => {
    const proxy = new KeyProxy({ key: () => FAKE_KEY, log: recordingLogger(), upstream: "http://127.0.0.1:9" });
    await proxy.start();
    cleanups.push(() => proxy.stop());
    const r = await call(proxy.baseUrl!, "/v1/messages", { headers: { "x-api-key": proxy.issue("s1").token }, body: "{}" });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body)).toMatchObject({ type: "error", error: { type: "api_error" } });
  });
});

describe("proxy tokens of API-billed Claude processes", () => {
  let fx: RuntimeFixture;
  afterEach(() => fx?.cleanup());

  const settings = { apiMonthlyLimitUsd: 50, apiResetDay: 1 } as AdminSettings;
  const start = async (agentExec?: AgentExec) => {
    const s = await setup();
    fx = runtimeFixture(({ store }) => ({
      billing: new BillingService({ store, settings: { get: () => settings }, keys: { key: () => FAKE_KEY, present: () => true } }),
      apiProxy: s.proxy,
      extraEnv: { ANTHROPIC_API_KEY: FAKE_KEY },
      ...(agentExec ? { agentExec } : {}),
    }));
    return s;
  };
  const apiSession = () => {
    fx.store.ensureUser("alice");
    return fx.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null }).id;
  };
  const turn = async (id: string, n: number) => {
    await fx.sessions.send(id, msgBody(`turn ${n}`));
    await until(() => fx.sessions.statusOf(id).status === "idle" && fx.store.getSession(id)!.turnCount >= n, 3000, `turn ${n}`);
  };
  const works = async (base: string, token: string) => (await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: "{}" })).status;

  it("each process gets its own token: live while it runs, revoked when it exits", async () => {
    const { proxy, base } = await start();
    const id = apiSession();
    await turn(id, 1);
    const env = fx.sdk.last.options.env!;
    expect(env.ANTHROPIC_BASE_URL).toBe(base);
    expect(env.ANTHROPIC_API_KEY).toMatch(PROXY_TOKEN_RE);
    expect(JSON.stringify(env)).not.toContain(FAKE_KEY);
    expect(await works(base, env.ANTHROPIC_API_KEY!)).toBe(200);
    fx.sdk.last.end(); // the Claude process exits
    await until(() => proxy.liveTokens === 0, 3000, "token revoked");
    expect(await works(base, env.ANTHROPIC_API_KEY!)).toBe(401);
    // The next turn starts a new process with a new token.
    await turn(id, 2);
    const next = fx.sdk.last.options.env!.ANTHROPIC_API_KEY!;
    expect(next).not.toBe(env.ANTHROPIC_API_KEY);
    expect(await works(base, next)).toBe(200);
  });

  it("revoked when the session is closed or deleted", async () => {
    const { proxy, base } = await start();
    const a = apiSession();
    const b = apiSession();
    await turn(a, 1);
    const ta = fx.sdk.last.options.env!.ANTHROPIC_API_KEY!;
    await turn(b, 1);
    const tb = fx.sdk.last.options.env!.ANTHROPIC_API_KEY!;
    expect(proxy.liveTokens).toBe(2);
    await fx.sessions.close(a);
    expect(await works(base, ta)).toBe(401);
    expect(await works(base, tb)).toBe(200);
    await fx.sessions.delete(b);
    expect(await works(base, tb)).toBe(401);
    expect(proxy.liveTokens).toBe(0);
  });

  it("as the agent account: the real key is nowhere in the spawn spec (argv, environment, stdin)", async () => {
    const runAs: AgentRunAs = { user: "workstation-agent", exec: "/opt/agent-workstation/bin/workstation-agent-exec", sudo: "/usr/bin/sudo", workRoot: "" };
    const spawned: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; stdin: () => string }[] = [];
    const spawnFn: SpawnFn = (command, args, opts) => {
      const stdin = new PassThrough();
      let written = "";
      stdin.on("data", (d: Buffer) => (written += d.toString("utf8")));
      const child = Object.assign(new EventEmitter(), { pid: 4242, stdin, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
      spawned.push({ command, args, env: opts.env, stdin: () => written });
      return child as unknown as ChildProcess;
    };
    const { base } = await start(new AgentExec(runAs, undefined, spawnFn));
    (runAs as { workRoot: string }).workRoot = fx.root;
    const id = apiSession();
    await turn(id, 1);
    const o = fx.sdk.last.options;
    // What the Agent SDK does with these options: spawn the CLI with its flags and the options' env.
    o.spawnClaudeCodeProcess!({ command: o.pathToClaudeCodeExecutable!, args: ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"], cwd: o.cwd!, env: o.env!, signal: new AbortController().signal });
    expect(spawned).toHaveLength(1);
    const spec = spawned[0]!;
    const all = JSON.stringify({ command: spec.command, args: spec.args, env: spec.env, stdin: spec.stdin() });
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain("sk-ant-");
    expect(spec.args).toContain(`ANTHROPIC_BASE_URL=${base}`);
    expect(spec.stdin()).toMatch(/^ANTHROPIC_API_KEY=hsk-[A-Za-z0-9_-]{43}\0\0$/);
    expect(spec.args.join(" ")).not.toContain("hsk-");
  });
});

describe("the hub's API key proxy", () => {
  it("starts with the hub, forwards to [billing] upstream with the key from the key file, stops with the hub", async () => {
    const up = await fakeUpstream();
    const h = await hubFixture({}, (dir) => {
      writeFileSync(join(dir, "anthropic.env"), `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
      return { billing: { upstream: up.url } };
    });
    try {
      const base = h.hub.apiProxy.baseUrl!;
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const s = (await h.app.inject({ method: "POST", url: "/api/sessions", headers: h.as("alice"), payload: { kind: "chat", billing: "api" } })).json() as { id: string };
      expect((await h.app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: h.as("alice"), payload: msgBody("hi") })).statusCode).toBe(200);
      await until(() => h.sdk.queries.length > 0);
      const env = h.sdk.last.options.env!;
      expect(env.ANTHROPIC_BASE_URL).toBe(base);
      expect(JSON.stringify(env)).not.toContain(FAKE_KEY);
      expect((await call(base, "/v1/messages", { headers: { "x-api-key": env.ANTHROPIC_API_KEY! }, body: "{}" })).status).toBe(200);
      expect(up.seen[0]!.headers["x-api-key"]).toBe(FAKE_KEY);
    } finally {
      await h.close();
      up.server.closeAllConnections();
      await new Promise<void>((r) => up.server.close(() => r()));
    }
    expect(h.hub.apiProxy.baseUrl).toBeNull();
  });
});

describe("the hub's gate on the proxy", () => {
  it("refuses requests with 429 once the budget is used up, and models outside the user's allowlist", async () => {
    const up = await fakeUpstream();
    const h = await hubFixture({}, (dir) => {
      writeFileSync(join(dir, "anthropic.env"), `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
      return { billing: { upstream: up.url } };
    });
    try {
      const base = h.hub.apiProxy.baseUrl!;
      const s = (await h.app.inject({ method: "POST", url: "/api/sessions", headers: h.as("alice"), payload: { kind: "chat", billing: "api" } })).json() as { id: string };
      await h.app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: h.as("alice"), payload: msgBody("hi") });
      await until(() => h.sdk.queries.length > 0);
      const token = h.sdk.last.options.env!.ANTHROPIC_API_KEY!;
      const body = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1, messages: [] });
      expect((await call(base, "/v1/messages", { headers: { "x-api-key": token }, body })).status).toBe(200);

      expect((await h.app.inject({ method: "PATCH", url: "/api/users/alice", headers: h.as("admin"), payload: { modelAllowlist: ["sonnet"] } })).statusCode).toBe(200);
      const denied = await call(base, "/v1/messages", { headers: { "x-api-key": token }, body });
      expect(denied.status).toBe(403);
      expect((await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: body.replace("opus-5-5", "sonnet-4-6") })).status).toBe(200);

      await h.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: h.as("admin"), payload: { apiMonthlyLimitUsd: 1 } });
      const over = await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: body.replace("opus-5-5", "sonnet-4-6") });
      expect(over.status).toBe(429);
      expect(JSON.parse(over.body).error.type).toBe("rate_limit_error");
    } finally {
      await h.close();
      up.server.closeAllConnections();
      await new Promise<void>((r) => up.server.close(() => r()));
    }
  });
});

describe("API key proxy gate", () => {
  async function gated(gate: (owner: string) => ProxyGate | null) {
    const up = await fakeUpstream();
    const proxy = new KeyProxy({ key: () => FAKE_KEY, log: recordingLogger(), upstream: up.url, gate });
    await proxy.start();
    cleanups.push(
      () => new Promise<void>((r) => up.server.close(() => r())),
      () => up.server.closeAllConnections(),
      () => proxy.stop(),
    );
    return { up, proxy, base: proxy.baseUrl! };
  }
  const msg = (model: string) => JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });

  it("refuses with 429 in the API's error shape while the budget is used up; nothing reaches upstream", async () => {
    const { up, proxy, base } = await gated(() => ({ refuse: { status: 429, type: "rate_limit_error", message: "used up" } }));
    const { token } = proxy.issue("s1");
    const r = await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: msg("claude-opus-5-5") });
    expect(r.status).toBe(429);
    expect(JSON.parse(r.body)).toEqual({ type: "error", error: { type: "rate_limit_error", message: "used up" } });
    expect(up.seen).toEqual([]);
    // count_tokens and model lookups are free: not gated.
    expect((await call(base, "/v1/models", { method: "GET", headers: { "x-api-key": token } })).status).toBe(200);
  });

  it("refuses a model outside the user's allowlist (403) and forwards an allowed one with its body intact", async () => {
    const { up, proxy, base } = await gated((owner) => (owner === "limited" ? { modelAllowed: (m) => modelMatchesAllowlist(["sonnet"], m) } : null));
    const limited = proxy.issue("limited").token;
    const free = proxy.issue("free").token;
    const bad = await call(base, "/v1/messages", { headers: { "x-api-key": limited }, body: msg("claude-opus-5-5") });
    expect(bad.status).toBe(403);
    expect(JSON.parse(bad.body).error.type).toBe("permission_error");
    expect(up.seen).toEqual([]);
    const body = msg("claude-sonnet-4-6-20260101");
    expect((await call(base, "/v1/messages", { headers: { "x-api-key": limited }, body })).status).toBe(200);
    expect(up.seen[0]!.body).toBe(body);
    expect(up.seen[0]!.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect((await call(base, "/v1/messages", { headers: { "x-api-key": free }, body: msg("claude-opus-5-5") })).status).toBe(200);
    expect((await call(base, "/v1/messages", { headers: { "x-api-key": limited }, body: "not json" })).status).toBe(403);
  });

  it("forwards the body that was checked: a duplicate `model` key cannot get another model through", async () => {
    const { up, proxy, base } = await gated(() => ({ modelAllowed: (m) => modelMatchesAllowlist(["sonnet"], m) }));
    const token = proxy.issue("limited").token;
    const rest = '"max_tokens":1,"messages":[{"role":"user","content":"hi"}]';
    // The last key is what JSON.parse sees: sonnet is checked and the only one forwarded.
    const dupAllowedLast = `{"model":"claude-opus-5-5",${rest},"model":"claude-sonnet-4-6"}`;
    expect((await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: dupAllowedLast })).status).toBe(200);
    const sent = up.seen[0]!.body;
    expect(sent.match(/"model"/g)).toHaveLength(1);
    expect(JSON.parse(sent).model).toBe("claude-sonnet-4-6");
    expect(up.seen[0]!.headers["content-length"]).toBe(String(Buffer.byteLength(sent)));
    // The other order: the checked model is the (last) disallowed one.
    const dupDeniedLast = `{"model":"claude-sonnet-4-6",${rest},"model":"claude-opus-5-5"}`;
    expect((await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: dupDeniedLast })).status).toBe(403);
    expect(up.seen).toHaveLength(1);
    // A body that is not an object has no model.
    expect((await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: "[1]" })).status).toBe(403);
    expect((await call(base, "/v1/messages", { headers: { "x-api-key": token }, body: "null" })).status).toBe(403);
  });

  it("matches allowlist entries by id or family alias, ignoring [1m] suffixes and dates", () => {
    expect(modelMatchesAllowlist(["opus"], "claude-opus-5-5")).toBe(true);
    expect(modelMatchesAllowlist(["opus"], "claude-sonnet-4-6")).toBe(false);
    expect(modelMatchesAllowlist(["claude-opus-5-5[1m]"], "claude-opus-5-5")).toBe(true);
    expect(modelMatchesAllowlist(["claude-opus-5-5"], "claude-opus-4-8")).toBe(false);
    expect(modelMatchesAllowlist(["claude-haiku-4-5"], "claude-haiku-4-5-20251001")).toBe(true);
    expect(modelMatchesAllowlist([], "claude-opus-5-5")).toBe(false);
  });
});
