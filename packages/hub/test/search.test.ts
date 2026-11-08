import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelevantSearchResponse, SearchResponse } from "@agent-workstation/protocol";
import { Store } from "../src/db/store.js";
import type { HelperOptions, HelperOutcome, HelperRunner } from "../src/helper.js";
import { HELPER_MODEL } from "../src/sessions/models.js";
import { makeSnippet, parseRelevantAnswer, queryTerms, SearchService } from "../src/search/service.js";
import { buildSummaryPrompt, SummaryService } from "../src/search/summaries.js";
import { silentLogger } from "../src/util/log.js";
import { hubFixture, msgBody, tempDir, tick, until, type HubFixture } from "./helpers.js";

let store: Store;
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* closed */
  }
});

let n = 0;
function session(user: string, title: string, o: { kind?: "chat" | "code"; incognito?: boolean; hidden?: boolean; at?: string } = {}): string {
  store.ensureUser(user);
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  store.insertSession({ id, user, kind: o.kind ?? "chat", title, cwd: ".chat", model: "default", permissionMode: "default", effort: null, incognito: o.incognito, hidden: o.hidden, createdAt: o.at });
  return id;
}
const user = (id: string, text: string, at?: string, extra: Record<string, unknown> = {}) =>
  store.appendMessage(id, { uuid: crypto.randomUUID(), kind: "user", payload: { type: "user", message: { role: "user", content: text }, ...extra }, at });
