import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ContextUsage, Session, SessionSnapshot, StreamDelta } from "@agent-workstation/protocol";
import { MemoryService } from "../src/memory.js";
import { breakdownFromCli, contextWindowFor, estimateTokens, requestContextTokens } from "../src/sessions/context.js";
import type { SdkContextUsage } from "../src/sessions/sdk.js";
import { TurnTokens, USAGE_DELTA_STEP } from "../src/sessions/turnTokens.js";
import type { FakeQuery } from "./fakeSdk.js";
import { hubFixture, msgBody, runtimeFixture, until, type RuntimeFixture } from "./helpers.js";

let fx: RuntimeFixture;
afterEach(() => fx?.cleanup());

const idle = (id: string, turns: number) => until(() => fx.sessions.statusOf(id).status === "idle" && fx.store.getSession(id)!.turnCount >= turns, 3000, `turn ${turns}`);
const usageDeltas = () =>
  fx.bus
    .ofType("delta")
    .map((d) => StreamDelta.parse(d.delta))
    .filter((d): d is Extract<StreamDelta, { part: "usage" }> => d.part === "usage");

function cliUsage(categories: { id?: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred"; isDeferred?: boolean }[], extra: Partial<SdkContextUsage> = {}): SdkContextUsage {
  return {
    categories: categories.map((c) => ({ name: c.id ?? "row", color: "x", ...c })) as SdkContextUsage["categories"],
    totalTokens: categories.filter((c) => c.kind === "used").reduce((a, c) => a + c.tokens, 0),
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 5,
    gridRows: [],
    model: "claude-opus-4-8",
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
    ...extra,
  } as SdkContextUsage;
}

describe("live output-token counter", () => {
  it("broadcasts usage deltas from message_start / message_delta and sums the whole turn", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("chat");
    let midTurn: (() => void) | null = null;
    const gate = new Promise<void>((r) => (midTurn = r));
    let snapshotTaken!: Promise<void>;
    let resume!: () => void;
    snapshotTaken = new Promise<void>((r) => (resume = r));
    fx.sdk.behavior = async (q: FakeQuery) => {
      q.init();
      // First API request: a tool call, 42 output tokens.
      q.streamText("msg_1", "Let me check.", { usage: { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 1 } });
      q.messageDelta(42);
      q.stop("msg_1");
      // A subagent's message counts towards the turn but is not folded into the partial.
      q.streamText("msg_sub", "subagent text", { usage: { input_tokens: 10, output_tokens: 1 }, parent: "toolu_1" });
      q.messageDelta(7, "toolu_1");
      q.stop("msg_sub", "toolu_1");
      // Second request: a long answer, exact count only at the end.
      q.streamText("msg_2", "x".repeat(400), { usage: { input_tokens: 1200, output_tokens: 1 } });
      midTurn!();
      await snapshotTaken;
      q.messageDelta(95);
      q.assistant("msg_2", "done");
      q.stop("msg_2");
      q.result();
    };
    await fx.sessions.send(id, msgBody("go"));
    await gate;
    await until(() => (fx.sessions.snapshot(id).partial.text.length >= 400 ? true : null), 2000, "streamed text");
    const mid = SessionSnapshot.parse(fx.sessions.snapshot(id));
    expect(mid.partial.messageId).toBe("msg_2");
    // 42 + 7 exact, plus an estimate (~100) for the in-flight message
    expect(mid.partial.turnOutputTokens).toBeGreaterThanOrEqual(42 + 7 + 90);
    expect(mid.turnStartedAt).toEqual(expect.any(String));
    expect(Date.parse(mid.turnStartedAt!)).toBeLessThanOrEqual(Date.now());
    resume();
    await idle(id, 1);

    const d = usageDeltas();
    expect(d[0]).toEqual({ part: "usage", messageId: "msg_1", outputTokens: 1, turnOutputTokens: 1 });
    expect(d).toContainEqual({ part: "usage", messageId: "msg_1", outputTokens: 42, turnOutputTokens: 42 });
    expect(d).toContainEqual({ part: "usage", messageId: "msg_1", outputTokens: 42, turnOutputTokens: 49 });
    // estimates while msg_2 streams, then the exact count
    expect(d.filter((x) => x.messageId === "msg_2" && x.outputTokens > 1 && x.outputTokens !== 95).length).toBeGreaterThan(0);
    expect(d[d.length - 1]).toEqual({ part: "usage", messageId: "msg_2", outputTokens: 95, turnOutputTokens: 42 + 7 + 95 });
    // the subagent's text was not folded into the main partial
    const texts = fx.bus.ofType("delta").filter((x) => x.delta.part === "text").map((x) => (x.delta.part === "text" ? x.delta.text : ""));
    expect(texts.join("")).not.toContain("subagent");

    const after = SessionSnapshot.parse(fx.sessions.snapshot(id));
    expect(after.partial.turnOutputTokens).toBe(0);
    expect(after.turnStartedAt).toBeNull();
  });

  it("restarts the count with every turn", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("chat");
    fx.sdk.behavior = (q) => {
      q.init();
      q.streamText("m", "hi", { usage: { input_tokens: 5, output_tokens: 1 } });
      q.messageDelta(10);
      q.assistant("m", "hi");
      q.stop("m");
      q.result();
    };
    await fx.sessions.send(id, msgBody("one"));
    await idle(id, 1);
    await fx.sessions.send(id, msgBody("two"));
    await idle(id, 2);
    expect(usageDeltas().map((x) => x.turnOutputTokens)).toEqual([1, 10, 1, 10]);
  });

  it("TurnTokens estimates in steps and lets the exact count win", () => {
    const t = new TurnTokens();
    t.start("", "m1", 1);
    expect(t.due(true)).toBe(true);
    t.streamed("", "a".repeat(4 * (USAGE_DELTA_STEP - 2)));
    expect(t.due(false)).toBe(false);
    t.streamed("", "a".repeat(4 * 4));
    expect(t.due(false)).toBe(true);
    expect(t.total).toBe(USAGE_DELTA_STEP + 2);
    t.report("", 20);
    expect(t.total).toBe(20);
    expect(t.due(true)).toBe(true);
    t.streamed("", "more text after the exact count is ignored");
    expect(t.total).toBe(20);
    t.finish("");
    t.start("", "m2", 3);
    expect(t.total).toBe(23);
    expect(t.mainMessage).toEqual({ messageId: "m2", outputTokens: 3 });
    // CJK text counts about one token per character; the estimate never goes below the reported count
    t.streamed("", "你好世界你好");
    expect(t.total).toBe(20 + 6);
  });
});

