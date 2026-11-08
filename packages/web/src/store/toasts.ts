import { create } from "zustand";

export type ToastTone = "info" | "success" | "error" | "progress";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** 0..1 for tone "progress" */
  progress?: number;
  /** ms before auto-dismiss; null = sticky. Defaults per tone. */
  duration?: number | null;
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id"> & { id?: string }) => string;
  update: (id: string, patch: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: string) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let counter = 0;

function arm(id: string, duration: number | null | undefined, tone: ToastTone, dismiss: (id: string) => void) {
  const prev = timers.get(id);
  if (prev) clearTimeout(prev);
  timers.delete(id);
  const ms = duration === undefined ? (tone === "error" ? 8000 : tone === "progress" ? null : 4000) : duration;
  if (ms != null) timers.set(id, setTimeout(() => dismiss(id), ms));
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = t.id ?? `toast-${++counter}`;
    set((s) => ({ toasts: [...s.toasts.filter((x) => x.id !== id), { ...t, id }] }));
    arm(id, t.duration, t.tone, get().dismiss);
    return id;
  },
  update: (id, patch) => {
    set((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
    const cur = get().toasts.find((x) => x.id === id);
    if (cur && (patch.tone || patch.duration !== undefined)) arm(id, cur.duration, cur.tone, get().dismiss);
  },
  dismiss: (id) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  },
}));

export const toast = {
  info: (title: string, description?: string) => useToasts.getState().push({ tone: "info", title, description }),
  success: (title: string, description?: string) => useToasts.getState().push({ tone: "success", title, description }),
  error: (title: string, description?: string) => useToasts.getState().push({ tone: "error", title, description }),
  progress: (id: string, title: string, progress: number, description?: string) => useToasts.getState().push({ id, tone: "progress", title, progress, description }),
  update: (id: string, patch: Partial<Omit<Toast, "id">>) => useToasts.getState().update(id, patch),
  dismiss: (id: string) => useToasts.getState().dismiss(id),
};
