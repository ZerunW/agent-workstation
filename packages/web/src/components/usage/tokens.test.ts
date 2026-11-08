import { describe, expect, it } from "vitest";
import { aggregateUsage, buildColumns, fillBuckets, type UsageRow } from "./tokens";

const r = (bucket: string, model: string, inT: number, outT: number, cost = 0): UsageRow & { model: string } => ({ bucket, model, inputTokens: inT, outputTokens: outT, cacheReadTokens: 5, cacheCreateTokens: 2, costUsd: cost, turns: 1 });

describe("aggregateUsage", () => {
  const rows = [r("2026-10-29", "opus", 100, 50, 1), r("2026-10-29", "sonnet", 10, 5, 0.1), r("2026-10-31", "opus", 200, 100, 2)];
  const agg = aggregateUsage(rows, (x) => x.model);
  it("sums totals and groups sorted by tokens", () => {
    expect(agg.totals).toMatchObject({ input: 310, output: 155, cacheRead: 15, cacheWrite: 6, turns: 3, tokens: 465 });
    expect(agg.totals.cost).toBeCloseTo(3.1);
    expect(agg.groups.map((g) => g.key)).toEqual(["opus", "sonnet"]);
    expect(agg.groups[0]!.tokens).toBe(450);
  });
  it("fills missing days and builds stacked columns", () => {
    expect(fillBuckets(agg.buckets)).toEqual(["2026-10-29", "2026-10-30", "2026-10-31"]);
    const { columns, series } = buildColumns(agg, "tokens", "7d");
    expect(series.map((s) => s.key)).toEqual(["opus", "sonnet"]);
    expect(columns).toHaveLength(3);
    expect(columns[0]!.values).toEqual({ opus: 150, sonnet: 15 });
    expect(columns[1]!.values).toEqual({});
    expect(columns[2]!.values).toEqual({ opus: 300 });
    expect(buildColumns(agg, "cost", "7d").columns[2]!.values).toEqual({ opus: 2 });
  });
  it("does not fill datetime buckets", () => {
    expect(fillBuckets(["2026-10-31T10:00:00Z", "2026-10-31T13:00:00Z"])).toHaveLength(2);
  });
  it("handles empty input", () => {
    const empty = aggregateUsage([], () => "x");
    expect(empty.groups).toEqual([]);
    expect(empty.totals.tokens).toBe(0);
  });
});
