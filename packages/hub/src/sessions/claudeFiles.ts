/**
 * Claude Code's own files under ~/.claude (or $CLAUDE_CONFIG_DIR):
 *   settings.json                         — we ensure cleanupPeriodDays so Claude never ages out transcripts
 *   projects/<encoded-cwd>/<id>.jsonl     — session transcripts
 *   projects/<encoded-cwd>/<id>/          — subagent transcripts / tool results of that session
 *
 * Iron rule: the hub only deletes these when a user explicitly deletes the
 * session that owns them.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../util/log.js";

export const RETENTION_DAYS = 36500;

/** Claude's project-dir encoding of a cwd. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Sets cleanupPeriodDays in settings.json if absent. Merges; never clobbers other keys or a file it cannot parse. */
export async function ensureTranscriptRetention(claudeHome: string, log: Logger): Promise<"set" | "present" | "skipped"> {
  const file = join(claudeHome, "settings.json");
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        log.warn({ file }, "settings.json is not an object; not touching it");
        return "skipped";
      }
      data = parsed as Record<string, unknown>;
    } catch (err) {
      log.warn({ file, err: String(err) }, "settings.json is not valid JSON; not touching it");
      return "skipped";
    }
  }
  if (data.cleanupPeriodDays !== undefined) return "present";
  data.cleanupPeriodDays = RETENTION_DAYS;
  await mkdir(claudeHome, { recursive: true });
  const tmp = `${file}.workstation-${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, file);
  log.info({ file }, `set cleanupPeriodDays=${RETENTION_DAYS} so Claude keeps transcripts`);
  return "set";
}

async function listProjectDirs(claudeHome: string): Promise<string[]> {
  const root = join(claudeHome, "projects");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

/** Deletes `<id>.jsonl` and `<id>/` in every project dir. Only call on explicit user delete. */
export async function deleteTranscripts(claudeHome: string, ids: string[], log: Logger): Promise<string[]> {
  const safe = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!safe.length) return [];
  const removed: string[] = [];
  for (const dir of await listProjectDirs(claudeHome)) {
    for (const id of safe) {
      for (const p of [join(dir, `${id}.jsonl`), join(dir, id)]) {
        if (!existsSync(p)) continue;
        await rm(p, { recursive: true, force: true });
        removed.push(p);
      }
    }
  }
  if (removed.length) log.info({ removed }, "deleted Claude transcripts of a user-deleted session");
  return removed;
}

/** Paths (jsonl + per-session dirs) that belong to the given Claude session ids. */
export async function transcriptPaths(claudeHome: string, ids: Set<string>, dirPrefix?: string): Promise<string[]> {
  if (!ids.size) return [];
  const out: string[] = [];
  for (const dir of await listProjectDirs(claudeHome)) {
    if (dirPrefix && !dir.split("/").pop()!.startsWith(dirPrefix)) continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const id = name.endsWith(".jsonl") ? name.slice(0, -6) : name;
      if (ids.has(id)) out.push(join(dir, name));
    }
  }
  return out;
}

export async function fileSize(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}
