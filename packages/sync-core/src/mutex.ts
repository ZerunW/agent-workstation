import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-key async mutex (one key per project).
 *
 * - `withLock(key, fn)` runs `fn` exclusively. It is re-entrant within the same
 *   async call chain: every ProjectRepo method takes the lock itself, so a caller
 *   that already holds it (via `withLock` or `LockHandle.run`) does not deadlock.
 * - `acquireLock(key)` returns a handle for holds that do not fit one function
 *   call — the hub acquires in PreToolUse and releases in PostToolUse so that
 *   sync pushes and review reads never observe a half-written tool result.
 *   Pass `autoReleaseMs` so a lost PostToolUse cannot wedge the project forever.
 */

export interface LockHandle {
  readonly key: string;
  /** Run `fn` as the lock holder (repo methods called inside will not wait). */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Release the lock. Idempotent. */
  release(): void;
  readonly released: boolean;
}

export interface AcquireOptions {
  /** Release automatically after this many milliseconds (guards against a lost release). */
  autoReleaseMs?: number;
  /** Reject if the lock cannot be obtained within this many milliseconds. */
  timeoutMs?: number;
}

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new Map<string, Promise<void>>();
const waiting = new Map<string, number>();

/** True when the current async context already holds `key`. */
export function holdsLock(key: string): boolean {
  return held.getStore()?.has(key) ?? false;
}

/** Number of callers waiting for or holding `key` (diagnostics). */
export function lockQueueLength(key: string): number {
  return waiting.get(key) ?? 0;
}

export async function acquireLock(key: string, opts: AcquireOptions = {}): Promise<LockHandle> {
  const prev = tails.get(key) ?? Promise.resolve();
  let releaseFn!: () => void;
  const mine = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  waiting.set(key, (waiting.get(key) ?? 0) + 1);

  let released = false;
  let timer: NodeJS.Timeout | undefined;
  const release = (acquired = true): void => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    const n = (waiting.get(key) ?? 1) - 1;
    if (n <= 0) waiting.delete(key);
    else waiting.set(key, n);
    // Only a holder may drop the tail: a waiter that gives up must leave it in
    // place, or a newcomer would skip the current holder.
    if (acquired && tails.get(key) === tail) tails.delete(key);
    releaseFn();
  };

  if (opts.timeoutMs !== undefined) {
    let to: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      to = setTimeout(() => resolve("timeout"), opts.timeoutMs);
    });
    const r = await Promise.race([prev.then(() => "ok" as const), timedOut]);
    if (to) clearTimeout(to);
    if (r === "timeout") {
      // Give up our place. `tail` is `prev.then(() => mine)`, so whoever queued
      // behind us still waits for the current holder even though we resolve now.
      release(false);
      throw new Error(`timed out waiting for lock ${key}`);
    }
  } else {
    await prev;
  }

  if (opts.autoReleaseMs !== undefined) {
    timer = setTimeout(release, opts.autoReleaseMs);
    timer.unref?.();
  }

  return {
    key,
    get released() {
      return released;
    },
    run<T>(fn: () => Promise<T> | T): Promise<T> {
      const cur = held.getStore();
      const next = new Set(cur ?? []);
      next.add(key);
      return held.run(next, async () => fn());
    },
    release: () => release(true),
  };
}

export async function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  if (holdsLock(key)) return fn();
  const h = await acquireLock(key);
  try {
    return await h.run(fn);
  } finally {
    h.release();
  }
}
