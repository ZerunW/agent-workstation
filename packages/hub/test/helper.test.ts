/**
 * The hub's helper model (helper.ts): one-shot Claude Haiku calls over the Messages API with the hub's key, no tools,
 * each billed as an api_requests row with its purpose and user; unavailable without a key or budget; failures come back
 * as outcomes, never as exceptions. The download check built on it degrades to "ask the person".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answerJson, DOWNLOAD_CHECK_MAX_TOKENS, HELPER_PROMPT_MAX_BYTES, SUMMARY_MAX_TOKENS, helperAvailable, helperUnavailableReason, runHelper } from "../src/helper.js";
import { HELPER_MODEL } from "../src/sessions/models.js";
import { helperDownloadJudge } from "../src/sessions/download.js";
import { hubFixture, type HubFixture } from "./helpers.js";

let h: HubFixture | null = null;
let server: Server | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const answer = (text: string, input = 500, output = 40) =>
  [
    sse("message_start", { message: { id: "m", type: "message", role: "assistant", model: HELPER_MODEL, content: [], usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } }),
    sse("message_stop", {}),
  ].join("");

type Reply = { text: string } | { status: number; body?: unknown };
const api = { seen: [] as { headers: IncomingMessage["headers"]; body: Record<string, any> }[], reply: (): Reply => ({ text: "hello" }) };

async function setup(o: { key?: boolean } = {}) {
  api.seen = [];
  api.reply = () => ({ text: "hello" });
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      api.seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      const r = api.reply();
      if ("status" in r) {
        res.writeHead(r.status, { "content-type": "application/json" });
        return void res.end(JSON.stringify(r.body ?? { type: "error", error: { type: "api_error", message: "boom" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(answer(r.text));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h = await hubFixture({}, (dir) => {
    if (o.key === false) writeFileSync(join(dir, "anthropic.env"), "");
    return { billing: { upstream: url } };
  });
  return h.hub;
}

describe("runHelper", () => {
  it("sends one tool-less Haiku request with the hub's key and bills it with its purpose and user", async () => {
    const hub = await setup();
    const out = await runHelper(hub, "Say hello.", { purpose: "summary", user: "alice", system: "Be brief.", maxTokens: 123 });
    expect(out).toMatchObject({ ok: true, text: "hello", error: null });
    expect(out.costUsd).toBeGreaterThan(0);
    expect(api.seen).toHaveLength(1);
    const { headers, body } = api.seen[0]!;
    expect(headers["x-api-key"]).toMatch(/^sk-ant-/);
    expect(body).toMatchObject({ model: HELPER_MODEL, max_tokens: 123, thinking: { type: "disabled" }, output_config: { effort: "low" }, system: "Be brief.", stream: true, messages: [{ role: "user", content: "Say hello." }] });
    expect(body.tools).toBeUndefined();
    const rows = hub.store.listApiRequests("2000", "3000");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: null, user: "alice", purpose: "summary", model: HELPER_MODEL, input: 500, output: 40, complete: true });
    expect(hub.billing.spentUsd()).toBeCloseTo(rows[0]!.costUsd, 9);
    expect(JSON.stringify(rows)).not.toContain("Say hello");
  });

  it("failures come back as outcomes: an API error, an empty answer, credits used up", async () => {
    const hub = await setup();
    api.reply = () => ({ status: 500 });
    expect(await runHelper(hub, "x", { purpose: "search", user: "alice" })).toMatchObject({ ok: false, text: "", error: expect.stringContaining("500") });
    api.reply = () => ({ status: 401 });
    expect(await runHelper(hub, "x", { purpose: "search", user: "alice" })).toMatchObject({ ok: false, error: "The API key was rejected." });
    api.reply = () => ({ text: "   " });
    expect(await runHelper(hub, "x", { purpose: "search", user: "alice" })).toMatchObject({ ok: false, error: "the helper model gave an empty answer" });
    api.reply = () => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } });
    expect(await runHelper(hub, "x", { purpose: "search", user: "alice" })).toMatchObject({ ok: false });
    // The API said the credits are gone: the helper is off until the key or the budget changes.
    expect(helperAvailable(hub)).toBe(false);
    expect(helperUnavailableReason(hub)).toBe("The Anthropic API reported that the credits are exhausted.");
    api.seen.length = 0;
    expect((await runHelper(hub, "x", { purpose: "search", user: "alice" })).ok).toBe(false);
    expect(api.seen).toHaveLength(0);
  });

  it("the short helpers leave room for an answer", () => {
    expect(DOWNLOAD_CHECK_MAX_TOKENS).toBeGreaterThanOrEqual(1000);
    expect(SUMMARY_MAX_TOKENS).toBeGreaterThanOrEqual(1000);
  });

  it("not available without a key or with the budget spent: no request is made", async () => {
    const hub = await setup({ key: false });
    expect(helperAvailable(hub)).toBe(false);
    expect(helperUnavailableReason(hub)).toBe("No Anthropic API key is configured on the server.");
    expect(await runHelper(hub, "x", { purpose: "pricing", user: "" })).toMatchObject({ ok: false, error: "No Anthropic API key is configured on the server." });
    writeFileSync(join(h!.dir, "anthropic.env"), "ANTHROPIC_API_KEY=sk-ant-api03-helper-not-a-real-key\n");
    hub.apiKeys.reload();
    expect(helperAvailable(hub)).toBe(true);
    hub.store.insertApiRequest({ at: new Date().toISOString(), sessionId: null, user: "alice", model: "claude-opus-5-5", input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, webSearchRequests: 0, speed: null, costUsd: 500, complete: true });
    expect(helperAvailable(hub)).toBe(false);
    expect(helperUnavailableReason(hub)).toBe("This month's API budget is used up.");
    expect((await runHelper(hub, "x", { purpose: "pricing", user: "" })).ok).toBe(false);
    expect(api.seen).toHaveLength(0);
  });

  it("an answer that does not arrive in time is a failure", async () => {
    const hub = await setup();
    server!.removeAllListeners("request");
    server!.on("request", () => undefined); // never answers
    const out = await runHelper(hub, "x", { purpose: "download", user: "", timeoutMs: 50 });
    expect(out).toMatchObject({ ok: false, error: "the helper model did not answer in time" });
  });
});

describe("the download check on the helper", () => {
  it("asks Haiku for hosts outside the well-known list and treats a missing key as 'ask the person'", async () => {
    const hub = await setup();
    const judge = helperDownloadJudge({ run: (prompt, timeoutMs) => runHelper(hub, prompt, { purpose: "download", user: "", maxTokens: DOWNLOAD_CHECK_MAX_TOKENS, timeoutMs }), available: () => helperAvailable(hub) });
    api.reply = () => ({ text: '{"safe": true, "reason": "A plain CSV."}' });
    expect(await judge("https://example.org/data.csv")).toEqual({ safe: true, reason: "A plain CSV." });
    expect(api.seen[0]!.body.messages[0].content).toContain("https://example.org/data.csv");
    expect(hub.store.listApiRequests("2000", "3000")[0]).toMatchObject({ purpose: "download", sessionId: null });
    api.reply = () => ({ text: "Probably fine." });
    expect(await judge("https://example.org/x.bin")).toMatchObject({ safe: false });
    api.reply = () => ({ status: 500 });
    expect(await judge("https://example.org/x.bin")).toMatchObject({ safe: false, reason: expect.stringContaining("could not be checked") });
    // No key: not safe, without a request.
    writeFileSync(join(h!.dir, "anthropic.env"), "");
    hub.apiKeys.reload();
    api.seen.length = 0;
    expect(await judge("https://example.org/y.bin")).toEqual({ safe: false, reason: "The address check is not available (no API key or budget)." });
    expect(api.seen).toHaveLength(0);
  });
});

describe("answerJson", () => {
  it("finds the JSON object bare, fenced or inside prose; arrays and garbage are null", () => {
    expect(answerJson('{"a":1}')).toEqual({ a: 1 });
    expect(answerJson('Sure!\n```json\n{"a": 2}\n```')).toEqual({ a: 2 });
    expect(answerJson('The answer is {"a": 3} as asked.')).toEqual({ a: 3 });
    expect(answerJson("[1,2]")).toBeNull();
    expect(answerJson("nothing")).toBeNull();
    expect(HELPER_PROMPT_MAX_BYTES).toBe(100_000);
  });
});
