import type { FileEntry } from "@agent-workstation/protocol";
import { dirHasChanges, type ChangedFile } from "../../store/changed";

/** Directories first, then everything else; case-insensitive natural order by name. */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  const rank = (e: FileEntry) => (e.kind === "dir" ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export interface DirState {
  /** null until the first successful load */
  entries: FileEntry[] | null;
  loading: boolean;
  error: string | null;
}

export type Row =
  | { kind: "entry"; entry: FileEntry; depth: number }
  | { kind: "status"; status: "loading" | "error" | "empty"; dir: string; depth: number; message?: string };

export interface FlattenOptions {
  /** Only keep entries changed in the current session (dirs that contain a changed path stay). */
  changed?: Record<string, ChangedFile> | null;
  /** Workspace-relative directory the tree starts at ("" = workspace root). */
  root?: string;
}

/** Is `path` strictly inside `root` ("" = everything)? */
export function isUnder(path: string, root: string): boolean {
  return root === "" || path.startsWith(`${root}/`);
}

/** The changed paths that live inside `root`. */
export function scopeChanged(changed: Record<string, ChangedFile>, root: string): Record<string, ChangedFile> {
  if (root === "") return changed;
  const out: Record<string, ChangedFile> = {};
  for (const [p, c] of Object.entries(changed)) if (isUnder(p, root)) out[p] = c;
  return out;
}

const isGone = (c: ChangedFile | undefined) => !c || c.kind === "unlink" || c.kind === "unlinkDir";

/** Is this entry (or, for folders, anything beneath it) in the changed map? */
export function isChangedEntry(entry: FileEntry, changed: Record<string, ChangedFile>): boolean {
  const own = !isGone(changed[entry.path]);
  if (entry.kind !== "dir") return own;
  return own || dirHasChanges(changed, entry.path);
}

/** Flatten the lazily loaded tree into visible rows (expanded folders only). Pure. */
export function flattenRows(dirs: Record<string, DirState>, expanded: ReadonlySet<string>, opts: FlattenOptions = {}): Row[] {
  const rows: Row[] = [];
  const changed = opts.changed ?? null;
  const walk = (dir: string, depth: number) => {
    const state = dirs[dir];
    if (!state || (state.loading && !state.entries)) {
      rows.push({ kind: "status", status: "loading", dir, depth });
      return;
    }
    if (state.error && !state.entries) {
      rows.push({ kind: "status", status: "error", dir, depth, message: state.error });
      return;
    }
    const entries = sortEntries(state.entries ?? []);
    let shown = 0;
    for (const entry of entries) {
      if (changed && !isChangedEntry(entry, changed)) continue;
      shown++;
      rows.push({ kind: "entry", entry, depth });
      if (entry.kind === "dir" && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
    if (shown === 0 && depth > 0 && !changed) rows.push({ kind: "status", status: "empty", dir, depth });
  };
  walk(opts.root ?? "", 0);
  return rows;
}

/** Parent directories ("a", "a/b") of a workspace path, outermost first. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Folders that must be open to reveal every changed (still existing) path. */
export function foldersToReveal(changed: Record<string, ChangedFile>, root = ""): string[] {
  const set = new Set<string>();
  for (const [path, c] of Object.entries(changed)) {
    if (isGone(c) || !isUnder(path, root)) continue;
    for (const a of ancestorsOf(path)) if (isUnder(a, root)) set.add(a);
    if (c.kind === "addDir") set.add(path);
  }
  return [...set].sort();
}

export interface TreeSummary {
  files: number;
  bytes: number;
}

/** Totals for a (possibly nested, flat) listing — used by the delete confirmation. */
export function summarizeTree(entries: readonly FileEntry[]): TreeSummary {
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    if (e.kind === "dir") continue;
    files++;
    bytes += e.size;
  }
  return { files, bytes };
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};

export function imageMimeForPath(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return IMAGE_MIME[ext] ?? null;
}

/** A folder name the hub will accept: no separators, not "." or "..". */
export function validFolderName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 200 && !/[\\/\0]/.test(n) && n !== "." && n !== "..";
}

/** Directory a row belongs to for drop/upload purposes. */
export function dirOfEntry(entry: FileEntry): string {
  if (entry.kind === "dir") return entry.path;
  const i = entry.path.lastIndexOf("/");
  return i < 0 ? "" : entry.path.slice(0, i);
}
