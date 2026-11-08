/** Directory listing and file preview, confined to a user root. */
import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileEntry } from "@agent-workstation/protocol";
import { badRequest } from "../util/errors.js";
import { isProbablyText, mediaTypeFor } from "./mime.js";
import { BROWSER_DIRNAME, resolveInRoot } from "./paths.js";

export const MAX_TREE_ENTRIES = 5000;
export const MAX_PREVIEW_BYTES = 1024 * 1024;
const HIDDEN = new Set([".DS_Store"]);

function entryOf(rel: string, name: string, st: { isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtime: Date }): FileEntry {
  const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
  return { path: rel, name, kind, size: kind === "file" ? st.size : 0, mtime: st.mtime.toISOString() };
}

/** Hidden from listings: the top-level `.sync/` review repos and `.browser/` (browser profile), and every `.claude/skills` folder. */
export function hiddenFromTree(rel: string): boolean {
  const parts = rel.split("/");
  if (parts[0] === ".sync" || parts[0] === BROWSER_DIRNAME) return true;
  for (let i = 0; i + 1 < parts.length; i++) if (parts[i] === ".claude" && parts[i + 1] === "skills") return true;
  return false;
}

/** Flat depth-first listing (dirs first, then files, by name). */
export async function listTree(root: string, relInput: string, depth: number, maxEntries = MAX_TREE_ENTRIES): Promise<FileEntry[]> {
  const base = await resolveInRoot(root, relInput, { allowRoot: true, mustExist: true });
  const st = await lstat(base.abs);
  if (!st.isDirectory()) {
    const name = base.rel.split("/").pop() ?? base.rel;
    return [entryOf(base.rel, name, st)];
  }
  const out: FileEntry[] = [];
  const walk = async (abs: string, rel: string, level: number): Promise<void> => {
    if (out.length >= maxEntries) return;
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const items = dirents
      .filter((d) => !HIDDEN.has(d.name))
      .sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad - bd || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
    for (const d of items) {
      if (out.length >= maxEntries) return;
      const childAbs = join(abs, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (hiddenFromTree(childRel)) continue;
      let cst;
      try {
        cst = await lstat(childAbs);
      } catch {
        continue;
      }
      out.push(entryOf(childRel, d.name, cst));
      if (cst.isDirectory() && level < depth) await walk(childAbs, childRel, level + 1);
    }
  };
  await walk(base.abs, base.rel, 1);
  return out;
}

export interface FileContent {
  path: string;
  size: number;
  truncated: boolean;
  text: string | null;
  mediaType: string;
}

/** Text preview (first MAX_PREVIEW_BYTES) or null text for binaries. */
export async function readContent(root: string, relInput: string): Promise<FileContent> {
  const r = await resolveInRoot(root, relInput, { mustExist: true });
  const st = await stat(r.abs);
  if (!st.isFile()) throw badRequest("invalid_request", `${r.rel} is not a file`);
  const mediaType = mediaTypeFor(r.abs);
  const len = Math.min(st.size, MAX_PREVIEW_BYTES);
  const chunks: Buffer[] = [];
  if (len > 0) {
    await new Promise<void>((resolve, reject) => {
      createReadStream(r.abs, { start: 0, end: len - 1 })
        .on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c))
        .on("end", () => resolve())
        .on("error", reject);
    });
  }
  const buf = Buffer.concat(chunks);
  const looksText = isProbablyText(buf) && !/^(image|audio|video)\//.test(mediaType) && mediaType !== "application/pdf" && mediaType !== "application/zip";
  return {
    path: r.rel,
    size: st.size,
    truncated: st.size > len,
    text: looksText ? buf.toString("utf8") : null,
    mediaType: looksText && mediaType === "application/octet-stream" ? "text/plain" : mediaType,
  };
}
