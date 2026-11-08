import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type ServerEvent } from "@agent-workstation/protocol";
import { HubSocket, type ConnStatus } from "./ws";
import { SID, session } from "../test/fixtures";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(ev: unknown) {
    this.onmessage?.({ data: typeof ev === "string" ? ev : JSON.stringify(ev) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const welcome = { type: "welcome", user: { name: "alice", createdAt: "x", isAdmin: false, enabled: true, terminalEnabled: true, weeklyTokenLimit: null, modelAllowlist: null }, protocolVersion: PROTOCOL_VERSION, serverTime: "2026-10-31T00:00:00Z" };

function make(extra: Partial<ConstructorParameters<typeof HubSocket>[0]> = {}) {
  const events: ServerEvent[] = [];
  const statuses: ConnStatus[] = [];
  const lastSeq: Record<string, number> = {};
  const sock = new HubSocket({
    url: () => "ws://hub/ws",
    user: "alice",
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    getLastSeq: (id) => lastSeq[id] ?? 0,
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    random: () => 0.5,
    minBackoffMs: 100,
    maxBackoffMs: 1000,
    pingIntervalMs: 1000,
    pongTimeoutMs: 500,
    ...extra,
  });
  return { sock, events, statuses, lastSeq };
}

describe("HubSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends hello on open, subscribes only after welcome, with lastSeq", () => {
    const { sock, statuses, lastSeq } = make();
    lastSeq[SID] = 7;
    sock.subscribe(SID); // before connect
    sock.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    expect(ws.sent).toEqual([{ type: "hello", user: "alice", protocolVersion: PROTOCOL_VERSION }]);
    ws.push(welcome);
    expect(ws.sent[1]).toEqual({ type: "subscribe", sessionId: SID, lastSeq: 7 });
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("subscribes immediately when already open and unsubscribes", () => {
    const { sock } = make();
    sock.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.push(welcome);
    sock.subscribe(SID);
    expect(ws.sent.at(-1)).toEqual({ type: "subscribe", sessionId: SID, lastSeq: 0 });
    sock.unsubscribe(SID);
    expect(ws.sent.at(-1)).toEqual({ type: "unsubscribe", sessionId: SID });
  });

  it("delivers valid events in order and drops unknown/invalid ones with a warning", () => {
    const { sock, events } = make();
    sock.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.push(welcome);
    ws.push({ type: "session_updated", session: session() });
    ws.push({ type: "totally_new_event", x: 1 });
    ws.push({ type: "message", sessionId: "not-a-uuid" });
    ws.push("not json");
    ws.push({ type: "pong" });
    expect(events.map((e) => e.type)).toEqual(["welcome", "session_updated"]);
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it("reconnects with exponential backoff and resubscribes with the latest seq", () => {
    const { sock, statuses, lastSeq } = make();
    sock.subscribe(SID);
    sock.start();
    let ws = FakeWS.instances[0]!;
    ws.open();
    ws.push(welcome);
    lastSeq[SID] = 12;
    ws.drop();
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(100); // 100ms * 2^0 * jitter(1.0)
    expect(FakeWS.instances).toHaveLength(2);
    ws = FakeWS.instances[1]!;
    ws.drop(); // fails before open: backoff doubles
    vi.advanceTimersByTime(199);
    expect(FakeWS.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(3);
    ws = FakeWS.instances[2]!;
    ws.open();
    ws.push(welcome);
    expect(ws.sent).toContainEqual({ type: "subscribe", sessionId: SID, lastSeq: 12 });
    expect(statuses.at(-1)).toBe("open");
    // backoff resets after a successful welcome
    ws.drop();
    vi.advanceTimersByTime(100);
    expect(FakeWS.instances).toHaveLength(4);
  });

  it("calls onSubscribe before each (re)subscribe", () => {
    const onSubscribe = vi.fn();
    const { sock } = make({ onSubscribe });
    sock.subscribe(SID);
    sock.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.push(welcome);
    expect(onSubscribe).toHaveBeenCalledWith(SID);
  });

  it("pings and reconnects when the pong never arrives", () => {
    const { sock } = make();
    sock.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.push(welcome);
    vi.advanceTimersByTime(1000);
    expect(ws.sent.at(-1)).toEqual({ type: "ping" });
    vi.advanceTimersByTime(500); // pong timeout
    vi.advanceTimersByTime(100); // reconnect delay
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("stop() closes without reconnecting", () => {
    const { sock, statuses } = make();
    sock.start();
    FakeWS.instances[0]!.open();
    sock.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("idle");
  });
});
