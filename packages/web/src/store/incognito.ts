import type { Session } from "@agent-workstation/protocol";
import { api, deleteSessionKeepalive } from "../lib/api";
import { useSessions } from "./sessions";

/**
 * Incognito chats (Chat mode) are deleted by the client when the person is done with them: on
 * "New chat", when another session or page is opened, and when the tab goes away. The hub also purges them on restart.
 * A hold marks the one on screen; leaving it deletes it.
 */
const live = new Set<string>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();

/** Incognito sessions never show in lists (the hub does not list them either; this covers the one just created here). */
export const isIncognito = (s: Pick<Session, "incognito"> | null | undefined): boolean => s?.incognito === true;
/** Subagent sessions (`parentSessionId` set) are opened from the parent's transcript only. */
export const isSubagentSession = (s: Pick<Session, "parentSessionId"> | null | undefined): boolean => !!s?.parentSessionId;
export const listable = (sessions: readonly Session[]): Session[] => sessions.filter((s) => !isIncognito(s) && !isSubagentSession(s));

/** True while the client is holding this session as an open incognito chat (survives the store dropping its row). */
export const isHeldIncognito = (id: string): boolean => live.has(id);

/**
 * Mark an incognito session as open. The returned release is the "left it" signal: it deletes the session after a tick,
 * and a hold taken again meanwhile (React StrictMode re-running the effect, a re-render) cancels that.
 */
export function holdIncognito(id: string): () => void {
  const timer = leaving.get(id);
  if (timer) {
    clearTimeout(timer);
    leaving.delete(id);
  }
  live.add(id);
  return () => {
    leaving.set(
      id,
      setTimeout(() => {
        leaving.delete(id);
        endIncognito(id);
      }, 0),
    );
  };
}

/** Delete one incognito session from the hub and from this client. Silent: a failure leaves the hub's restart purge. */
export function endIncognito(id: string): void {
  if (!live.delete(id)) return;
  useSessions.getState().removeSession(id);
  void api.deleteSession(id).catch(() => {});
}

/** The page is going away (`pagehide`): delete every open incognito session with requests that outlive it. */
export function endAllIncognitoOnExit(): void {
  for (const [id, timer] of leaving) {
    clearTimeout(timer);
    leaving.delete(id);
  }
  for (const id of live) deleteSessionKeepalive(id);
  live.clear();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", endAllIncognitoOnExit);

/** Test hook: forget every hold without deleting anything. */
export function resetIncognito(): void {
  for (const timer of leaving.values()) clearTimeout(timer);
  leaving.clear();
  live.clear();
}
