import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextUsage } from "@agent-workstation/protocol";
import { SID, session, snapshotEvent, usageDelta } from "../test/fixtures";
import { handleServerEvent } from "./hub";
import { useApp } from "./app";
import { useSessions } from "./sessions";

const usage: ContextUsage = {
  usedTokens: 26_000,
  windowTokens: 100_000,
  model: "claude-sonnet-5-5",
  breakdown: [{ key: "messages", label: "Messages", tokens: 26_000 }],
  updatedAt: "2026-10-31T12:00:00.000Z",
};
const stored = () => useSessions.getState().sessions[SID];
const view = () => useSessions.getState().views[SID];

beforeEach(() => {
  useSessions.getState().reset();
  useApp.setState({ memoriesTick: 0, serverOffsetMs: 0 });
  useSessions.getState().setSessions([session()]);
});

describe("context_usage", () => {
  it("patches the session in the store and in its open view", () => {
    handleServerEvent(snapshotEvent(session()));
    expect(stored()?.contextUsage).toBeUndefined();
    handleServerEvent({ type: "context_usage", sessionId: SID, usage });
    expect(stored()?.contextUsage).toEqual(usage);
    expect(view()?.session?.contextUsage).toEqual(usage);
  });

  it("works for a session that has no open view yet, and ignores an unknown one", () => {
    handleServerEvent({ type: "context_usage", sessionId: SID, usage });
    expect(stored()?.contextUsage).toEqual(usage);
    expect(view()).toBeUndefined();
    handleServerEvent({ type: "context_usage", sessionId: "22222222-2222-4222-8222-222222222222", usage });
    expect(useSessions.getState().sessions["22222222-2222-4222-8222-222222222222"]).toBeUndefined();
  });

  it("survives a later session_updated and a list refresh from a hub that omits it, but a new value replaces it", () => {
    handleServerEvent(snapshotEvent(session()));
    handleServerEvent({ type: "context_usage", sessionId: SID, usage });
    handleServerEvent({ type: "session_updated", session: session({ title: "Renamed" }) });
    expect(stored()?.title).toBe("Renamed");
    expect(stored()?.contextUsage).toEqual(usage);
    expect(view()?.session?.contextUsage).toEqual(usage);
    useSessions.getState().setSessions([session({ title: "Renamed again" })]);
    expect(stored()?.contextUsage).toEqual(usage);
    const next = { ...usage, usedTokens: 50_000, updatedAt: "2026-10-31T12:05:00.000Z" };
    handleServerEvent({ type: "context_usage", sessionId: SID, usage: next });
    expect(stored()?.contextUsage).toEqual(next);
  });
});

describe("turn state through the hub glue", () => {
  it("usage deltas (batched) land in the view's turn, and the end of the turn clears them", () => {
    handleServerEvent(snapshotEvent(session({ status: "running" }), {}, null, "2026-10-31T12:00:00.000Z"));
    handleServerEvent(usageDelta(100));
    handleServerEvent(usageDelta(250));
    handleServerEvent({ type: "pong" }); // any ordered event flushes the delta batch
    expect(view()?.turn).toEqual({ startedAt: Date.parse("2026-10-31T12:00:00.000Z"), outputTokens: 250 });
    handleServerEvent({ type: "session_state", sessionId: SID, status: "idle", queuePosition: null });
    expect(view()?.turn).toEqual({ startedAt: null, outputTokens: 0 });
  });

  it("a session_updated that says idle also ends the turn (it bypasses the reducer)", () => {
    handleServerEvent(snapshotEvent(session({ status: "running" }), {}, null, "2026-10-31T12:00:00.000Z"));
    expect(view()?.turn.startedAt).not.toBeNull();
    handleServerEvent({ type: "session_updated", session: session({ status: "idle" }) });
    expect(view()?.turn.startedAt).toBeNull();
  });
});

describe("memories_changed", () => {
  it("bumps the counter the Memory page refetches on", () => {
    handleServerEvent({ type: "memories_changed" });
    handleServerEvent({ type: "memories_changed" });
    expect(useApp.getState().memoriesTick).toBe(2);
  });
});

describe("clock skew (welcome.serverTime)", () => {
  const welcome = (serverTime: string) => ({ type: "welcome" as const, user: { name: "alice" } as never, protocolVersion: 1, serverTime });
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("measures the hub-minus-browser offset from the welcome and applies it to turnStartedAt", () => {
    // the server is 5 minutes ahead
    handleServerEvent(welcome(new Date(now + 300_000).toISOString()));
    expect(useApp.getState().serverOffsetMs).toBe(300_000);
    handleServerEvent(snapshotEvent(session({ status: "running" }), {}, null, new Date(now + 300_000 - 12_000).toISOString()));
    expect(view()?.turn.startedAt).toBe(now - 12_000);
  });

  it("without a welcome (or with an unreadable time) nothing is shifted", () => {
    handleServerEvent(welcome("not a date"));
    expect(useApp.getState().serverOffsetMs).toBe(0);
    handleServerEvent(snapshotEvent(session({ status: "running" }), {}, null, new Date(now - 7000).toISOString()));
    expect(view()?.turn.startedAt).toBe(now - 7000);
  });

  it("a later welcome (reconnect) re-measures it", () => {
    handleServerEvent(welcome(new Date(now + 300_000).toISOString()));
    handleServerEvent(welcome(new Date(now - 2000).toISOString()));
    expect(useApp.getState().serverOffsetMs).toBe(-2000);
  });
});
