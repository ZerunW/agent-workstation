import { describe, expect, it, vi } from "vitest";
import type { ServerEvent, Session } from "@agent-workstation/protocol";
import { assistant, resultMsg, session, SID, snapshotEvent, stored, usageDelta, userText } from "../test/fixtures";
import { earlierGap, emptyView, eventSessionId, hasEarlierMessages, insertMessages, reduceSessionEvent } from "./session-reducer";

const replay = (...messages: ReturnType<typeof stored>[]): ServerEvent => ({ type: "replay", sessionId: SID, messages });
const live = (message: ReturnType<typeof stored>): ServerEvent => ({ type: "message", sessionId: SID, message });

describe("session reducer: replay -> snapshot -> live", () => {
  it("orders replay, snapshot and live events and dedupes by seq", () => {
    let v = emptyView(SID);
    v = reduceSessionEvent(v, replay(userText(1, "a"), assistant(2, [{ type: "text", text: "b" }])));
    expect(v.snapshotReceived).toBe(false);
    v = reduceSessionEvent(v, snapshotEvent(session({ lastSeq: 2, status: "running" })));
    expect(v.snapshotReceived).toBe(true);
    expect(v.session?.status).toBe("running");
    v = reduceSessionEvent(v, live(assistant(3, [{ type: "text", text: "c" }])));
    v = reduceSessionEvent(v, live(assistant(3, [{ type: "text", text: "c-dup" }])));
    expect(v.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect((v.messages[2]!.payload as any).message.content[0].text).toBe("c"); // first writer wins
    expect(v.lastSeq).toBe(3);
    expect(v.backfillAfter).toBeNull();
  });

  it("is idempotent when a replay overlaps already-held messages", () => {
    let v = reduceSessionEvent(emptyView(SID), replay(userText(1, "a"), userText(2, "b")));
    const before = v;
    v = reduceSessionEvent(v, replay(userText(1, "a"), userText(2, "b")));
    expect(v).toBe(before);
    v = reduceSessionEvent(v, replay(userText(2, "b"), userText(3, "c")));
    expect(v.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("keeps messages sorted when they arrive out of order", () => {
    const v = insertMessages(emptyView(SID), [userText(3, "c"), userText(1, "a"), userText(2, "b")]);
    expect(v.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    const w = insertMessages(v, [userText(0 + 5, "e"), userText(4, "d")]);
    expect(w.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(w.lastSeq).toBe(5);
  });

  it("requests a backfill when a live message skips seqs", () => {
    let v = reduceSessionEvent(emptyView(SID), replay(userText(1, "a"), userText(2, "b")));
    v = reduceSessionEvent(v, live(userText(5, "e")));
    expect(v.backfillAfter).toBe(2);
    v = reduceSessionEvent(v, replay(userText(3, "c"), userText(4, "d")));
    expect(v.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    v = reduceSessionEvent(v, { type: "backfill_done" });
    expect(v.backfillAfter).toBeNull();
  });

  it("requests a backfill when the snapshot says the hub has newer messages than the replay delivered", () => {
    let v = reduceSessionEvent(emptyView(SID), replay(userText(1, "a")));
    v = reduceSessionEvent(v, snapshotEvent(session({ lastSeq: 9 })));
    expect(v.backfillAfter).toBe(1);
  });

  it("subscribe_begin marks the snapshot as pending again without dropping messages", () => {
    let v = reduceSessionEvent(emptyView(SID), replay(userText(1, "a")));
    v = reduceSessionEvent(v, snapshotEvent(session({ lastSeq: 1 })));
    v = reduceSessionEvent(v, { type: "subscribe_begin" });
    expect(v.snapshotReceived).toBe(false);
    expect(v.messages).toHaveLength(1);
  });

  it("streams deltas, reconciles on the persisted assistant message and clears on result", () => {
    let v = reduceSessionEvent(emptyView(SID), snapshotEvent(session({ status: "running" })));
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "text", messageId: "m1", text: "Hel" } });
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "text", messageId: "m1", text: "lo" } });
    expect(v.partial.blocks).toEqual([{ type: "text", text: "Hello" }]);
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "message_end", messageId: "m1" } });
    v = reduceSessionEvent(v, live(assistant(1, [{ type: "text", text: "Hello" }])));
    expect(v.partial.blocks).toEqual([]);
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "text", messageId: "m2", text: "x" } });
    v = reduceSessionEvent(v, live(resultMsg(2)));
    expect(v.partial.blocks).toEqual([]);
  });

  it("restores the in-flight partial from a snapshot after reconnect", () => {
    const v = reduceSessionEvent(emptyView(SID), snapshotEvent(session({ status: "running" }), { messageId: "m", text: "so far", currentTool: { toolUseId: "t", toolName: "Bash", partialJson: '{"a"' } }));
    expect(v.partial.blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("removes the optimistic user bubble when the persisted echo (same uuid) arrives", () => {
    let v = reduceSessionEvent(emptyView(SID), { type: "pending_user_add", entry: { uuid: "abc", text: "hi", images: [], state: "sending", position: null, at: 0 } });
    expect(v.pendingUser).toHaveLength(1);
    v = reduceSessionEvent(v, live(userText(1, "hi", "abc")));
    expect(v.pendingUser).toHaveLength(0);
  });

  it("applies session_state / session_settings / session_updated to the session", () => {
    let v = reduceSessionEvent(emptyView(SID), snapshotEvent(session()));
    v = reduceSessionEvent(v, { type: "session_state", sessionId: SID, status: "queued", queuePosition: 2 });
    expect(v.session).toMatchObject({ status: "queued", queuePosition: 2 });
    v = reduceSessionEvent(v, { type: "session_settings", sessionId: SID, settings: { model: "m2", permissionMode: "plan", effort: "high" } });
    expect(v.session).toMatchObject({ model: "m2", permissionMode: "plan", effort: "high" });
    v = reduceSessionEvent(v, { type: "session_updated", session: session({ title: "Renamed" }) });
    expect(v.session?.title).toBe("Renamed");
  });
});

describe("permissions", () => {
  const req = { requestId: "r1", sessionId: SID, toolName: "Bash", input: { command: "ls" }, toolUseId: "tu1", at: "2026-10-31T00:00:00Z" };

  it("tracks pending -> resolved, marking answers from other tabs as elsewhere", () => {
    let v = reduceSessionEvent(emptyView(SID), { type: "permission_request", request: req });
    expect(v.permissions[0]).toMatchObject({ status: "pending", elsewhere: false });
    v = reduceSessionEvent(v, { type: "permission_resolved", sessionId: SID, requestId: "r1", behavior: "allow" });
    expect(v.permissions[0]).toMatchObject({ status: "allowed", elsewhere: true });
  });

  it("does not flag elsewhere when this client answered", () => {
    let v = reduceSessionEvent(emptyView(SID), { type: "permission_request", request: req });
    v = reduceSessionEvent(v, { type: "local_permission_answer", requestId: "r1", behavior: "deny" });
    v = reduceSessionEvent(v, { type: "permission_resolved", sessionId: SID, requestId: "r1", behavior: "deny" });
    expect(v.permissions[0]).toMatchObject({ status: "denied", elsewhere: false });
  });

  it("marks cancelled and ignores duplicate requests", () => {
    let v = reduceSessionEvent(emptyView(SID), { type: "permission_request", request: req });
    v = reduceSessionEvent(v, { type: "permission_request", request: req });
    expect(v.permissions).toHaveLength(1);
    v = reduceSessionEvent(v, { type: "permission_cancelled", sessionId: SID, requestId: "r1" });
    expect(v.permissions[0]!.status).toBe("cancelled");
  });

  it("a snapshot after reconnect re-surfaces the pending request and resolves stale ones", () => {
    let v = reduceSessionEvent(emptyView(SID), { type: "permission_request", request: req });
    v = reduceSessionEvent(v, snapshotEvent(session(), {}, { ...req, requestId: "r2" }));
    expect(v.permissions.find((p) => p.request.requestId === "r1")!.status).toBe("resolved");
    expect(v.permissions.find((p) => p.request.requestId === "r2")!.status).toBe("pending");
  });
});

describe("eventSessionId", () => {
  it("scopes events and leaves global ones undefined", () => {
    expect(eventSessionId({ type: "delta", sessionId: SID, delta: { part: "message_end", messageId: "m" } })).toBe(SID);
    expect(eventSessionId({ type: "pong" })).toBeUndefined();
    expect(eventSessionId({ type: "session_updated", session: session() })).toBe(SID);
  });
});

describe("truncated replay and earlier messages", () => {
  const truncatedReplay = (...messages: ReturnType<typeof stored>[]): ServerEvent => ({ type: "replay", sessionId: SID, messages, truncated: true });

  it("remembers a truncated replay without treating the missing head as a gap to backfill", () => {
    let v = emptyView(SID);
    v = reduceSessionEvent(v, truncatedReplay(userText(8, "h"), assistant(9, [{ type: "text", text: "i" }])));
    v = reduceSessionEvent(v, snapshotEvent(session({ lastSeq: 9 })));
    expect(v.truncated).toBe(true);
    expect(v.backfillAfter).toBeNull();
    expect(earlierGap(v.messages)).toEqual({ afterSeq: 0, beforeSeq: 8 });
    expect(hasEarlierMessages(v)).toBe(true);
  });

  it("a plain replay (or a live message) never clears the flag; filling the head does not either until the gap is gone", () => {
    let v = reduceSessionEvent(emptyView(SID), truncatedReplay(userText(5, "e")));
    v = reduceSessionEvent(v, replay(userText(6, "f")));
    expect(v.truncated).toBe(true);
    v = reduceSessionEvent(v, replay(userText(1, "a"), userText(2, "b"), userText(3, "c"), userText(4, "d")));
    expect(earlierGap(v.messages)).toBeNull();
    expect(hasEarlierMessages(v)).toBe(false); // flag stays set but there is nothing left to load
  });

  it("is not offered for sessions that were never truncated, even with a hole", () => {
    const v = reduceSessionEvent(emptyView(SID), replay(userText(3, "c")));
    expect(v.truncated).toBe(false);
    expect(hasEarlierMessages(v)).toBe(false);
  });

  it("earlierGap finds the first hole, including one in the middle", () => {
    expect(earlierGap([])).toBeNull();
    expect(earlierGap([userText(1, "a"), userText(2, "b")])).toBeNull();
    expect(earlierGap([userText(1, "a"), userText(2, "b"), userText(7, "g")])).toEqual({ afterSeq: 2, beforeSeq: 7 });
  });

  it("earlier_state toggles loading and `exhausted` hides the control", () => {
    let v = reduceSessionEvent(emptyView(SID), truncatedReplay(userText(5, "e")));
    v = reduceSessionEvent(v, { type: "earlier_state", loading: true });
    expect(v.loadingEarlier).toBe(true);
    v = reduceSessionEvent(v, { type: "earlier_state", loading: false, exhausted: true });
    expect(v.loadingEarlier).toBe(false);
    expect(v.truncated).toBe(false);
    expect(hasEarlierMessages(v)).toBe(false);
  });
});

describe("turn state (live indicator)", () => {
  const state = (status: Session["status"], queuePosition: number | null = null): ServerEvent => ({ type: "session_state", sessionId: SID, status, queuePosition });
  const pending = (at: number, uuid = "p1") => ({ type: "pending_user_add" as const, entry: { uuid, text: "hi", images: [], state: "sending" as const, position: null, at } });
  const t0 = Date.parse("2026-10-31T12:00:00Z");

  it("starts empty", () => {
    expect(emptyView(SID).turn).toEqual({ startedAt: null, outputTokens: 0 });
  });

  it("sending a message starts the clock; a message sent into a running turn does not restart it", () => {
    let v = reduceSessionEvent(emptyView(SID, session()), pending(t0));
    expect(v.turn.startedAt).toBe(t0);
    v = reduceSessionEvent(v, pending(t0 + 5000, "p2"));
    expect(v.turn.startedAt).toBe(t0);
  });

  it("session_state running starts it when nothing did, and keeps an earlier start", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0 + 2000);
    try {
      let v = reduceSessionEvent(emptyView(SID, session()), state("running"));
      expect(v.turn.startedAt).toBe(t0 + 2000);
      const sent = reduceSessionEvent(emptyView(SID, session()), pending(t0));
      v = reduceSessionEvent(sent, state("running"));
      expect(v.turn.startedAt).toBe(t0);
      // requires_action / queued neither start nor reset it
      expect(reduceSessionEvent(v, state("requires_action")).turn.startedAt).toBe(t0);
      expect(reduceSessionEvent(emptyView(SID, session()), state("queued", 1)).turn.startedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the start and the tokens from a snapshot of a running turn", () => {
    const iso = new Date(t0).toISOString();
    const v = reduceSessionEvent(emptyView(SID), snapshotEvent(session({ status: "running" }), { turnOutputTokens: 1234 }, null, iso));
    expect(v.turn).toEqual({ startedAt: t0, outputTokens: 1234 });
  });

  it("a snapshot without turn fields (older hub) of a running session keeps what it had, or starts now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    try {
      const had = reduceSessionEvent(reduceSessionEvent(emptyView(SID, session()), pending(t0 - 4000)), snapshotEvent(session({ status: "running" })));
      expect(had.turn.startedAt).toBe(t0 - 4000);
      const fresh = reduceSessionEvent(emptyView(SID), snapshotEvent(session({ status: "running" })));
      expect(fresh.turn).toEqual({ startedAt: t0, outputTokens: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shifts the hub's turnStartedAt by the clock offset so a drifting server clock does not skew the elapsed time", () => {
    // the server's clock runs 5 min ahead of this browser; its turn began 12 s before "now" on its own clock
    const offsetMs = 5 * 60_000;
    const hubNow = t0 + offsetMs;
    const iso = new Date(hubNow - 12_000).toISOString();
    const ev = snapshotEvent(session({ status: "running" }), {}, null, iso);
    expect(reduceSessionEvent(emptyView(SID), ev, { serverOffsetMs: offsetMs }).turn.startedAt).toBe(t0 - 12_000);
    // the server behind the browser (negative offset) works the same way
    expect(reduceSessionEvent(emptyView(SID), snapshotEvent(session({ status: "running" }), {}, null, new Date(t0 - 90_000 - 12_000).toISOString()), { serverOffsetMs: -90_000 }).turn.startedAt).toBe(t0 - 12_000);
    // no clock given: the timestamp is taken as is
    expect(reduceSessionEvent(emptyView(SID), ev).turn.startedAt).toBe(hubNow - 12_000);
  });

  it("a snapshot of an idle session clears the turn", () => {
    let v = reduceSessionEvent(emptyView(SID, session({ status: "running" })), pending(t0));
    v = reduceSessionEvent(v, usageDelta(900));
    v = reduceSessionEvent(v, snapshotEvent(session({ status: "idle" }), {}, null, null));
    expect(v.turn).toEqual({ startedAt: null, outputTokens: 0 });
  });

  it("usage deltas set the turn's output tokens (absolute) without touching the partial", () => {
    let v = reduceSessionEvent(emptyView(SID), snapshotEvent(session({ status: "running" }), {}, null, new Date(t0).toISOString()));
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "text", messageId: "m", text: "Hi" } });
    const partial = v.partial;
    v = reduceSessionEvent(v, usageDelta(120, 40));
    expect(v.turn.outputTokens).toBe(120);
    expect(v.partial).toBe(partial);
    v = reduceSessionEvent(v, usageDelta(310, 200));
    expect(v.turn.outputTokens).toBe(310);
    // the same count again is a no-op (no re-render)
    expect(reduceSessionEvent(v, usageDelta(310))).toBe(v);
  });

  it("a late usage delta after the turn ended does not leak into the next turn", () => {
    let v = reduceSessionEvent(emptyView(SID), snapshotEvent(session({ status: "running" })));
    v = reduceSessionEvent(v, usageDelta(500));
    v = reduceSessionEvent(v, state("idle"));
    expect(v.turn).toEqual({ startedAt: null, outputTokens: 0 });
    v = reduceSessionEvent(v, usageDelta(800));
    expect(v.turn.outputTokens).toBe(0);
  });

  it("resets on idle and on dead", () => {
    for (const end of ["idle", "dead"] as const) {
      let v = reduceSessionEvent(emptyView(SID, session({ status: "running" })), pending(t0));
      v = reduceSessionEvent(v, usageDelta(42));
      expect(v.turn).toEqual({ startedAt: t0, outputTokens: 42 });
      v = reduceSessionEvent(v, state(end));
      expect(v.turn).toEqual({ startedAt: null, outputTokens: 0 });
    }
  });

  it("session_updated carrying an idle status also resets it", () => {
    let v = reduceSessionEvent(emptyView(SID, session({ status: "running" })), pending(t0));
    v = reduceSessionEvent(v, { type: "session_updated", session: session({ status: "idle" }) });
    expect(v.turn.startedAt).toBeNull();
  });

  it("a send that failed (or was discarded) before any turn started does not leave a stale start behind", () => {
    let v = reduceSessionEvent(emptyView(SID, session()), pending(t0));
    v = reduceSessionEvent(v, { type: "pending_user_update", uuid: "p1", patch: { state: "failed", error: "boom" } });
    expect(v.turn.startedAt).toBeNull();
    v = reduceSessionEvent(emptyView(SID, session()), pending(t0));
    v = reduceSessionEvent(v, { type: "pending_user_remove", uuid: "p1" });
    expect(v.turn.startedAt).toBeNull();
    // …but while a turn runs, a failed second send must not stop the running turn's timer
    let running = reduceSessionEvent(emptyView(SID, session({ status: "running" })), pending(t0));
    running = reduceSessionEvent(running, pending(t0 + 1, "p2"));
    running = reduceSessionEvent(running, { type: "pending_user_update", uuid: "p2", patch: { state: "failed" } });
    expect(running.turn.startedAt).toBe(t0);
  });

  it("the hub's echo of the sent message keeps the clock running until the turn state arrives", () => {
    let v = reduceSessionEvent(emptyView(SID, session()), pending(t0, "abc"));
    v = reduceSessionEvent(v, live(userText(1, "hi", "abc")));
    expect(v.pendingUser).toHaveLength(0);
    expect(v.turn.startedAt).toBe(t0);
  });
});

