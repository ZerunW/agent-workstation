/**
 * Parsers for git's machine-readable, NUL-terminated (`-z`) outputs.
 * All paths are raw bytes decoded as UTF-8 (we always run with
 * `core.quotepath=false`, so nothing is C-quoted).
 */
import { ZERO_OID } from "./hash.js";

function splitNul(buf: Buffer | string): string[] {
  const s = typeof buf === "string" ? buf : buf.toString("utf8");
  const parts = s.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Split off the first `n` space-separated fields; the remainder (which may contain spaces) is returned last. */
function fields(token: string, n: number): [string[], string] {
  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const sp = token.indexOf(" ", pos);
    if (sp < 0) throw new Error(`malformed porcelain line: ${JSON.stringify(token)}`);
    out.push(token.slice(pos, sp));
    pos = sp + 1;
  }
  return [out, token.slice(pos)];
}

// ---------------------------------------------------------------------------
// git status --porcelain=v2 -z
// ---------------------------------------------------------------------------

interface TrackedBase {
  /** Two-letter status: X = HEAD vs index, Y = index vs work tree; "." = unchanged. */
  xy: string;
  sub: string;
  modeHead: number;
  modeIndex: number;
  modeWorktree: number;
  oidHead: string;
  oidIndex: string;
  path: string;
}

export type PorcelainEntry =
  | ({ kind: "ordinary" } & TrackedBase)
  | ({ kind: "renamed"; score: string; origPath: string } & TrackedBase)
  | { kind: "unmerged"; xy: string; sub: string; path: string }
  | { kind: "untracked"; path: string }
  | { kind: "ignored"; path: string }
  | { kind: "header"; text: string };

