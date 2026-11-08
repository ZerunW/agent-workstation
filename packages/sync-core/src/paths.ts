import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { SyncCoreError } from "./errors.js";

/**
 * Validate a project-relative POSIX path coming from the wire.
 * Rejects absolute paths, `..`, `.`, empty segments, NUL, and any `.git`
 * component (git itself refuses those in the index).
 */
export function assertRelPath(p: unknown): string {
  if (typeof p !== "string" || p.length === 0) throw new SyncCoreError("invalid_path", "path must be a non-empty string");
  if (p.length > 4096) throw new SyncCoreError("invalid_path", "path too long");
  if (p.includes("\0")) throw new SyncCoreError("invalid_path", "path contains NUL");
  if (p.startsWith("/")) throw new SyncCoreError("invalid_path", `path must be relative: ${p}`);
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new SyncCoreError("invalid_path", `invalid path segment in ${JSON.stringify(p)}`);
    if (seg.toLowerCase() === ".git") throw new SyncCoreError("invalid_path", `.git is not allowed in paths: ${p}`);
  }
  return p;
}

export async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await lstat(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

/**
 * Resolve `rel` inside `root`, refusing to traverse symlinks: every existing
 * parent component must be a real directory. The final component may be
 * anything (callers lstat it). Throws `symlink` when a parent is a symlink and
 * `invalid_path` when a parent is a regular file.
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  assertRelPath(rel);
  const segs = rel.split("/");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]!);
    const st = await lstatOrNull(cur);
    if (!st) return path.join(root, ...segs); // the rest does not exist yet
    if (st.isSymbolicLink()) throw new SyncCoreError("symlink", `parent directory is a symlink: ${segs.slice(0, i + 1).join("/")}`);
    if (!st.isDirectory()) throw new SyncCoreError("invalid_path", `parent is not a directory: ${segs.slice(0, i + 1).join("/")}`);
  }
  return path.join(root, ...segs);
}

/** Write via a temp file in the same directory + rename, then set the mode explicitly. */
export async function writeFileAtomic(abs: string, data: Uint8Array, mode: number): Promise<void> {
  const dir = path.dirname(abs);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.workstation-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { mode });
    await chmod(tmp, mode);
    await rename(tmp, abs);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Remove now-empty parent directories of `abs`, stopping at `root` (never recursive). */
export async function pruneEmptyParents(root: string, abs: string): Promise<void> {
  let dir = path.dirname(abs);
  while (dir.length > root.length && dir.startsWith(root + path.sep)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

export function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

/** git tree mode for a regular file with/without the executable bit. */
export function gitFileMode(executable: boolean): number {
  return executable ? 0o100755 : 0o100644;
}

export const GIT_MODE_SYMLINK = 0o120000;
export const GIT_MODE_GITLINK = 0o160000;

export function isSymlinkMode(mode: number): boolean {
  return (mode & 0o170000) === 0o120000;
}

/** True if `child` is `parent` or inside it (both absolute, normalised). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
