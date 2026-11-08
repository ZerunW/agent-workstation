/** localStorage that never throws (private windows, blocked storage, SSR/tests). */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  },
  getJSON<T>(key: string, fallback: T): T {
    const raw = safeStorage.get(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJSON(key: string, value: unknown): void {
    try {
      safeStorage.set(key, JSON.stringify(value));
    } catch {}
  },
};

export const STORAGE_KEYS = {
  user: "workstation.user",
  mode: "workstation.mode",
  sidebarOpen: "workstation.sidebarOpen",
  rightOpen: "workstation.rightOpen",
  rightTab: "workstation.rightTab",
  rightWidth: "workstation.rightWidth",
  lastSession: "workstation.lastSession", // JSON { chat?: id, code?: id }
  lastCwd: "workstation.lastCwd",
  theme: "workstation.theme",
  diffLayout: "workstation.diffLayout", // "unified" | "split"
  overviewCollapsed: "workstation.overviewCollapsed", // JSON { <card id>: true } of the collapsed Overview cards
} as const;

