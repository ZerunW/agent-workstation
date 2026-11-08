import { describe, expect, it } from "vitest";
import { gridBounds, isRange, RANGES, RETENTION_S, selectResolution } from "../src/ranges.js";

describe("range -> resolution", () => {
  it("serves each range from the tier that covers it", () => {
    expect(selectResolution("1h", 10)).toEqual({ range: "1h", tier: "raw", stepS: 10, windowS: 3600 });
    expect(selectResolution("6h")).toMatchObject({ tier: "1m", stepS: 60, windowS: 21600 });
    expect(selectResolution("24h")).toMatchObject({ tier: "1m", stepS: 120, windowS: 86400 });
    expect(selectResolution("7d")).toMatchObject({ tier: "1m", stepS: 900, windowS: 7 * 86400 });
    expect(selectResolution("30d")).toMatchObject({ tier: "1h", stepS: 3600, windowS: 30 * 86400 });
  });

  it("never asks a tier for data older than it retains", () => {
    for (const range of RANGES) {
      const r = selectResolution(range);
      if (r.tier === "raw") expect(r.windowS).toBeLessThanOrEqual(RETENTION_S.raw);
      if (r.tier === "1m") expect(r.windowS).toBeLessThanOrEqual(RETENTION_S.m1);
    }
  });

  it("keeps every range under 750 points per series so phones stay fast", () => {
    for (const range of RANGES) {
      const r = selectResolution(range);
      expect(r.windowS / r.stepS).toBeLessThanOrEqual(750);
    }
  });

  it("the 1h view follows the sample interval", () => {
    expect(selectResolution("1h", 5).stepS).toBe(5);
    expect(selectResolution("1h", 30).stepS).toBe(30);
  });

  it("the step is always a whole number of the tier's native step", () => {
    for (const range of RANGES) {
      const r = selectResolution(range);
      if (r.tier === "1m") expect(r.stepS % 60).toBe(0);
      if (r.tier === "1h") expect(r.stepS % 3600).toBe(0);
    }
  });

  it("validates range strings", () => {
    expect(isRange("24h")).toBe(true);
    expect(isRange("2h")).toBe(false);
    expect(isRange(undefined)).toBe(false);
  });
});

describe("gridBounds", () => {
  it("aligns buckets to multiples of the step inside the window", () => {
    const res = selectResolution("1h", 10);
    const b = gridBounds(res, 10_005);
    expect(b.first).toBe(6410); // ceil((10005-3600)/10)*10
    expect(b.last).toBe(10_000);
    expect(b.count).toBe(360);
    expect((b.last - b.first) / 10 + 1).toBe(b.count);
  });
});
