import type { Session, SessionKind } from "@agent-workstation/protocol";
import { create } from "zustand";
import { useApp } from "./app";
import { emptyView, keepContextUsage, reduceSessionEvent, syncTurn, type SessionView, type ViewAction } from "../lib/session-reducer";

interface SessionsState {
  /** Every session of the signed-in user (both kinds). */
  sessions: Record<string, Session>;
  listLoaded: boolean;
  views: Record<string, SessionView>;
  setSessions: (list: Session[]) => void;
  upsertSession: (s: Session) => void;
  /** Merge fields into a session (and its view's copy), e.g. `contextUsage` from a `context_usage` event. */
  patchSession: (id: string, patch: Partial<Session>) => void;
  removeSession: (id: string) => void;
  /** Apply an action to a session's view (creating it on demand). */
  dispatch: (id: string, action: ViewAction) => void;
  /** Apply many actions for one session in a single store update (delta batching). */
  dispatchMany: (id: string, actions: ViewAction[]) => void;
  dropView: (id: string) => void;
  reset: () => void;
}

/** Hub-vs-browser clock offset for the reducer (hub timestamps such as `turnStartedAt`). */
const clock = () => ({ serverOffsetMs: useApp.getState().serverOffsetMs });

export const useSessions = create<SessionsState>((set) => ({
  sessions: {},
  listLoaded: false,
  views: {},
  setSessions: (list) =>
    set((s) => {
      const sessions: Record<string, Session> = {};
      for (const x of list) sessions[x.id] = keepContextUsage(s.sessions[x.id], x);
      // Keep sessions known only from a view (e.g. just created) so the sidebar does not flicker.
      for (const [id, v] of Object.entries(s.views)) if (!sessions[id] && v.session && s.sessions[id]) sessions[id] = s.sessions[id]!;
      return { sessions, listLoaded: true };
    }),
  upsertSession: (incoming) =>
    set((s) => {
      const view = s.views[incoming.id];
      const sess = keepContextUsage(s.sessions[incoming.id] ?? view?.session, incoming);
      return {
        sessions: { ...s.sessions, [sess.id]: sess },
        views: view ? { ...s.views, [sess.id]: syncTurn({ ...view, session: sess }) } : s.views,
      };
    }),
  patchSession: (id, patch) =>
    set((s) => {
      const view = s.views[id];
      const known = s.sessions[id] ?? view?.session;
      if (!known) return s;
      const sess = { ...known, ...patch };
      return {
        sessions: { ...s.sessions, [id]: sess },
        views: view ? { ...s.views, [id]: { ...view, session: view.session ? { ...view.session, ...patch } : sess } } : s.views,
      };
    }),
  removeSession: (id) =>
    set((s) => {
      const { [id]: _a, ...sessions } = s.sessions;
      const { [id]: _b, ...views } = s.views;
      return { sessions, views };
    }),
  dispatch: (id, action) =>
    set((s) => {
      const cur = s.views[id] ?? emptyView(id, s.sessions[id] ?? null);
      const next = reduceSessionEvent(cur, action, clock());
      if (next === cur && s.views[id]) return s;
      const sessions = next.session && next.session !== s.sessions[id] ? { ...s.sessions, [id]: next.session } : s.sessions;
      return { views: { ...s.views, [id]: next }, sessions };
    }),
  dispatchMany: (id, actions) =>
    set((s) => {
      const cur = s.views[id] ?? emptyView(id, s.sessions[id] ?? null);
      let next = cur;
      const c = clock();
      for (const a of actions) next = reduceSessionEvent(next, a, c);
      if (next === cur && s.views[id]) return s;
      const sessions = next.session && next.session !== s.sessions[id] ? { ...s.sessions, [id]: next.session } : s.sessions;
      return { views: { ...s.views, [id]: next }, sessions };
    }),
  dropView: (id) =>
    set((s) => {
      const { [id]: _v, ...views } = s.views;
      return { views };
    }),
  reset: () => set({ sessions: {}, listLoaded: false, views: {} }),
}));

export function sessionsOfKind(sessions: Record<string, Session>, kind: SessionKind): Session[] {
  return Object.values(sessions)
    .filter((x) => x.kind === kind && !x.parentSessionId)
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
}
