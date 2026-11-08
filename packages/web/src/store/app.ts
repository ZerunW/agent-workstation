import type { DiskStatus, Me, ModelInfo, SessionKind, UsageLimits } from "@agent-workstation/protocol";
import { create } from "zustand";
import type { ConnStatus } from "../lib/ws";
import { setApiUser } from "../lib/api";
import { safeStorage, STORAGE_KEYS } from "../lib/storage";

export type RightTab = "overview" | "files" | "changes" | "history" | "terminal" | "browser" | "sync";
export const RIGHT_TABS: readonly RightTab[] = ["overview", "files", "changes", "history", "terminal", "browser", "sync"];
export const isRightTab = (v: string | null | undefined): v is RightTab => !!v && (RIGHT_TABS as readonly string[]).includes(v);
export type Theme = "system" | "light" | "dark";

export interface AppNotice {
  id: string;
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  at: string;
}

const readMode = (): SessionKind => (safeStorage.get(STORAGE_KEYS.mode) === "chat" ? "chat" : "code");
const readBool = (key: string, fallback: boolean) => {
  const v = safeStorage.get(key);
  return v == null ? fallback : v === "1";
};
const readTab = (): RightTab => {
  const v = safeStorage.get(STORAGE_KEYS.rightTab);
  return isRightTab(v) ? v : "files";
};

interface AppState {
  user: string | null;
  me: Me | null;
  meError: string | null;
  mode: SessionKind;
  conn: ConnStatus;
  sidebarOpen: boolean;
  rightOpen: boolean;
  rightTab: RightTab;
  rightWidth: number;
  theme: Theme;
  limits: UsageLimits | null;
  disk: DiskStatus | null;
  diskModalDismissed: boolean;
  models: ModelInfo[];
  modelsLoaded: boolean;
  notices: AppNotice[];
  /** Reasons the composer is blocked by the last rejected send (cleared on the next accepted send). */
  sendBlock: { code: string; message: string } | null;
  /** pending file counts reported by review_changed, per project id */
  reviewPending: Record<string, number>;
  paletteOpen: boolean;
  /** The ⌘K search dialog (keyword + relevant columns). */
  searchOpen: boolean;
  /** Files tab: only show files changed in this session (also set by "Show in Files" on the Changes tab). */
  filesChangedOnly: boolean;
  /** Overview → Outputs asks the Files tab to open this file in its preview; the Files tab clears it once handled. */
  openFileRequest: string | null;
  /** Bumped by every `memories_changed` event: the Memory page refetches when it changes. */
  memoriesTick: number;
  /** Hub clock minus this browser's clock (ms), measured from `welcome.serverTime`; 0 until the first welcome. */
  serverOffsetMs: number;