export function parsePorcelainV2(buf: Buffer | string): PorcelainEntry[] {
  const tokens = splitNul(buf);
  const out: PorcelainEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t[0]) {
      case "1": {
        const [f, path] = fields(t, 8);
        out.push({
          kind: "ordinary",
          xy: f[1]!,
          sub: f[2]!,
          modeHead: parseInt(f[3]!, 8),
          modeIndex: parseInt(f[4]!, 8),
          modeWorktree: parseInt(f[5]!, 8),
          oidHead: f[6]!,
          oidIndex: f[7]!,
          path,
        });
        break;
      }
      case "2": {
        const [f, path] = fields(t, 9);
        const origPath = tokens[++i];
        if (origPath === undefined) throw new Error("porcelain v2: rename entry without original path");
        out.push({
          kind: "renamed",
          xy: f[1]!,
          sub: f[2]!,
          modeHead: parseInt(f[3]!, 8),
          modeIndex: parseInt(f[4]!, 8),
          modeWorktree: parseInt(f[5]!, 8),
          oidHead: f[6]!,
          oidIndex: f[7]!,
          score: f[8]!,
          path,
          origPath,
        });
        break;
      }
      case "u": {
        const [f, path] = fields(t, 10);
        out.push({ kind: "unmerged", xy: f[1]!, sub: f[2]!, path });
        break;
      }
      case "?":
        out.push({ kind: "untracked", path: t.slice(2) });
        break;
      case "!":
        out.push({ kind: "ignored", path: t.slice(2) });
        break;
      case "#":
        out.push({ kind: "header", text: t.slice(2) });
        break;
      default:
        throw new Error(`unknown porcelain v2 entry: ${JSON.stringify(t)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change records (what the review is built from)
// ---------------------------------------------------------------------------

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "typechange";

export interface ChangeRecord {
  path: string;
  /** Set for renames. */
  oldPath?: string;
  status: ChangeStatus;
  /** git mode on the `local` side (0 when absent). */
  oldMode: number;
  /** git mode on the work-tree side (0 when absent / unknown). */
  newMode: number;
  oldOid: string | null;
  /** Blob of the work-tree content as staged in the temp index (null when deleted or not staged). */
  newOid: string | null;
  /** In the work tree but not staged (too large to stage, or unreadable). */
  unstaged?: boolean;
}

const realOid = (oid: string): string | null => (oid && oid !== ZERO_OID ? oid : null);

/**
 * Convert porcelain entries (taken after the work tree was staged into a temp
 * index, so changes are in the X column) into change records. Falls back to
 * the Y column for anything that could not be staged.
 */
export function porcelainToChanges(entries: readonly PorcelainEntry[]): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  for (const e of entries) {
    if (e.kind === "header" || e.kind === "ignored") continue;
    if (e.kind === "untracked") {
      if (e.path.endsWith("/")) continue; // nested repository
      out.push({ path: e.path, status: "added", oldMode: 0, newMode: 0, oldOid: null, newOid: null, unstaged: true });
      continue;
    }
    if (e.kind === "unmerged") {
      out.push({ path: e.path, status: "modified", oldMode: 0, newMode: 0, oldOid: null, newOid: null, unstaged: true });
      continue;
    }
    const x = e.xy[0] ?? ".";
    const y = e.xy[1] ?? ".";
    const staged = x !== ".";
    if (e.kind === "renamed") {
      if (x === "C") {
        out.push({ path: e.path, status: "added", oldMode: 0, newMode: e.modeIndex, oldOid: null, newOid: realOid(e.oidIndex) });
      } else {
        out.push({
          path: e.path,
          oldPath: e.origPath,
          status: "renamed",
          oldMode: e.modeHead,
          newMode: e.modeIndex,
          oldOid: realOid(e.oidHead),
          newOid: realOid(e.oidIndex),
        });
      }
      continue;
    }
    const code = staged ? x : y;
    const rec: ChangeRecord = {
      path: e.path,
      status: "modified",
      oldMode: e.modeHead,
      newMode: staged ? e.modeIndex : e.modeWorktree,
      oldOid: realOid(e.oidHead),
      newOid: staged ? realOid(e.oidIndex) : null,
    };
    if (!staged) rec.unstaged = true;
    switch (code) {
      case "A":
        rec.status = "added";
        rec.oldMode = 0;
        rec.oldOid = null;
        break;
      case "D":
        rec.status = "deleted";
        rec.newMode = 0;
        rec.newOid = null;
        delete rec.unstaged;
        break;
      case "T":
        rec.status = "typechange";
        break;
      case "M":
        rec.status = "modified";
        break;
      default:
        continue;
    }
    out.push(rec);
  }
  return out;
}

/**
 * Pair a deleted path with an added path whose blob is byte-identical
 * (same object id, same file type) into a single rename. git's own rename
 * detection already pairs similar files; this catches exact renames it skipped
 * (rename limit, or input that came from a source without rename detection).
 * Deterministic: candidates are matched in path order. Output is sorted by path.
 */
export function pairRenames(records: readonly ChangeRecord[]): ChangeRecord[] {
  const kind = (mode: number): number => mode & 0o170000;
  const deletedByOid = new Map<string, ChangeRecord[]>();
  const sorted = [...records].sort((a, b) => cmp(a.path, b.path));
  for (const r of sorted) {
    if (r.status === "deleted" && r.oldOid) {
      const list = deletedByOid.get(r.oldOid) ?? [];
      list.push(r);
      deletedByOid.set(r.oldOid, list);
    }
  }
  const consumed = new Set<ChangeRecord>();
  const renamed: ChangeRecord[] = [];
  for (const a of sorted) {
    if (a.status !== "added" || !a.newOid || a.unstaged) continue;
    const list = deletedByOid.get(a.newOid);
    if (!list) continue;
    const idx = list.findIndex((d) => !consumed.has(d) && kind(d.oldMode) === kind(a.newMode));
    if (idx < 0) continue;
    const d = list[idx]!;
    consumed.add(d);
    consumed.add(a);
    renamed.push({ path: a.path, oldPath: d.path, status: "renamed", oldMode: d.oldMode, newMode: a.newMode, oldOid: d.oldOid, newOid: a.newOid });
  }
  return [...sorted.filter((r) => !consumed.has(r)), ...renamed].sort((a, b) => cmp(a.path, b.path));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// git diff --numstat -z
// ---------------------------------------------------------------------------

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export function parseNumstatZ(buf: Buffer | string): NumstatEntry[] {
  const tokens = splitNul(buf);
  const out: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const t1 = t.indexOf("\t");
    const t2 = t1 < 0 ? -1 : t.indexOf("\t", t1 + 1);
    if (t1 < 0 || t2 < 0) throw new Error(`malformed numstat entry: ${JSON.stringify(t)}`);
    const a = t.slice(0, t1);
    const d = t.slice(t1 + 1, t2);
    const binary = a === "-" || d === "-";
    const rest = t.slice(t2 + 1);
    const entry: NumstatEntry = { path: rest, additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary };
    if (rest === "") {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      if (oldPath === undefined || newPath === undefined) throw new Error("numstat: rename entry truncated");
      entry.oldPath = oldPath;
      entry.path = newPath;
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// git ls-tree -r -z / git ls-files -s -z
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: number;
  type: string;
  oid: string;
  path: string;
}

/** `<mode> SP <type> SP <oid> TAB <path>` */
export function parseLsTreeZ(buf: Buffer | string): TreeEntry[] {
  return splitNul(buf).map((t) => {
    const tab = t.indexOf("\t");
    const [mode, type, oid] = t.slice(0, tab).split(" ");
    return { mode: parseInt(mode!, 8), type: type!, oid: oid!, path: t.slice(tab + 1) };
  });
}

/** `<mode> SP <oid> SP <stage> TAB <path>` */
export function parseLsFilesStageZ(buf: Buffer | string): TreeEntry[] {
  return splitNul(buf).map((t) => {
    const tab = t.indexOf("\t");
    const [mode, oid] = t.slice(0, tab).split(" ");
    const m = parseInt(mode!, 8);
    return { mode: m, type: (m & 0o170000) === 0o160000 ? "commit" : "blob", oid: oid!, path: t.slice(tab + 1) };
  });
}

export { splitNul };
