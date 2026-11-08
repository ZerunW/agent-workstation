/**
 * Token-usage reports built from the `turns` table.
 * SQL aggregates by UTC hour; this module re-buckets into the hub's local
 * time (hours for "today", days for "7d"/"30d") so a "day" matches the
 * server's local calendar. Bucket keys are ISO timestamps of the bucket start.
 */
import type { TokenUsageBucket } from "@agent-workstation/protocol";
import type { Store } from "../db/store.js";

export type UsageRangeName = "today" | "7d" | "30d";

export const WEEK_MS = 7 * 24 * 3600_000;

export function rangeStart(range: UsageRangeName, now: Date): Date {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "today") return midnight;
  const days = range === "7d" ? 6 : 29;
  return new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - days);
}

function bucketKey(utcHour: string, range: UsageRangeName): string {
  const d = new Date(`${utcHour}:00:00.000Z`);
  if (range === "today") return d.toISOString();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}

/** A usage bucket with the user it belongs to. */
export type UserBucket = TokenUsageBucket & { user: string };

/** Buckets per (time, user, model). */
export function usageBuckets(store: Store, range: UsageRangeName, user: string | null, now: Date = new Date()): UserBucket[] {
  const since = rangeStart(range, now);
  // Query from the UTC hour containing the local start so partial hours are included.
  const sinceIso = new Date(Math.floor(since.getTime() / 3600_000) * 3600_000).toISOString();
  const rows = store.usageByHour(sinceIso, user);
  const map = new Map<string, UserBucket>();
  for (const r of rows) {
    const bucket = bucketKey(r.bucket, range);
    if (bucket < since.toISOString() && range !== "today") continue;
    const key = `${bucket}|${r.user}|${r.model}`;
    const cur = map.get(key) ?? { bucket, user: r.user, model: r.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0, turns: 0 };
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.cacheReadTokens += r.cacheReadTokens;
    cur.cacheCreateTokens += r.cacheCreateTokens;
    cur.costUsd += r.costUsd;
    cur.turns += r.turns;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : a.user < b.user ? -1 : 1));
}

/** Rolling 7-day input+output tokens. */
export function weeklyTokens(store: Store, user: string, now: Date = new Date()): number {
  return store.tokensSince(user, new Date(now.getTime() - WEEK_MS).toISOString());
}
