import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, encodeInput, encodeResize, parseServerFrame, TerminalSocket, terminalWsUrl, type TerminalConn } from "./terminalSocket";
import { buildXtermTheme, hexToRgba } from "./xtermTheme";

describe("terminal frames", () => {
  it("parses valid server frames", () => {
    expect(parseServerFrame(JSON.stringify({ t: "out", data: "hi\r\n" }))).toEqual({ t: "out", data: "hi\r\n" });
    expect(parseServerFrame(JSON.stringify({ t: "exit", code: 0 }))).toEqual({ t: "exit", code: 0 });
    expect(parseServerFrame(JSON.stringify({ t: "exit", code: null }))).toEqual({ t: "exit", code: null });
  });
  it("ignores malformed, unknown and non-text frames", () => {
    expect(parseServerFrame("not json")).toBeNull();
    expect(parseServerFrame(JSON.stringify({ t: "bell" }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ t: "out", data: 5 }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ t: "exit", code: 1.5 }))).toBeNull();
    expect(parseServerFrame(new ArrayBuffer(2))).toBeNull();
    expect(parseServerFrame(undefined)).toBeNull();
  });
  it("encodes client frames per protocol", () => {
    expect(JSON.parse(encodeInput("ls\r"))).toEqual({ t: "in", data: "ls\r" });
    expect(JSON.parse(encodeResize(120.7, 40))).toEqual({ t: "resize", cols: 120, rows: 40 });
    expect(JSON.parse(encodeResize(0, 0))).toEqual({ t: "resize", cols: 1, rows: 1 }); // protocol requires positive ints
  });
  it("puts the user in the websocket query string", () => {
    const url = new URL(terminalWsUrl("abc 1", "alice"));
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/ws/terminal/abc%201");
    expect(url.searchParams.get("user")).toBe("alice");
  });
});

describe("backoffDelay", () => {
  it("doubles with attempts, caps at max, and jitters ±25%", () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, { min: 400, max: 10_000, random: mid })).toBe(400);
    expect(backoffDelay(1, { min: 400, max: 10_000, random: mid })).toBe(800);
    expect(backoffDelay(3, { min: 400, max: 10_000, random: mid })).toBe(3200);
    expect(backoffDelay(10, { min: 400, max: 10_000, random: mid })).toBe(10_000);
    expect(backoffDelay(2, { min: 400, max: 10_000, random: () => 0 })).toBe(1200);
    expect(backoffDelay(2, { min: 400, max: 10_000, random: () => 1 })).toBe(2000);
  });
});

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(frame: unknown) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("TerminalSocket", () => {
  let statuses: TerminalConn[];
  let output: string[];
  let exits: Array<number | null>;
  const make = (extra: Partial<ConstructorParameters<typeof TerminalSocket>[0]> = {}) =>
    new TerminalSocket({
      url: () => "ws://hub/ws/terminal/t1?user=u",
      onOutput: (d) => output.push(d),
      onExit: (c) => exits.push(c),
      onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
      random: () => 0.5,
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      ...extra,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    statuses = [];
    output = [];
    exits = [];
  });
  afterEach(() => vi.useRealTimers());

  it("connects, forwards output and sends the stored size on open", () => {
    const s = make();
    s.sendResize(100, 30); // before open: remembered, not sent
    s.start();
    const ws = FakeWS.instances[0]!;
    expect(ws.url).toContain("/ws/terminal/t1");
    ws.open();
    expect(statuses).toEqual(["open"]); // the initial status is already "connecting"
    expect(JSON.parse(ws.sent[0]!)).toEqual({ t: "resize", cols: 100, rows: 30 });
    ws.message({ t: "out", data: "$ " });
    ws.message("garbage");
    ws.message({ t: "wat" });
    expect(output).toEqual(["$ "]);
    expect(s.sendInput("ls\r")).toBe(true);
    expect(JSON.parse(ws.sent[1]!)).toEqual({ t: "in", data: "ls\r" });
  });

  it("calls onAttach on every (re)attach before that attachment's output, so the buffer can be cleared", () => {
    const events: string[] = [];
    const s = make({ onAttach: () => events.push("attach"), onOutput: (d) => events.push(`out:${d}`) });
    s.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.message({ t: "out", data: "screen" });
    ws.drop();
    vi.advanceTimersByTime(200);
    const ws2 = FakeWS.instances[1]!;
    ws2.open();
    ws2.message({ t: "out", data: "screen" }); // the hub replays the tmux screen on attach
    expect(events).toEqual(["attach", "out:screen", "attach", "out:screen"]);
  });

  it("drops keystrokes while disconnected instead of queueing them", () => {
    const s = make();
    s.start();
    expect(s.sendInput("x")).toBe(false);
  });

  it("re-attaches to the same url with backoff after the socket drops", () => {
    const s = make();
    s.start();
    FakeWS.instances[0]!.open();
    FakeWS.instances[0]!.drop();
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(99);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1]!.url).toBe(FakeWS.instances[0]!.url);
    // second consecutive failure waits longer (200ms)
    FakeWS.instances[1]!.drop();
    vi.advanceTimersByTime(150);
    expect(FakeWS.instances).toHaveLength(2);
    vi.advanceTimersByTime(60);
    expect(FakeWS.instances).toHaveLength(3);
    FakeWS.instances[2]!.open();
    expect(statuses.at(-1)).toBe("open");
  });

  it("an exit frame stops reconnecting and reports the code once", () => {
    const s = make();
    s.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.message({ t: "exit", code: 130 });
    ws.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(exits).toEqual([130]);
    expect(statuses.at(-1)).toBe("exited");
  });

  it("stop() closes for good", () => {
    const s = make();
    s.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    s.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("gives up after maxAttempts consecutive failures and can be retried", () => {
    const s = make({ maxAttempts: 3 });
    s.start();
    for (let i = 0; i < 4; i++) {
      FakeWS.instances.at(-1)!.drop();
      vi.advanceTimersByTime(5000);
    }
    expect(statuses.at(-1)).toBe("closed");
    const n = FakeWS.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(n);
    s.retryNow();
    expect(FakeWS.instances).toHaveLength(n + 1);
  });
});

describe("xterm theme", () => {
  it("builds from CSS tokens and falls back for non-hex values", () => {
    const vars: Record<string, string> = { "--code-bg": "#101010", "--fg": "#eeeeee", "--accent": "#ff8800" };
    const theme = buildXtermTheme((n) => vars[n] ?? "", true);
    expect(theme.background).toBe("#101010");
    expect(theme.foreground).toBe("#eeeeee");
    expect(theme.cursor).toBe("#ff8800");
    expect(theme.selectionBackground).toBe("rgba(255, 136, 0, 0.35)");
    const fallback = buildXtermTheme(() => "rgb(1 2 3 / 0.5)", false);
    expect(fallback.background).toBe("#f1f3f6");
    expect(fallback.red).toBeTruthy();
  });
  it("hexToRgba handles short hex and rejects junk", () => {
    expect(hexToRgba("#fff", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
    expect(hexToRgba("red", 1)).toBeNull();
  });
});
