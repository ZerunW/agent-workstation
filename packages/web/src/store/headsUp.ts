import type { KnownHeadsUp } from "@agent-workstation/protocol";
import { create } from "zustand";
import { api } from "../lib/api";

interface HeadsUpState {
  /** Heads-ups the user already knew (the hub keeps them; newest first). */
  known: KnownHeadsUp[];
  loaded: boolean;
  /** Cards closed with × during this page view only. */
  dismissed: Record<string, true>;
  /** Fetch the list once (or again with `force`); failures leave it as it is. */
  load: (force?: boolean) => Promise<void>;
  /** POST; resolves once the hub has it. Rejects when the request fails. */
  markKnown: (text: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  dismiss: (key: string) => void;
}

let inflight: Promise<void> | null = null;

export const useHeadsUp = create<HeadsUpState>((set, get) => ({
  known: [],
  loaded: false,
  dismissed: {},
  load: (force = false) => {
    if (!force && get().loaded) return Promise.resolve();
    if (inflight && !force) return inflight;
    const run = api.knownHeadsUps().then(
      // keep the old array when nothing changed, so subscribers do not re-render
      (known) => set((s) => ({ loaded: true, known: JSON.stringify(s.known) === JSON.stringify(known) ? s.known : known })),
      () => {}, // older hub or offline: nothing is known, cards show
    );
    const tracked: Promise<void> = run.finally(() => {
      if (inflight === tracked) inflight = null;
    });
    inflight = tracked;
    return tracked;
  },
  markKnown: async (text) => {
    const res = await api.addKnownHeadsUp(text);
    set((s) => {
      const entry: KnownHeadsUp = res && typeof res === "object" && typeof res.id === "string" ? { id: res.id, text: res.text ?? text, at: res.at ?? new Date().toISOString() } : { id: `local:${text}`, text, at: new Date().toISOString() };
      return { known: [entry, ...s.known.filter((k) => k.text !== text)] };
    });
  },
  remove: async (id) => {
    await api.removeKnownHeadsUp(id);
    set((s) => ({ known: s.known.filter((k) => k.id !== id) }));
  },
  dismiss: (key) => set((s) => ({ dismissed: { ...s.dismissed, [key]: true } })),
}));
