import type { ServerEvent, Session, SessionStatus } from "@agent-workstation/protocol";
import { t } from "../i18n";
import { addServerEventTap } from "../store/hub";
import { useApp } from "../store/app";
import { useSessions } from "../store/sessions";
import { toolMeta } from "./toolSummary";
import { isRecord, resultInfo } from "./sdk";
import { truncate } from "./format";

/**
 * Asks AgentWorkstation.app (`window.__workstationShell.notify`) for a native notification when a long turn finished or a session has
 * been waiting for an answer. Driven by the server events the app receives for every session; does nothing in a
 * plain browser. See docs/MAC-APP.md.
 */
export const LONG_TURN_MS = 5 * 60_000;
export const WAITING_MS = 60_000;

export interface ShellNotifyDeps {
  /** The clock (epoch ms) and timers: fake them in tests. */
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  shell: () => Window["__workstationShell"];
  /** The global switch (`me.user.notificationsEnabled !== false`), read live. */
  globalEnabled: () => boolean;
  getSession: (id: string) => Session | undefined;
  /** The end-of-turn recap the client holds for a session, if any. */
  getRecap: (id: string) => string | null | undefined;
  /** When the client's own turn timer says the turn began (epoch ms), used when seeding. */
  getTurnStartedAt: (id: string) => number | null | undefined;
  /** True while the session is open on screen in a visible, focused window. */
  isWatching: (id: string) => boolean;
  /** Hub timestamp (ISO) to local epoch ms. */
  toLocalMs: (iso: string) => number;
}

export interface ShellNotifier {
  handle: (ev: ServerEvent) => void;
  /** Sessions that are already busy when the notifier starts. */
  seed: (sessions: readonly Session[]) => void;
  /** Re-read the switches: cancels the pending "waiting" timers of every session that no longer notifies. */
  sync: () => void;
  dispose: () => void;
}

type PermissionRequest = Extract<ServerEvent, { type: "permission_request" }>["request"];

const BUSY: ReadonlySet<SessionStatus> = new Set(["running", "requires_action"]);
const FINAL: ReadonlySet<SessionStatus> = new Set(["idle", "dead"]);

function firstLine(s: string): string {
  return truncate(s.split("\n").find((l) => l.trim() !== "")?.trim() ?? "", 140);
}

/** The tool or question of a permission request in a few words. */
export function waitingBody(req: PermissionRequest): string {
  if (req.browserSite) return truncate(req.browserSite.origin, 100);
  if (req.subagent) return truncate(req.subagent.description, 100);
  const input = isRecord(req.input) ? req.input : {};
  if (req.toolName === "AskUserQuestion") {
    const q = Array.isArray(input.questions) ? input.questions.find(isRecord) : undefined;
    const text = q && typeof q.question === "string" ? q.question : typeof input.question === "string" ? input.question : "";
    if (text) return firstLine(text);
  }
  const meta = toolMeta(req.toolName, req.input);
  return truncate(meta.summary ? `${meta.label}: ${firstLine(meta.summary)}` : meta.label, 100);
}