describe("context usage", () => {
  const opusTurn = (q: FakeQuery) => {
    q.init();
    q.streamText("m1", "answer", { usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 1 } });
    q.messageDelta(50);
    q.emit({
      type: "assistant",
      message: { id: "m1", role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 50 } },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: q.sessionId,
    });
    q.stop("m1");
    q.emitResultWithTotals(
      { input: 100, output: 50, cost: 0.01 },
      {
        usage: { input_tokens: 300, output_tokens: 80, cache_creation_input_tokens: 2000, cache_read_input_tokens: 20000 },
        modelUsage: {
          "claude-opus-4-8": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10000, cacheCreationInputTokens: 2000, costUSD: 0.01, webSearchRequests: 0, contextWindow: 200_000, maxOutputTokens: 32_000 },
          "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0, contextWindow: 200_000, maxOutputTokens: 8_000 },
        },
      },
    );
  };

  it("computes totals and the /context breakdown at turn end", async () => {
    let memories!: MemoryService;
    fx = runtimeFixture(({ store, bus }) => {
      memories = new MemoryService(store, bus);
      return { memories };
    });
    const id = fx.newSession("chat");
    memories.create("alice", "Prefers concise answers with code samples.", "user");
    fx.sdk.contextUsage = cliUsage([
      { id: "system_prompt", tokens: 3000, kind: "used" },
      { id: "system_tools", tokens: 0, kind: "used" },
      { id: "mcp_tools", tokens: 600, kind: "used" },
      { id: "mcp_tools_deferred", tokens: 5000, kind: "deferred", isDeferred: true },
      { id: "memory_files", tokens: 0, kind: "used" },
      { id: "messages", tokens: 7000, kind: "used" },
      { id: "autocompact_buffer", tokens: 33_000, kind: "buffer" },
      { id: "free_space", tokens: 151_400, kind: "free" },
    ]);
    fx.sdk.behavior = opusTurn;
    await fx.sessions.send(id, msgBody("hello"));
    await idle(id, 1);
    const ev = await until(() => fx.bus.ofType("context_usage")[0], 2000, "context_usage");
    expect(fx.sdk.last.contextUsageCalls).toBe(1);
    expect(ev.sessionId).toBe(id);
    const u = ContextUsage.parse(ev.usage);
    expect(u).toMatchObject({ usedTokens: 12_100, windowTokens: 200_000, model: "claude-opus-4-8" });
    const memTokens = estimateTokens(memories.promptSection("alice")!);
    expect(memTokens).toBeGreaterThan(0);
    expect(u.breakdown).toEqual([
      { key: "system_prompt", label: "System prompt", tokens: 3000 - memTokens },
      { key: "system_tools", label: "System tools", tokens: 0 },
      { key: "mcp_tools", label: "MCP tools", tokens: 600 },
      { key: "skills", label: "Skills", tokens: 0 },
      { key: "memory", label: "Memory", tokens: memTokens },
      { key: "messages", label: "Messages", tokens: 12_100 - 3600 },
      { key: "autocompact_buffer", label: "Autocompact buffer", tokens: 33_000 },
    ]);
    // persisted, on the Session object, and carried by session_updated
    const s = Session.parse(fx.sessions.toProtocol(fx.store.getSession(id)!));
    expect(s.contextUsage).toEqual(u);
    const updates = fx.bus.ofType("session_updated").filter((e) => e.session.id === id && e.session.contextUsage);
    expect(updates[updates.length - 1]!.session.contextUsage).toEqual(u);
    expect(fx.bus.events.find((e) => e.event.type === "context_usage")!.scope).toBe("user");
  });

  it("falls back to totals only when the CLI cannot report a breakdown", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    fx.sdk.behavior = opusTurn;
    await fx.sessions.send(id, msgBody("hello"));
    await idle(id, 1);
    const ev = await until(() => fx.bus.ofType("context_usage")[0], 2000, "context_usage");
    expect(ev.usage).toMatchObject({ usedTokens: 12_100, windowTokens: 200_000, model: "claude-opus-4-8", breakdown: null });
  });

  it("keeps the previous value after a turn without a model request when the CLI does not answer", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("chat");
    fx.sdk.behavior = opusTurn;
    await fx.sessions.send(id, msgBody("hello"));
    await until(() => fx.bus.ofType("context_usage")[0], 2000, "context_usage");
    fx.sdk.behavior = (q) => q.emitResultWithTotals({ input: 100, output: 50, cost: 0.01 }, { usage: { input_tokens: 0, output_tokens: 0 } });
    await fx.sessions.send(id, msgBody("/cost"));
    await idle(id, 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(fx.bus.ofType("context_usage")).toHaveLength(1);
    expect(fx.sessions.toProtocol(fx.store.getSession(id)!).contextUsage?.usedTokens).toBe(12_100);

    // ... and takes the CLI's own total when it answers (e.g. after /clear)
    fx.sdk.contextUsage = cliUsage([{ id: "system_prompt", tokens: 2500, kind: "used" }, { id: "messages", tokens: 0, kind: "used" }]);
    await fx.sessions.send(id, msgBody("/clear"));
    await idle(id, 3);
    const ev = await until(() => fx.bus.ofType("context_usage")[1], 2000, "second context_usage");
    expect(ev.usage).toMatchObject({ usedTokens: 2500, model: "claude-opus-4-8" });
  });

  it("is on GET /api/sessions/:id after a turn", async () => {
    const h = await hubFixture();
    try {
      const created = (await h.app.inject({ method: "POST", url: "/api/sessions", headers: h.as("alice"), payload: { kind: "chat" } })).json() as { id: string };
      expect(Session.parse(created).contextUsage ?? null).toBeNull();
      await h.app.inject({ method: "POST", url: `/api/sessions/${created.id}/messages`, headers: h.as("alice"), payload: { uuid: randomUUID(), text: "hi" } });
      const s = await until(async () => {
        const r = Session.parse((await h.app.inject({ url: `/api/sessions/${created.id}`, headers: h.as("alice") })).json());
        return r.contextUsage ? r : null;
      }, 3000, "contextUsage");
      // the fake default turn reports only the result's usage (1 input token) and a 200k window
      expect(s.contextUsage).toMatchObject({ usedTokens: 1, windowTokens: 200_000, model: "fake-model", breakdown: null });
    } finally {
      await h.close();
    }
  });
});

