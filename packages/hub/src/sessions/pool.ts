/**
 * Process-slot pool. Sessions are unlimited (rows in SQLite); what is limited
 * is the number of live Claude Code processes:
 *   - at most `max()` at once, and
 *   - no new process while MemAvailable < `minFreeMiB()`.
 * When either limit is hit the pool first asks the owner to reclaim an idle
 * process (never one in the middle of a turn); if none can be reclaimed the
 * request waits in a FIFO queue whose positions are reported to the UI.
 *
 * Slots are identified by a token rather than by session id so that a late
 * `release()` from an old process can never free the slot of its successor.
 */
import type { Logger } from "../util/log.js";

export interface PoolOptions {
  max: () => number;
  minFreeMiB: () => number;
  memAvailableMiB: () => number;
  /**
   * Close one idle process, other than `exceptOwner`'s, and release its slot
   * synchronously. Returns true when a slot was freed.
   */
  reclaimIdle: (exceptOwner: string) => boolean;
  /** Called whenever queue membership or order changes. */
  onQueueChanged?: (owners: string[]) => void;
  log?: Logger;
  /** How often waiters are re-checked (memory can free up without a release). */
  pumpIntervalMs?: number;
}

interface Waiter {
  owner: string;
  grant: (token: number) => void;
}

export type BlockReason = "max" | "memory";

export class ProcessPool {
  private readonly active = new Map<number, string>();
  private readonly waiters: Waiter[] = [];
  private nextToken = 1;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: PoolOptions) {}

  get activeCount(): number {
    return this.active.size;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  activeOwners(): string[] {
    return [...this.active.values()];
  }

  queuedOwners(): string[] {
    return this.waiters.map((w) => w.owner);
  }

  /** Why a new process cannot start right now, or null if it can. */
  blockReason(): BlockReason | null {
    if (this.active.size >= this.opts.max()) return "max";
    if (this.opts.memAvailableMiB() < this.opts.minFreeMiB()) return "memory";
    return null;
  }

  /**
   * Takes a slot immediately if possible (reclaiming an idle process if
   * needed). Returns null when the caller must queue. New requests never
   * overtake existing waiters.
   */
  tryAcquire(owner: string): number | null {
    if (this.waiters.length > 0 && this.waiters[0]!.owner !== owner) return null;
    return this.acquireNow(owner);
  }

  enqueue(owner: string, grant: (token: number) => void): number {
    const existing = this.waiters.findIndex((w) => w.owner === owner);
    if (existing >= 0) {
      this.waiters[existing]!.grant = grant;
      return existing + 1;
    }
    this.waiters.push({ owner, grant });
    this.opts.log?.info({ owner, position: this.waiters.length, reason: this.blockReason() }, "process slot queued");
    this.changed();
    this.ensureTimer();
    return this.waiters.length;
  }

  cancel(owner: string): boolean {
    const i = this.waiters.findIndex((w) => w.owner === owner);
    if (i < 0) return false;
    this.waiters.splice(i, 1);
    this.changed();
    return true;
  }

  position(owner: string): number | null {
    const i = this.waiters.findIndex((w) => w.owner === owner);
    return i < 0 ? null : i + 1;
  }

  /** Idempotent. */
  release(token: number): void {
    if (!this.active.delete(token)) return;
    this.pump();
  }

  /** Grants slots to waiters while capacity allows. */
  pump(): void {
    let granted = false;
    while (this.waiters.length > 0) {
      const w = this.waiters[0]!;
      const token = this.acquireNow(w.owner);
      if (token === null) break;
      this.waiters.shift();
      granted = true;
      try {
        w.grant(token);
      } catch (err) {
        this.opts.log?.error({ err, owner: w.owner }, "slot grant callback failed");
        this.release(token);
      }
    }
    if (granted) this.changed();
    if (this.waiters.length === 0) this.stopTimer();
  }

  dispose(): void {
    this.stopTimer();
    this.waiters.length = 0;
  }

  private acquireNow(owner: string): number | null {
    const reason = this.blockReason();
    if (reason === null) return this.take(owner);
    // Swap an idle process for this one: net process count is unchanged, so
    // this is allowed even when the memory gate is what blocked us.
    if (this.opts.reclaimIdle(owner)) {
      const after = this.blockReason();
      if (after === null || after === "memory") return this.take(owner);
    }
    return null;
  }

  private take(owner: string): number {
    const token = this.nextToken++;
    this.active.set(token, owner);
    return token;
  }

  private changed(): void {
    this.opts.onQueueChanged?.(this.queuedOwners());
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), this.opts.pumpIntervalMs ?? 5000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
