import type { BackgroundTask, NextStep, PermissionRequest, ServerEvent, Session, StoredMessage } from "@agent-workstation/protocol";
import { emptyPartial, foldDelta, partialFromSnapshot, reconcilePartial, type PartialState } from "./transcript";

export type PermissionStatus = "pending" | "allowed" | "denied" | "cancelled" | "resolved";

export interface PermissionEntry {
  request: PermissionRequest;
  status: PermissionStatus;
  /** What this client answered locally (before the hub confirmed). */
  local: "allow" | "deny" | null;
  /** true when the hub resolved it but this client did not answer it. */
  elsewhere: boolean;
  /** lastSeq when the request arrived: the card renders after that message. */
  afterSeq: number;
}

export interface PendingUser {
  uuid: string;
  text: string;
  images: string[];
  /** Uploaded files attached to the message, for the chips under the optimistic bubble. */
  files?: { path: string; name: string; size?: number }[];
  state: "sending" | "queued" | "failed";
  position: number | null;
  error?: string;
  code?: string;
  at: number;
}

/** The running turn, for the live indicator at the bottom of the transcript. */
export interface TurnState {
  /** Epoch ms the turn started (null while idle or not known yet). */
  startedAt: number | null;
  /** Output tokens of the turn so far. */
  outputTokens: number;
}

const IDLE_TURN: TurnState = { startedAt: null, outputTokens: 0 };

export interface SessionView {
  id: string;
  session: Session | null;
  /** Sorted by seq, unique by seq. */
  messages: StoredMessage[];
  lastSeq: number;
  partial: PartialState;
  permissions: PermissionEntry[];
  /** true once the hub's snapshot for the current subscribe arrived (replay precedes it). */
  snapshotReceived: boolean;
  /** When set, the store should GET /messages?after=<value> to fill a hole. */
  backfillAfter: number | null;
  pendingUser: PendingUser[];
  /** The hub flagged a replay as `truncated`: older messages exist that were not sent (see `earlierGap`). */
  truncated: boolean;
  /** A "Load earlier messages" request is in flight. */
  loadingEarlier: boolean;
  turn: TurnState;
  /** The session's background tasks; undefined until the hub reports them (older hubs never do). */
  backgroundTasks?: BackgroundTask[];
  /** The end-of-turn box; undefined/null when none (older hubs never set it). */
  nextStep?: NextStep | null;
}

export function emptyView(id: string, session: Session | null = null): SessionView {
  return { id, session, messages: [], lastSeq: 0, partial: emptyPartial(), permissions: [], snapshotReceived: false, backfillAfter: null, pendingUser: [], truncated: false, loadingEarlier: false, turn: IDLE_TURN };
}

/**
 * The earliest hole in a message list: seqs `afterSeq + 1 .. beforeSeq - 1` are missing (a long session whose replay was
 * truncated starts at seq > 1). null when the list is contiguous from seq 1.
 */
export function earlierGap(messages: readonly StoredMessage[]): { afterSeq: number; beforeSeq: number } | null {
  let prev = 0;
  for (const m of messages) {
    if (m.seq > prev + 1) return { afterSeq: prev, beforeSeq: m.seq };
    prev = m.seq;
  }
  return null;
}

/** True when a truncated replay left older messages that "Load earlier messages" can fetch. */
export function hasEarlierMessages(view: Pick<SessionView, "truncated" | "messages">): boolean {
  return view.truncated && earlierGap(view.messages) !== null;
}

