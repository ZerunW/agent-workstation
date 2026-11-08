import type { BrowserState, ServerEvent } from "@agent-workstation/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowser } from "./browser";
import { connectHub, disconnectHub, handleServerEvent, sendBrowserInput, sendBrowserView } from "./hub";

const STATE: BrowserState = { running: true, url: "https://example.com/", title: "Example", controlledBy: "agent", sessionId: null, viewers: 1, viewport: { width: 1280, height: 800 } };

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {}
}
const frames = () => FakeWS.all[0].sent.filter((m) => (m as { type: string }).type.startsWith("browser_"));

beforeEach(() => {
  FakeWS.all = [];
  useBrowser.getState().reset();
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  sendBrowserView(false);
  disconnectHub();
  vi.unstubAllGlobals();
});

describe("browser events", () => {
  it("stores browser_state and browser_frame", () => {
    handleServerEvent({ type: "browser_state", state: STATE });
    handleServerEvent({ type: "browser_frame", data: "AAAA", width: 640, height: 400, at: "2026-10-31T00:00:00.000Z" });
    expect(useBrowser.getState().state).toEqual(STATE);
    expect(useBrowser.getState().frame).toEqual({ data: "AAAA", width: 640, height: 400, at: "2026-10-31T00:00:00.000Z" });
  });

  it("drops the last frame when the browser stops", () => {
    handleServerEvent({ type: "browser_state", state: STATE });
    handleServerEvent({ type: "browser_frame", data: "AAAA", width: 640, height: 400, at: "x" });
    handleServerEvent({ type: "browser_state", state: { ...STATE, running: false, url: null, title: null, controlledBy: null } });
    expect(useBrowser.getState().frame).toBeNull();
  });
});

describe("browser view / input over the socket", () => {
  it("sends browser_view with maxWidth only when on, and browser_input as given", () => {
    connectHub("alice");
    sendBrowserView(true, 801.4);
    sendBrowserInput({ kind: "navigate", url: "https://a.test/" });
    sendBrowserView(false, 999);
    expect(frames()).toEqual([
      { type: "browser_view", on: true, maxWidth: 801 },
      { type: "browser_input", input: { kind: "navigate", url: "https://a.test/" } },
      { type: "browser_view", on: false },
    ]);
  });

  it("reports an offline input as not sent", () => {
    expect(sendBrowserInput({ kind: "history", action: "reload" })).toBe(false);
  });

  it("asks for frames again after a reconnect (the hub's flag is per connection)", () => {
    connectHub("alice");
    sendBrowserView(true, 640);
    const welcome = { type: "welcome", user: { name: "alice" }, protocolVersion: 1, serverTime: "2026-10-31T00:00:00.000Z" } as unknown as ServerEvent;
    handleServerEvent(welcome);
    expect(frames().filter((m) => (m as { type: string }).type === "browser_view")).toEqual([
      { type: "browser_view", on: true, maxWidth: 640 },
      { type: "browser_view", on: true, maxWidth: 640 },
    ]);
    sendBrowserView(false);
    handleServerEvent(welcome);
    expect(frames().filter((m) => (m as { on?: boolean }).on === true)).toHaveLength(2);
  });
});
