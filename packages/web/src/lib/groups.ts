import type { Session, SessionKind } from "@agent-workstation/protocol";
import { dayBucket, type DayBucket } from "./format";
import type { ProjectInfo } from "./api";
import { resolveSessionProject } from "./projects";

export interface SessionGroup {
  key: string;
  /** i18n-able bucket for chat groups, or the project name for code groups ("" = Workspace) */
  label: string;
  bucket?: DayBucket;
  /** cwd a new session in this group starts in (`projects/<name>` or "" for the workspace) */
  cwd?: string;
  projectId?: string | null;
  sessions: Session[];
}

const BUCKET_ORDER: DayBucket[] = ["today", "yesterday", "week", "month", "older"];

/**
 * Sidebar grouping: Code sessions by project (from `projectId` or a `projects/<name>` cwd), everything else
 * under "Workspace"; Chat sessions by day. Sessions inside a group are newest-first; code groups are ordered
 * by their newest session.
 */
export function groupSessions(sessions: readonly Session[], kind: SessionKind, query = "", now = new Date(), projects: readonly ProjectInfo[] = []): SessionGroup[] {
  const q = query.trim().toLowerCase();
  const list = sessions.filter((s) => s.kind === kind && (!q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))).sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));

  if (kind === "chat") {
    const byBucket = new Map<DayBucket, Session[]>();
    for (const s of list) {
      const b = dayBucket(s.lastActiveAt, now);
      const arr = byBucket.get(b) ?? [];
      arr.push(s);
      byBucket.set(b, arr);
    }
    return BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => ({ key: `day:${b}`, label: b, bucket: b, sessions: byBucket.get(b)! }));
  }

  const byProject = new Map<string, SessionGroup>();
  for (const s of list) {
    const ref = resolveSessionProject(s, projects);
    const key = ref ? `project:${ref.name}` : "workspace";
    let g = byProject.get(key);
    if (!g) {
      g = { key, label: ref?.name ?? "", cwd: ref ? `projects/${ref.name}` : "", projectId: ref?.id ?? null, sessions: [] };
      byProject.set(key, g);
    }
    if (!g.projectId && ref?.id) g.projectId = ref.id;
    g.sessions.push(s);
  }
  return [...byProject.values()].sort((a, b) => Date.parse(b.sessions[0]!.lastActiveAt) - Date.parse(a.sessions[0]!.lastActiveAt));
}
