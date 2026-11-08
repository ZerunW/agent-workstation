/**
 * Disk monitor for the filesystem holding `users_root`.
 *   level ok    < warn%
 *   level warn  ≥ warn%   (UI nags users to pull data back and delete it themselves)
 *   level block ≥ block%  (read-only protection: no new turns, no uploads)
 * It is checked every 60 s; `disk_status` is broadcast on level changes (and
 * sent to each client on connect). Per-user breakdowns come from `du`,
 * cached for a few minutes.
 *
 * Iron rule: this module only measures. The hub never deletes user data on
 * its own — no expiry, no cleanup timers.
 */
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type { DiskLevel, DiskStatus } from "@agent-workstation/protocol";
import type { Store } from "../db/store.js";
import type { Logger } from "../util/log.js";
import type { Broadcaster } from "../ws/protocol.js";
import { transcriptPaths } from "../sessions/claudeFiles.js";

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export type StatFsFn = (path: string) => Promise<DiskUsage>;
export type DuFn = (paths: string[]) => Promise<Map<string, number>>;

export const realStatFs: StatFsFn = async (path) => {
  const s = await statfs(path);
  const bsize = Number(s.bsize);
  const blocks = Number(s.blocks);
  const bfree = Number(s.bfree);
  const bavail = Number(s.bavail);
  const used = blocks - bfree;
  const denom = used + bavail;
  return {
    totalBytes: blocks * bsize,
    freeBytes: bavail * bsize,
    usedPercent: denom > 0 ? Math.round((used / denom) * 1000) / 10 : 0,
  };
};

/** `du -sk` on many paths at once; missing paths are reported as 0. */
export const realDu: DuFn = (paths) =>
  new Promise((resolve) => {
    const out = new Map<string, number>(paths.map((p) => [p, 0]));
    if (!paths.length) return resolve(out);
    execFile("du", ["-sk", ...paths], { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 }, (_err, stdout) => {
      for (const line of String(stdout ?? "").split("\n")) {
        const m = /^(\d+)\s+(.+)$/.exec(line);
        if (m && out.has(m[2]!)) out.set(m[2]!, Number(m[1]) * 1024);
      }
      resolve(out);
    });
  });

export function diskLevel(usedPercent: number, warnPercent: number, blockPercent: number): DiskLevel {
  if (usedPercent >= blockPercent) return "block";
  if (usedPercent >= warnPercent) return "warn";
  return "ok";
}

type BreakdownEntry = DiskStatus["breakdown"][number];
type ProjectEntry = DiskStatus["projects"][number];

export interface DiskMonitorDeps {
  usersRoot: string;
  claudeHome: string;
  store: Store;
  bus: Broadcaster;
  log: Logger;
  thresholds: () => { warn: number; block: number };
  /** Users to include in admin breakdowns. */
  listUsers: () => string[];
  isAdmin: (user: string) => boolean;
  /** Per-project pending/undownloaded counts and sizes, keyed by user (refreshed with the breakdown). */
  projectStats?: () => Promise<Map<string, ProjectEntry[]>>;
  statfs?: StatFsFn;
  du?: DuFn;
  intervalMs?: number;
  breakdownTtlMs?: number;
}

export class DiskMonitor {
  private usage: DiskUsage = { totalBytes: 0, freeBytes: 0, usedPercent: 0 };
  private levelValue: DiskLevel = "ok";
  private timer: NodeJS.Timeout | null = null;
  private breakdown = new Map<string, BreakdownEntry[]>();
  private projects = new Map<string, ProjectEntry[]>();
  private breakdownAt = 0;
  private breakdownInflight: Promise<void> | null = null;
  private checkedOnce = false;

  constructor(private readonly deps: DiskMonitorDeps) {}

  get level(): DiskLevel {
    return this.levelValue;
  }

