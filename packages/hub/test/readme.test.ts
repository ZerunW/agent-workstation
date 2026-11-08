/**
 * The readme: GET /api/readme/:doc (both pages from the docs folder, read per request; unknown 404; open route; the
 * `assistant` flag follows the budget check) and POST /api/readme/ask (validation, 403 without credits, rate
 * limit, streaming from a fake Anthropic API with the right request, the api_requests row, nothing logged).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { meteredCostUsd } from "../src/billing.js";
import { AskRateLimiter, readmeSystemPrompt } from "../src/routes/readme.js";
import type { Logger } from "../src/util/log.js";
import { hubFixture, type HubFixture } from "./helpers.js";

const FAKE_KEY = "sk-ant-api03-README-not-a-real-key-000000";
const QUESTION = "Wie verbinde ich meinen Mac? geheim-frage-123";
const ANSWER = ["Öffne die ", "Mac-App. geheim-antwort-456"];
const FEATURES = "# Features\n\nThe server browser and synced projects.";
const STARTED = "# Getting started\n\nInstall the Mac app and sign in with Tailscale.";

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const rec = (obj: unknown, msg?: string) => void lines.push(JSON.stringify(obj) + " " + (msg ?? ""));
  return { lines, debug: rec, info: rec, warn: rec, error: rec };
}

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const USAGE_IN = { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
const STREAM = [
  sse("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: USAGE_IN } }),
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  ...ANSWER.map((text) => sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } }),
  sse("message_stop", {}),
];

interface Seen {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, any>;
}

async function fakeApi() {
  const api = {
    url: "",
    seen: [] as Seen[],
    server: null as unknown as Server,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const part of STREAM) res.write(part);
      res.end();
    },
  };
  api.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      api.seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      api.handler(req, res);
    });
  });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  return api;
}

let h: HubFixture | null = null;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(o: { key?: boolean; pages?: boolean } = {}) {
  const api = await fakeApi();
  cleanups.push(() => new Promise<void>((r) => api.server.close(() => r())), () => api.server.closeAllConnections());
  const log = recordingLogger();
  h = await hubFixture(
    { log },
    (dir) => {
      const docsDir = join(dir, "docs");
      mkdirSync(join(docsDir, "readme"), { recursive: true });
      if (o.pages !== false) {
        writeFileSync(join(docsDir, "readme", "features.md"), FEATURES);
        writeFileSync(join(docsDir, "readme", "getting-started.md"), STARTED);
      }
      return { paths: { docs_dir: docsDir }, billing: { upstream: api.url } };
    },
  );
  if (o.key !== false) writeFileSync(join(h.dir, "anthropic.env"), `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
  else rmSync(join(h.dir, "anthropic.env"), { force: true });
  h.hub.apiKeys.reload();
  return { api, log, h };
}

/** SSE events of a response body. */
function events(body: string): { event: string; data: any }[] {
  return body
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const event = /^event: (.+)$/m.exec(b)?.[1] ?? "";
      const data = /^data: (.+)$/m.exec(b)?.[1] ?? "null";
      return { event, data: JSON.parse(data) };
    });
}

/** Signed in as alice unless `headers` say otherwise (the assistant needs a user). */
const ask = (f: HubFixture, payload: unknown, headers: Record<string, string> = f.as("alice")) => f.app.inject({ method: "POST", url: "/api/readme/ask", headers, payload: payload as Record<string, unknown> });
const question = { messages: [{ role: "user", text: QUESTION }] };

