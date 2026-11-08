import type { PermissionRequest, ServerEvent, Session } from "@agent-workstation/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resultMsg, session, SID, snapshotEvent } from "../test/fixtures";
import { createShellNotifier, waitingBody, type ShellNotifier } from "./shellNotify";

const CHILD = "22222222-2222-4222-8222-222222222222";
const MIN = 60_000;

let sessions: Record<string, Session>;
let watching: Set<string>;
let recap: string | null;
let notify: ReturnType<typeof vi.fn>;
let withShell: boolean;
let globalOn: boolean;
let n: ShellNotifier;

const status = (s: Session["status"], over: Partial<Session> = {}): ServerEvent => {
  sessions[over.id ?? SID] = session({ status: s, ...over });
  return { type: "session_updated", session: sessions[over.id ?? SID]! };
};
const perm = (requestId: string, over: Partial<PermissionRequest> = {}): ServerEvent => ({
  type: "permission_request",
  request: { requestId, sessionId: SID, toolName: "Bash", input: { command: "npm test" }, at: "2026-11-01T00:00:00.000Z", ...over },
});
const advance = (ms: number) => vi.advanceTimersByTime(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
  sessions = { [SID]: session() };
  watching = new Set();
  recap = null;
  notify = vi.fn();
  withShell = true;
  globalOn = true;
  n = createShellNotifier({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    shell: () => (withShell ? { notify: notify as unknown as NonNullable<Window["__workstationShell"]>["notify"] } : undefined),
    globalEnabled: () => globalOn,
    getSession: (id) => sessions[id],
    getRecap: () => recap,
    getTurnStartedAt: () => null,
    isWatching: (id) => watching.has(id),
    toLocalMs: (iso) => Date.parse(iso),
  });
});
afterEach(() => {
  n.dispose();
  vi.useRealTimers();
});

