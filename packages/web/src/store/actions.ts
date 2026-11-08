import type { EffortLevel, PermissionMode, Session, SessionKind, SessionSettings } from "@agent-workstation/protocol";
import { api, ApiError, type RewindRequest, type RewindResult } from "../lib/api";
import { uuid } from "../lib/format";
import { useApp } from "./app";
import { toProtocolAttachment, useComposer, type DraftAttachment } from "./composer";
import { useSessions } from "./sessions";
import { toast } from "./toasts";
import { backfill } from "./hub";
import { t } from "../i18n";

/** Error codes that block the composer instead of failing a single message. */
export const BLOCKING_CODES = ["remote_disabled", "weekly_limit", "disk_block", "user_disabled", "api_limit_reached"] as const;
export type BlockingCode = (typeof BLOCKING_CODES)[number];

export function isBlockingCode(code: string | undefined): code is BlockingCode {
  return !!code && (BLOCKING_CODES as readonly string[]).includes(code);
}

/** The hub has no API key or no budget: remember it, so the composer stops offering to start. */
function markApiUnavailable(): void {
  const { me, setMe } = useApp.getState();
  if (me && me.apiAvailable !== false) setMe({ ...me, apiAvailable: false });
}

export type SendOutcome = { ok: true; uuid: string } | { ok: false; code?: string; message: string; restoreDraft: boolean };

const retryBag = new Map<string, { sessionId: string; text: string; attachments: DraftAttachment[] }>();

function imagesOf(attachments: DraftAttachment[]): string[] {
  return attachments.filter((a) => a.type === "image").map((a) => `data:${a.mediaType};base64,${a.dataBase64}`);
}

function filesOf(attachments: DraftAttachment[]): { path: string; name: string; size?: number }[] {
  return attachments.filter((a) => a.type === "file_ref").map((a) => ({ path: a.path, name: a.name, size: a.size }));
}

export async function sendMessage(sessionId: string, text: string, attachments: DraftAttachment[] = [], reuseUuid?: string): Promise<SendOutcome> {
  const id = reuseUuid ?? uuid();
  const store = useSessions.getState();
  retryBag.set(id, { sessionId, text, attachments });
  store.dispatch(sessionId, { type: "pending_user_add", entry: { uuid: id, text, images: imagesOf(attachments), files: filesOf(attachments), state: "sending", position: null, at: Date.now() } });
  try {
    const res = await api.sendMessage(sessionId, { uuid: id, text, attachments: attachments.length ? attachments.map(toProtocolAttachment) : undefined });
    useApp.getState().setSendBlock(null);
    if (res.state === "queued") useSessions.getState().dispatch(sessionId, { type: "pending_user_update", uuid: id, patch: { state: "queued", position: res.position } });
    // The persisted echo normally removes the pending bubble; if it never shows up, backfill from REST.
    setTimeout(() => {
      const v = useSessions.getState().views[sessionId];
      if (v?.pendingUser.some((p) => p.uuid === id && p.state !== "queued")) {
        useSessions.setState((s) => {
          const cur = s.views[sessionId];
          return cur ? { views: { ...s.views, [sessionId]: { ...cur, backfillAfter: cur.backfillAfter ?? cur.lastSeq } } } : s;
        });
        void backfill(sessionId);
      }
    }, 4000);
    retryBag.delete(id);
    return { ok: true, uuid: id };
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, e instanceof Error ? e.message : String(e));
    if (err.code === "api_unavailable") {
      // a toast, not a block: the draft comes back
      markApiUnavailable();
      useSessions.getState().dispatch(sessionId, { type: "pending_user_remove", uuid: id });
      toast.error(t("api.unavailable"));
      retryBag.delete(id);
      return { ok: false, code: err.code, message: err.message, restoreDraft: true };
    }
    if (isBlockingCode(err.code)) {
      useSessions.getState().dispatch(sessionId, { type: "pending_user_remove", uuid: id });
      useApp.getState().setSendBlock({ code: err.code, message: err.message });
      retryBag.delete(id);
      return { ok: false, code: err.code, message: err.message, restoreDraft: true };
    }
    useSessions.getState().dispatch(sessionId, { type: "pending_user_update", uuid: id, patch: { state: "failed", error: err.message, code: err.code } });
    return { ok: false, code: err.code, message: err.message, restoreDraft: false };
  }
}

export function retrySend(sessionId: string, id: string): void {
  const saved = retryBag.get(id);
  if (!saved) {
    useSessions.getState().dispatch(sessionId, { type: "pending_user_remove", uuid: id });
    return;
  }
  void sendMessage(saved.sessionId, saved.text, saved.attachments, id);
}

export function discardPending(sessionId: string, id: string): void {
  retryBag.delete(id);
  useSessions.getState().dispatch(sessionId, { type: "pending_user_remove", uuid: id });
}

export async function stopSession(sessionId: string): Promise<void> {
  try {
    await api.stop(sessionId);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
  }
}