/** Idempotent, order-independent insertion keyed by seq (first writer wins: persisted messages are immutable). */
export function insertMessages(view: SessionView, incoming: readonly StoredMessage[]): SessionView {
  if (incoming.length === 0) return view;
  const known = new Set<number>();
  for (const m of view.messages) known.add(m.seq);
  const fresh: StoredMessage[] = [];
  for (const m of incoming) {
    if (known.has(m.seq)) continue;
    known.add(m.seq);
    fresh.push(m);
  }
  if (fresh.length === 0) return view;
  let messages: StoredMessage[];
  const last = view.messages[view.messages.length - 1];
  const sortedFresh = fresh.sort((a, b) => a.seq - b.seq);
  if (!last || sortedFresh[0]!.seq > last.seq) messages = view.messages.concat(sortedFresh);
  else messages = view.messages.concat(sortedFresh).sort((a, b) => a.seq - b.seq);
  const lastSeq = Math.max(view.lastSeq, messages[messages.length - 1]!.seq);
  return { ...view, messages, lastSeq };
}

function withSession(view: SessionView, patch: Partial<Session>): SessionView {
  if (!view.session) return view;
  return { ...view, session: { ...view.session, ...patch } };
}

/** Drop the held messages whose seq lies in a rewound (inclusive) range, and their pinned marks. */
function dropRewound(view: SessionView, ranges: ReadonlyArray<readonly [number, number]>): SessionView {
  const inRange = (seq: number) => ranges.some(([from, to]) => seq >= from && seq <= to);
  const dropped = view.messages.filter((m) => inRange(m.seq));
  if (dropped.length === 0) return view;
  const gone = new Set(dropped.map((m) => m.uuid));
  const next = { ...view, messages: view.messages.filter((m) => !inRange(m.seq)) };
  const pins = next.session?.pinnedMessages;
  const kept = pins?.filter((u) => !gone.has(u));
  return pins && kept && kept.length !== pins.length ? withSession(next, { pinnedMessages: kept }) : next;
}

/** An incoming Session from a hub that omits `contextUsage` must not wipe what a `context_usage` event delivered. */
export function keepContextUsage(prev: Session | null | undefined, next: Session): Session {
  return next.contextUsage === undefined && prev?.contextUsage !== undefined ? { ...next, contextUsage: prev.contextUsage } : next;
}

/** Keep the turn timer in step with the session status: cleared once idle/dead, started when running. */
export function syncTurn(view: SessionView, now = Date.now()): SessionView {
  if (!view.session) return view;
  const status = view.session.status;
  if (!isBusyStatus(status)) return view.turn.startedAt == null && view.turn.outputTokens === 0 ? view : { ...view, turn: IDLE_TURN };
  if (status === "running" && view.turn.startedAt == null) return { ...view, turn: { ...view.turn, startedAt: now } };
  return view;
}

/** An unsent (failed / discarded) message started the timer but no turn followed: drop it. */
function dropUnstartedTurn(view: SessionView): SessionView {
  if (isBusyStatus(view.session?.status) || view.turn.startedAt == null) return view;
  return view.pendingUser.some((p) => p.state !== "failed") ? view : { ...view, turn: IDLE_TURN };
}

export type LocalAction =
  | { type: "local_permission_answer"; requestId: string; behavior: "allow" | "deny" }
  | { type: "pending_user_add"; entry: PendingUser }
  | { type: "pending_user_update"; uuid: string; patch: Partial<PendingUser> }
  | { type: "pending_user_remove"; uuid: string }
  | { type: "subscribe_begin" }
  | { type: "backfill_done" }
  /** `exhausted`: the hub had nothing more to give, so stop offering "Load earlier messages". */
  | { type: "earlier_state"; loading: boolean; exhausted?: boolean };

export type ViewAction = ServerEvent | LocalAction;

/** Clock facts the reducer cannot know on its own. */
export interface ReducerClock {
  /** Hub clock minus the local clock (ms): hub timestamps are shifted by it before they are compared with `Date.now()`. */
  serverOffsetMs?: number;
}

