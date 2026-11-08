import { create } from "zustand";

export interface SyncConflict {
  reason: string;
  at: string;
}

interface ReviewState {
  /** Bumped on every `review_changed` for a project: review/history views refetch when it moves. */
  version: Record<string, number>;
  /** `sync_conflict` events per project and file path, kept until the user resolves or dismisses them. */
  conflicts: Record<string, Record<string, SyncConflict>>;
  bump: (projectId: string) => void;
  addConflict: (projectId: string, path: string, reason: string, at?: string) => void;
  clearConflict: (projectId: string, path: string) => void;
  clear: () => void;
}

export const useReview = create<ReviewState>((set) => ({
  version: {},
  conflicts: {},
  bump: (projectId) => set((s) => ({ version: { ...s.version, [projectId]: (s.version[projectId] ?? 0) + 1 } })),
  addConflict: (projectId, path, reason, at = new Date().toISOString()) =>
    set((s) => ({ conflicts: { ...s.conflicts, [projectId]: { ...(s.conflicts[projectId] ?? {}), [path]: { reason, at } } } })),
  clearConflict: (projectId, path) =>
    set((s) => {
      const cur = s.conflicts[projectId];
      if (!cur || !(path in cur)) return s;
      const { [path]: _gone, ...rest } = cur;
      return { conflicts: { ...s.conflicts, [projectId]: rest } };
    }),
  clear: () => set({ version: {}, conflicts: {} }),
}));
