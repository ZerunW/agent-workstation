import { USER_QUERY_PARAM, type BrowserInput, type ServerEvent } from "@agent-workstation/protocol";
import { api, setApiUser, wsUrl, ApiError } from "../lib/api";
import { earlierGap, eventSessionId, type ViewAction } from "../lib/session-reducer";
import { HubSocket } from "../lib/ws";
import { t } from "../i18n";
import { useApp } from "./app";
import { useBrowser } from "./browser";
import { useChanged } from "./changed";
import { useProjects } from "./projects";
import { useReview } from "./review";
import { useSessions } from "./sessions";
import { toast } from "./toasts";

/**
 * Glue between the single WebSocket and the zustand stores.
 * Deltas are batched per animation frame (flushed before any ordered event) so a fast stream
 * costs one render per frame, not one per token.
 */
let socket: HubSocket | null = null;
/** Sessions the UI wants live; survives (re)connects and component effect ordering. */
const desired = new Map<string, number>();
let deltaBuf = new Map<string, ViewAction[]>();
let flushHandle: number | ReturnType<typeof setTimeout> | null = null;
const backfilling = new Set<string>();
const taps = new Set<(ev: ServerEvent) => void>();

/** Observe every decoded server event (the embed forwards some of them to the macOS host). */
export function addServerEventTap(fn: (ev: ServerEvent) => void): () => void {
  taps.add(fn);
  return () => taps.delete(fn);
}

function flushDeltas(): void {
  if (flushHandle != null) {
    if (typeof cancelAnimationFrame === "function" && typeof flushHandle === "number") cancelAnimationFrame(flushHandle);
    else clearTimeout(flushHandle as ReturnType<typeof setTimeout>);
    flushHandle = null;
  }
  if (deltaBuf.size === 0) return;
  const buf = deltaBuf;
  deltaBuf = new Map();
  for (const [id, actions] of buf) useSessions.getState().dispatchMany(id, actions);
}

function scheduleFlush(): void {
  if (flushHandle != null) return;
  if (typeof requestAnimationFrame === "function") flushHandle = requestAnimationFrame(() => ((flushHandle = null), flushDeltas()));
  else flushHandle = setTimeout(() => ((flushHandle = null), flushDeltas()), 16);
}

/** Entry point for every decoded server event (also used by the embed host bridge and tests). */
export function handleServerEvent(ev: ServerEvent): void {
  for (const tap of taps) {
    try {
      tap(ev);
    } catch (e) {
      console.warn("[hub] event tap failed", e);
    }
  }
  const app = useApp.getState();
  const sessions = useSessions.getState();

  if (ev.type === "delta") {
    const list = deltaBuf.get(ev.sessionId) ?? [];
    list.push(ev);
    deltaBuf.set(ev.sessionId, list);
    scheduleFlush();
    return;
  }
  if (ev.type === "browser_frame") {
    useBrowser.getState().setFrame({ data: ev.data, width: ev.width, height: ev.height, at: ev.at });
    return;
  }
  flushDeltas();

  switch (ev.type) {
    case "welcome":
      app.setServerTime(ev.serverTime);
      // the hub's view flag is per connection: a reconnect has to ask for frames again
      if (browserView.on) sendBrowserView(true, browserView.maxWidth);
      return;
    case "browser_state":
      useBrowser.getState().setState(ev.state);
      return;
    case "session_updated":
      sessions.upsertSession(ev.session);
      return;
    case "session_deleted":
      sessions.removeSession(ev.sessionId);
      return;
    case "file_event":
      useChanged.getState().record(ev);
      return;
    case "usage_limits":
      app.setLimits(ev.limits);
      return;
    case "disk_status":
      app.setDisk(ev.status);
      return;
    case "context_usage":
      sessions.patchSession(ev.sessionId, { contextUsage: ev.usage });
      return;
    case "memories_changed":
      app.bumpMemories();
      return;
    case "review_changed":
      app.setReviewPending(ev.projectId, ev.pendingFiles);
      useProjects.getState().patch(ev.projectId, { pendingFiles: ev.pendingFiles, localCommit: ev.localCommit });
      useReview.getState().bump(ev.projectId);
      return;
    case "sync_conflict":
      useReview.getState().addConflict(ev.projectId, ev.path, ev.reason);
      toast.error(t("review.conflict.toast", { path: ev.path }), ev.reason);
      return;
    case "notice":
      handleNotice(ev);
      return;
    case "error": {
      if (ev.sessionId) sessions.dispatch(ev.sessionId, { type: "backfill_done" });
      toast.error(ev.message || t("app.error.generic"), ev.code);
      return;
    }
    case "pong":
      return;
    default:
      break;
  }

  const id = eventSessionId(ev);
  if (!id) return;
  sessions.dispatch(id, ev as ViewAction);
  const view = useSessions.getState().views[id];
  if (view?.backfillAfter != null) void backfill(id);
}

