import { PROTOCOL_VERSION, ServerEvent, type ClientEvent } from "@agent-workstation/protocol";

export type ConnStatus = "idle" | "connecting" | "open" | "reconnecting";

export interface HubSocketOptions {
  /** Resolve the ws:// URL each time we (re)connect. */
  url: () => string;
  user: string;
  onEvent: (ev: ServerEvent) => void;
  onStatus?: (status: ConnStatus) => void;
  /** Highest seq the client holds for a session (sent as `lastSeq` on every (re)subscribe). */
  getLastSeq: (sessionId: string) => number;
  /** Called right before each (re)subscribe so stores can mark the snapshot as pending. */
  onSubscribe?: (sessionId: string) => void;
  WebSocketImpl?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  random?: () => number;
}

/**
 * Single multiplexed hub connection.
 *   open -> hello -> welcome -> (re)subscribe all -> replay -> snapshot -> live events.
 * Reconnects with exponential backoff + jitter; keeps a ping watchdog so half-open sockets are detected.
 */
export class HubSocket {
  private ws: WebSocket | null = null;
  private status: ConnStatus = "idle";
  private subs = new Set<string>();
  private attempt = 0;
  private stopped = true;
  private welcomed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: HubSocketOptions) {}

  getStatus(): ConnStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000, "client stop");
      } catch {}
    }
    this.setStatus("idle");
  }

  subscribe(sessionId: string): void {
    this.subs.add(sessionId);
    if (this.welcomed) this.sendSubscribe(sessionId);
  }

  unsubscribe(sessionId: string): void {
    if (!this.subs.delete(sessionId)) return;
    if (this.welcomed) this.send({ type: "unsubscribe", sessionId });
  }

  send(ev: ClientEvent): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(ev));
    return true;
  }

  /** Force a reconnect now (e.g. tab became visible and the socket looks dead). */
  reconnectNow(): void {
    if (this.stopped) return;
    this.dropSocket();
    this.attempt = 0;
    this.connect();
  }

  // ---- internals ---------------------------------------------------------
  private setStatus(s: ConnStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 && this.status !== "reconnecting" ? "connecting" : "reconnecting");
    this.welcomed = false;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.opts.url());
    } catch (e) {
      console.warn("[ws] failed to construct socket", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.send({ type: "hello", user: this.opts.user, protocolVersion: PROTOCOL_VERSION });
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onerror = () => {
      /* followed by onclose */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      this.clearPing();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      console.warn("[ws] dropped non-JSON frame");
      return;
    }
    const parsed = ServerEvent.safeParse(json);
    if (!parsed.success) {
      console.warn("[ws] dropped unknown/invalid server event", (json as { type?: unknown })?.type, parsed.error.issues[0]);
      return;
    }
    const ev = parsed.data;
    this.armPongWatchdog(false);
    if (ev.type === "welcome") {
      this.welcomed = true;
      this.attempt = 0;
      this.setStatus("open");
      this.startPing();
      this.opts.onEvent(ev);
      for (const id of this.subs) this.sendSubscribe(id);
      return;
    }
    if (ev.type === "pong") return;
    this.opts.onEvent(ev);
  }

  private sendSubscribe(sessionId: string): void {
    this.opts.onSubscribe?.(sessionId);
    this.send({ type: "subscribe", sessionId, lastSeq: this.opts.getLastSeq(sessionId) });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 15_000;
    const rnd = this.opts.random ?? Math.random;
    const base = Math.min(max, min * 2 ** this.attempt);
    const delay = Math.round(base * (0.75 + rnd() * 0.5));
    this.attempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.clearPing();
    const every = this.opts.pingIntervalMs ?? 25_000;
    this.pingTimer = setInterval(() => {
      if (this.send({ type: "ping" })) this.armPongWatchdog(true);
    }, every);
  }

  private armPongWatchdog(arm: boolean): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    if (!arm) return;
    this.pongTimer = setTimeout(() => {
      console.warn("[ws] pong timeout, reconnecting");
      this.dropSocket();
      this.scheduleReconnect();
    }, this.opts.pongTimeoutMs ?? 10_000);
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearTimers(): void {
    this.clearPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