describe("context usage on the session", () => {
  const usage = { usedTokens: 100, windowTokens: 1000, model: null, breakdown: null, updatedAt: "2026-10-31T12:00:00Z" };

  it("a later session_updated / snapshot from a hub that omits contextUsage keeps the last known one", () => {
    let v = reduceSessionEvent(emptyView(SID, session({ contextUsage: usage })), { type: "session_updated", session: session({ title: "Renamed" }) });
    expect(v.session?.contextUsage).toEqual(usage);
    v = reduceSessionEvent(v, snapshotEvent(session()));
    expect(v.session?.contextUsage).toEqual(usage);
    // an explicit value (even null) from the hub wins
    v = reduceSessionEvent(v, { type: "session_updated", session: session({ contextUsage: null }) });
    expect(v.session?.contextUsage).toBeNull();
  });
});

describe("session reducer: background tasks", () => {
  const task = { taskId: "t1", type: "local_bash", description: "npm run dev", startedAt: "2026-10-31T12:00:00Z" };
  const withTasks = (s: Session, tasks: (typeof task)[]): ServerEvent => {
    const snap = snapshotEvent(s);
    return snap.type === "snapshot" ? { ...snap, snapshot: { ...snap.snapshot, backgroundTasks: tasks } } : snap;
  };

  it("is undefined until the hub reports it (an older hub never does)", () => {
    const v = reduceSessionEvent(emptyView(SID, session()), snapshotEvent(session()));
    expect(v.backgroundTasks).toBeUndefined();
  });

  it("takes the snapshot's list and follows background_tasks events (the full current set)", () => {
    let v = reduceSessionEvent(emptyView(SID, session()), withTasks(session(), [task]));
    expect(v.backgroundTasks).toEqual([task]);
    v = reduceSessionEvent(v, { type: "background_tasks", sessionId: SID, tasks: [task, { ...task, taskId: "t2" }] });
    expect(v.backgroundTasks?.map((t) => t.taskId)).toEqual(["t1", "t2"]);
    v = reduceSessionEvent(v, { type: "background_tasks", sessionId: SID, tasks: [] });
    expect(v.backgroundTasks).toEqual([]);
    // a snapshot from a hub without the field does not wipe what events delivered
    v = reduceSessionEvent(v, { type: "background_tasks", sessionId: SID, tasks: [task] });
    v = reduceSessionEvent(v, snapshotEvent(session()));
    expect(v.backgroundTasks).toEqual([task]);
  });

  it("is scoped to its session", () => {
    expect(eventSessionId({ type: "background_tasks", sessionId: SID, tasks: [] })).toBe(SID);
  });
});