describe("GET /api/readme/:doc", () => {
  it("serves both pages without a user header, read per request; unknown pages 404", async () => {
    const { h } = await setup({ key: false });
    for (const [doc, md] of [["features", FEATURES], ["getting-started", STARTED]] as const) {
      const r = await h.app.inject({ method: "GET", url: `/api/readme/${doc}` });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ doc, markdown: md, assistant: false });
    }
    // A changed page is served at once (no restart).
    writeFileSync(join(h.dir, "docs", "readme", "features.md"), "# Features v2");
    expect((await h.app.inject({ method: "GET", url: "/api/readme/features" })).json().markdown).toBe("# Features v2");
    for (const bad of ["nope", "..%2Fsecret", "FEATURES"]) {
      const r = await h.app.inject({ method: "GET", url: `/api/readme/${bad}` });
      expect(r.statusCode).toBe(404);
      expect(r.json().code).toBe("not_found");
    }
  });

  it("assistant: true while any API credit remains (the reserves included), false once spent or with the budget off", async () => {
    const { h } = await setup();
    const flag = async () => (await h.app.inject({ method: "GET", url: "/api/readme/features" })).json().assistant as boolean;
    expect(h.hub.billing.overBudget()).toBe(false);
    expect(await flag()).toBe(true);
    const spend = (costUsd: number) => h.hub.store.insertApiRequest({ at: new Date().toISOString(), sessionId: "s1", user: "alice", model: "claude-opus-5-5", input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, webSearchRequests: 0, speed: null, costUsd, complete: true });
    const limit = h.hub.billing.limitUsd();
    // Down to the service reserve: sessions stop, the assistant still runs.
    spend(limit - h.hub.billing.serviceReserveUsd());
    expect(h.hub.billing.overBudget()).toBe(true);
    expect(await flag()).toBe(true);
    // Everything spent: no assistant.
    spend(h.hub.billing.serviceReserveUsd());
    expect(await flag()).toBe(false);
    // Budget switched off.
    spend(-limit);
    await h.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: h.as("admin"), payload: { apiMonthlyLimitUsd: 0 } });
    expect(await flag()).toBe(false);
  });
});

