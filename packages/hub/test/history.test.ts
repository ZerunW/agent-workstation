import { afterEach, describe, expect, it } from "vitest";
import type { SearchHit, Session } from "@agent-workstation/protocol";
import { Store } from "../src/db/store.js";
import { MemoryService } from "../src/memory.js";
import { HISTORY_GUIDANCE, historyTools } from "../src/search/history.js";
import { SearchService } from "../src/search/service.js";
import type { HubToolSpec } from "../src/sessions/sdk.js";
import { silentLogger } from "../src/util/log.js";
import { msgBody, runtimeFixture, until, type RuntimeFixture } from "./helpers.js";

let store: Store;
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* closed */
  }
});

let n = 0;
function session(user: string, title: string, o: { kind?: "chat" | "code"; incognito?: boolean; hidden?: boolean } = {}): string {
  store.ensureUser(user);
  const id = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
  store.insertSession({ id, user, kind: o.kind ?? "chat", title, cwd: ".chat", model: "default", permissionMode: "default", effort: null, incognito: o.incognito, hidden: o.hidden });
  return id;
}
const say = (id: string, kind: "user" | "assistant", text: string) =>
  store.appendMessage(id, {
    uuid: crypto.randomUUID(),
    kind,
    payload: kind === "user" ? { type: "user", message: { role: "user", content: text } } : { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", model: "m", content: [{ type: "text", text }] } },
  });
const toSession = (row: NonNullable<ReturnType<Store["getSession"]>>): Session => ({
  id: row.id,
  user: row.user,
  kind: row.kind,
  title: row.title,
  cwd: row.cwd,
  model: row.model,
  permissionMode: row.permissionMode,
  effort: row.effort,
  status: "idle",
  queuePosition: null,
  claudeSessionId: null,
  createdAt: row.createdAt,
  lastActiveAt: row.lastActiveAt,
  lastSeq: row.lastSeq,
  costUsd: 0,
});
const keywordSearch = () => new SearchService({ store, toSession, helper: null, helperAvailable: () => false, helperUnavailableReason: () => "off", log: silentLogger });
const tool = (tools: HubToolSpec[], name: string) => tools.find((t) => t.name === name)!;
const textOf = (r: unknown) => (typeof r === "string" ? r : (r as { text: string }).text);

describe("past-conversation tools", () => {
  it("search_conversations lists the user's other conversations (not the current one, not incognito)", async () => {
    store = new Store(":memory:");
    const current = session("alice", "Current chat about tea");
    say(current, "user", "green tea or black tea?");
    const old = session("alice", "Tea ceremony notes", { kind: "code" });
    say(old, "user", "the Japanese tea ceremony");
    const inc = session("alice", "Incognito tea", { incognito: true });
    say(inc, "user", "secret tea");
    const bob = session("bob", "Bob tea");
    say(bob, "user", "tea for bob");
    const tools = historyTools({ store, search: keywordSearch(), relevantAvailable: () => false }, "alice", current);
    const out = textOf(await tool(tools, "search_conversations").handler({ query: "tea" }));
    expect(out).toContain(`"Tea ceremony notes" — code · `);
    expect(out).toContain(`id: ${old}`);
    expect(out).toContain("«tea»");
    expect(out).not.toContain(current);
    expect(out).not.toContain(inc);
    expect(out).not.toContain(bob);
    expect(textOf(await tool(tools, "search_conversations").handler({ query: "nothing-like-this" }))).toContain("No earlier conversations match");
    expect(await tool(tools, "search_conversations").handler({ query: "  " })).toEqual({ text: "No query given.", isError: true });
  });

  it("merges relevant (helper model) and keyword hits; a failing relevant search falls back to keywords", async () => {
    store = new Store(":memory:");
    const a = session("alice", "Mortgage refinancing");
    say(a, "user", "should I refinance my mortgage");
    const b = session("alice", "Loan questions");
    const row = (id: string) => toSession(store.getSession(id)!);
    const fail = { v: false };
    const search = {
      keyword: (u: string, q: string, limit?: number) => keywordSearch().keyword(u, q, limit),
      relevant: async (): Promise<{ hits: SearchHit[]; model: string; cached: boolean }> => {
        if (fail.v) throw new Error("the helper timed out");
        return { hits: [{ session: row(b), snippet: "Talked about loan rates.", at: row(b).lastActiveAt, reason: "Also about home loans." }, { session: row(a), snippet: "Summary A", at: "x", reason: "Refinancing." }], model: "m", cached: false };
      },
    };
    const tools = historyTools({ store, search, relevantAvailable: () => true }, "alice", "00000000-0000-4000-9000-999999999999");
    const out = textOf(await tool(tools, "search_conversations").handler({ query: "mortgage", limit: 5 }));
    expect(out.indexOf(b)).toBeLessThan(out.indexOf(a));
    expect(out).toContain("why: Also about home loans.");
    expect(out).toContain("«mortgage»"); // keyword snippet merged into the relevant hit
    fail.v = true;
    const fallback = textOf(await tool(tools, "search_conversations").handler({ query: "mortgage" }));
    expect(fallback).toContain("keyword matches only");
    expect(fallback).toContain(a);
  });

  it("read_conversation returns the user's own plain transcript, newest part kept; others are refused", async () => {
    store = new Store(":memory:");
    const mine = session("alice", "Long talk");
    for (let i = 0; i < 40; i++) {
      say(mine, "user", `question ${i} ${"q".repeat(400)}`);
      say(mine, "assistant", `answer ${i} ${"a".repeat(400)}`);
    }
    const inc = session("alice", "Incognito", { incognito: true });
    say(inc, "user", "secret");
    const hidden = session("alice", "probe", { hidden: true });
    const bob = session("bob", "Bob");
    say(bob, "user", "bob's");
    const tools = historyTools({ store, search: keywordSearch(), relevantAvailable: () => false }, "alice", "x");
    const read = tool(tools, "read_conversation");
    const full = textOf(await read.handler({ sessionId: mine }));
    expect(full.startsWith('Conversation "Long talk" (chat · started')).toBe(true);
    expect(full.length).toBeLessThanOrEqual(20_000);
    expect(full).toContain("[… earlier messages omitted …]");
    expect(full).toContain("answer 39");
    expect(full).not.toContain("question 0 ");
    expect(full).toMatch(/User \(\d{4}-\d\d-\d\d \d\d:\d\d\): question 3\d/);
    const short = textOf(await read.handler({ sessionId: mine, maxChars: 2000 }));
    expect(short.length).toBeLessThanOrEqual(2000);
    expect(short).toContain("answer 39");
    for (const id of [inc, hidden, bob, "not-an-id"]) expect(await read.handler({ sessionId: id })).toEqual({ text: "No conversation with that id.", isError: true });
  });
});

describe("past-conversation tools in Claude sessions", () => {
  let fx: RuntimeFixture;
  afterEach(() => fx?.cleanup());
  const setup = () =>
    (fx = runtimeFixture(({ store: st, bus }) => {
      const search = new SearchService({ store: st, toSession, helper: null, helperAvailable: () => false, helperUnavailableReason: () => "off", log: silentLogger });
      return { memories: new MemoryService(st, bus), history: { tools: (u, id) => historyTools({ store: st, search, relevantAvailable: () => false }, u, id) } };
    }));
  const idle = (id: string) => until(() => fx.sessions.statusOf(id).status === "idle" && fx.store.getSession(id)!.turnCount >= 1, 3000, "turn");

  it("chat and code sessions get workstation-history pre-approved and mentioned in the prompt; incognito chats do not", async () => {
    setup();
    const chat = fx.newSession("chat");
    await fx.sessions.send(chat, msgBody("hi"));
    await idle(chat);
    let o = fx.sdk.last.options;
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["workstation-memory", "workstation-history", "workstation-visual", "workstation_turn", "workstation_subagent"]);
    expect(o.allowedTools).toEqual([
      "mcp__workstation-memory__remember",
      "mcp__workstation-memory__forget",
      "mcp__workstation-history__search_conversations",
      "mcp__workstation-history__read_conversation",
      "mcp__workstation-visual__show_visual",
      "mcp__workstation_turn__heads_up",
      "mcp__workstation_subagent__run_subagents",
    ]);
    expect(String(o.systemPrompt)).toContain("- Memory: `remember`");
    expect(String(o.systemPrompt)).toContain(HISTORY_GUIDANCE);

    const code = fx.newSession("code");
    await fx.sessions.send(code, msgBody("hi"));
    await idle(code);
    o = fx.sdk.last.options;
    expect(o.allowedTools).toEqual(["mcp__workstation-history__search_conversations", "mcp__workstation-history__read_conversation", "mcp__workstation-visual__show_visual", "mcp__workstation_turn__wrap_up", "mcp__workstation_turn__heads_up", "mcp__workstation_subagent__run_subagents"]);
    expect((o.systemPrompt as { append?: string }).append).toContain(HISTORY_GUIDANCE);

    fx.store.ensureUser("alice");
    const inc = fx.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null, incognito: true }).id;
    await fx.sessions.send(inc, msgBody("hi"));
    await idle(inc);
    expect(Object.keys(fx.sdk.last.options.mcpServers ?? {})).toEqual(["workstation-visual", "workstation_turn", "workstation_subagent"]);
    expect(() => fx.sessions.create({ user: "alice", kind: "code", cwd: "", model: "default", permissionMode: "default", effort: null, incognito: true })).toThrow(/incognito/);
  });
});
