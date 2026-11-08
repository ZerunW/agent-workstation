import { create } from "zustand";

/**
 * "Show this subagent run in the transcript": set by the Overview tasks card, consumed by the matching tool group and
 * row (they open and scroll to it). One request at a time; the row clears it once it has handled it.
 */
interface SubagentFocusState {
  focus: { sessionId: string; description: string } | null;
  reveal: (sessionId: string, description: string) => void;
  clear: () => void;
}

export const useSubagentFocus = create<SubagentFocusState>((set) => ({
  focus: null,
  reveal: (sessionId, description) => set({ focus: { sessionId, description } }),
  clear: () => set({ focus: null }),
}));
