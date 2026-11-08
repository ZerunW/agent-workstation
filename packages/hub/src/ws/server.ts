/**
 * WebSocket endpoint `/ws`: one connection per client, multiplexed by session.
 *
 * Handshake: hello → welcome (+ usage_limits, disk_status, notices)
 *            subscribe{sessionId,lastSeq} → replay (seq > lastSeq, chunked) → snapshot → live events.
 * Replay and snapshot are produced synchronously in the same tick as the
 * subscription is registered, so no live event can interleave out of order.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { ClientEvent, PROTOCOL_VERSION, type BrowserInput, type ServerEvent } from "@agent-workstation/protocol";
import { isBrowserError } from "@agent-workstation/browser";
import { storedMessageJson, type UserRow } from "../db/store.js";
import type { Hub } from "../hub.js";
import { isValidUsername, LOCAL_CALLER, type Caller } from "../identity.js";
import { RESERVED_USERS } from "../users.js";
import { errorMessage, HttpError } from "../util/errors.js";
import { uuid } from "../util/ids.js";
import type { Logger } from "../util/log.js";
import { iso } from "../util/time.js";
import type { Broadcaster } from "./protocol.js";

interface Conn {
  /** Viewer id for the browser's live view. */
  id: string;
  ws: WebSocket;
  /** Who opened the connection (from the upgrade request). */
  caller: Caller;
  user: string | null;
  subs: Set<string>;
  alive: boolean;
  /** Unsubscribes this connection's live browser view (null = view off). */
  browserView: (() => void) | null;
}

const OPEN = 1;
/** Live-view frames are dropped (the next one is newer anyway) while this much is still queued for the client. */
export const BROWSER_FRAME_MAX_BUFFERED = 1_000_000;
const REPLAY_CHUNK = 200;
/** A subscribe replays at most the newest REPLAY_MAX messages (`truncated: true`); clients backfill older ones via REST. */
export const REPLAY_MAX = 500;
const MAX_FRAME_BYTES = 1024 * 1024;
/** Deltas are droppable (the next snapshot recovers); skip them for clients this far behind. */
const SLOW_CLIENT_BYTES = 4 * 1024 * 1024;