describe("session reducer: next step", () => {
  const step = { recap: "Done.", ask: "Ship?", actions: [{ label: "Ship" }], at: "2026-10-31T12:00:00Z" };

  it("follows the snapshot and next_step events; a snapshot without the field clears it", () => {
    let v = reduceSessionEvent(emptyView(SID, session()), snapshotEvent(session()));
    expect(v.nextStep).toBeNull();
    v = reduceSessionEvent(v, { type: "next_step", sessionId: SID, step });
    expect(v.nextStep).toEqual(step);
    v = reduceSessionEvent(v, { type: "next_step", sessionId: SID, step: null });
    expect(v.nextStep).toBeNull();
    const snap = snapshotEvent(session());
    if (snap.type !== "snapshot") throw new Error("snapshot expected");
    v = reduceSessionEvent(v, { ...snap, snapshot: { ...snap.snapshot, nextStep: step } });
    expect(v.nextStep).toEqual(step);
    v = reduceSessionEvent(v, snapshotEvent(session()));
    expect(v.nextStep).toBeNull();
  });

  it("is cleared when the user sends something", () => {
    let v = reduceSessionEvent(emptyView(SID, session()), { type: "next_step", sessionId: SID, step });
    v = reduceSessionEvent(v, { type: "pending_user_add", entry: { uuid: "p", text: "x", images: [], state: "sending", position: null, at: 1 } });
    expect(v.nextStep).toBeNull();
  });

  it("is scoped to its session", () => {
    expect(eventSessionId({ type: "next_step", sessionId: SID, step: null })).toBe(SID);
  });
});

