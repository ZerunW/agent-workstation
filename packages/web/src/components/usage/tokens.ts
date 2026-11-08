import { formatCost, formatTokens } from "../../lib/format";
import type { BarColumn, BarSeries } from "./StackedBars";
import { seriesVar } from "./useThemeTick";

export interface UsageRow {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  costUsd: number;
  turns?: number;
}

export interface UsageGroup {
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  /** input + output: the quantity weekly limits are enforced on */
  tokens: number;
}

export interface UsageAggregate {
  totals: Omit<UsageGroup, "key">;
  /** sorted by tokens, descending */
  groups: UsageGroup[];
  buckets: string[];
  /** bucket -> group key -> {tokens, cost} */
  cells: Map<string, Map<string, { tokens: number; cost: number }>>;
}

export type BarMetric = "tokens" | "cost";

const zero = (): Omit<UsageGroup, "key"> => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, tokens: 0 });

/** Fold hub usage rows into totals, per-group sums and a bucket x group matrix. */
export function aggregateUsage<T extends UsageRow>(rows: readonly T[], keyOf: (r: T) => string): UsageAggregate {
  const totals = zero();
  const groups = new Map<string, UsageGroup>();
  const cells = new Map<string, Map<string, { tokens: number; cost: number }>>();
  for (const r of rows) {
    const key = keyOf(r);
    const g = groups.get(key) ?? { key, ...zero() };
    const add = (target: Omit<UsageGroup, "key">) => {
      target.input += r.inputTokens;
      target.output += r.outputTokens;
      target.cacheRead += r.cacheReadTokens ?? 0;
      target.cacheWrite += r.cacheCreateTokens ?? 0;
      target.cost += r.costUsd;
      target.turns += r.turns ?? 0;
      target.tokens += r.inputTokens + r.outputTokens;
    };
    add(g);
    add(totals);
    groups.set(key, g);
    let row = cells.get(r.bucket);
    if (!row) cells.set(r.bucket, (row = new Map()));
    const cell = row.get(key) ?? { tokens: 0, cost: 0 };
    cell.tokens += r.inputTokens + r.outputTokens;
    cell.cost += r.costUsd;
    row.set(key, cell);
  }
  return {
    totals,
    groups: [...groups.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost || a.key.localeCompare(b.key)),
    buckets: [...cells.keys()].sort(),
    cells,
  };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Sorted bucket keys with missing days filled in when the hub buckets by calendar day. */
export function fillBuckets(buckets: readonly string[]): string[] {
  const sorted = [...buckets].sort();
  if (sorted.length < 2 || !sorted.every((b) => DATE_ONLY.test(b))) return sorted;
  const toUtc = (s: string) => {
    const m = DATE_ONLY.exec(s)!;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  const out: string[] = [];
  const end = toUtc(sorted[sorted.length - 1]!);
  // Cap at 400 days so a bad payload can never explode the DOM.
  for (let t = toUtc(sorted[0]!), n = 0; t <= end && n < 400; t += 86_400_000, n++) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Human label for a bucket start ("Mon 27", "Oct 27", "14:00"). */
export function bucketLabel(bucket: string, range: "today" | "7d" | "30d"): string {
  const d = DATE_ONLY.exec(bucket);
  if (d) {
    const date = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    return date.toLocaleDateString(undefined, range === "7d" ? { weekday: "short", day: "numeric" } : { month: "short", day: "numeric" });
  }
  const dt = new Date(bucket);
  if (Number.isNaN(dt.getTime())) return bucket;
  return range === "today" ? dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" });
}

export function buildColumns(agg: UsageAggregate, metric: BarMetric, range: "today" | "7d" | "30d"): { columns: BarColumn[]; series: BarSeries[] } {
  const series: BarSeries[] = agg.groups.map((g, i) => ({ key: g.key, label: g.key, colorVar: seriesVar(i) }));
  const columns: BarColumn[] = fillBuckets(agg.buckets).map((bucket) => {
    const values: Record<string, number> = {};
    for (const [key, cell] of agg.cells.get(bucket) ?? []) values[key] = metric === "tokens" ? cell.tokens : cell.cost;
    return { key: bucket, label: bucketLabel(bucket, range), values };
  });
  return { columns, series };
}

export const metricFormatter = (metric: BarMetric) => (metric === "tokens" ? formatTokens : formatCost);
