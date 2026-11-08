import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "@agent-workstation/protocol";
import { Pricing } from "../src/pricing.js";
import { TurnCost } from "../src/sessions/turnCost.js";
import type { FakeQuery } from "./fakeSdk.js";
import { msgBody, runtimeFixture, until, type RuntimeFixture } from "./helpers.js";

let fx: RuntimeFixture;
afterEach(() => fx?.cleanup());

const OPUS = "claude-opus-4-8";
const usd = (u: { input?: number; cacheCreate?: number; cacheRead?: number; output?: number }) => ((u.input ?? 0) * 5 + (u.cacheCreate ?? 0) * 6.25 + (u.cacheRead ?? 0) * 0.5 + (u.output ?? 0) * 25) / 1_000_000;

describe("TurnCost", () => {
  it("prices cache classes, counts a message once and never decreases", () => {
    const c = new TurnCost();
    c.note("m1", OPUS, { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 1 });
    expect(c.usd).toBeCloseTo(usd({ input: 100, cacheCreate: 2000, cacheRead: 10_000, output: 1 }), 9);
    c.note("m1", OPUS, { output_tokens: 50 });
    c.note("m1", OPUS, { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 50 });
    const exact = usd({ input: 100, cacheCreate: 2000, cacheRead: 10_000, output: 50 });
    expect(c.usd).toBeCloseTo(exact, 9);
    c.setOutput("m1", 10); // an older, smaller estimate cannot lower it
    expect(c.usd).toBeCloseTo(exact, 9);
    c.note("m2", "claude-haiku-4-5", { input_tokens: 1000, output_tokens: 1000 });
    expect(c.usd).toBeCloseTo(exact + (1000 + 5000) / 1_000_000, 9);
    c.reset();
    expect(c.usd).toBe(0);
  });

  it("prices unknown models like the most expensive known family so budgets are not undercounted", () => {
    const c = new TurnCost();
    c.note("m", "mystery-model", { input_tokens: 1_000_000 });
    expect(c.usd).toBeCloseTo(10, 9); // Fable: $10 / MTok input
  });

  it("uses the hub's price table: per-model prices, 1h cache writes, the Haiku 5.5 tier, fast mode, web search, overrides", () => {
    const c = new TurnCost();
    c.note("a", "claude-opus-5-5", { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 }, server_tool_use: { web_search_requests: 3 } });
    expect(c.usd).toBeCloseTo(4 + 8 + 0.03, 9);
    c.note("b", "claude-opus-5-5", { output_tokens: 1_000_000, speed: "fast" });
    expect(c.usd).toBeCloseTo(12.03 + 40, 9);
    c.note("c", "claude-haiku-5-5", { input_tokens: 150_000 }); // one request above 100K: the long-prompt tier
    expect(c.usd).toBeCloseTo(52.03 + 0.075, 9);
    // A pricer with an override (the hub passes its PricingService).
    const custom = new TurnCost(new Pricing({ "claude-sonnet-5-5": [{ from: null, input: 7, output: 9, cacheReadFactor: 0.1, cacheRead: 0.7 }] }));
    custom.note("x", "claude-sonnet-5-5-20261001", { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
    expect(custom.usd).toBeCloseTo(7.7, 9);
  });
});

describe("cost_update", () => {
  const turn = (q: FakeQuery) => {
    q.init();
    q.streamText("m1", "answer", { model: OPUS, usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 1 } });
    q.messageDelta(500);
    q.emit({
      type: "assistant",
      message: { id: "m1", role: "assistant", model: OPUS, content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 500 } },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: q.sessionId,
    });
    q.stop("m1");
    q.emitResultWithTotals({ input: 100, output: 500, cost: 0.2 });
  };

  it("broadcasts a growing estimate during the turn and the exact cost at the result", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    fx.sdk.behavior = turn;
    await fx.sessions.send(id, msgBody("go"));
    await until(() => fx.bus.ofType("cost_update").some((e) => e.final), 3000, "final cost_update");

    const updates = fx.bus.ofType("cost_update");
    expect(updates.every((e) => e.sessionId === id)).toBe(true);
    expect(fx.bus.events.find((e) => e.event.type === "cost_update")!.scope).toBe("user");
    const live = updates.filter((e) => !e.final);
    const final = updates.filter((e) => e.final);
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(final).toHaveLength(1);
    // the live estimates only grow and stop at the list price of the message's usage
    const turnCosts = live.map((e) => e.turnCostUsd);
    expect([...turnCosts].sort((a, b) => a - b)).toEqual(turnCosts);
    expect(turnCosts[turnCosts.length - 1]).toBeCloseTo(usd({ input: 100, cacheCreate: 2000, cacheRead: 10_000, output: 500 }), 9);
    expect(live.every((e) => e.sessionCostUsd === e.turnCostUsd)).toBe(true);
    // the result carries the SDK's exact cost, equal to what was stored on the session
    expect(final[0]).toMatchObject({ turnCostUsd: 0.2, sessionCostUsd: 0.2 });
    expect(fx.store.getSession(id)!.costUsd).toBeCloseTo(0.2, 9);
    expect(fx.bus.ofType("cost_update").at(-1)!.final).toBe(true);
  });

  it("adds the session's earlier cost to the live session total", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    fx.sdk.behavior = turn;
    await fx.sessions.send(id, msgBody("one"));
    await until(() => fx.bus.ofType("cost_update").some((e) => e.final), 3000, "first final");
    const before = fx.bus.ofType("cost_update").length;
    fx.sdk.behavior = (q) => {
      q.init();
      q.streamText("m2", "again", { usage: { input_tokens: 1000, output_tokens: 1 } });
      q.messageDelta(10);
      q.stop("m2");
      q.emitResultWithTotals({ input: 1100, output: 510, cost: 0.2 + 0.01 });
    };
    await fx.sessions.send(id, msgBody("two"));
    await until(() => fx.bus.ofType("cost_update").filter((e) => e.final).length === 2, 3000, "second final");
    const second = fx.bus.ofType("cost_update").slice(before);
    const live = second.filter((e) => !e.final);
    expect(live.length).toBeGreaterThan(0);
    expect(live.at(-1)!.sessionCostUsd).toBeCloseTo(0.2 + live.at(-1)!.turnCostUsd, 9);
    expect(second.at(-1)!).toMatchObject({ final: true, turnCostUsd: expect.closeTo(0.01, 9), sessionCostUsd: expect.closeTo(0.21, 9) });
  });
});

describe("Session.cwdAbs", () => {
  it("is the absolute working directory", () => {
    fx = runtimeFixture();
    // A chat works in a folder of its own.
    const chat = Session.parse(fx.sessions.toProtocol(fx.store.getSession(fx.newSession("chat"))!));
    expect(chat.cwd).toBe(`.chat/${chat.id}`);
    expect(chat.cwdAbs).toBe(join(fx.root, "alice", ".chat", chat.id));
    const code = Session.parse(fx.sessions.toProtocol(fx.store.getSession(fx.newSession("code"))!));
    expect(code.cwd).toBe("");
    expect(code.cwdAbs).toBe(join(fx.root, "alice"));
    const nested = fx.sessions.create({ user: "alice", kind: "code", cwd: "projects/sample-app", model: "default", permissionMode: "default", effort: null });
    expect(Session.parse(fx.sessions.toProtocol(nested)).cwdAbs).toBe(join(fx.root, "alice", "projects", "sample-app"));
  });
});
