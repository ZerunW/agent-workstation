import type { ModelInfo } from "@agent-workstation/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SID, session } from "../test/fixtures";

const mocks = vi.hoisted(() => ({ patchSettings: vi.fn(), createSession: vi.fn(), sendMessage: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, patchSettings: mocks.patchSettings, createSession: mocks.createSession, sendMessage: mocks.sendMessage } };
});

import { ApiError } from "../lib/api";
import { createSession, isBlockingCode, patchSettings, sendMessage } from "./actions";
import { useApp } from "./app";
import { useSessions } from "./sessions";
import { useToasts } from "./toasts";

const MODELS: ModelInfo[] = [{ value: "claude-opus-5-5", displayName: "Opus 5.5", family: "opus", legacy: false }];
const toasts = () => useToasts.getState().toasts.map((t) => t.title);

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  useSessions.getState().reset();
  useApp.setState({ models: MODELS, modelsLoaded: true, sendBlock: null });
});

describe("patchSettings", () => {
  const seed = (over: Parameters<typeof session>[0]) => useSessions.setState({ sessions: { [SID]: session(over) }, views: {}, listLoaded: true });
  const modelNow = () => {
    const s = useSessions.getState();
    return (s.views[SID]?.session ?? s.sessions[SID])?.model;
  };

  it("applies the change at once and sends the patch", async () => {
    seed({ kind: "chat", model: "claude-opus-5-5" });
    mocks.patchSettings.mockResolvedValue({});
    await patchSettings(SID, { model: "claude-sonnet-5-5" });
    expect(mocks.patchSettings).toHaveBeenCalledWith(SID, { model: "claude-sonnet-5-5" });
    expect(modelNow()).toBe("claude-sonnet-5-5");
  });

  it("rolls back and keeps the hub's message on a failure", async () => {
    seed({ kind: "chat", model: "claude-opus-5-5" });
    mocks.patchSettings.mockRejectedValue(new ApiError(403, "model not allowed", "model_not_allowed"));
    await patchSettings(SID, { model: "claude-sonnet-5-5" });
    expect(toasts()).toEqual(["model not allowed"]);
    expect(modelNow()).toBe("claude-opus-5-5");
  });

  it("api_unavailable rolls back, toasts and marks the account without API credits", async () => {
    useApp.setState({ me: { user: { name: "alice" }, apiAvailable: true } as never });
    seed({ kind: "chat", model: "claude-opus-5-5" });
    mocks.patchSettings.mockRejectedValue(new ApiError(503, "x", "api_unavailable"));
    await patchSettings(SID, { model: "claude-sonnet-5-5" });
    expect(toasts()).toEqual(["API credits are not available"]);
    expect(modelNow()).toBe("claude-opus-5-5");
    expect(useApp.getState().me?.apiAvailable).toBe(false);
  });

  it("api_limit_reached toasts that the credits are used up", async () => {
    seed({ kind: "chat", model: "claude-opus-5-5" });
    mocks.patchSettings.mockRejectedValue(new ApiError(429, "x", "api_limit_reached"));
    await patchSettings(SID, { model: "claude-sonnet-5-5" });
    expect(toasts()).toEqual(["API credits used up this month"]);
  });
});

describe("createSession", () => {
  it("sends the chosen model, effort and mode", async () => {
    mocks.createSession.mockResolvedValue(session());
    await createSession("code", { cwd: "proj", settings: { model: "claude-opus-5-5", effort: "high", permissionMode: "plan" } });
    expect(mocks.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "code", cwd: "proj", model: "claude-opus-5-5", effort: "high", permissionMode: "plan" }));
    expect(mocks.createSession.mock.calls.at(-1)![0]).not.toHaveProperty("backend");
    expect(mocks.createSession.mock.calls.at(-1)![0]).not.toHaveProperty("billing");
  });

  it("other errors toast", async () => {
    mocks.createSession.mockRejectedValue(new ApiError(500, "boom"));
    expect(await createSession("chat", {})).toBeNull();
    expect(toasts()).toEqual(["boom"]);
    expect(useApp.getState().sendBlock).toBeNull();
  });

  it("sends incognito for a chat only when asked, never for code", async () => {
    mocks.createSession.mockResolvedValue(session({ kind: "chat", incognito: true }));
    await createSession("chat", { incognito: true });
    expect(mocks.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "chat", incognito: true }));
    await createSession("chat", {});
    expect(mocks.createSession.mock.calls.at(-1)![0].incognito).toBeUndefined();
    await createSession("chat", { incognito: false });
    expect(mocks.createSession.mock.calls.at(-1)![0].incognito).toBeUndefined();
    await createSession("code", { incognito: true });
    expect(mocks.createSession.mock.calls.at(-1)![0].incognito).toBeUndefined();
  });

  it("api_unavailable is a toast (and the account loses its API credits); the draft survives because nothing was created", async () => {
    useApp.setState({ me: { user: { name: "alice" }, apiAvailable: true } as never });
    mocks.createSession.mockRejectedValue(new ApiError(503, "no key", "api_unavailable"));
    expect(await createSession("chat", {})).toBeNull();
    expect(toasts()).toEqual(["API credits are not available"]);
    expect(useApp.getState().me?.apiAvailable).toBe(false);
    expect(useApp.getState().sendBlock).toBeNull();
  });

  it("api_limit_reached blocks the composer instead of a toast", async () => {
    mocks.createSession.mockRejectedValue(new ApiError(429, "used up", "api_limit_reached"));
    expect(await createSession("chat", {})).toBeNull();
    expect(useApp.getState().sendBlock).toEqual({ code: "api_limit_reached", message: "used up" });
    expect(toasts()).toEqual([]);
  });
});

describe("sendMessage: API credit errors", () => {
  const seed = () => useSessions.setState({ sessions: { [SID]: session() }, views: {}, listLoaded: true });

  it("api_limit_reached blocks the composer and hands the draft back", async () => {
    seed();
    mocks.sendMessage.mockRejectedValue(new ApiError(429, "This month's budget is used up", "api_limit_reached"));
    const out = await sendMessage(SID, "hi");
    expect(out).toMatchObject({ ok: false, code: "api_limit_reached", restoreDraft: true });
    expect(useApp.getState().sendBlock).toEqual({ code: "api_limit_reached", message: "This month's budget is used up" });
    expect(isBlockingCode("api_limit_reached")).toBe(true);
    expect(toasts()).toEqual([]);
  });

  it("api_unavailable is a toast, takes the pending bubble back and returns the draft", async () => {
    useApp.setState({ me: { user: { name: "alice" }, apiAvailable: true } as never });
    seed();
    mocks.sendMessage.mockRejectedValue(new ApiError(503, "no key", "api_unavailable"));
    const out = await sendMessage(SID, "hi");
    expect(out).toMatchObject({ ok: false, code: "api_unavailable", restoreDraft: true });
    expect(toasts()).toEqual(["API credits are not available"]);
    expect(useSessions.getState().views[SID]?.pendingUser ?? []).toHaveLength(0);
    expect(useApp.getState().sendBlock).toBeNull();
    expect(useApp.getState().me?.apiAvailable).toBe(false);
  });
});