export async function createSession(kind: SessionKind, opts: { cwd?: string; title?: string; settings?: SessionSettings; incognito?: boolean } = {}): Promise<Session | null> {
  try {
    const s = await api.createSession({
      kind,
      cwd: kind === "code" ? opts.cwd : undefined,
      title: opts.title,
      model: opts.settings?.model,
      permissionMode: kind === "code" ? opts.settings?.permissionMode : undefined,
      effort: opts.settings?.effort,
      // incognito is Chat only
      incognito: kind === "chat" && opts.incognito ? true : undefined,
    });
    useSessions.getState().upsertSession(s);
    return s;
  } catch (e) {
    if (e instanceof ApiError && e.code === "api_unavailable") {
      markApiUnavailable();
      toast.error(t("api.unavailable"));
      return null;
    }
    if (e instanceof ApiError && e.code === "api_limit_reached") {
      useApp.getState().setSendBlock({ code: e.code, message: e.message });
      return null;
    }
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
    return null;
  }
}

export async function renameSession(id: string, title: string): Promise<void> {
  try {
    const s = await api.renameSession(id, title);
    useSessions.getState().upsertSession(s);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
  }
}

/** Per-session notification switch: optimistic, reverted when the hub refuses. */
export async function setSessionNotify(id: string, notify: boolean): Promise<void> {
  const store = useSessions.getState();
  const cur = store.views[id]?.session ?? store.sessions[id];
  if (!cur) return;
  const before = cur.notify;
  store.patchSession(id, { notify });
  try {
    store.upsertSession(await api.setSessionNotify(id, notify));
  } catch (e) {
    useSessions.getState().patchSession(id, { notify: before });
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
  }
}

/** The global notification switch (`me.user.notificationsEnabled`): optimistic, reverted when the hub refuses. */
export async function setNotificationsEnabled(next: boolean): Promise<void> {
  const patchMe = (v: boolean | undefined, user?: Partial<NonNullable<ReturnType<typeof useApp.getState>["me"]>["user"]>) => {
    const cur = useApp.getState().me;
    if (cur) useApp.getState().setMe({ ...cur, user: { ...cur.user, ...user, notificationsEnabled: v } });
  };
  const before = useApp.getState().me?.user.notificationsEnabled;
  patchMe(next);
  try {
    const user = await api.patchPreferences({ notificationsEnabled: next });
    patchMe(user.notificationsEnabled ?? next, user);
  } catch (e) {
    patchMe(before);
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await api.deleteSession(id);
    useSessions.getState().removeSession(id);
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
    return false;
  }
}

/** Optimistic settings change; the hub's `session_settings` echo (all tabs) is the source of truth. */
export async function patchSettings(sessionId: string, patch: SessionSettings): Promise<void> {
  const store = useSessions.getState();
  const cur = store.views[sessionId]?.session ?? store.sessions[sessionId];
  if (!cur) return;
  const before = { model: cur.model, permissionMode: cur.permissionMode as PermissionMode, effort: cur.effort as EffortLevel | null };
  const after = {
    model: patch.model ?? before.model,
    permissionMode: patch.permissionMode ?? before.permissionMode,
    effort: patch.effort === undefined ? before.effort : patch.effort,
  };
  store.dispatch(sessionId, { type: "session_settings", sessionId, settings: after });
  try {
    await api.patchSettings(sessionId, patch);
  } catch (e) {
    useSessions.getState().dispatch(sessionId, { type: "session_settings", sessionId, settings: before });
    if (e instanceof ApiError && e.code === "api_unavailable") {
      markApiUnavailable();
      toast.error(t("api.unavailable"));
    } else if (e instanceof ApiError && e.code === "api_limit_reached") toast.error(t("api.limitReached"));
    else toast.error(e instanceof Error ? e.message : t("app.error.generic"));
  }
}

/** Put text into a session's composer, ahead of whatever is already typed there. */
export function putDraft(sessionId: string, text: string): void {
  if (!text) return;
  const c = useComposer.getState();
  const cur = c.drafts[sessionId]?.text ?? "";
  c.setText(sessionId, cur.trim() && cur !== text ? `${text}\n\n${cur}` : text);
  c.requestFocus();
}

/**
 * Rewind to before a user message (Code: Rewind, Rewind code too; Chat: Retry, Edit via `resend`). The hub answers with
 * `messages_rewound` for every tab; without `resend` the removed text goes back into the composer. null = failed (toasted).
 */
export async function rewindSession(sessionId: string, body: RewindRequest): Promise<RewindResult | null> {
  try {
    const res = await api.rewind(sessionId, body);
    if (!body.resend) putDraft(sessionId, res.draft);
    return res;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
    return null;
  }
}

/** Fork a session at a message; the new session is known to the store and its composer holds the draft. null = failed (toasted). */
export async function forkSession(sessionId: string, messageUuid: string): Promise<Session | null> {
  try {
    const res = await api.fork(sessionId, messageUuid);
    useSessions.getState().upsertSession(res.session);
    if (res.draft) putDraft(res.session.id, res.draft);
    return res.session;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
    return null;
  }
}

/** Pin or unpin a message (optimistic; the marks come back with the session). */
export async function setPinned(sessionId: string, messageUuid: string, pinned: boolean): Promise<void> {
  const store = useSessions.getState();
  const before = (store.views[sessionId]?.session ?? store.sessions[sessionId])?.pinnedMessages ?? [];
  const after = pinned ? [...before.filter((u) => u !== messageUuid), messageUuid] : before.filter((u) => u !== messageUuid);
  store.patchSession(sessionId, { pinnedMessages: after });
  try {
    await (pinned ? api.pinMessage(sessionId, messageUuid) : api.unpinMessage(sessionId, messageUuid));
  } catch (e) {
    useSessions.getState().patchSession(sessionId, { pinnedMessages: before });
    toast.error(e instanceof Error ? e.message : t("app.error.generic"));
  }
}
