import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../test/fixtures";

const deleteSession = vi.fn(async (_id: string) => undefined);
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, deleteSession: (id: string) => deleteSession(id) } };
});

import { setApiUser } from "../lib/api";
import { endAllIncognitoOnExit, endIncognito, holdIncognito, isHeldIncognito, isIncognito, isSubagentSession, listable, resetIncognito } from "./incognito";
import { sessionsOfKind, useSessions } from "./sessions";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetIncognito();
  useSessions.getState().reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("listable", () => {
  it("drops incognito sessions from lists and nothing else", () => {
    const list = [session({ id: A }), session({ id: SID, incognito: true }), session({ id: "c", incognito: false })];
    expect(listable(list).map((s) => s.id)).toEqual([A, "c"]);
    expect(isIncognito(list[1])).toBe(true);
    expect(isIncognito(list[0])).toBe(false);
    expect(isIncognito(undefined)).toBe(false);
  });
});

describe("subagent sessions", () => {
  it("never count as listable, and sessionsOfKind leaves them out", () => {
    const child = session({ id: "kid", parentSessionId: A });
    expect(isSubagentSession(child)).toBe(true);
    expect(isSubagentSession(session({ id: A, parentSessionId: null }))).toBe(false);
    expect(isSubagentSession(session({ id: A }))).toBe(false);
    expect(listable([session({ id: A }), child]).map((s) => s.id)).toEqual([A]);
    const all = Object.fromEntries([session({ id: A }), child].map((s) => [s.id, s]));
    expect(sessionsOfKind(all, "code").map((s) => s.id)).toEqual([A]);
  });
});

describe("holding an open incognito chat", () => {
  it("leaving it deletes it from the hub and from the store", async () => {
    useSessions.setState({ sessions: { [SID]: session({ incognito: true }) }, views: {}, listLoaded: true });
    const release = holdIncognito(SID);
    expect(isHeldIncognito(SID)).toBe(true);
    release();
    expect(deleteSession).not.toHaveBeenCalled(); // after a tick, so a re-run of the effect can cancel it
    await vi.advanceTimersByTimeAsync(0);
    expect(deleteSession).toHaveBeenCalledWith(SID);
    expect(useSessions.getState().sessions[SID]).toBeUndefined();
    expect(isHeldIncognito(SID)).toBe(false);
  });

  it("a hold taken again in the same tick (StrictMode re-running the effect) cancels the delete", async () => {
    const release = holdIncognito(SID);
    release();
    holdIncognito(SID);
    await vi.advanceTimersByTimeAsync(50);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(isHeldIncognito(SID)).toBe(true);
  });

  it("deleting twice asks the hub once, and a failing delete is silent (the restart purge is the net)", async () => {
    deleteSession.mockRejectedValueOnce(new Error("offline"));
    holdIncognito(SID);
    endIncognito(SID);
    endIncognito(SID);
    await vi.advanceTimersByTimeAsync(0);
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("endIncognito leaves sessions that are not held alone", () => {
    useSessions.setState({ sessions: { [SID]: session() }, views: {}, listLoaded: true });
    endIncognito(SID);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(useSessions.getState().sessions[SID]).toBeDefined();
  });
});

describe("closing the tab", () => {
  it("pagehide sends a keepalive DELETE (with the user header) for every open incognito chat", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    setApiUser("alice");
    holdIncognito(SID);
    holdIncognito(A);
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toMatch(/^\/api\/sessions\/(?:1{8}-1111|a{8}-aaaa)/);
      expect(init).toMatchObject({ method: "DELETE", keepalive: true });
      expect(init.headers).toMatchObject({ "X-Workstation-User": "alice" });
    }
    expect(isHeldIncognito(SID)).toBe(false);
    // a second pagehide has nothing left to do
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    setApiUser(null);
  });

  it("a delete that was already scheduled by leaving is not sent twice on pagehide", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const release = holdIncognito(SID);
    release();
    endAllIncognitoOnExit();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("nothing open: nothing sent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