  setUser: (user: string | null) => void;
  setMe: (me: Me | null, error?: string | null) => void;
  setMode: (mode: SessionKind) => void;
  setConn: (c: ConnStatus) => void;
  toggleSidebar: (open?: boolean) => void;
  setRight: (open: boolean, tab?: RightTab) => void;
  setRightWidth: (w: number) => void;
  setTheme: (t: Theme) => void;
  setLimits: (l: UsageLimits | null) => void;
  setDisk: (d: DiskStatus | null) => void;
  dismissDiskModal: () => void;
  setModels: (m: ModelInfo[]) => void;
  pushNotice: (n: Omit<AppNotice, "id">) => void;
  dismissNotice: (id: string) => void;
  clearNotice: (code: string) => void;
  setSendBlock: (b: AppState["sendBlock"]) => void;
  setReviewPending: (projectId: string, n: number) => void;
  setPaletteOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setFilesChangedOnly: (v: boolean) => void;
  /** Switch to the Files tab and open `path` in its preview. */
  openFile: (path: string) => void;
  bumpMemories: () => void;
  setServerTime: (iso: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  user: safeStorage.get(STORAGE_KEYS.user),
  me: null,
  meError: null,
  mode: readMode(),
  conn: "idle",
  sidebarOpen: readBool(STORAGE_KEYS.sidebarOpen, true),
  rightOpen: readBool(STORAGE_KEYS.rightOpen, false),
  rightTab: readTab(),
  rightWidth: Math.min(720, Math.max(280, Number(safeStorage.get(STORAGE_KEYS.rightWidth)) || 420)),
  theme: (safeStorage.get(STORAGE_KEYS.theme) as Theme | null) ?? "system",
  limits: null,
  disk: null,
  diskModalDismissed: false,
  models: [],
  modelsLoaded: false,
  notices: [],
  sendBlock: null,
  reviewPending: {},
  paletteOpen: false,
  searchOpen: false,
  filesChangedOnly: false,
  openFileRequest: null,
  memoriesTick: 0,
  serverOffsetMs: 0,

  setUser: (user) => {
    setApiUser(user); // synchronous: child effects fetch before RequireUser's effect runs
    if (user) safeStorage.set(STORAGE_KEYS.user, user);
    else safeStorage.remove(STORAGE_KEYS.user);
    set({ user, me: null, meError: null, limits: null, disk: null, diskModalDismissed: false, notices: [], sendBlock: null, modelsLoaded: false, models: [] });
  },
  setMe: (me, error = null) => set({ me, meError: error }),
  setMode: (mode) => {
    safeStorage.set(STORAGE_KEYS.mode, mode);
    set({ mode });
  },
  setConn: (conn) => set({ conn }),
  toggleSidebar: (open) => {
    const next = open ?? !get().sidebarOpen;
    safeStorage.set(STORAGE_KEYS.sidebarOpen, next ? "1" : "0");
    set({ sidebarOpen: next });
  },
  setRight: (open, tab) => {
    const nextTab = tab ?? get().rightTab;
    safeStorage.set(STORAGE_KEYS.rightOpen, open ? "1" : "0");
    safeStorage.set(STORAGE_KEYS.rightTab, nextTab);
    set({ rightOpen: open, rightTab: nextTab });
  },
  setRightWidth: (rightWidth) => {
    safeStorage.set(STORAGE_KEYS.rightWidth, String(Math.round(rightWidth)));
    set({ rightWidth });
  },
  setTheme: (theme) => {
    safeStorage.set(STORAGE_KEYS.theme, theme);
    set({ theme });
  },
  setLimits: (limits) => set({ limits }),
  setDisk: (disk) => set((s) => ({ disk, me: s.me && disk ? { ...s.me, disk: disk.level } : s.me })),
  dismissDiskModal: () => set({ diskModalDismissed: true }),
  setModels: (models) => set({ models, modelsLoaded: true }),
  pushNotice: (n) =>
    set((s) => ({
      // one banner per code: the latest message wins
      notices: [...s.notices.filter((x) => x.code !== n.code), { ...n, id: `${n.code}-${n.at}` }],
    })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  clearNotice: (code) => set((s) => ({ notices: s.notices.filter((n) => n.code !== code) })),
  setSendBlock: (sendBlock) => set({ sendBlock }),
  setReviewPending: (projectId, n) => set((s) => ({ reviewPending: { ...s.reviewPending, [projectId]: n } })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setFilesChangedOnly: (filesChangedOnly) => set({ filesChangedOnly }),
  openFile: (path) => {
    safeStorage.set(STORAGE_KEYS.rightOpen, "1");
    safeStorage.set(STORAGE_KEYS.rightTab, "files");
    set({ rightOpen: true, rightTab: "files", openFileRequest: path });
  },
  bumpMemories: () => set((s) => ({ memoriesTick: s.memoriesTick + 1 })),
  setServerTime: (iso) => {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) set({ serverOffsetMs: t - Date.now() });
  },
}));

// Identity header must be available before any component effect fires (reload / StrictMode remount).
setApiUser(safeStorage.get(STORAGE_KEYS.user));

export function rememberSession(kind: SessionKind, id: string | null): void {
  const cur = safeStorage.getJSON<Record<string, string>>(STORAGE_KEYS.lastSession, {});
  if (id) cur[kind] = id;
  else delete cur[kind];
  safeStorage.setJSON(STORAGE_KEYS.lastSession, cur);
}

export function recallSession(kind: SessionKind): string | null {
  return safeStorage.getJSON<Record<string, string>>(STORAGE_KEYS.lastSession, {})[kind] ?? null;
}

/** Severity of the API-credit budget, for the sidebar red dot. */
export function usageSeverity(limits: UsageLimits | null): "normal" | "warning" | "critical" {
  const sev = limits?.api?.severity;
  return sev === "critical" || sev === "warning" ? sev : "normal";
}
