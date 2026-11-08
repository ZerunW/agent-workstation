import type { BrowserState } from "@agent-workstation/protocol";
import { create } from "zustand";

export interface BrowserFrame {
  data: string;
  width: number;
  height: number;
  at: string;
}

interface BrowserStore {
  state: BrowserState | null;
  /** Latest frame; components that draw it subscribe imperatively so a frame never re-renders React. */
  frame: BrowserFrame | null;
  setState: (state: BrowserState) => void;
  setFrame: (frame: BrowserFrame) => void;
  reset: () => void;
}

export const useBrowser = create<BrowserStore>((set) => ({
  state: null,
  frame: null,
  setState: (state) => set((s) => ({ state, frame: state.running ? s.frame : null })),
  setFrame: (frame) => set({ frame }),
  reset: () => set({ state: null, frame: null }),
}));
