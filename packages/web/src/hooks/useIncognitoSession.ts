import { useEffect } from "react";
import { holdIncognito, isHeldIncognito } from "../store/incognito";
import { useSessions } from "../store/sessions";

/**
 * Open incognito chat lifecycle for the session in the URL: while it is on screen it is held, and when the person leaves it
 * (new chat, another session, another page, unmount) the client deletes it. Returns whether the session is an incognito one.
 * An incognito chat stays one while it is open even if the store momentarily forgets its row (the session poll).
 */
export function useIncognitoSession(sessionId: string | undefined): boolean {
  const flagged = useSessions((s) => (sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId])?.incognito === true : false));
  const id = sessionId && (flagged || isHeldIncognito(sessionId)) ? sessionId : null;
  useEffect(() => (id ? holdIncognito(id) : undefined), [id]);
  return id !== null;
}
