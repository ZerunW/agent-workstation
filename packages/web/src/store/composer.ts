import type { Attachment } from "@agent-workstation/protocol";
import type { EffortLevel, PermissionMode } from "@agent-workstation/protocol";
import { create } from "zustand";

export type ImageDraftAttachment = Extract<Attachment, { type: "image" }>;
/** A file already uploaded to the workspace, kept with what the tile shows (the hub only needs `path`). */
export type FileDraftAttachment = Extract<Attachment, { type: "file_ref" }> & { name: string; size?: number };
export type DraftAttachment = ImageDraftAttachment | FileDraftAttachment;

/** A file still on its way to the server: shown as a tile with a progress bar until it becomes a file_ref. */
export interface PendingUpload {
  id: string;
  name: string;
  size: number;
  /** 0..1 */
  progress: number;
  error?: string;
}

export interface Draft {
  text: string;
  /** Inline images (base64) and references to uploaded files: both are tiles above the text, never text. */
  attachments: DraftAttachment[];
}

export interface NewSessionSettings {
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel | null;
}

interface ComposerState {
  drafts: Record<string, Draft>;
  /** Uploads in flight (or failed) per draft key. */
  uploads: Record<string, PendingUpload[]>;
  /** Defaults applied when the session is created lazily on the first send. */
  newSettings: NewSessionSettings;
  /** Project folder (relative cwd) for the next Code session. */
  newCwd: string;
  /** The next Chat is created incognito (the ghost toggle on a new chat). */
  newIncognito: boolean;
  setText: (key: string, text: string) => void;
  appendText: (key: string, text: string) => void;
  addAttachments: (key: string, items: DraftAttachment[]) => void;
  removeAttachment: (key: string, index: number) => void;
  addUpload: (key: string, item: PendingUpload) => void;
  updateUpload: (key: string, id: string, patch: Partial<PendingUpload>) => void;
  removeUpload: (key: string, id: string) => void;
  clear: (key: string) => void;
  restore: (key: string, draft: Draft) => void;
  setNewSettings: (patch: NewSessionSettings) => void;
  setNewCwd: (cwd: string) => void;
  setNewIncognito: (on: boolean) => void;
  /** Focus request counter: composers focus when it changes. */
  focusTick: number;
  requestFocus: () => void;
}

const empty: Draft = { text: "", attachments: [] };
const none: PendingUpload[] = [];
export const getDraft = (drafts: Record<string, Draft>, key: string): Draft => drafts[key] ?? empty;
export const getUploads = (uploads: Record<string, PendingUpload[]>, key: string): PendingUpload[] => uploads[key] ?? none;

/** The protocol shape of a draft attachment (tile-only fields such as the file name are dropped). */
export function toProtocolAttachment(a: DraftAttachment): Attachment {
  return a.type === "image" ? a : { type: "file_ref", path: a.path };
}

export const useComposer = create<ComposerState>((set) => ({
  drafts: {},
  uploads: {},
  newSettings: {},
  newCwd: "",
  newIncognito: false,
  focusTick: 0,
  setText: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: { ...getDraft(s.drafts, key), text } } })),
  appendText: (key, text) =>
    set((s) => {
      const d = getDraft(s.drafts, key);
      const sep = d.text && !/\s$/.test(d.text) ? " " : "";
      return { drafts: { ...s.drafts, [key]: { ...d, text: `${d.text}${sep}${text}` } } };
    }),
  addAttachments: (key, items) => set((s) => ({ drafts: { ...s.drafts, [key]: { ...getDraft(s.drafts, key), attachments: [...getDraft(s.drafts, key).attachments, ...items] } } })),
  removeAttachment: (key, index) => set((s) => ({ drafts: { ...s.drafts, [key]: { ...getDraft(s.drafts, key), attachments: getDraft(s.drafts, key).attachments.filter((_, i) => i !== index) } } })),
  addUpload: (key, item) => set((s) => ({ uploads: { ...s.uploads, [key]: [...getUploads(s.uploads, key), item] } })),
  updateUpload: (key, id, patch) => set((s) => ({ uploads: { ...s.uploads, [key]: getUploads(s.uploads, key).map((u) => (u.id === id ? { ...u, ...patch } : u)) } })),
  removeUpload: (key, id) =>
    set((s) => {
      const rest = getUploads(s.uploads, key).filter((u) => u.id !== id);
      const { [key]: _old, ...others } = s.uploads;
      return { uploads: rest.length ? { ...others, [key]: rest } : others };
    }),
  clear: (key) =>
    set((s) => {
      const { [key]: _d, ...rest } = s.drafts;
      return { drafts: rest };
    }),
  restore: (key, draft) => set((s) => ({ drafts: { ...s.drafts, [key]: draft } })),
  setNewSettings: (patch) => set((s) => ({ newSettings: { ...s.newSettings, ...patch } })),
  setNewCwd: (newCwd) => set({ newCwd }),
  setNewIncognito: (newIncognito) => set({ newIncognito }),
  requestFocus: () => set((s) => ({ focusTick: s.focusTick + 1 })),
}));
