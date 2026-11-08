import { beforeEach, describe, expect, it, vi } from "vitest";
import { SID, session, snapshotEvent, userText } from "../test/fixtures";

const mocks = vi.hoisted(() => ({ messages: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, messages: mocks.messages } };
});

import { loadEarlier, handleServerEvent } from "./hub";
import { useSessions } from "./sessions";
import { useToasts } from "./toasts";

const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => userText(from + i, `m${from + i}`));
const view = () => useSessions.getState().views[SID]!;

beforeEach(() => {
  vi.clearAllMocks();
  useSessions.getState().reset();
  useToasts.setState({ toasts: [] });
  // the hub truncated the replay: only seq 301..320 arrived
  handleServerEvent({ type: "replay", sessionId: SID, messages: seqs(301, 320), truncated: true });
  handleServerEvent(snapshotEvent(session({ lastSeq: 320 })));
});

describe("loadEarlier", () => {
  it("fetches the page just before the oldest held message via ?after= and merges it", async () => {
    mocks.messages.mockResolvedValue(seqs(101, 300));
    await loadEarlier(SID);
    // oldest held = 301 → the 200 messages 101..300 are `after=100, limit=200`
    expect(mocks.messages).toHaveBeenCalledWith(SID, 100, 200);
    expect(view().messages[0]!.seq).toBe(101);
    expect(view().messages).toHaveLength(220);
    expect(view().loadingEarlier).toBe(false);
    expect(view().truncated).toBe(true); // 1..100 still missing: the control stays
    // next click continues from the new oldest message
    mocks.messages.mockResolvedValue(seqs(1, 100));
    await loadEarlier(SID);
    expect(mocks.messages).toHaveBeenLastCalledWith(SID, 0, 100);
    expect(view().messages[0]!.seq).toBe(1);
  });

  it("stops offering the control when the hub has nothing for the range", async () => {
    mocks.messages.mockResolvedValue([]);
    await loadEarlier(SID);
    expect(view().truncated).toBe(false);
    expect(view().loadingEarlier).toBe(false);
  });

  it("keeps the control and tells the user when the request fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.messages.mockRejectedValue(new Error("boom"));
    await loadEarlier(SID);
    expect(view().truncated).toBe(true);
    expect(view().loadingEarlier).toBe(false);
    expect(useToasts.getState().toasts.some((t) => t.tone === "error" && t.description === "boom")).toBe(true);
  });

  it("ignores overlapping calls while a request is in flight", async () => {
    let release: (v: ReturnType<typeof seqs>) => void = () => {};
    mocks.messages.mockImplementation(() => new Promise((r) => (release = r)));
    const first = loadEarlier(SID);
    expect(view().loadingEarlier).toBe(true);
    await loadEarlier(SID);
    expect(mocks.messages).toHaveBeenCalledTimes(1);
    release(seqs(101, 300));
    await first;
    expect(view().messages).toHaveLength(220);
  });
});