describe("finished turns", () => {
  it("notifies only when the turn was busy for more than 5 minutes", () => {
    n.handle(status("running"));
    advance(5 * MIN - 1000); // 4:59
    n.handle(status("idle"));
    expect(notify).not.toHaveBeenCalled();

    n.handle(status("running"));
    advance(5 * MIN + 1000); // 5:01
    n.handle(status("idle"));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ id: `done:${SID}`, title: "Test session finished", body: "", sessionId: SID });
  });

  it("counts requires_action as busy and measures from the snapshot's turnStartedAt", () => {
    n.handle(snapshotEvent(session({ status: "running" }), {}, null, new Date(Date.now() - 6 * MIN).toISOString()));
    n.handle(status("requires_action"));
    advance(1000);
    n.handle(status("idle"));
    expect(notify).toHaveBeenCalledTimes(1);

    notify.mockClear();
    n.handle(status("running")); // a fresh turn: counted from now again
    advance(MIN);
    n.handle(status("idle"));
    expect(notify).not.toHaveBeenCalled();
  });

  it("uses the first line of the next-step recap as the body", () => {
    n.handle(status("running"));
    n.handle({ type: "next_step", sessionId: SID, step: { recap: "\nTests pass.\nSecond line", at: "2026-11-01T12:00:00.000Z" } });
    advance(6 * MIN);
    n.handle(status("idle"));
    expect(notify.mock.calls[0]![0].body).toBe("Tests pass.");
  });

  it("falls back to the recap the client already holds", () => {
    recap = "From the store";
    n.handle(status("running"));
    advance(6 * MIN);
    n.handle({ type: "session_state", sessionId: SID, status: "idle", queuePosition: null });
    expect(notify.mock.calls[0]![0].body).toBe("From the store");
  });

  it("says 'stopped with an error' for a dead session or an error result", () => {
    n.handle(status("running"));
    advance(6 * MIN);
    n.handle(status("dead"));
    expect(notify.mock.calls[0]![0]).toMatchObject({ title: "Test session stopped with an error", body: "" });

    n.handle(status("running"));
    n.handle({ type: "message", sessionId: SID, message: resultMsg(5, { subtype: "error_during_execution", is_error: true }) });
    advance(6 * MIN);
    n.handle(status("idle"));
    expect(notify.mock.calls[1]![0].title).toBe("Test session stopped with an error");

    n.handle(status("running")); // the error belonged to the previous turn
    n.handle({ type: "message", sessionId: SID, message: resultMsg(9) });
    advance(6 * MIN);
    n.handle(status("idle"));
    expect(notify.mock.calls[2]![0].title).toBe("Test session finished");
  });

  it("reuses the same id for repeated notifications of one session", () => {
    for (let i = 0; i < 2; i++) {
      n.handle(status("running"));
      advance(6 * MIN);
      n.handle(status("idle"));
    }
    expect(notify.mock.calls.map((c) => c[0].id)).toEqual([`done:${SID}`, `done:${SID}`]);
  });

  it("seeds sessions that are already busy", () => {
    const s = session({ status: "running" });
    sessions[SID] = s;
    n.seed([s]);
    advance(6 * MIN);
    n.handle(status("idle"));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("waiting for the user", () => {
  it("notifies after more than 60 seconds, once per request", () => {
    n.handle(status("requires_action"));
    n.handle(perm("r1"));
    advance(59_000);
    expect(notify).not.toHaveBeenCalled();
    advance(2000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ id: `waiting:${SID}:r1`, title: "Test session is waiting for you", body: "Bash: npm test", sessionId: SID });

    n.handle(perm("r1")); // replayed after a reconnect
    n.handle(snapshotEvent(session({ status: "requires_action" }), {}, perm("r1").type === "permission_request" ? (perm("r1") as { request: PermissionRequest }).request : null));
    advance(5 * MIN);
    expect(notify).toHaveBeenCalledTimes(1);

    n.handle(perm("r2"));
    advance(61_000);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0].id).toBe(`waiting:${SID}:r2`);
  });

  it("no notification when it is answered or cancelled before 60 seconds", () => {
    n.handle(perm("r1"));
    n.handle(perm("r2"));
    advance(30_000);
    n.handle({ type: "permission_resolved", sessionId: SID, requestId: "r1", behavior: "allow" });
    n.handle({ type: "permission_cancelled", sessionId: SID, requestId: "r2" });
    advance(5 * MIN);
    expect(notify).not.toHaveBeenCalled();
  });

  it("answering after the notification does nothing more", () => {
    n.handle(perm("r1"));
    advance(61_000);
    n.handle({ type: "permission_resolved", sessionId: SID, requestId: "r1", behavior: "deny" });
    advance(5 * MIN);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("cancels pending timers when the session ends", () => {
    n.handle(status("requires_action"));
    n.handle(perm("r1"));
    advance(10_000);
    n.handle(status("idle"));
    advance(5 * MIN);
    expect(notify).not.toHaveBeenCalled();
  });

  it("describes questions, browser sites and subagent batches", () => {
    const base = { requestId: "r", sessionId: SID, at: "" };
    expect(waitingBody({ ...base, toolName: "AskUserQuestion", input: { questions: [{ question: "Which database?\nmore" }] } })).toBe("Which database?");
    expect(waitingBody({ ...base, toolName: "mcp__browser__browser_navigate", input: {}, browserSite: { origin: "https://example.com" } })).toBe("https://example.com");
    expect(waitingBody({ ...base, toolName: "Task", input: {}, subagent: { sessionId: CHILD, description: "Run 3 reviewers" } })).toBe("Run 3 reviewers");
  });
});

describe("suppression", () => {
  it("is silent for a session that is open, visible and focused", () => {
    watching.add(SID);
    n.handle(status("running"));
    advance(6 * MIN);
    n.handle(status("idle"));
    n.handle(perm("r1"));
    advance(2 * MIN);
    expect(notify).not.toHaveBeenCalled();
  });

  it("checks again when the timer fires (the window may have lost focus meanwhile)", () => {
    watching.add(SID);
    n.handle(perm("r1"));
    advance(30_000);
    watching.delete(SID);
    advance(31_000);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("ignores subagent child sessions", () => {
    n.handle(status("running", { id: CHILD, parentSessionId: SID }));
    advance(6 * MIN);
    n.handle(status("idle", { id: CHILD, parentSessionId: SID }));
    n.handle(perm("c1", { sessionId: CHILD }));
    advance(2 * MIN);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a subagent's request is shown on the parent", () => {
    n.handle(perm("s1", { subagent: { sessionId: CHILD, description: "Fetch docs" } }));
    advance(61_000);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SID, body: "Fetch docs" }));
  });

  it("never reveals the title or recap of an incognito chat", () => {
    sessions[SID] = session({ incognito: true, title: "Secret plans" });
    recap = "private recap";
    n.handle(status("running", { incognito: true, title: "Secret plans" }));
    advance(6 * MIN);
    n.handle(status("idle", { incognito: true, title: "Secret plans" }));
    n.handle(perm("r1"));
    advance(61_000);
    expect(notify.mock.calls.map((c) => c[0])).toEqual([
      { id: `done:${SID}`, title: "A chat finished", body: "", sessionId: SID },
      { id: `waiting:${SID}:r1`, title: "A chat is waiting for you", body: "", sessionId: SID },
    ]);
  });
});

