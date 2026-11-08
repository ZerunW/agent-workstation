import type { SessionOutput } from "@agent-workstation/protocol";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { useChanged, type ChangedFile } from "./changed";

interface OutputsState {
  /** What the hub's file_touches say per session (loaded from GET /api/sessions/:id/outputs). */
  bySession: Record<string, SessionOutput[]>;
  load: (sessionId: string) => Promise<void>;
}

export const useOutputs = create<OutputsState>((set) => ({
  bySession: {},
  load: async (sessionId) => {
    try {
      const outputs = await api.sessionOutputs(sessionId);
      set((s) => ({ bySession: { ...s.bySession, [sessionId]: outputs } }));
    } catch {
      // keep what we have; the live file events still work
    }
  },
}));

const NONE: Record<string, ChangedFile> = {};
const NO_OUTPUTS: SessionOutput[] = [];

/**
 * The hub's recorded outputs of a session with the live `file_event`s of this page on top: the newer entry per path wins
 * (a live `unlink` marks a recorded path missing, i.e. kind "unlink"); a live `unlink` of an unrecorded path is dropped.
 */
export function mergeOutputs(recorded: SessionOutput[], live: Record<string, ChangedFile>, sessionId: string): Record<string, ChangedFile> {
  const out: Record<string, ChangedFile> = {};
  for (const o of recorded) out[o.path] = { kind: o.missing ? "unlink" : "change", at: o.at, sessionId };
  for (const [path, ev] of Object.entries(live)) {
    const rec = out[path];
    if (!rec) {
      if (ev.kind !== "unlink") out[path] = ev;
    } else if (Date.parse(ev.at) >= Date.parse(rec.at) || Number.isNaN(Date.parse(rec.at))) {
      out[path] = ev;
    }
  }
  return out;
}

/** Loads the session's recorded outputs once per mount / session. */
export function useLoadOutputs(sessionId: string | null, enabled = true): void {
  const load = useOutputs((s) => s.load);
  useEffect(() => {
    if (sessionId && enabled) void load(sessionId);
  }, [sessionId, enabled, load]);
}

/** The merged changed map (path → latest state) of a session; the workspace-wide live map when there is no session. */
export function useMergedChanged(sessionId: string | null): Record<string, ChangedFile> {
  const live = useChanged((s) => (sessionId ? (s.bySession[sessionId] ?? NONE) : s.all));
  const recorded = useOutputs((s) => (sessionId ? (s.bySession[sessionId] ?? NO_OUTPUTS) : NO_OUTPUTS));
  return useMemo(() => (sessionId ? mergeOutputs(recorded, live, sessionId) : live), [sessionId, recorded, live]);
}
