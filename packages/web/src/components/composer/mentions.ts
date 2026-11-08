import type { FileEntry } from "@agent-workstation/protocol";
import { api } from "../../lib/api";
import { fuzzyMatch } from "../../lib/fuzzy";

const TTL_MS = 20_000;
let cache: { at: number; entries: FileEntry[]; user: string | null; cwd: string } | null = null;
let inflight: { cwd: string; user: string | null; promise: Promise<FileEntry[]> } | null = null;

/** Re-root workspace-relative entries at `cwd`; entries outside it are dropped. */
function relativeTo(entries: readonly FileEntry[], cwd: string): FileEntry[] {
  if (!cwd) return [...entries];
  const prefix = `${cwd}/`;
  const out: FileEntry[] = [];
  for (const e of entries) if (e.path.startsWith(prefix)) out.push({ ...e, path: e.path.slice(prefix.length) });
  return out;
}

/**
 * Flat, recursive (depth 3) listing used for `@` completion, rooted at `cwd` (workspace-relative, "" = whole
 * workspace) with paths relative to it. Cached briefly; failures yield [].
 */
export async function loadMentionIndex(user: string | null, cwd = "", force = false): Promise<FileEntry[]> {
  if (!force && cache && cache.user === user && cache.cwd === cwd && Date.now() - cache.at < TTL_MS) return cache.entries;
  if (inflight && inflight.cwd === cwd && inflight.user === user) return inflight.promise;
  const promise: Promise<FileEntry[]> = api
    .filesTree(cwd, 3)
    .then((entries) => {
      const rel = relativeTo(entries, cwd).slice(0, 8000);
      cache = { at: Date.now(), entries: rel, user, cwd };
      return rel;
    })
    .catch(() => (cache && cache.user === user && cache.cwd === cwd ? cache.entries : []))
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { cwd, user, promise };
  return promise;
}

export function resetMentionIndex(): void {
  cache = null;
}

export interface MentionMatch {
  entry: FileEntry;
  indexes: number[];
}

/** Rank workspace entries for the text after `@`. Empty query lists the top level. */
export function filterMentions(entries: readonly FileEntry[], query: string, limit = 12): MentionMatch[] {
  const q = query.replace(/^\.?\//, "");
  if (!q) {
    return entries
      .filter((e) => !e.path.includes("/"))
      .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "dir" ? -1 : 1))
      .slice(0, limit)
      .map((entry) => ({ entry, indexes: [] }));
  }
  const out: Array<MentionMatch & { score: number }> = [];
  for (const entry of entries) {
    const m = fuzzyMatch(q, entry.path);
    if (!m) continue;
    // prefer shallow paths and files whose basename matches
    const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const baseHit = fuzzyMatch(q, base);
    const depth = entry.path.split("/").length;
    out.push({ entry, indexes: m.indexes, score: m.score + (baseHit ? 40 + baseHit.score * 0.2 : 0) - depth * 2 + (entry.kind === "dir" ? 3 : 0) });
  }
  out.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  return out.slice(0, limit);
}

/** Text to insert for a picked entry (directories keep the palette open with a trailing slash). */
export function mentionInsertText(entry: FileEntry): string {
  return entry.kind === "dir" ? `@${entry.path}/` : `@${entry.path} `;
}