  current(): DiskUsage & { level: DiskLevel } {
    return { ...this.usage, level: this.levelValue };
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-reads usage; broadcasts when the level changed. Returns the new level. */
  async check(): Promise<DiskLevel> {
    try {
      this.usage = await (this.deps.statfs ?? realStatFs)(this.deps.usersRoot);
    } catch (err) {
      this.deps.log.warn({ err: String(err) }, "statfs failed");
      return this.levelValue;
    }
    const t = this.deps.thresholds();
    const next = diskLevel(this.usage.usedPercent, t.warn, t.block);
    const prev = this.levelValue;
    this.levelValue = next;
    if (next !== prev || !this.checkedOnce) {
      if (this.checkedOnce || next !== "ok") this.deps.log.info({ from: prev, to: next, usedPercent: this.usage.usedPercent }, "disk level");
      if (this.checkedOnce) this.broadcast();
    }
    this.checkedOnce = true;
    return next;
  }

  /** Re-evaluates the level after thresholds changed. */
  async thresholdsChanged(): Promise<void> {
    await this.check();
  }

  broadcast(): void {
    this.deps.bus.toEachUser((user) => ({ type: "disk_status", status: this.statusFor(user) }));
  }

  /** Synchronous status with the cached breakdown (refreshed in the background when stale). */
  statusFor(user: string): DiskStatus {
    if (Date.now() - this.breakdownAt > (this.deps.breakdownTtlMs ?? 5 * 60_000)) void this.refreshBreakdown();
    const t = this.deps.thresholds();
    const admin = this.deps.isAdmin(user);
    const users = admin ? [...this.breakdown.keys()] : [user];
    const breakdown: BreakdownEntry[] = [];
    for (const u of users) breakdown.push(...(this.breakdown.get(u) ?? []));
    const projects: ProjectEntry[] = [];
    for (const u of admin ? [...this.projects.keys()].sort() : [user]) projects.push(...(this.projects.get(u) ?? []));
    return {
      level: this.levelValue,
      usedPercent: this.usage.usedPercent,
      totalBytes: this.usage.totalBytes,
      freeBytes: this.usage.freeBytes,
      warnPercent: t.warn,
      blockPercent: t.block,
      breakdown,
      projects,
    };
  }

  /** Status with a fresh-enough breakdown (awaits `du` when the cache is cold). */
  async statusForFresh(user: string): Promise<DiskStatus> {
    if (!this.checkedOnce) await this.check();
    if (Date.now() - this.breakdownAt > 2 * 60_000) await this.refreshBreakdown();
    return this.statusFor(user);
  }

  refreshBreakdown(): Promise<void> {
    if (this.breakdownInflight) return this.breakdownInflight;
    this.breakdownInflight = (async () => {
      const users = this.deps.listUsers();
      const du = this.deps.du ?? realDu;
      const paths: string[] = [];
      const plan: { user: string; label: string; path: string; abs: string[] }[] = [];
      for (const u of users) {
        const root = join(this.deps.usersRoot, u);
        for (const [label, rel] of [
          ["Inbox", "inbox"],
          ["Projects", "projects"],
          ["Project history", ".sync"],
          ["Chat", ".chat"],
        ] as const) {
          const abs = join(root, rel);
          paths.push(abs);
          plan.push({ user: u, label, path: rel, abs: [abs] });
        }
        const ids = new Set(this.deps.store.claudeSessionIdsForUser(u));
        const tp = await transcriptPaths(this.deps.claudeHome, ids);
        paths.push(...tp);
        plan.push({ user: u, label: "Claude transcripts", path: "~/.claude/projects", abs: tp });
      }
      const sizes = await du(paths);
      const next = new Map<string, BreakdownEntry[]>();
      for (const p of plan) {
        const bytes = p.abs.reduce((s, a) => s + (sizes.get(a) ?? 0), 0);
        const list = next.get(p.user) ?? [];
        list.push({ label: p.label, user: p.user, path: p.path, bytes });
        next.set(p.user, list);
      }
      this.breakdown = next;
      if (this.deps.projectStats) {
        try {
          this.projects = await this.deps.projectStats();
        } catch (err) {
          this.deps.log.warn({ err: String(err) }, "project disk stats failed");
        }
      }
      this.breakdownAt = Date.now();
    })()
      .catch((err) => this.deps.log.warn({ err: String(err) }, "disk breakdown failed"))
      .finally(() => (this.breakdownInflight = null));
    return this.breakdownInflight;
  }
}