describe("context helpers", () => {
  it("resolves the context window", () => {
    expect(contextWindowFor("claude-opus-4-8", { "claude-opus-4-8": { contextWindow: 200_000 } })).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-6", { "claude-sonnet-4-6[1m]": { contextWindow: 1_000_000 }, "claude-haiku-4-5": { contextWindow: 200_000 } })).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-4-6[1m]", {})).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-8", { other: { contextWindow: 0 }, more: {} })).toBe(200_000);
    expect(contextWindowFor("mystery", {})).toBeNull();
    expect(contextWindowFor(null, { "only-model": { contextWindow: 64_000 } })).toBe(64_000);
  });

  it("counts request context and refuses unlabeled CLI rows", () => {
    expect(requestContextTokens({ input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5, output_tokens: 100 })).toBe(12);
    expect(requestContextTokens({ input_tokens: 3, cache_creation_input_tokens: null })).toBe(3);
    expect(breakdownFromCli(cliUsage([{ tokens: 10, kind: "used" }]), { usedTokens: 10, memorySectionTokens: 0 })).toBeNull();
    const b = breakdownFromCli(cliUsage([{ id: "custom_agents", tokens: 40, kind: "used" }, { id: "compact_buffer", tokens: 3000, kind: "buffer" }]), { usedTokens: null, memorySectionTokens: 0 });
    expect(b?.find((r) => r.key === "custom_agents")?.tokens).toBe(40);
    expect(b?.find((r) => r.key === "autocompact_buffer")?.tokens).toBe(3000);
  });
});
