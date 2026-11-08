import { TerminalServerFrame } from "@agent-workstation/protocol";
import type { z } from "zod";
import { wsUrl } from "../../lib/api";

export type TerminalFrame = z.infer<typeof TerminalServerFrame>;
export type TerminalConn = "connecting" | "open" | "reconnecting" | "exited" | "closed";

/** Validate one server frame (JSON text). Anything malformed or unknown is ignored (null). */
export function parseServerFrame(raw: unknown): TerminalFrame | null {
  if (typeof raw !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = TerminalServerFrame.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export const encodeInput = (data: string): string => JSON.stringify({ t: "in", data });
export const encodeResize = (cols: number, rows: number): string => JSON.stringify({ t: "resize", cols: Math.max(1, Math.floor(cols)), rows: Math.max(1, Math.floor(rows)) });

/** Exponential backoff with ±25% jitter, capped. */
export function backoffDelay(attempt: number, opts: { min?: number; max?: number; random?: () => number } = {}): number {
  const min = opts.min ?? 400;
  const max = opts.max ?? 10_000;
  const rnd = opts.random ?? Math.random;
  const base = Math.min(max, min * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + rnd() * 0.5));
}

/**
 * Browsers cannot set headers on a WebSocket, so the user travels as a `user` query parameter
 * (the hub reads `?user=` on /ws/terminal/:id).
 */
export function terminalWsUrl(id: string, user: string | null): string {
  return wsUrl(`/ws/terminal/${encodeURIComponent(id)}`, { user: user ?? undefined });
}

export interface TerminalSocketOptions {
  url: () => string;
  onOutput: (data: string) => void;
  onExit: (code: number | null) => void;
  onStatus: (status: TerminalConn) => void;
  /**
   * Called on every successful (re)attach, before any output of that attachment arrives. The hub redraws the tmux
   * screen on each attach, so the consumer must clear its buffer here or the output appears twice.
   */
  onAttach?: () => void;
  WebSocketImpl?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive failed connects before giving up (terminal probably deleted). Default 12. */
  maxAttempts?: number;
  random?: () => number;
}

/**
 * One terminal WebSocket with automatic re-attach. The hub keeps the shell alive in tmux, so a
 * reconnect simply opens the same `/ws/terminal/:id` again; the hub then replays the screen, so the caller clears
 * its buffer in `onAttach`.
 */
export class TerminalSocket {
  private ws: WebSocket | null = null;
  private stopped = true;
  private exited = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private size: { cols: number; rows: number } | null = null;
  private status: TerminalConn = "connecting";

  constructor(private readonly opts: TerminalSocketOptions) {}

  getStatus(): TerminalConn {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.exited = false;
    this.attempt = 0;
    this.connect();
  }

  /** Close for good (no reconnect). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000, "client closed");
      } catch {}
    }
  }

  /** Manual retry after we gave up. */
  retryNow(): void {
    this.stop();
    this.stopped = true;
    this.start();
  }

  sendInput(data: string): boolean {
    return this.send(encodeInput(data));
  }

  sendResize(cols: number, rows: number): boolean {
    if (!(cols > 0) || !(rows > 0)) return false;
    this.size = { cols, rows };
    return this.send(encodeResize(cols, rows));
  }

  private send(text: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false; // keystrokes while offline are dropped, never queued
    ws.send(text);
    return true;
  }

  private setStatus(s: TerminalConn): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus(s);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onAttach?.();
      this.setStatus("open");
      if (this.size) this.send(encodeResize(this.size.cols, this.size.rows));
    };
    ws.onmessage = (e) => {
      const frame = parseServerFrame(e.data);
      if (!frame) return;
      if (frame.t === "out") this.opts.onOutput(frame.data);
      else {
        this.exited = true;
        this.setStatus("exited");
        this.stop();
        this.opts.onExit(frame.code);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.stopped && !this.exited) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const max = this.opts.maxAttempts ?? 12;
    if (this.attempt >= max) {
      this.stopped = true;
      this.setStatus("closed");
      return;
    }
    this.setStatus("reconnecting");
    const delay = backoffDelay(this.attempt, { min: this.opts.minBackoffMs, max: this.opts.maxBackoffMs, random: this.opts.random });
    this.attempt++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