const assistant = (id: string, content: unknown[], at?: string) =>
  store.appendMessage(id, { uuid: crypto.randomUUID(), kind: "assistant", payload: { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", model: "m", content } }, at });
const text = (t: string) => ({ type: "text", text: t });

function service(o: { helper?: HelperRunner | null; available?: boolean; s?: Store } = {}) {
  const st = o.s ?? store;
  return new SearchService({
    store: st,
    toSession: (row) => ({ id: row.id, user: row.user, kind: row.kind, title: row.title, cwd: row.cwd, model: row.model, permissionMode: row.permissionMode, effort: row.effort, status: "idle", queuePosition: null, claudeSessionId: null, createdAt: row.createdAt, lastActiveAt: row.lastActiveAt, lastSeq: row.lastSeq, costUsd: 0, incognito: row.incognito }),
    helper: o.helper === undefined ? null : o.helper,
    helperAvailable: () => o.available ?? true,
    helperUnavailableReason: () => "The helper is off in this test.",
    log: silentLogger,
  });
}

describe("keyword search (FTS5 trigram)", () => {
  it("uses FTS5 with the trigram tokenizer in the bundled SQLite", () => {
    store = new Store(":memory:");
    expect(store.fts).toBe(true);
  });

  it("matches titles and message text, newest first, one hit per session, with « » snippets", () => {
    store = new Store(":memory:");
    const a = session("alice", "Kubernetes cluster upgrade", { at: "2026-10-01T00:00:00.000Z" });
    const b = session("alice", "Grocery list", { at: "2026-10-02T00:00:00.000Z" });
    user(a, "How do I drain a node before the upgrade?", "2026-10-01T01:00:00.000Z");
    assistant(a, [{ type: "thinking", thinking: "secret plan about grocery" }, text("Use kubectl drain <node> --ignore-daemonsets."), { type: "tool_use", id: "t", name: "Bash", input: { command: "kubectl drain" } }], "2026-10-01T01:01:00.000Z");
    user(b, "Buy milk, eggs and a kubectl cheat sheet", "2026-10-05T00:00:00.000Z");
    const s = service();
    const hits = s.keyword("alice", "kubectl");
    expect(hits.map((h) => h.session.id)).toEqual([b, a]);
    expect(hits[0]!.at).toBe("2026-10-05T00:00:00.000Z");
    expect(hits[0]!.snippet).toContain("«kubectl»");
    expect(hits[1]!.snippet).toBe("Use «kubectl» drain <node> --ignore-daemonsets.");
    // Every term must match; case-insensitive; titles count.
    expect(s.keyword("alice", "KUBECTL drain").map((h) => h.session.id)).toEqual([a]);
    expect(s.keyword("alice", "cluster upgrade")[0]).toMatchObject({ session: { id: a }, snippet: expect.stringContaining("«upgrade»") });
    // Thinking and tool calls are not indexed.
    expect(s.keyword("alice", "secret plan")).toEqual([]);
    expect(s.keyword("alice", "ignore-daemonsets")).toHaveLength(1);
  });

  it("finds CJK (3+ characters through FTS, 1–2 characters through LIKE), diacritics and typos", () => {
    store = new Store(":memory:");
    const a = session("alice", "資料庫遷移");
    user(a, "我們討論了資料庫遷移的步驟和回滾計畫");
    const b = session("alice", "Paris trip");
    user(b, "Find a nice café near the Louvre");
    const c = session("alice", "Infra");
    assistant(c, [text("The Kubernetes control plane needs three nodes.")]);
    const s = service();
    expect(s.keyword("alice", "資料庫").map((h) => h.session.id)).toEqual([a]);
    expect(s.keyword("alice", "資料庫")[0]!.snippet).toContain("«資料庫»");
    expect(s.keyword("alice", "回滾").map((h) => h.session.id)).toEqual([a]); // 2 characters
    expect(s.keyword("alice", "庫").map((h) => h.session.id)).toEqual([a]); // 1 character
    expect(s.keyword("alice", "cafe").map((h) => h.session.id)).toEqual([b]);
    expect(s.keyword("alice", "cafe")[0]!.snippet).toContain("«café»");
    const typo = s.keyword("alice", "kubernets");
    expect(typo.map((h) => h.session.id)).toEqual([c]);
    expect(typo[0]!.snippet).toContain("«Kubernetes»");
    expect(s.keyword("alice", "zzzzqqq")).toEqual([]);
  });

  it("never returns incognito, hidden or other users' sessions; follows renames and deletes", () => {
    store = new Store(":memory:");
    const mine = session("alice", "Budget planning");
    user(mine, "quarterly budget numbers");
    const incog = session("alice", "Budget secrets", { incognito: true });
    user(incog, "my secret budget");
    const hidden = session("alice", "budget probe", { hidden: true });
    user(hidden, "budget");
    const bob = session("bob", "Bob's budget");
    user(bob, "budget for bob");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM search_docs WHERE session_id IN (?, ?)").get(incog, hidden)).toEqual({ n: 0 });
    const s = service();
    expect(s.keyword("alice", "budget").map((h) => h.session.id)).toEqual([mine]);
    expect(s.keyword("bob", "budget").map((h) => h.session.id)).toEqual([bob]);
    store.updateSession(mine, { title: "Annual forecast" });
    expect(s.keyword("alice", "forecast").map((h) => h.session.id)).toEqual([mine]);
    expect(s.keyword("alice", "planning")).toEqual([]);
    store.deleteSession(mine);
    expect(s.keyword("alice", "budget")).toEqual([]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM search_docs WHERE session_id = ?").get(mine)).toEqual({ n: 0 });
  });

  it("indexes the typed text of messages with attachments (hub.text), not the inlined documents", () => {
    store = new Store(":memory:");
    const a = session("alice", "Doc");
    user(a, "", undefined, { message: { role: "user", content: [text("<document>INLINED CONTRACT TEXT</document>"), text("please review")] }, hub: { text: "please review the lease", attachments: [] } });
    const s = service();
    expect(s.keyword("alice", "lease")).toHaveLength(1);
    expect(s.keyword("alice", "INLINED")).toEqual([]);
  });

  it("falls back to LIKE without FTS5, and builds the index for older data in the background", async () => {
    store = new Store(":memory:");
    const a = session("alice", "Old chat");
    user(a, "pancakes recipe with blueberries");
    const noFts = Object.create(store, { fts: { value: false } }) as Store;
    expect(service({ s: noFts }).keyword("alice", "blueberr").map((h) => h.session.id)).toEqual([a]);
    // Data from before the index: wipe it, then the startup build restores it.
    store.db.exec("DELETE FROM search_docs");
    const s = service();
    expect(s.keyword("alice", "pancakes")).toEqual([]);
    await s.startBuild(1);
    expect(s.keyword("alice", "pancakes").map((h) => h.session.id)).toEqual([a]);
    expect(store.kvGet("search_index_version")).toBe(1);
    store.db.exec("DELETE FROM search_docs");
    await s.startBuild(1); // already built for this version: no-op
    expect(s.keyword("alice", "pancakes")).toEqual([]);
  });

  it("migrates a database from an earlier build (no incognito column, no search tables) and indexes it", async () => {
    const t = tempDir();
    try {
      const file = join(t.dir, "old.sqlite");
      store = new Store(file);
      const a = session("alice", "Legacy chat");
      user(a, "a message about photosynthesis");
      store.close();
      // Strip everything the search batch added, as in a database from before it.
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(file);
      raw.exec(`DROP TRIGGER search_docs_ai; DROP TRIGGER search_docs_ad; DROP TRIGGER search_docs_au; DROP TABLE search_fts;
        DROP TABLE search_docs; DROP TABLE session_summaries;
        ALTER TABLE sessions DROP COLUMN incognito; ALTER TABLE turns DROP COLUMN purpose;`);
      raw.close();
      store = new Store(file);
      expect(store.fts).toBe(true);
      expect(store.getSession(a)).toMatchObject({ incognito: false });
      const s = service();
      expect(s.keyword("alice", "photosynthesis")).toEqual([]);
      await s.startBuild(1);
      expect(s.keyword("alice", "photosynthesis").map((h) => h.session.id)).toEqual([a]);
      store.insertTurn({ sessionId: a, user: "alice", kind: "chat", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.5, durationMs: 1, at: new Date().toISOString() });
      expect(store.db.prepare("SELECT cost_usd FROM turns").pluck().get()).toBe(0.5);
    } finally {
      store.close();
      t.cleanup();
    }
  });

  it("splits queries and builds snippets", () => {
    expect(queryTerms(` "hello"  world hello `)).toEqual(["hello", "world"]);
    expect(makeSnippet("a".repeat(300) + " needle " + "b".repeat(300), ["needle"], 20)).toMatch(/^…a+ «needle» b+…$/);
    expect(makeSnippet("Résumé of the café", ["resume", "CAFE"])).toBe("«Résumé» of the «café»");
    expect(makeSnippet("no match here", ["zzz"])).toBe("no match here");
  });

  it("marks whole words for word-character terms, substrings for CJK and fuzzy words", () => {
    // "is" inside "this" / "island" is not marked; the standalone words are.
    expect(makeSnippet("Is this what it is? An island.", ["what", "is"])).toBe("«Is» this «what» it «is»? An island.");
    expect(makeSnippet("this thing", ["is"])).toBe("this thing");
    // 3+ character terms fall back to the start of a word when no whole word occurs; never mid-word.
    expect(makeSnippet("configuration files", ["config"])).toBe("«config»uration files");
    expect(makeSnippet("the database is slow", ["base"])).toBe("the database is slow");
    expect(makeSnippet("a config and its configuration", ["config"])).toBe("a «config» and its configuration");
    // Diacritics and case still fold; underscores and digits are word characters.
    expect(makeSnippet("Café_bar and café", ["cafe"])).toBe("Café_bar and «café»");
    expect(makeSnippet("v2 and v22", ["v2"])).toBe("«v2» and v22");
    // CJK terms match as substrings, and a Latin word next to CJK text is a whole word.
    expect(makeSnippet("我的資料庫設定", ["資料庫"])).toBe("我的«資料庫»設定");
    expect(makeSnippet("使用kubectl部署", ["kubectl"])).toBe("使用«kubectl»部署");
    // Non-word terms (punctuation inside) keep substring marking.
    expect(makeSnippet("see mynode.js and node.js", ["node.js"])).toBe("see my«node.js» and «node.js»");
    // Words that only matched fuzzily are marked as substrings.
    expect(makeSnippet("The Kubernetes nodes", [{ text: "Kubernetes", mode: "substring" }])).toBe("The «Kubernetes» nodes");
    expect(makeSnippet("this", [{ text: "is", mode: "substring" }])).toBe("th«is»");
    // Nothing markable: the window still centres on the raw occurrence.
    expect(makeSnippet("x".repeat(300) + " database " + "y".repeat(300), ["base"], 20)).toMatch(/^…x+ database y+…$/);
  });

  it("keyword search highlights whole words of the query", () => {
    store = new Store(":memory:");
    const a = session("alice", "Notes");
    user(a, "This is what the island said");
    const hits = service().keyword("alice", "what is");
    expect(hits.map((h) => h.session.id)).toEqual([a]);
    expect(hits[0]!.snippet).toBe("This «is» «what» the island said");
  });
});

describe("relevant search answer parsing", () => {
  it("validates ids, drops duplicates and garbage", () => {
    const listed = ["s1", "s2", "s3"];
    expect(parseRelevantAnswer('```json\n[{"id": 2, "reason": "About X."}, {"id": 99, "reason": "bad"}, {"id": "abc"}, {"id": 1}, {"id": 2}]\n```', listed, 10)).toEqual([
      { id: "s2", reason: "About X." },
      { id: "s1", reason: "" },
    ]);
    expect(parseRelevantAnswer('{"results": [{"id": "3", "reason": "r"}]}', listed, 10)).toEqual([{ id: "s3", reason: "r" }]);
    expect(parseRelevantAnswer('[{"id": "s1", "reason": "uuid form"}]', listed, 10)).toEqual([{ id: "s1", reason: "uuid form" }]);
    expect(parseRelevantAnswer("I could not find anything.", listed, 10)).toEqual([]);
    expect(parseRelevantAnswer("[1, 2, 3]", listed, 2)).toEqual([
      { id: "s1", reason: "" },
      { id: "s2", reason: "" },
    ]);
  });
});

describe("session summaries", () => {
  const helperOk = (calls: string[]): HelperRunner => async (prompt: string, opts: HelperOptions): Promise<HelperOutcome> => {
    calls.push(`${opts.purpose}/${opts.user}/${opts.maxTokens}:${prompt}`);
    return { ok: true, text: "  The user planned a Kubernetes upgrade.\n It worked. ", error: null, costUsd: 0.0001, durationMs: 5 };
  };

  it("summarizes an idle session after the debounce, at most once per interval, never incognito", async () => {
    store = new Store(":memory:");
    const a = session("alice", "Upgrade");
    user(a, "Plan the Kubernetes upgrade");
    assistant(a, [text("Drain the nodes first.")]);
    const incog = session("alice", "Secret", { incognito: true });
    user(incog, "secret stuff");
    const calls: string[] = [];
    let now = 1_000_000;
    const idle = { v: true };
    const svc = new SummaryService({ store, helper: helperOk(calls), available: () => true, isIdle: () => idle.v, log: silentLogger, debounceMs: 20, minIntervalMs: 60_000, clock: () => now });
    try {
      svc.sessionIdle(a);
      svc.sessionIdle(a); // debounced: one run
      svc.sessionIdle(incog);
      await tick(80);
      await svc.idle();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^summary\/alice\/1000:/);
      expect(calls[0]).toContain("Title: Upgrade");
      expect(calls[0]).toContain("User: Plan the Kubernetes upgrade");
      expect(calls[0]).toContain("Assistant: Drain the nodes first.");
      const sum = store.getSummary(a)!;
      expect(sum).toMatchObject({ summary: "The user planned a Kubernetes upgrade. It worked.", model: HELPER_MODEL, messageSeq: 2 });
      expect(store.getSummary(incog)).toBeNull();
      expect(store.db.prepare("SELECT COUNT(*) FROM turns").pluck().get()).toBe(0); // billed as api_requests by the helper, not as turns

      // Nothing new → no run; new messages within 10 minutes → waits for the interval.
      expect(await svc.run(a)).toBe(false);
      user(a, "And the database?");
      expect(await svc.run(a)).toBe(false);
      expect(calls).toHaveLength(1);
      now += 61_000;
      idle.v = false; // busy: skipped (the next idle reschedules)
      expect(await svc.run(a)).toBe(false);
      idle.v = true;
      expect(await svc.run(a)).toBe(true);
      expect(store.getSummary(a)!.messageSeq).toBe(3);
    } finally {
      svc.stop();
    }
  });

  it("skips while the helper is unavailable and keeps transcripts within the budget", async () => {
    store = new Store(":memory:");
    const a = session("alice", "Long");
    user(a, "start " + "x".repeat(50_000) + " end");
    const calls: string[] = [];
    const avail = { v: false };
    const svc = new SummaryService({ store, helper: helperOk(calls), available: () => avail.v, isIdle: () => true, log: silentLogger, minIntervalMs: 0 });
    expect(await svc.run(a)).toBe(false);
    expect(calls).toHaveLength(0);
    avail.v = true;
    expect(await svc.run(a)).toBe(true);
    expect(calls[0]!.length).toBeLessThan(32_000);
    expect(calls[0]).toContain("User: start");
    expect(calls[0]).toContain("end");
    expect(buildSummaryPrompt("T", [{ role: "user", text: "hi" }])).toContain("<<<\nUser: hi\n>>>");
    svc.stop();
  });

});

// ------------------------------------------------------------------ the hub with a fake Messages API

const sseEv = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const answerStream = (text: string, input = 1000, output = 20) =>
  [
    sseEv("message_start", { message: { id: "m", type: "message", role: "assistant", model: HELPER_MODEL, content: [], usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }),
    sseEv("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sseEv("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    sseEv("content_block_stop", { index: 0 }),
    sseEv("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } }),
    sseEv("message_stop", {}),
  ].join("");

type Answer = { text: string; input?: number; output?: number } | { status: number };

describe("search routes and relevant search through the hub", () => {
  let h: HubFixture;
  let server: Server;
  /** Answers the helper's Messages calls by purpose (the prompt tells them apart). */
  const api = { seen: [] as { body: Record<string, any> }[], answer: (_prompt: string, _kind: "summary" | "search"): Answer => ({ text: "[]" }) };
  afterEach(async () => {
    await h?.close();
    server?.closeAllConnections();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  async function apiHub(o: { key?: boolean } = {}): Promise<HubFixture> {
    api.seen = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>;
        api.seen.push({ body });
        const prompt = String(body.messages?.[0]?.content ?? "");
        const a = api.answer(prompt, prompt.includes("Title:") && !prompt.includes("numbered") ? "summary" : "search");
        if ("status" in a) {
          res.writeHead(a.status, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(answerStream(a.text, a.input, a.output));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    h = await hubFixture({ summaryDebounceMs: 10, summaryMinIntervalMs: 0 }, (dir) => {
      if (o.key === false) writeFileSync(join(dir, "anthropic.env"), "");
      return { billing: { upstream: url } };
    });
    return h;
  }
  const create = async (title: string, extra: Record<string, unknown> = {}) =>
    (await h.app.inject({ method: "POST", url: "/api/sessions", headers: h.as("alice"), payload: { kind: "chat", title, model: "opus", ...extra } })).json() as { id: string };
  const say = async (id: string, text: string) => {
    const before = h.hub.store.getSession(id)!.turnCount;
    await h.app.inject({ method: "POST", url: `/api/sessions/${id}/messages`, headers: h.as("alice"), payload: msgBody(text) });
    await until(() => h.hub.store.getSession(id)!.turnCount > before && h.hub.sessions.statusOf(id).status === "idle", 3000, "turn");
  };

  it("GET /api/search: keyword hits for the caller only, never incognito; 400 without q", async () => {
    await apiHub();
    const a = await create("Sourdough starter");
    await say(a.id, "my sourdough starter smells like acetone");
    const inc = await create("Incognito sourdough", { incognito: true });
    await say(inc.id, "secret sourdough");
    const r = SearchResponse.parse((await h.app.inject({ method: "GET", url: "/api/search?q=sourdough", headers: h.as("alice") })).json());
    expect(r.hits.map((x) => x.session.id)).toEqual([a.id]);
    expect(r.hits[0]!.snippet).toContain("«sourdough»");
    expect(((await h.app.inject({ method: "GET", url: "/api/search?q=sourdough", headers: h.as("bob") })).json() as SearchResponse).hits).toEqual([]);
    expect((await h.app.inject({ method: "GET", url: "/api/search", headers: h.as("alice") })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "GET", url: "/api/search?q=x&limit=500", headers: h.as("alice") })).statusCode).toBe(400);
  });

  it("summarizes idle sessions with Haiku and ranks them for GET /api/search/relevant (validated ids, cache, billing)", async () => {
    await apiHub();
    api.answer = (prompt, kind) => (kind === "summary" ? { text: `Summary of: ${/Title: (.*)/.exec(prompt)?.[1] ?? "?"}`, input: 7000, output: 20 } : { text: "[]" });
    const a = await create("Tax return 2025");
    await say(a.id, "help me with deductions");
    const b = await create("Bread baking");
    await say(b.id, "rye bread hydration");
    const inc = await create("Incognito taxes", { incognito: true });
    await say(inc.id, "hidden tax stuff");
    await until(() => h.hub.store.getSummary(a.id) && h.hub.store.getSummary(b.id), 3000, "summaries");
    await h.hub.summaries.idle();
    expect(h.hub.store.getSummary(a.id)!.summary).toBe("Summary of: Tax return 2025");
    expect(h.hub.store.getSummary(a.id)!.model).toBe(HELPER_MODEL);
    expect(h.hub.store.getSummary(inc.id)).toBeNull();
    // Summaries are metered as api_requests of the hub's helper, never as session turns.
    const summaryRows = h.hub.store.db.prepare("SELECT user, purpose, model, session_id FROM api_requests WHERE purpose = 'summary'").all();
    expect(summaryRows.length).toBeGreaterThanOrEqual(2);
    expect(summaryRows[0]).toEqual({ user: "alice", purpose: "summary", model: HELPER_MODEL, session_id: null });
    expect(api.seen.every((s) => s.body.model === HELPER_MODEL && s.body.tools === undefined)).toBe(true);

    let prompts: string[] = [];
    api.answer = (prompt) => {
      prompts.push(prompt);
      // List is newest first: 1 = Bread baking, 2 = Tax return. 7 does not exist, "nope" is not an id.
      return { text: '[{"id": 2, "reason": "It is about taxes."}, {"id": 7, "reason": "?"}, {"id": "nope"}, {"id": 2}]', input: 8000, output: 15 };
    };
    const get = async (q: string) => h.app.inject({ method: "GET", url: `/api/search/relevant?q=${encodeURIComponent(q)}`, headers: h.as("alice") });
    const r1 = RelevantSearchResponse.parse((await get("my taxes")).json());
    expect(r1).toMatchObject({ model: HELPER_MODEL, cached: false });
    expect(r1.hits).toHaveLength(1);
    expect(r1.hits[0]).toMatchObject({ session: { id: a.id }, snippet: "Summary of: Tax return 2025", reason: "It is about taxes." });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("my taxes");
    expect(prompts[0]).toMatch(/1\. \[\d{4}-\d\d-\d\d\] \(chat\) Bread baking — Summary of: Bread baking/);
    expect(prompts[0]).not.toContain("Incognito");
    const searchRows = h.hub.store.db.prepare("SELECT user, model, input, purpose, session_id, cost_usd FROM api_requests WHERE purpose = 'search'").all() as { cost_usd: number }[];
    expect(searchRows).toEqual([{ user: "alice", model: HELPER_MODEL, input: 8000, purpose: "search", session_id: null, cost_usd: expect.any(Number) }]);
    expect(searchRows[0]!.cost_usd).toBeGreaterThan(0);
    expect(h.hub.billing.spentUsd()).toBeGreaterThan(0);

    const r2 = (await get("  My   TAXES ")).json() as RelevantSearchResponse;
    expect(r2.cached).toBe(true);
    expect(r2.hits.map((x) => x.session.id)).toEqual([a.id]);
    expect(prompts).toHaveLength(1);
    // A rename changes what the model would see: the cache entry no longer applies.
    await h.app.inject({ method: "PATCH", url: `/api/sessions/${b.id}`, headers: h.as("alice"), payload: { title: "Sourdough" } });
    expect(((await get("my taxes")).json() as RelevantSearchResponse).cached).toBe(false);
    expect(prompts).toHaveLength(2);
    // Garbage from the model → no hits (not an error); a failed call → 502.
    api.answer = () => ({ text: "Sorry, nothing." });
    expect(((await get("anything else")).json() as RelevantSearchResponse).hits).toEqual([]);
    api.answer = () => ({ status: 500 });
    const failed = await get("one more");
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: "search_failed" });
  });

  it("without a key: 503 api_unavailable for relevant search, no summaries, keyword search keeps working", async () => {
    await apiHub({ key: false });
    const r = await h.app.inject({ method: "GET", url: "/api/search/relevant?q=x", headers: h.as("alice") });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "api_unavailable" });
    const a = h.hub.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "opus", permissionMode: "default", effort: null });
    h.hub.store.appendMessage(a.id, { uuid: crypto.randomUUID(), kind: "user", payload: { type: "user", message: { role: "user", content: "zucchini bread" } } });
    expect(((await h.app.inject({ method: "GET", url: "/api/search?q=zucchini", headers: h.as("alice") })).json() as SearchResponse).hits).toHaveLength(1);
    expect(await h.hub.summaries.run(a.id)).toBe(false);
    expect(api.seen).toHaveLength(0);
  });

  it("the budget spent: relevant search is refused too", async () => {
    await apiHub();
    h.hub.store.insertApiRequest({ at: new Date().toISOString(), sessionId: null, user: "alice", model: "claude-opus-5-5", input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, webSearchRequests: 0, speed: null, costUsd: 500, complete: true });
    const r = await h.app.inject({ method: "GET", url: "/api/search/relevant?q=x", headers: h.as("alice") });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "api_unavailable" });
    expect(api.seen).toHaveLength(0);
  });
});
