import { create } from "zustand";

export type FileEventKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export interface ChangedFile {
  kind: FileEventKind;
  at: string;
  sessionId: string | null;
}

interface ChangedState {
  /** Latest event per path since this page loaded (all sessions). */
  all: Record<string, ChangedFile>;
  /** Latest event per path, bucketed by the session that caused it. */
  bySession: Record<string, Record<string, ChangedFile>>;
  /** Bumped on every event so lists can refresh cheaply. */
  tick: number;
  record: (ev: { path: string; kind: FileEventKind; sessionId: string | null; at: string }) => void;
  clear: () => void;
}

export const useChanged = create<ChangedState>((set) => ({
  all: {},
  bySession: {},
  tick: 0,
  record: (ev) =>
    set((s) => {
      const entry: ChangedFile = { kind: ev.kind, at: ev.at, sessionId: ev.sessionId };
      const bySession = ev.sessionId ? { ...s.bySession, [ev.sessionId]: { ...(s.bySession[ev.sessionId] ?? {}), [ev.path]: entry } } : s.bySession;
      return { all: { ...s.all, [ev.path]: entry }, bySession, tick: s.tick + 1 };
    }),
  clear: () => set({ all: {}, bySession: {}, tick: 0 }),
}));

/** True when `dirPath` contains a changed path (used to flag collapsed folders). */
export function dirHasChanges(changed: Record<string, ChangedFile>, dirPath: string): boolean {
  const prefix = dirPath === "" ? "" : `${dirPath}/`;
  for (const p of Object.keys(changed)) {
    if (changed[p]!.kind === "unlink" || changed[p]!.kind === "unlinkDir") continue;
    if (prefix === "" || p.startsWith(prefix)) return true;
  }
  return false;
}
