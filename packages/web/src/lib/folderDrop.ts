import { t } from "../i18n";
import { useApp } from "../store/app";
import { toast } from "../store/toasts";
import { joinPath } from "./format";
import { newCodeSessionUrl, validCwd } from "./newSession";
import { uploadFile } from "./upload";

/** Never uploaded from a dropped folder, at any depth. */
export const FOLDER_SKIP = new Set([".git", "node_modules", ".DS_Store"]);
export const MAX_FOLDER_FILES = 2000;
export const MAX_FOLDER_BYTES = 500 * 1024 * 1024;

export interface FolderFile {
  file: File;
  /** Path inside the dropped folder, e.g. "src/a.ts". */
  rel: string;
}

/**
 * The entries of a drop (`webkitGetAsEntry`). Must run synchronously inside the drop handler: the items are gone afterwards.
 * Browsers without the API give none, and the drop is then handled as plain files.
 */
export function dropEntries(dt: DataTransfer | null | undefined): FileSystemEntry[] {
  const out: FileSystemEntry[] = [];
  for (const item of Array.from(dt?.items ?? [])) {
    if (item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) out.push(entry);
  }
  return out;
}

export const isDirectoryEntry = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory;

const readBatch = (reader: FileSystemDirectoryReader) => new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

export class FolderTooLargeError extends Error {
  constructor() {
    super("folder too large");
  }
}

/** Every file below `dir` (recursive, skip list applied). Throws FolderTooLargeError as soon as a cap is passed. */
export async function collectFolder(dir: FileSystemDirectoryEntry): Promise<FolderFile[]> {
  const files: FolderFile[] = [];
  let bytes = 0;
  const walk = async (d: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = d.createReader();
    for (;;) {
      const batch = await readBatch(reader); // readEntries returns chunks until it returns []
      if (batch.length === 0) return;
      for (const entry of batch) {
        if (FOLDER_SKIP.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry, rel);
        else if (entry.isFile) {
          const file = await fileOf(entry as FileSystemFileEntry);
          bytes += file.size;
          if (files.length + 1 > MAX_FOLDER_FILES || bytes > MAX_FOLDER_BYTES) throw new FolderTooLargeError();
          files.push({ file, rel });
        }
      }
    }
  };
  await walk(dir, "");
  return files;
}

let seq = 0;

/**
 * Drop handler step: true when the drop contains a folder (the caller must then not treat the drop as files — the
 * browser lists a folder in `dataTransfer.files` as a 0-byte entry). Entries are read synchronously, as they must be.
 * In a browser the folder is uploaded; inside the app the shell takes folder drops, so one that slips through is ignored.
 */
export function handleFolderDrop(dt: DataTransfer | null | undefined, navigate: (to: string) => void): boolean {
  const dirs = dropEntries(dt).filter(isDirectoryEntry);
  if (dirs.length === 0) return false;
  if (!window.__workstationShell) void dropFolders(dirs, navigate);
  return true;
}

/** Browser folder drop: the first folder that uploads becomes a new Code session's directory (`/?new=code&cwd=inbox/<name>`). */
export async function dropFolders(dirs: FileSystemDirectoryEntry[], navigate: (to: string) => void): Promise<void> {
  let path: string | null = null;
  for (const dir of dirs) path ??= await uploadFolder(dir);
  if (path) navigate(newCodeSessionUrl(path));
}

/**
 * Upload a dropped folder to `inbox/<name>/` (chunked upload, relative paths kept, one progress toast).
 * Returns the folder's workspace path, or null when nothing was uploaded.
 */
export async function uploadFolder(dir: FileSystemDirectoryEntry): Promise<string | null> {
  const name = dir.name;
  const target = validCwd(joinPath("inbox", name));
  if (!target) return null;
  if (useApp.getState().disk?.level === "block") {
    toast.error(t("disk.blocked.upload"));
    return null;
  }
  let files: FolderFile[];
  try {
    files = await collectFolder(dir);
  } catch (e) {
    toast.error(e instanceof FolderTooLargeError ? t("composer.folder.tooLarge", { files: MAX_FOLDER_FILES.toLocaleString("en-US"), mb: MAX_FOLDER_BYTES / 1024 / 1024 }) : t("app.error.generic"));
    return null;
  }
  if (files.length === 0) return null; // nothing to upload: the folder would not exist on the server
  const total = files.reduce((n, f) => n + f.file.size, 0);
  const id = `upload-folder-${++seq}`;
  toast.progress(id, t("composer.upload.start", { name }), 0);
  let done = 0;
  try {
    for (const { file, rel } of files) {
      const base = done;
      await uploadFile(file, {
        path: joinPath(target, rel),
        onProgress: (p) => {
          const frac = total > 0 ? Math.min(1, (base + p.sentBytes) / total) : 1;
          toast.update(id, { title: t("composer.upload.progress", { name, percent: Math.round(frac * 100) }), progress: frac });
        },
      });
      done += file.size;
    }
    toast.update(id, { tone: "success", title: t("composer.upload.done", { name, path: target }), progress: 1, duration: 3500 });
    return target;
  } catch (e) {
    toast.update(id, { tone: "error", title: t("composer.upload.failed", { name, error: e instanceof Error ? e.message : String(e) }), duration: null });
    return null;
  }
}
