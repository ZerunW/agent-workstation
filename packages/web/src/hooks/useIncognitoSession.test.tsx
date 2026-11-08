import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../test/fixtures";

const deleteSession = vi.fn(async (_id: string) => undefined);
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, deleteSession: (id: string) => deleteSession(id) } };
});

import { resetIncognito } from "../store/incognito";
import { useSessions } from "../store/sessions";
import { useIncognitoSession } from "./useIncognitoSession";

const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const flush = () => act(() => vi.advanceTimersByTimeAsync(5));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetIncognito();
  useSessions.setState({ sessions: { [SID]: session({ kind: "chat", incognito: true }), [OTHER]: session({ id: OTHER, kind: "chat" }) }, views: {}, listLoaded: true });
});
afterEach(() => vi.useRealTimers());

describe("useIncognitoSession", () => {
  it("is true for an incognito chat and false for a normal one", () => {
    expect(renderHook(() => useIncognitoSession(SID)).result.current).toBe(true);
    expect(renderHook(() => useIncognitoSession(OTHER)).result.current).toBe(false);
    expect(renderHook(() => useIncognitoSession(undefined)).result.current).toBe(false);
  });

  it("deletes the chat when the person starts a new chat (the URL loses its session)", async () => {
    const { rerender } = renderHook(({ id }: { id: string | undefined }) => useIncognitoSession(id), { initialProps: { id: SID as string | undefined } });
    await flush();
    expect(deleteSession).not.toHaveBeenCalled();
    rerender({ id: undefined });
    await flush();
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith(SID);
  });

  it("deletes it when another session is opened, and leaves that one alone", async () => {
    const { rerender } = renderHook(({ id }: { id: string | undefined }) => useIncognitoSession(id), { initialProps: { id: SID as string | undefined } });
    rerender({ id: OTHER });
    await flush();
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith(SID);
  });

  it("deletes it when the view goes away (another page)", async () => {
    const { unmount } = renderHook(() => useIncognitoSession(SID));
    await flush();
    unmount();
    await flush();
    expect(deleteSession).toHaveBeenCalledWith(SID);
  });

  it("never deletes a normal chat when it is left", async () => {
    const { rerender } = renderHook(({ id }: { id: string | undefined }) => useIncognitoSession(id), { initialProps: { id: OTHER as string | undefined } });
    rerender({ id: undefined });
    await flush();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("StrictMode's mount / unmount / mount does not delete the chat that is open", async () => {
    renderHook(() => useIncognitoSession(SID), { wrapper: StrictMode });
    await flush();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("keeps holding the chat when the session list refresh forgets its row, and deletes it only on leaving", async () => {
    const { rerender, result } = renderHook(({ id }: { id: string | undefined }) => useIncognitoSession(id), { initialProps: { id: SID as string | undefined } });
    act(() => useSessions.setState({ sessions: {} }));
    expect(result.current).toBe(true);
    await flush();
    expect(deleteSession).not.toHaveBeenCalled();
    rerender({ id: undefined });
    await flush();
    expect(deleteSession).toHaveBeenCalledWith(SID);
  });
});
