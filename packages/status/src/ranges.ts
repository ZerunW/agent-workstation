/**
 * Chart ranges and the storage resolution that serves each of them.
 *
 *   raw  10 s samples (48 h)   1m  one-minute aggregates (90 d)   1h  one-hour aggregates (forever)
 *
 * `stepS` is the bucket size returned to the client; it may be a multiple of the table's native
 * step (the store re-buckets with SQL). All of them aim for 360..720 points per series so a
 * phone can draw every chart quickly.
 */
export const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

export type Tier = "raw" | "1m" | "1h";

export interface Resolution {
  range: Range;
  tier: Tier;
  /** Bucket size of the response, in seconds. */
  stepS: number;
  /** How far back from "now" the window reaches, in seconds. */
  windowS: number;
}

export const RETENTION_S = {
  raw: 48 * 3600,
  m1: 90 * 86400,
} as const;

export function isRange(v: unknown): v is Range {
  return typeof v === "string" && (RANGES as readonly string[]).includes(v);
}

/**
 * Pick the resolution for a range. `sampleIntervalS` is the collector period: the 1 h view
 * shows every raw sample (so its step equals the sample interval).
 */
export function selectResolution(range: Range, sampleIntervalS = 10): Resolution {
  switch (range) {
    case "1h":
      return { range, tier: "raw", stepS: sampleIntervalS, windowS: 3600 };
    case "6h":
      return { range, tier: "1m", stepS: 60, windowS: 6 * 3600 };
    case "24h":
      return { range, tier: "1m", stepS: 120, windowS: 24 * 3600 };
    case "7d":
      return { range, tier: "1m", stepS: 900, windowS: 7 * 86400 };
    case "30d":
      return { range, tier: "1h", stepS: 3600, windowS: 30 * 86400 };
  }
}

/** First and last bucket start (epoch seconds, multiples of `stepS`) inside [now - windowS, now]. */
export function gridBounds(res: Resolution, nowS: number): { first: number; last: number; count: number } {
  const from = nowS - res.windowS;
  const first = Math.ceil(from / res.stepS) * res.stepS;
  const last = Math.floor(nowS / res.stepS) * res.stepS;
  return { first, last, count: last >= first ? Math.floor((last - first) / res.stepS) + 1 : 0 };
}