/** Pure reducer for everything that happens inside one session. Events for other sessions are ignored by the caller. */
export function reduceSessionEvent(view: SessionView, ev: ViewAction, clock: ReducerClock = {}): SessionView {
  switch (ev.type) {
    case "subscribe_begin":
      return { ...view, snapshotReceived: false };

    case "background_tasks":
      return { ...view, backgroundTasks: ev.tasks };

    case "next_step":
      return { ...view, nextStep: ev.step };

    case "messages_rewound": {
      // later messages continue with higher seqs, so lastSeq stays; the pinned marks of the dropped messages go too
      const dropped = view.messages.filter((m) => m.seq >= ev.fromSeq);
      const pins = view.session?.pinnedMessages;
      if (dropped.length === 0 && !pins) return view;
      const gone = new Set(dropped.map((m) => m.uuid));
      const kept = pins?.filter((u) => !gone.has(u));
      const next = dropped.length ? { ...view, messages: view.messages.filter((m) => m.seq < ev.fromSeq), partial: emptyPartial(), nextStep: null } : view;
      return kept && pins && kept.length !== pins.length ? withSession(next, { pinnedMessages: kept }) : next;
    }

    case "backfill_done":
      return view.backfillAfter == null ? view : { ...view, backfillAfter: null };

    case "earlier_state":
      return { ...view, loadingEarlier: ev.loading, truncated: ev.exhausted ? false : view.truncated };

    case "replay": {
      let next = insertMessages(view, ev.messages);
      if (ev.truncated === true && !next.truncated) next = { ...next, truncated: true };
      if (view.pendingUser.length === 0) return next;
      const seen = new Set(ev.messages.filter((m) => m.kind === "user").map((m) => m.uuid));
      return { ...next, pendingUser: next.pendingUser.filter((p) => !seen.has(p.uuid)) };
    }

    case "snapshot": {
      const { snapshot } = ev;
      const startedAt = snapshot.turnStartedAt ? Date.parse(snapshot.turnStartedAt) - (clock.serverOffsetMs ?? 0) : NaN;
      const turn: TurnState = isBusyStatus(snapshot.session.status)
        ? { startedAt: Number.isFinite(startedAt) ? startedAt : view.turn.startedAt, outputTokens: snapshot.partial.turnOutputTokens ?? view.turn.outputTokens }
        : IDLE_TURN;
      let next: SessionView = syncTurn({ ...view, session: keepContextUsage(view.session, snapshot.session), partial: partialFromSnapshot(snapshot.partial), snapshotReceived: true, turn, backgroundTasks: snapshot.backgroundTasks ?? view.backgroundTasks, nextStep: snapshot.nextStep ?? null });
      // Reconcile pending permissions: the snapshot is the truth after a (re)connect.
      const pending = snapshot.pendingPermission;
      next = {
        ...next,
        permissions: next.permissions.map((p) => (p.status === "pending" && p.request.requestId !== pending?.requestId ? { ...p, status: "resolved" as const, elsewhere: p.local == null } : p)),
      };
      if (pending && !next.permissions.some((p) => p.request.requestId === pending.requestId)) {
        next = { ...next, permissions: [...next.permissions, { request: pending, status: "pending", local: null, elsewhere: false, afterSeq: next.lastSeq }] };
      }
      if (snapshot.rewound?.length) next = dropRewound(next, snapshot.rewound);
      if (snapshot.session.lastSeq > next.lastSeq) next = { ...next, backfillAfter: next.lastSeq };
      return next;
    }

    case "message": {
      const m = ev.message;
      const prevLast = view.lastSeq;
      let next = insertMessages(view, [m]);
      if (next === view) return view; // duplicate
      if (prevLast > 0 && m.seq > prevLast + 1) next = { ...next, backfillAfter: next.backfillAfter ?? prevLast };
      if (next.session && m.seq > next.session.lastSeq) next = withSession(next, { lastSeq: m.seq });
      if (m.kind === "assistant") next = { ...next, partial: reconcilePartial(next.partial, m.payload) };
      else if (m.kind === "result") next = { ...next, partial: emptyPartial() };
      else if (m.kind === "user") next = { ...next, pendingUser: next.pendingUser.filter((p) => p.uuid !== m.uuid) };
      return next;
    }

    case "delta": {
      const d = ev.delta;
      if (d.part === "usage") {
        // tokens of the running turn (absolute, not a delta); a late one after the turn ended must not leak into the next
        const status = view.session?.status;
        if (status === "idle" || status === "dead" || view.turn.outputTokens === d.turnOutputTokens) return view;
        return { ...view, turn: { ...view.turn, outputTokens: d.turnOutputTokens } };
      }
      return { ...view, partial: foldDelta(view.partial, d) };
    }

    case "session_state": {
      let next = syncTurn(withSession(view, { status: ev.status, queuePosition: ev.queuePosition }));
      if (ev.status === "idle" || ev.status === "dead") next = { ...next, partial: emptyPartial() };
      if (ev.status !== "queued") next = { ...next, pendingUser: next.pendingUser.map((p) => (p.state === "queued" ? { ...p, state: "sending" as const, position: null } : p)) };
      return next;
    }

    case "session_settings":
      return withSession(view, {
        model: ev.settings.model,
        permissionMode: ev.settings.permissionMode,
        effort: ev.settings.effort,
      });

    case "session_updated":
      return syncTurn({ ...view, session: keepContextUsage(view.session, ev.session) });

    case "permission_request": {
      if (view.permissions.some((p) => p.request.requestId === ev.request.requestId)) return view;
      return { ...view, permissions: [...view.permissions, { request: ev.request, status: "pending", local: null, elsewhere: false, afterSeq: view.lastSeq }] };
    }

    case "permission_resolved":
      return {
        ...view,
        permissions: view.permissions.map((p) =>
          p.request.requestId === ev.requestId ? { ...p, status: ev.behavior === "allow" ? ("allowed" as const) : ("denied" as const), elsewhere: p.local == null } : p,
        ),
      };

    case "permission_cancelled":
      return { ...view, permissions: view.permissions.map((p) => (p.request.requestId === ev.requestId && p.status === "pending" ? { ...p, status: "cancelled" as const } : p)) };

    case "local_permission_answer":
      return { ...view, permissions: view.permissions.map((p) => (p.request.requestId === ev.requestId ? { ...p, local: ev.behavior } : p)) };

    case "pending_user_add":
      // sending starts the clock (a message sent into a running turn keeps the turn's own start)
      return {
        ...view,
        pendingUser: [...view.pendingUser.filter((p) => p.uuid !== ev.entry.uuid), ev.entry],
        // sending anything answers the end-of-turn box
        nextStep: null,
        turn: view.turn.startedAt == null ? { ...view.turn, startedAt: ev.entry.at } : view.turn,
      };
    case "pending_user_update": {
      const next = { ...view, pendingUser: view.pendingUser.map((p) => (p.uuid === ev.uuid ? { ...p, ...ev.patch } : p)) };
      return ev.patch.state === "failed" ? dropUnstartedTurn(next) : next;
    }
    case "pending_user_remove":
      return dropUnstartedTurn({ ...view, pendingUser: view.pendingUser.filter((p) => p.uuid !== ev.uuid) });

    default:
      return view;
  }
}

export function isBusyStatus(status: Session["status"] | undefined): boolean {
  return status === "running" || status === "requires_action" || status === "queued";
}

/** Session id a server event is scoped to (undefined for global events). */
export function eventSessionId(ev: ServerEvent): string | undefined {
  switch (ev.type) {
    case "replay":
    case "snapshot":
    case "message":
    case "delta":
    case "session_state":
    case "session_settings":
    case "session_deleted":
    case "permission_resolved":
    case "permission_cancelled":
    case "background_tasks":
    case "next_step":
    case "messages_rewound":
      return ev.sessionId;
    case "session_updated":
      return ev.session.id;
    case "permission_request":
      return ev.request.sessionId;
    case "error":
      return ev.sessionId;
    default:
      return undefined;
  }
}