function handleNotice(ev: Extract<ServerEvent, { type: "notice" }>): void {
  const app = useApp.getState();
  app.pushNotice({ level: ev.level, code: ev.code, message: ev.message, at: ev.at });
  if (ev.code === "remote_enabled") app.clearNotice("remote_disabled");
}

/** Fill a gap in a session's message list from REST (pages of 500 until caught up). */
export async function backfill(sessionId: string): Promise<void> {
  if (backfilling.has(sessionId)) return;
  backfilling.add(sessionId);
  try {
    for (let guard = 0; guard < 40; guard++) {
      const view = useSessions.getState().views[sessionId];
      if (!view || view.backfillAfter == null) break;
      const after = view.backfillAfter;
      const batch = await api.messages(sessionId, after, 500);
      if (batch.length === 0) {
        useSessions.getState().dispatch(sessionId, { type: "backfill_done" });
        break;
      }
      useSessions.getState().dispatch(sessionId, { type: "replay", sessionId, messages: batch });
      const maxSeq = Math.max(...batch.map((m) => m.seq));
      const target = useSessions.getState().views[sessionId]?.session?.lastSeq ?? maxSeq;
      if (batch.length < 500 || maxSeq >= target) {
        useSessions.getState().dispatch(sessionId, { type: "backfill_done" });
        break;
      }
      // more pages: continue from the new tail
      useSessions.setState((s) => {
        const v = s.views[sessionId];
        return v ? { views: { ...s.views, [sessionId]: { ...v, backfillAfter: maxSeq } } } : s;
      });
    }
  } catch (e) {
    console.warn("[hub] backfill failed", e);
    useSessions.getState().dispatch(sessionId, { type: "backfill_done" });
  } finally {
    backfilling.delete(sessionId);
  }
}

const EARLIER_PAGE = 200;
const loadingEarlier = new Set<string>();

/**
 * "Load earlier messages": the hub truncated the replay of a long session. `GET /messages?after=` pages forward only, so
 * the page just before the oldest held message is `after = oldest - 1 - EARLIER_PAGE`. Seqs are contiguous per session;
 * when the hub returns nothing for the range the control is hidden (`exhausted`).
 */
export async function loadEarlier(sessionId: string): Promise<void> {
  if (loadingEarlier.has(sessionId)) return;
  const gap = earlierGap(useSessions.getState().views[sessionId]?.messages ?? []);
  if (!gap) {
    useSessions.getState().dispatch(sessionId, { type: "earlier_state", loading: false, exhausted: true });
    return;
  }
  loadingEarlier.add(sessionId);
  useSessions.getState().dispatch(sessionId, { type: "earlier_state", loading: true });
  try {
    const after = Math.max(gap.afterSeq, gap.beforeSeq - 1 - EARLIER_PAGE);
    const limit = gap.beforeSeq - 1 - after;
    const batch = await api.messages(sessionId, after, limit);
    const fresh = batch.filter((m) => m.seq < gap.beforeSeq);
    if (fresh.length) useSessions.getState().dispatch(sessionId, { type: "replay", sessionId, messages: fresh });
    useSessions.getState().dispatch(sessionId, { type: "earlier_state", loading: false, exhausted: fresh.length === 0 });
  } catch (e) {
    console.warn("[hub] load earlier failed", e);
    useSessions.getState().dispatch(sessionId, { type: "earlier_state", loading: false });
    toast.error(t("tx.earlier.failed"), e instanceof Error ? e.message : String(e));
  } finally {
    loadingEarlier.delete(sessionId);
  }
}

