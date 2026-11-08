import { useMemo } from "react";
import type { Session } from "@agent-workstation/protocol";
import { resolveSessionProject, type ProjectRef } from "../../lib/projects";
import { useProjects, type ProjectsStatus } from "../../store/projects";
import { useSessions } from "../../store/sessions";

export interface SessionProject {
  session: Session | null;
  /** null = the session works outside every project (or there is no session). */
  project: ProjectRef | null;
  projectsStatus: ProjectsStatus;
}

/** The project a session works in: `Session.projectId` when the hub sends it, else matched from the cwd. */
export function useSessionProject(sessionId: string | null): SessionProject {
  const session = useSessions((s) => (sessionId ? (s.sessions[sessionId] ?? null) : null));
  const list = useProjects((s) => s.list);
  const projectsStatus = useProjects((s) => s.status);
  const project = useMemo(() => (session ? resolveSessionProject(session, list) : null), [session, list]);
  return { session, project, projectsStatus };
}
