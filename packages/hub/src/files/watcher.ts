/**
 * chokidar watcher per user root, started while the user has at least one
 * WebSocket connection (and kept for a linger period after the last one
 * closes). Events are coalesced every 250 ms and broadcast as `file_event`,
 * tagged with the session whose turn is currently running for that user.
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { Logger } from "../util/log.js";
import { iso } from "../util/time.js";
import type { Broadcaster } from "../ws/protocol.js";
import { BROWSER_DIRNAME, toRelPath } from "./paths.js";

export type FileEventKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir";
const KINDS = new Set<string>(["add", "change", "unlink", "addDir", "unlinkDir"]);
const IGNORED_DIRS = new Set(["node_modules", ".git", ".chat"]);
const MAX_EVENTS_PER_FLUSH = 300;

/**
 * Paths the watcher (and the file tree) never report: node_modules/.git/.chat
 * anywhere, the review repositories under the top-level `.sync/`, the browser
 * profile under the top-level `.browser/`, and every `.claude/skills` folder
 * (skills have their own API).
 */
export function isIgnoredPath(rel: string): boolean {
  if (!rel) return false;
  const parts = rel.split("/");
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  if (parts[0] === ".sync" || parts[0] === BROWSER_DIRNAME) return true;
  for (let i = 0; i + 1 < parts.length; i++) if (parts[i] === ".claude" && parts[i + 1] === "skills") return true;
  return basename(rel) === ".DS_Store";
}

interface Entry {
  watcher: FSWatcher;
  refs: number;
  linger: NodeJS.Timeout | null;
  rootReal: string;
  buffer: Map<string, FileEventKind>;
  flushTimer: NodeJS.Timeout | null;
}

export interface WatcherDeps {
  userRoot: (user: string) => string;
  bus: Broadcaster;
  log: Logger;
  sessionFor: (user: string, rel: string) => string | null;
  /** Every coalesced batch of changed paths (projects use it to trigger review_changed). */
  onPaths?: (user: string, rels: string[]) => void;
  lingerMs?: number;
  flushMs?: number;
  /** chokidar polling, for tests on filesystems without native events. */
  usePolling?: boolean;
}

export class WatcherHub {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: WatcherDeps) {}

  acquire(user: string): void {
    const existing = this.entries.get(user);
    if (existing) {
      existing.refs++;
      if (existing.linger) {
        clearTimeout(existing.linger);
        existing.linger = null;
      }
      return;
    }
    let rootReal: string;
    try {
      rootReal = realpathSync(this.deps.userRoot(user));
    } catch (err) {
      this.deps.log.warn({ user, err: String(err) }, "cannot watch user root");
      return;
    }
    const watcher = watch(rootReal, {
      ignoreInitial: true,
      followSymlinks: false,
      persistent: true,
      usePolling: this.deps.usePolling ?? false,
      interval: 200,
      ignored: (p: string) => {
        const rel = toRelPath(rootReal, p);
        return rel === null ? true : isIgnoredPath(rel);
      },
    });
    const entry: Entry = { watcher, refs: 1, linger: null, rootReal, buffer: new Map(), flushTimer: null };
    watcher.on("all", (event: string, path: string) => {
      if (!KINDS.has(event)) return;
      const rel = toRelPath(rootReal, path);
      if (!rel) return;
      entry.buffer.set(rel, event as FileEventKind);
      if (!entry.flushTimer) {
        entry.flushTimer = setTimeout(() => this.flush(user, entry), this.deps.flushMs ?? 250);
        entry.flushTimer.unref?.();
      }
    });
    watcher.on("error", (err: unknown) => this.deps.log.warn({ user, err: String(err) }, "file watcher error"));
    this.entries.set(user, entry);
  }

  release(user: string): void {
    const e = this.entries.get(user);
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs > 0 || e.linger) return;
    e.linger = setTimeout(() => {
      if (e.refs === 0) void this.close(user);
    }, this.deps.lingerMs ?? 5 * 60_000);
    e.linger.unref?.();
  }

  /** Stops watching a user's root now (the user is being deleted). */
  async forget(user: string): Promise<void> {
    await this.close(user);
  }

  isWatching(user: string): boolean {
    return this.entries.has(user);
  }

  private flush(user: string, e: Entry): void {
    e.flushTimer = null;
    const at = iso();
    let n = 0;
    for (const [rel, kind] of e.buffer) {
      if (n++ >= MAX_EVENTS_PER_FLUSH) break;
      this.deps.bus.toUser(user, { type: "file_event", path: rel, kind, sessionId: this.deps.sessionFor(user, rel), at });
    }
    const rels = [...e.buffer.keys()];
    e.buffer.clear();
    if (this.deps.onPaths) {
      try {
        this.deps.onPaths(user, rels);
      } catch (err) {
        this.deps.log.warn({ user, err: String(err) }, "watcher onPaths failed");
      }
    }
  }

  private async close(user: string): Promise<void> {
    const e = this.entries.get(user);
    if (!e) return;
    this.entries.delete(user);
    if (e.flushTimer) clearTimeout(e.flushTimer);
    if (e.linger) clearTimeout(e.linger);
    await e.watcher.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((u) => this.close(u)));
  }
}