export function connectHub(user: string): void {
  disconnectHub();
  setApiUser(user);
  socket = new HubSocket({
    url: () => wsUrl("/ws", { [USER_QUERY_PARAM]: user }),
    user,
    onEvent: handleServerEvent,
    onStatus: (s) => {
      const prev = useApp.getState().conn;
      useApp.getState().setConn(s);
      if (s === "open" && prev === "reconnecting") {
        toast.success(t("app.reconnected"));
        void refreshSessions();
        // review_changed events may have been missed while offline: make open review/history views refetch
        void refreshProjects().then(() => {
          for (const p of useProjects.getState().list) useReview.getState().bump(p.id);
        });
      }
    },
    getLastSeq: (id) => useSessions.getState().views[id]?.lastSeq ?? 0,
    onSubscribe: (id) => useSessions.getState().dispatch(id, { type: "subscribe_begin" }),
  });
  socket.start();
  for (const id of desired.keys()) socket.subscribe(id);
}

export function disconnectHub(): void {
  socket?.stop();
  socket = null;
  deltaBuf = new Map();
  useApp.getState().setConn("idle");
}

export function getSocket(): HubSocket | null {
  return socket;
}

export function subscribeSession(id: string): () => void {
  desired.set(id, (desired.get(id) ?? 0) + 1);
  socket?.subscribe(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (desired.get(id) ?? 1) - 1;
    if (n <= 0) {
      desired.delete(id);
      socket?.unsubscribe(id);
    } else desired.set(id, n);
  };
}

/** The live browser view: the hub only streams frames to connections that switched it on (re-sent after a reconnect). */
let browserView: { on: boolean; maxWidth?: number } = { on: false };
export function sendBrowserView(on: boolean, maxWidth?: number): void {
  browserView = { on, maxWidth: on ? maxWidth : undefined };
  socket?.send({ type: "browser_view", on, ...(on && maxWidth ? { maxWidth: Math.round(maxWidth) } : {}) });
}
export function sendBrowserInput(input: BrowserInput): boolean {
  return socket?.send({ type: "browser_input", input }) ?? false;
}

export function sendPermissionResponse(sessionId: string, response: { requestId: string; behavior: "allow" | "deny"; updatedInput?: unknown; message?: string; remember?: "session" | "user" }): void {
  useSessions.getState().dispatch(sessionId, { type: "local_permission_answer", requestId: response.requestId, behavior: response.behavior });
  const ok = socket?.send({ type: "permission_response", sessionId, response });
  if (!ok) toast.error(t("app.offline"));
}

// ---------------------------------------------------------------------------
// Bootstrap (REST) — me, sessions, limits, disk, models
// ---------------------------------------------------------------------------
export async function refreshSessions(): Promise<void> {
  try {
    const list = await api.sessions();
    useSessions.getState().setSessions(list);
  } catch (e) {
    console.warn("[hub] session list failed", e);
  }
}

export async function refreshProjects(): Promise<void> {
  await useProjects.getState().load();
}

/** "user_bound": the stored username belongs to another Tailscale account (403); sign in again instead of retrying. */
export async function bootstrap(): Promise<"ok" | "unauthorized" | "user_bound"> {
  const app = useApp.getState();
  try {
    const me = await api.me();
    app.setMe(me);
  } catch (e) {
    if (e instanceof ApiError && e.code === "user_bound") {
      app.setMe(null, e.message);
      return "user_bound";
    }
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) {
      app.setMe(null, e.message);
      return "unauthorized";
    }
    app.setMe(null, e instanceof Error ? e.message : String(e));
  }
  await Promise.allSettled([
    refreshSessions(),
    refreshProjects(),
    api.usageLimits().then((l) => useApp.getState().setLimits(l)),
    api.disk().then((d) => useApp.getState().setDisk(d)),
    api.models().then((m) => useApp.getState().setModels(m)),
  ]);
  return "ok";
}

/** Lightweight bootstrap for the embedded page: only what the transcript + composer need. */
export async function bootstrapEmbed(): Promise<void> {
  await Promise.allSettled([
    api.me().then((m) => useApp.getState().setMe(m)),
    api.disk().then((d) => useApp.getState().setDisk(d)),
  ]);
}