export function createShellNotifier(deps: ShellNotifyDeps): ShellNotifier {
  const status = new Map<string, SessionStatus>();
  const busySince = new Map<string, number>();
  const resultFailed = new Map<string, boolean>();
  const recaps = new Map<string, string | null>();
  const children = new Set<string>();
  /** Requests being tracked (one notification each): `${sessionId}\n${requestId}`. `timer` is null once it fired. */
  const waiting = new Map<string, { sessionId: string; timer: unknown }>();
  const key = (sessionId: string, requestId: string) => `${sessionId}\n${requestId}`;

  const send = (n: { id: string; title: string; body: string; sessionId: string }) => {
    const shell = deps.shell();
    if (typeof shell?.notify !== "function") return;
    try {
      shell.notify(n);
    } catch (e) {
      console.warn("[shell] notify failed", e);
    }
  };

  /** Both switches, read live: the global one and the session's own (`notify`, absent = on). */
  const enabled = (id: string, session?: Session) => deps.globalEnabled() && (session ?? deps.getSession(id))?.notify !== false;

  /** Subagent sessions are covered by their parent's card. */
  const isChild = (id: string, session?: Session) => {
    if ((session ?? deps.getSession(id))?.parentSessionId) children.add(id);
    return children.has(id);
  };

  const cancelWaiting = (sessionId: string, requestId?: string) => {
    for (const [k, w] of waiting) {
      if (w.sessionId !== sessionId || (requestId !== undefined && k !== key(sessionId, requestId))) continue;
      if (w.timer != null) deps.clearTimer(w.timer);
      waiting.delete(k);
    }
  };

  const finished = (id: string, session: Session | undefined, failed: boolean) => {
    if (deps.isWatching(id) || !enabled(id, session)) return;
    if (session?.incognito) {
      send({ id: `done:${id}`, title: t(failed ? "shellNotify.incognitoFailed" : "shellNotify.incognitoDone"), body: "", sessionId: id });
      return;
    }
    const title = session?.title || t("shellNotify.untitled");
    const recap = recaps.get(id) ?? deps.getRecap(id);
    send({ id: `done:${id}`, title: t(failed ? "shellNotify.failed" : "shellNotify.done", { title }), body: failed || !recap ? "" : firstLine(recap), sessionId: id });
  };

  const onStatus = (id: string, next: SessionStatus, session?: Session, startedAtMs?: number | null) => {
    if (isChild(id, session)) return;
    status.set(id, next);
    if (!enabled(id, session)) cancelWaiting(id);
    if (BUSY.has(next)) {
      const since = busySince.get(id);
      if (since === undefined) {
        busySince.set(id, startedAtMs ?? deps.now());
        resultFailed.delete(id);
      } else if (startedAtMs != null && startedAtMs < since) busySince.set(id, startedAtMs);
      return;
    }
    if (!FINAL.has(next)) return;
    cancelWaiting(id);
    const since = busySince.get(id);
    busySince.delete(id);
    if (since === undefined || deps.now() - since <= LONG_TURN_MS) return;
    finished(id, session ?? deps.getSession(id), next === "dead" || resultFailed.get(id) === true);
  };

  const onPermission = (req: PermissionRequest) => {
    const id = req.sessionId;
    if (isChild(id)) return;
    const k = key(id, req.requestId);
    if (waiting.has(k) || !enabled(id)) return; // a replay of a request already tracked or notified; or switched off
    const timer = deps.setTimer(() => {
      const w = waiting.get(k);
      if (!w) return;
      w.timer = null; // stays tracked: no second notification for this request
      if (deps.isWatching(id) || !enabled(id)) return;
      const session = deps.getSession(id);
      const nid = `waiting:${id}:${req.requestId}`;
      if (session?.incognito) send({ id: nid, title: t("shellNotify.incognitoWaiting"), body: "", sessionId: id });
      else send({ id: nid, title: t("shellNotify.waiting", { title: session?.title || t("shellNotify.untitled") }), body: waitingBody(req), sessionId: id });
    }, WAITING_MS);
    waiting.set(k, { sessionId: id, timer });
  };

  return {
    handle(ev) {
      if (typeof deps.shell()?.notify !== "function") return;
      switch (ev.type) {
        case "session_updated":
          onStatus(ev.session.id, ev.session.status, ev.session);
          return;
        case "session_state":
          onStatus(ev.sessionId, ev.status);
          return;
        case "snapshot": {
          const at = ev.snapshot.turnStartedAt ? deps.toLocalMs(ev.snapshot.turnStartedAt) : null;
          onStatus(ev.sessionId, ev.snapshot.session.status, ev.snapshot.session, at != null && Number.isFinite(at) ? at : null);
          recaps.set(ev.sessionId, ev.snapshot.nextStep?.recap ?? null);
          if (ev.snapshot.pendingPermission) onPermission(ev.snapshot.pendingPermission);
          return;
        }
        case "message":
          if (ev.message.kind === "result") resultFailed.set(ev.sessionId, resultInfo(ev.message.payload).isError);
          return;
        case "next_step":
          recaps.set(ev.sessionId, ev.step?.recap ?? null);
          return;
        case "permission_request":
          onPermission(ev.request);
          return;
        case "permission_resolved":
        case "permission_cancelled":
          cancelWaiting(ev.sessionId, ev.requestId);
          return;
        case "session_deleted":
          cancelWaiting(ev.sessionId);
          for (const m of [status, busySince, resultFailed, recaps]) m.delete(ev.sessionId);
          children.delete(ev.sessionId);
          return;
        default:
          return;
      }
    },
    seed(sessions) {
      for (const s of sessions) {
        if (!BUSY.has(s.status) || status.has(s.id)) continue;
        onStatus(s.id, s.status, s, deps.getTurnStartedAt(s.id));
      }
    },
    sync() {
      for (const w of [...waiting.values()]) if (w.timer != null && !enabled(w.sessionId)) cancelWaiting(w.sessionId);
    },
    dispose() {
      for (const w of waiting.values()) if (w.timer != null) deps.clearTimer(w.timer);
      waiting.clear();
    },
  };
}

/**
 * Wire the notifier to the app: observes every server event and lets the shell open a session
 * (`window.__workstationOpenSession`). Returns a stop function. A no-op without `__workstationShell.notify`.
 */
export function startShellNotifier(navigate: (to: string) => void): () => void {
  if (typeof window === "undefined" || typeof window.__workstationShell?.notify !== "function") return () => {};
  const notifier = createShellNotifier({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    shell: () => window.__workstationShell,
    globalEnabled: () => useApp.getState().me?.user.notificationsEnabled !== false,
    getSession: (id) => useSessions.getState().sessions[id] ?? useSessions.getState().views[id]?.session ?? undefined,
    getRecap: (id) => useSessions.getState().views[id]?.nextStep?.recap,
    getTurnStartedAt: (id) => useSessions.getState().views[id]?.turn.startedAt,
    isWatching: (id) => document.visibilityState === "visible" && document.hasFocus() && window.location.pathname === `/s/${id}`,
    toLocalMs: (iso) => Date.parse(iso) - useApp.getState().serverOffsetMs,
  });
  notifier.seed(Object.values(useSessions.getState().sessions));
  const untap = addServerEventTap(notifier.handle);
  const unsubs = [
    useApp.subscribe((st, prev) => {
      if (st.me?.user.notificationsEnabled !== prev.me?.user.notificationsEnabled) notifier.sync();
    }),
    useSessions.subscribe(() => notifier.sync()),
  ];
  const open = (id: string) => {
    if (typeof id === "string" && id) navigate(`/s/${encodeURIComponent(id)}`);
  };
  window.__workstationOpenSession = open;
  return () => {
    untap();
    for (const u of unsubs) u();
    notifier.dispose();
    if (window.__workstationOpenSession === open) delete window.__workstationOpenSession;
  };
}
