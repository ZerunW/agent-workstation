/**
 * Workspace path confinement. Every file API resolves client paths through
 * here: relative POSIX paths only, no "..", no NUL, and after resolving
 * symlinks (realpath of the target, or of its nearest existing ancestor for
 * paths about to be created) the result must stay inside the user root.
 */
import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { HttpError } from "../util/errors.js";

export const outside = (detail = "path escapes the workspace") => new HttpError(403, "path_outside_workspace", detail);

/**
 * `<user root>/.browser/`: the server browser's profile (cookies, logins) and its output; owned by the hub account. Hidden
 * from file listings and the watcher, refused by the files API and by the agents' file tools.
 */
export const BROWSER_DIRNAME = ".browser";
export const isBrowserPath = (rel: string): boolean => rel === BROWSER_DIRNAME || rel.startsWith(`${BROWSER_DIRNAME}/`);

/** Normalizes a client path. "" (root) is only allowed with allowRoot. */
export function normalizeRelPath(rel: string, allowRoot = false): string {
  if (typeof rel !== "string") throw new HttpError(400, "invalid_request", "path must be a string");
  if (rel.includes("\0")) throw outside("path contains NUL");
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) throw outside("path must be relative");
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw outside("path must not contain ..");
  const norm = parts.join("/");
  if (!norm && !allowRoot) throw new HttpError(400, "invalid_request", "path must not be empty");
  return norm;
}

function within(rootReal: string, p: string): boolean {
  return p === rootReal || p.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

export interface ResolveOptions {
  allowRoot?: boolean;
  mustExist?: boolean;
  /** Check the parent only, so a symlink itself can be deleted/listed without following it. */
  noFollowLast?: boolean;
}

export interface Resolved {
  /** Absolute path (inside the real user root). */
  abs: string;
  /** Normalized relative path ("" for the root). */
  rel: string;
  exists: boolean;
}

async function nearestExisting(p: string): Promise<string> {
  let cur = p;
  for (;;) {
    try {
      await lstat(cur);
      return cur;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

export async function resolveInRoot(root: string, relInput: string, opts: ResolveOptions = {}): Promise<Resolved> {
  const rel = normalizeRelPath(relInput, opts.allowRoot ?? false);
  const rootReal = await realpath(root);
  const abs = rel ? join(rootReal, ...rel.split("/")) : rootReal;
  let exists = true;
  try {
    await lstat(abs);
  } catch {
    exists = false;
  }
  if (!exists && opts.mustExist) throw new HttpError(404, "not_found", `no such file: ${rel || "/"}`);

  if (exists && !opts.noFollowLast) {
    const real = await realpath(abs).catch(() => null);
    if (real === null) {
      // Dangling symlink: confine by its parent.
      const parentReal = await realpath(dirname(abs));
      if (!within(rootReal, parentReal)) throw outside();
    } else if (!within(rootReal, real)) {
      throw outside("path resolves (via a symlink) outside the workspace");
    }
  } else {
    const anchor = exists ? dirname(abs) : await nearestExisting(dirname(abs));
    const anchorReal = await realpath(anchor);
    if (!within(rootReal, anchorReal)) throw outside();
  }
  return { abs, rel, exists };
}

/** Synchronous variant used where async is awkward (prompt building). */
export function resolveInRootSync(root: string, relInput: string, opts: ResolveOptions = {}): Resolved {
  const rel = normalizeRelPath(relInput, opts.allowRoot ?? false);
  const rootReal = realpathSync(root);
  const abs = rel ? join(rootReal, ...rel.split("/")) : rootReal;
  let exists = true;
  try {
    lstatSync(abs);
  } catch {
    exists = false;
  }
  if (!exists && opts.mustExist) throw new HttpError(404, "not_found", `no such file: ${rel || "/"}`);
  if (exists && !opts.noFollowLast) {
    let real: string | null = null;
    try {
      real = realpathSync(abs);
    } catch {
      real = null;
    }
    if (real === null ? !within(rootReal, realpathSync(dirname(abs))) : !within(rootReal, real)) throw outside();
  } else {
    let anchor = exists ? dirname(abs) : dirname(abs);
    for (;;) {
      try {
        lstatSync(anchor);
        break;
      } catch {
        const parent = dirname(anchor);
        if (parent === anchor) break;
        anchor = parent;
      }
    }
    if (!within(rootReal, realpathSync(anchor))) throw outside();
  }
  return { abs, rel, exists };
}

/** Absolute → relative POSIX path, or null when outside the root. */
export function toRelPath(rootReal: string, abs: string): string | null {
  const r = relative(rootReal, abs);
  if (r === "") return "";
  if (r.startsWith("..") || r.startsWith(sep)) return null;
  return r.split(sep).join("/");
}

/** "a/b/name.ext" → "a/b/name (n).ext" */
export function numberedName(rel: string, n: number): string {
  const dir = dirname(rel);
  const base = basename(rel);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const name = `${stem} (${n})${ext}`;
  return dir === "." ? name : `${dir}/${name}`;
}
