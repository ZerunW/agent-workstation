import type { Session } from "@agent-workstation/protocol";
import type { ProjectInfo } from "./api";

type SessionLike = Pick<Session, "cwd" | "projectId">;

/** `Session.projectId` (optional and nullable: older hubs do not send it, sessions outside projects have null). */
export function sessionProjectId(s: SessionLike): string | null {
  return s.projectId ?? null;
}

/** "projects/foo" or "projects/foo/src" → "foo"; anything else → null. */
export function projectNameFromCwd(cwd: string): string | null {
  const m = /^projects\/([^/]+)(?:\/|$)/.exec(cwd.replace(/^\/+/, ""));
  return m?.[1] ?? null;
}

export interface ProjectRef {
  /** null while the project list does not know the project (older hub, list not loaded yet). */
  id: string | null;
  name: string;
}

/**
 * Which project does a session work in? `projectId` wins; without it the cwd (`projects/<name>[/...]`) is matched
 * against the project names. Sessions outside every project (cwd "", ".chat", "docs", …) return null.
 */
export function resolveSessionProject(s: SessionLike, projects: readonly ProjectInfo[]): ProjectRef | null {
  const pid = sessionProjectId(s);
  if (pid) {
    const hit = projects.find((p) => p.id === pid);
    if (hit) return { id: hit.id, name: hit.name };
    const name = projectNameFromCwd(s.cwd);
    if (name) return { id: pid, name };
    return { id: pid, name: pid.slice(0, 8) };
  }
  const name = projectNameFromCwd(s.cwd);
  if (!name) return null;
  const hit = projects.find((p) => p.name === name);
  return { id: hit?.id ?? null, name };
}

/** Short git-style hash for display. */
export const shortCommit = (c: string | null | undefined, n = 7): string => (c ? c.slice(0, n) : "—");