export class WsHub implements Broadcaster {
  private hub: Hub | null = null;
  private readonly conns = new Set<Conn>();
  private readonly byUser = new Map<string, Set<Conn>>();
  private readonly bySession = new Map<string, Set<Conn>>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly log: Logger) {}

  bind(hub: Hub): void {
    this.hub = hub;
  }

  register(app: FastifyInstance): void {
    // The upgrade passed the identity hook (auth.ts): refused callers never get here; hello applies the username rules.
    app.get("/ws", { websocket: true }, (socket, req) => this.accept(socket as WebSocket, req.workstationCaller ?? LOCAL_CALLER));
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30_000);
    this.heartbeat.unref?.();
  }

  connectedUsers(): string[] {
    return [...this.byUser.keys()];
  }

  /** Sends a notice to every connection of `user` and closes them (the user was deleted). */
  disconnectUser(user: string, message: string): void {
    for (const c of [...(this.byUser.get(user) ?? [])]) {
      this.send(c, { type: "notice", level: "warning", code: "user_deleted", message, at: iso() });
      try {
        c.ws.close(4003, "user deleted");
      } catch {
        /* ignore */
      }
      this.drop(c);
      c.user = null; // the socket's own close event must not release the watcher again
    }
  }

  isConnected(user: string): boolean {
    return (this.byUser.get(user)?.size ?? 0) > 0;
  }

  connectionCount(): number {
    return this.conns.size;
  }

  closeAll(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.conns) {
      try {
        c.ws.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------ Broadcaster

  toSession(sessionId: string, event: ServerEvent): void {
    const set = this.bySession.get(sessionId);
    if (!set?.size) return;
    const text = JSON.stringify(event);
    const droppable = event.type === "delta";
    for (const c of set) this.sendText(c, text, droppable);
  }

  toUser(user: string, event: ServerEvent): void {
    const set = this.byUser.get(user);
    if (!set?.size) return;
    const text = JSON.stringify(event);
    for (const c of set) this.sendText(c, text, false);
  }

  toAll(event: ServerEvent): void {
    if (!this.conns.size) return;
    const text = JSON.stringify(event);
    for (const c of this.conns) if (c.user) this.sendText(c, text, false);
  }

  toEachUser(make: (user: string) => ServerEvent | null): void {
    for (const user of this.byUser.keys()) {
      const e = make(user);
      if (e) this.toUser(user, e);
    }
  }

  // -------------------------------------------------------------- internals

  private sendText(c: Conn, text: string, droppable: boolean): void {
    if (c.ws.readyState !== OPEN) return;
    if (droppable && c.ws.bufferedAmount > SLOW_CLIENT_BYTES) return;
    c.ws.send(text);
  }

  private send(c: Conn, event: ServerEvent): void {
    this.sendText(c, JSON.stringify(event), false);
  }

  private error(c: Conn, code: string, message: string, sessionId?: string): void {
    this.send(c, { type: "error", code, message, ...(sessionId ? { sessionId } : {}) });
  }

  private accept(ws: WebSocket, caller: Caller): void {
    const conn: Conn = { id: uuid(), ws, caller, user: null, subs: new Set(), alive: true, browserView: null };
    this.conns.add(conn);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      conn.alive = true;
      const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (isBinary || buf.length > MAX_FRAME_BYTES) return this.error(conn, "invalid_event", "frames must be JSON text under 1 MB");
      try {
        this.onMessage(conn, buf.toString("utf8"));
      } catch (err) {
        const code = err instanceof HttpError ? err.code : "internal";
        this.log.warn({ err: errorMessage(err) }, "ws handler failed");
        this.error(conn, code, errorMessage(err));
      }
    });
    ws.on("close", () => this.drop(conn));
    ws.on("error", (err) => this.log.debug({ err: errorMessage(err) }, "ws error"));
  }

  private drop(conn: Conn): void {
    this.conns.delete(conn);
    this.stopBrowserView(conn);
    for (const id of conn.subs) this.bySession.get(id)?.delete(conn);
    if (conn.user) {
      const set = this.byUser.get(conn.user);
      set?.delete(conn);
      if (set && set.size === 0) this.byUser.delete(conn.user);
      this.hub?.watchers.release(conn.user);
    }
  }

  private onMessage(conn: Conn, text: string): void {
    const hub = this.hub;
    if (!hub) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.error(conn, "invalid_event", "not JSON");
    }
    const parsed = ClientEvent.safeParse(json);
    if (!parsed.success) return this.error(conn, "invalid_event", parsed.error.issues.map((i) => i.message).join("; "));
    const ev = parsed.data;
    if (ev.type !== "hello" && !conn.user) return this.error(conn, "hello_required", "send hello first");

    switch (ev.type) {
      case "hello":
        return this.hello(conn, ev.user, ev.protocolVersion);
      case "subscribe":
        return this.subscribe(conn, ev.sessionId, ev.lastSeq);
      case "unsubscribe":
        conn.subs.delete(ev.sessionId);
        this.bySession.get(ev.sessionId)?.delete(conn);
        return;
      case "permission_response": {
        const s = hub.store.getSession(ev.sessionId);
        if (!s || s.user !== conn.user) return this.error(conn, "not_found", "no such session", ev.sessionId);
        const r = hub.sessions.respondPermission(conn.user!, ev.sessionId, ev.response);
        if (!r.ok) this.error(conn, r.code, r.message, ev.sessionId);
        return;
      }
      case "ping":
        return this.send(conn, { type: "pong" });
      case "browser_view":
        return ev.on ? this.startBrowserView(conn, ev.maxWidth) : this.stopBrowserView(conn);
      case "browser_input":
        void this.browserInput(conn, ev.input);
        return;
    }
  }

  // ---------------------------------------------------------------- browser

  private browserError(conn: Conn, err: unknown): void {
    if (isBrowserError(err)) return this.error(conn, `browser_${err.code}`, err.message);
    this.log.warn({ user: conn.user, err: errorMessage(err) }, "browser request failed");
    this.error(conn, "internal", errorMessage(err));
  }

  /** Frames flow while the view is on (from when the browser runs; subscribing never starts it). */
  private startBrowserView(conn: Conn, maxWidth: number | undefined): void {
    const hub = this.hub!;
    this.stopBrowserView(conn);
    try {
      conn.browserView = hub.browsers.subscribeFrames(conn.user!, conn.id, maxWidth !== undefined ? { maxWidth } : {}, (f) => {
        if (conn.ws.readyState !== OPEN || conn.ws.bufferedAmount >= BROWSER_FRAME_MAX_BUFFERED) return; // slow client: drop
        conn.ws.send(JSON.stringify({ type: "browser_frame", data: f.data, width: f.width, height: f.height, at: f.at } satisfies ServerEvent));
      });
    } catch (err) {
      this.browserError(conn, err);
    }
  }

  private stopBrowserView(conn: Conn): void {
    const unsub = conn.browserView;
    conn.browserView = null;
    unsub?.();
  }

  private async browserInput(conn: Conn, input: BrowserInput): Promise<void> {
    try {
      await this.hub!.browsers.input(conn.user!, input);
    } catch (err) {
      this.browserError(conn, err);
    }
  }

  private hello(conn: Conn, user: string, protocolVersion: number): void {
    const hub = this.hub!;
    if (!isValidUsername(user) || RESERVED_USERS.has(user)) {
      this.error(conn, "reserved_user", "invalid or reserved username");
      conn.ws.close(4001, "invalid user");
      return;
    }
    let auth: { row: UserRow; isAdmin: boolean };
    try {
      auth = hub.users.authorize(user, conn.caller);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      this.error(conn, err.code, err.message);
      conn.ws.close(4001, err.code);
      return;
    }
    const { row, isAdmin } = auth;
    if (conn.user && conn.user !== user) {
      // Re-identification: drop the old identity's subscriptions.
      this.drop(conn);
      this.conns.add(conn);
      conn.subs.clear();
    }
    if (conn.user !== user) {
      conn.user = user;
      const set = this.byUser.get(user) ?? new Set<Conn>();
      set.add(conn);
      this.byUser.set(user, set);
      hub.watchers.acquire(user);
    }
    this.send(conn, { type: "welcome", user: hub.users.toProtocol(row, isAdmin), protocolVersion: PROTOCOL_VERSION, serverTime: iso() });
    if (protocolVersion !== PROTOCOL_VERSION) {
      this.send(conn, { type: "notice", level: "warning", code: "protocol_mismatch", message: `hub speaks protocol ${PROTOCOL_VERSION}, client sent ${protocolVersion}`, at: iso() });
    }
    this.send(conn, { type: "usage_limits", limits: hub.usageLimits.current() });
    this.send(conn, { type: "disk_status", status: hub.disk.statusFor(user) });
    if (hub.browsers.config.enabled) this.send(conn, { type: "browser_state", state: hub.browsers.state(user) });
    if (!hub.settings.get().remoteClaudeEnabled) {
      this.send(conn, { type: "notice", level: "warning", code: "remote_disabled", message: "Remote sessions are disabled by the admin.", at: iso() });
    }
  }

  private subscribe(conn: Conn, sessionId: string, lastSeq: number): void {
    const hub = this.hub!;
    const s = hub.store.getSession(sessionId);
    if (!s || s.user !== conn.user || s.hidden) return this.error(conn, "not_found", "no such session", sessionId);
    // Register first, then replay + snapshot synchronously: nothing can interleave.
    conn.subs.add(sessionId);
    const set = this.bySession.get(sessionId) ?? new Set<Conn>();
    set.add(conn);
    this.bySession.set(sessionId, set);

    // seqs are allocated gap-free per session (1..lastSeq), so the newest REPLAY_MAX start after lastSeq - REPLAY_MAX
    // (rewound messages keep their seqs and are skipped, so a replay after a rewind may carry fewer).
    const from = Math.max(lastSeq, s.lastSeq - REPLAY_MAX);
    const truncated = from > lastSeq;
    let batch: string[] = [];
    let sent = false;
    const flush = () => {
      this.sendText(conn, `{"type":"replay","sessionId":${JSON.stringify(sessionId)},"messages":[${batch.join(",")}]${truncated ? ',"truncated":true' : ""}}`, false);
      batch = [];
      sent = true;
    };
    for (const m of hub.store.iterateMessages(sessionId, from)) {
      batch.push(storedMessageJson(m));
      if (batch.length >= REPLAY_CHUNK) flush();
    }
    if (batch.length || !sent) flush();
    this.send(conn, { type: "snapshot", sessionId, snapshot: hub.sessions.snapshot(sessionId) });
    if (hub.disk.level !== "ok") this.send(conn, { type: "disk_status", status: hub.disk.statusFor(conn.user!) });
  }
}