describe("POST /api/readme/ask", () => {
  it("validates the conversation", async () => {
    const { h, api } = await setup();
    for (const bad of [{}, { messages: [] }, { messages: [{ role: "user", text: "" }] }, { messages: [{ role: "user", text: "x".repeat(4001) }] }, { messages: Array.from({ length: 21 }, () => ({ role: "user", text: "q" })) }, { messages: [{ role: "system", text: "q" }] }]) {
      const r = await ask(h, bad);
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("invalid_request");
    }
    const endsWithAnswer = await ask(h, { messages: [{ role: "user", text: "q" }, { role: "assistant", text: "a" }] });
    expect(endsWithAnswer.statusCode).toBe(400);
    expect(api.seen).toHaveLength(0);
  });

  it("403 api_unavailable without a key or at the reserve; nothing reaches the API", async () => {
    const { h, api } = await setup({ key: false });
    const r = await ask(h, question);
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("api_unavailable");
    writeFileSync(join(h.dir, "anthropic.env"), `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
    h.hub.apiKeys.reload();
    h.hub.store.insertApiRequest({ at: new Date().toISOString(), sessionId: "s1", user: "alice", model: "claude-opus-5-5", input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, webSearchRequests: 0, speed: null, costUsd: h.hub.billing.limitUsd(), complete: true });
    expect((await ask(h, question)).statusCode).toBe(403);
    expect(api.seen).toHaveLength(0);
  });

  it("streams the answer from the Messages API (Sonnet 5.5, medium effort, both pages in the system prompt) and records an api_requests row", async () => {
    const { h, api, log } = await setup();
    const r = await ask(h, question);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    const evs = events(r.body);
    expect(evs.filter((e) => e.event === "delta").map((e) => e.data.text)).toEqual(ANSWER);
    const done = evs.at(-1)!;
    expect(done.event).toBe("done");

    expect(api.seen).toHaveLength(1);
    const req = api.seen[0]!;
    expect(req.path).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 4000, stream: true, output_config: { effort: "medium" }, messages: [{ role: "user", content: QUESTION }] });
    expect(req.body.thinking).toBeUndefined();
    const system = (req.body.system as { text: string }[]).map((b) => b.text).join("\n");
    expect(system).toContain(FEATURES);
    expect(system).toContain(STARTED);
    expect(system).toContain("Answer only from Agent Workstation's documentation");
    expect(system).toContain("say so plainly");
    expect(system).toContain("language of the user's latest message");

    const rows = h.hub.store.listApiRequests("2000-01-01", "2100-01-01");
    expect(rows).toHaveLength(1);
    const usage = { model: "claude-sonnet-5-5", input: 1200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 50, webSearchRequests: 0, speed: null };
    expect(rows[0]).toMatchObject({ sessionId: null, user: "alice", purpose: "readme", ...usage, complete: true });
    const cost = meteredCostUsd(h.hub.pricing, usage, rows[0]!.at);
    expect(cost).toBeGreaterThan(0);
    expect(rows[0]!.costUsd).toBeCloseTo(cost, 10);
    expect(done.data.costUsd).toBeCloseTo(cost, 6);
    // It counts against this period's API credits.
    expect(h.hub.billing.spentUsd()).toBeCloseTo(cost, 10);

    // Nothing of the conversation (or the key) is logged or stored.
    const dump = JSON.stringify(h.hub.store.db.prepare("SELECT * FROM api_requests").all()) + log.lines.join("\n");
    for (const secret of ["geheim-frage-123", "geheim-antwort-456", FAKE_KEY]) expect(dump).not.toContain(secret);
  });

  it("needs a signed-in user: 401 without a username, and nothing reaches the API", async () => {
    const { h, api } = await setup();
    const r = await ask(h, question, {});
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("user_required");
    expect(api.seen).toHaveLength(0);
  });

  it("records the caller's username; a multi-turn conversation is passed on", async () => {
    const { h, api } = await setup();
    const r = await ask(h, { messages: [{ role: "user", text: "first" }, { role: "assistant", text: "answer" }, { role: "user", text: "second" }] }, h.as("alice"));
    expect(r.statusCode).toBe(200);
    expect(api.seen[0]!.body.messages).toEqual([{ role: "user", content: "first" }, { role: "assistant", content: "answer" }, { role: "user", content: "second" }]);
    expect(h.hub.store.listApiRequests("2000-01-01", "2100-01-01")[0]).toMatchObject({ user: "alice", purpose: "readme", sessionId: null });
  });

  it("an API error becomes an error event (exhausted credits also pause sessions); no row for a refused request", async () => {
    const { h, api } = await setup();
    api.handler = (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }));
    };
    const r = await ask(h, question);
    expect(r.statusCode).toBe(200);
    expect(events(r.body)).toEqual([{ event: "error", data: { code: "api_unavailable", message: expect.any(String) } }]);
    expect(h.hub.store.listApiRequests("2000-01-01", "2100-01-01")).toHaveLength(0);
    expect(h.hub.billing.overBudget()).toBe(true);
    expect((await h.app.inject({ method: "GET", url: "/api/readme/features" })).json().assistant).toBe(false);
  });

  it("rate-limits each caller to 20 questions per 10 minutes", async () => {
    const { h, api } = await setup();
    for (let i = 0; i < 20; i++) expect((await ask(h, question)).statusCode).toBe(200);
    const r = await ask(h, question);
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe("rate_limited");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(api.seen).toHaveLength(20);

    let now = 0;
    const lim = new AskRateLimiter(2, 1000, () => now);
    expect(lim.take("a").ok && lim.take("a").ok).toBe(true);
    expect(lim.take("a")).toEqual({ ok: false, retryAfterS: 1 });
    expect(lim.take("b").ok).toBe(true);
    now = 1000;
    expect(lim.take("a").ok).toBe(true);
  });
});

describe("readmeSystemPrompt", () => {
  it("holds every page under its name", () => {
    const p = readmeSystemPrompt([{ doc: "features", markdown: "A\n" }, { doc: "getting-started", markdown: "B" }]);
    expect(p).toContain('<doc name="features">\nA\n</doc>');
    expect(p).toContain('<doc name="getting-started">\nB\n</doc>');
  });
});
