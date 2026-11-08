import { create } from "zustand";
import { api, isUnavailable, type ProjectInfo } from "../lib/api";

export type ProjectsStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

interface ProjectsState {
  list: ProjectInfo[];
  status: ProjectsStatus;
  error: string | null;
  /** Fetch GET /api/projects. Never throws: older hubs answer 404/501 → status "unavailable". */
  load: () => Promise<void>;
  /** Apply live numbers from `review_changed`. */
  patch: (id: string, patch: Partial<Pick<ProjectInfo, "pendingFiles" | "localCommit" | "sizeBytes">>) => void;
  remove: (id: string) => void;
  reset: () => void;
}

export const useProjects = create<ProjectsState>((set, get) => ({
  list: [],
  status: "idle",
  error: null,
  load: async () => {
    if (get().status === "idle") set({ status: "loading" });
    try {
      const list = await api.projects();
      set({ list, status: "ready", error: null });
    } catch (e) {
      if (isUnavailable(e)) set({ list: [], status: "unavailable", error: null });
      else set({ status: get().list.length ? "ready" : "error", error: e instanceof Error ? e.message : String(e) });
    }
  },
  patch: (id, patch) => set((s) => ({ list: s.list.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
  remove: (id) => set((s) => ({ list: s.list.filter((p) => p.id !== id) })),
  reset: () => set({ list: [], status: "idle", error: null }),
}));