describe("session reducer: messages_rewound", () => {
  const rewound = (fromSeq: number): ServerEvent => ({ type: "messages_rewound", sessionId: SID, fromSeq });
  const base = () =>
    reduceSessionEvent(
      emptyView(SID, session({ pinnedMessages: ["a-2", "a-4"] })),
      replay(userText(1, "q1", "u-1"), stored(2, "assistant", { type: "assistant", message: { content: [{ type: "text", text: "a1" }] } }, "a-2"), userText(3, "q2", "u-3"), stored(4, "assistant", { type: "assistant", message: { content: [{ type: "text", text: "a2" }] } }, "a-4")),
    );

  it("drops the messages with seq >= fromSeq and keeps the earlier ones", () => {
    expect(reduceSessionEvent(base(), rewound(3)).messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("drops the pinned marks of the removed messages only", () => {
    expect(reduceSessionEvent(base(), rewound(3)).session?.pinnedMessages).toEqual(["a-2"]);
  });

  it("keeps lastSeq: later messages continue with higher seqs, and a new one is not a gap", () => {
    let v = reduceSessionEvent(base(), rewound(3));
    expect(v.lastSeq).toBe(4);
    v = reduceSessionEvent(v, live(userText(5, "again", "u-5")));
    expect(v.messages.map((m) => m.seq)).toEqual([1, 2, 5]);
    expect(v.backfillAfter).toBeNull();
  });

  it("clears the in-flight partial", () => {
    let v = reduceSessionEvent(base(), { type: "delta", sessionId: SID, delta: { part: "text", messageId: "m", text: "typing" } });
    expect(v.partial.blocks.length).toBe(1);
    v = reduceSessionEvent(v, rewound(3));
    expect(v.partial.blocks).toEqual([]);
  });

  it("rewinding past everything leaves an empty list; a rewind of nothing leaves the view alone", () => {
    expect(reduceSessionEvent(base(), rewound(1)).messages).toEqual([]);
    const empty = emptyView(SID, session());
    expect(reduceSessionEvent(empty, rewound(5))).toBe(empty);
  });

  it("is scoped to its session", () => {
    expect(eventSessionId(rewound(2))).toBe(SID);
  });
});

describe("session reducer: snapshot.rewound", () => {
  const msg = (seq: number) => stored(seq, "assistant", { type: "assistant", message: { content: [{ type: "text", text: `m${seq}` }] } }, `a-${seq}`);
  const held = (pins: string[] = []) => reduceSessionEvent(emptyView(SID, session({ pinnedMessages: pins })), replay(...[1, 2, 3, 4, 5, 6].map(msg)));
  const snap = (rewound?: Array<[number, number]>, s: Session = session({ lastSeq: 6 })): ServerEvent => {
    const ev = snapshotEvent(s);
    return ev.type === "snapshot" ? { ...ev, snapshot: { ...ev.snapshot, ...(rewound ? { rewound } : {}) } } : ev;
  };

  it("drops the held messages whose seq lies in a rewound range (inclusive)", () => {
    const v = reduceSessionEvent(held(), snap([[3, 4]]));
    expect(v.messages.map((m) => m.seq)).toEqual([1, 2, 5, 6]);
    expect(v.snapshotReceived).toBe(true);
  });

  it("handles several ranges and keeps lastSeq", () => {
    const v = reduceSessionEvent(held(), snap([[1, 1], [4, 5]]));
    expect(v.messages.map((m) => m.seq)).toEqual([2, 3, 6]);
    expect(v.lastSeq).toBe(6);
    expect(v.backfillAfter).toBeNull();
  });

  it("drops the pins of the removed messages only", () => {
    const v = reduceSessionEvent(held(["a-2", "a-3", "a-6"]), snap([[3, 4]], session({ lastSeq: 6, pinnedMessages: ["a-2", "a-3", "a-6"] })));
    expect(v.session?.pinnedMessages).toEqual(["a-2", "a-6"]);
  });

  it("leaves the view alone without ranges, with an empty list, or when nothing held is in a range", () => {
    const base = held();
    expect(reduceSessionEvent(base, snap()).messages).toHaveLength(6);
    expect(reduceSessionEvent(base, snap([])).messages).toHaveLength(6);
    expect(reduceSessionEvent(base, snap([[10, 12]])).messages).toHaveLength(6);
  });
});