describe("notification switches", () => {
  const finishLong = (over: Partial<Session> = {}) => {
    n.handle(status("running", over));
    advance(6 * MIN);
    n.handle(status("idle", over));
  };

  it("a session with notify: false stays silent; absent or true notifies", () => {
    finishLong({ notify: false });
    n.handle(perm("r1"));
    advance(2 * MIN);
    expect(notify).not.toHaveBeenCalled();

    finishLong({ notify: true });
    expect(notify).toHaveBeenCalledTimes(1);
    finishLong();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("the global switch off silences every session, whatever its own switch says", () => {
    globalOn = false;
    finishLong({ notify: true });
    n.handle(perm("r1"));
    advance(2 * MIN);
    expect(notify).not.toHaveBeenCalled();
    globalOn = true; // read live
    finishLong();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("turning a session's switch off cancels its pending waiting timers (event or sync), not other sessions'", () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    sessions[OTHER] = session({ id: OTHER });
    n.handle(perm("r1"));
    n.handle(perm("o1", { sessionId: OTHER }));
    advance(30_000);
    n.handle(status("requires_action", { notify: false })); // session_updated carries the new switch
    advance(5 * MIN);
    expect(notify.mock.calls.map((c) => c[0].id)).toEqual([`waiting:${OTHER}:o1`]);

    notify.mockClear();
    sessions[SID] = session({ notify: true });
    n.handle(perm("r2"));
    advance(30_000);
    sessions[SID] = session({ notify: false });
    n.sync();
    advance(5 * MIN);
    expect(notify).not.toHaveBeenCalled();
  });

  it("turning the global switch off cancels all pending waiting timers", () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    sessions[OTHER] = session({ id: OTHER });
    n.handle(perm("r1"));
    n.handle(perm("o1", { sessionId: OTHER }));
    advance(30_000);
    globalOn = false;
    n.sync();
    advance(5 * MIN);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a timer that fires after a switch went off (no sync) still sends nothing", () => {
    n.handle(perm("r1"));
    advance(30_000);
    globalOn = false;
    advance(31_000);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("without the shell", () => {
  it("makes no calls and sets no timers in a plain browser", () => {
    withShell = false;
    const spy = vi.spyOn(globalThis, "setTimeout");
    n.handle(status("running"));
    advance(6 * MIN);
    n.handle(status("idle"));
    n.handle(perm("r1"));
    advance(5 * MIN);
    expect(notify).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a shell without notify is the same as none", () => {
    n = createShellNotifier({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      shell: () => ({ pickFolder: () => {} }),
      globalEnabled: () => true,
      getSession: (id) => sessions[id],
      getRecap: () => null,
      getTurnStartedAt: () => null,
      isWatching: () => false,
      toLocalMs: (iso) => Date.parse(iso),
    });
    n.handle(status("running"));
    advance(6 * MIN);
    n.handle(status("idle"));
    expect(notify).not.toHaveBeenCalled();
  });
});
