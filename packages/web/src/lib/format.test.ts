import { describe, expect, it } from "vitest";
import { formatElapsed, formatKTokens, formatResetTime, formatUsd, formatUsdWhole } from "./format";

describe("formatElapsed", () => {
  it("shows seconds, then minutes and seconds, then hours and minutes", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(5 * 60_000 + 21_000)).toBe("5m 21s");
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(3_600_000 + 2 * 60_000 + 59_000)).toBe("1h 2m");
  });

  it("clamps negative or non-finite input (clock skew between the hub and this browser)", () => {
    expect(formatElapsed(-4000)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
});

describe("formatKTokens", () => {
  it("keeps small counts exact and uses one decimal for thousands and millions", () => {
    expect(formatKTokens(0)).toBe("0");
    expect(formatKTokens(842)).toBe("842");
    expect(formatKTokens(1000)).toBe("1k");
    expect(formatKTokens(1250)).toBe("1.3k");
    expect(formatKTokens(1_200)).toBe("1.2k");
    expect(formatKTokens(26_000)).toBe("26k");
    expect(formatKTokens(12_500)).toBe("12.5k");
    expect(formatKTokens(999_950)).toBe("1M");
    expect(formatKTokens(1_000_000)).toBe("1M");
    expect(formatKTokens(1_540_000)).toBe("1.5M");
  });

  it("is a dash for unknown values", () => {
    expect(formatKTokens(null)).toBe("—");
    expect(formatKTokens(undefined)).toBe("—");
  });
});

describe("formatResetTime", () => {
  const utc = { locale: "en-US", timeZone: "UTC" };

  it("is month, day and a short clock time: no seconds, no leading zero", () => {
    expect(formatResetTime("2026-01-15T15:20:56Z", utc)).toBe("Jan 15, 3:20 PM");
    expect(formatResetTime("2026-01-15T11:00:00Z", utc)).toBe("Jan 15, 11:00 AM");
    expect(formatResetTime("2026-02-01T00:00:00Z", utc)).toBe("Feb 1, 12:00 AM");
    expect(formatResetTime("2026-11-02T08:05:59.999Z", utc)).toBe("Nov 2, 8:05 AM");
  });

  it("always shows the date, also for a reset later today (a bare clock with seconds is not enough)", () => {
    const soon = new Date(Date.now() + 3 * 3600_000 + 54 * 60_000);
    const out = formatResetTime(soon, { locale: "en-US" });
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
    expect(out).not.toMatch(/:\d{2}:\d{2}/);
  });

  it("uses the local time zone unless told otherwise", () => {
    const local = new Date(2026, 0, 15, 15, 20, 56); // built from local components
    expect(formatResetTime(local, { locale: "en-US" })).toBe("Jan 15, 3:20 PM");
    expect(formatResetTime(local.toISOString(), { locale: "en-US" })).toBe("Jan 15, 3:20 PM");
    expect(formatResetTime(local.getTime(), { locale: "en-US" })).toBe("Jan 15, 3:20 PM");
  });

  it("writes a plain space before AM/PM (no narrow no-break space)", () => {
    expect(formatResetTime("2026-01-15T15:20:00Z", utc)).not.toMatch(/[\u202f\u00a0]/);
  });

  it("is a dash for missing or unparsable input", () => {
    expect(formatResetTime(null)).toBe("—");
    expect(formatResetTime(undefined)).toBe("—");
    expect(formatResetTime("")).toBe("—");
    expect(formatResetTime("garbage")).toBe("—");
  });
});

describe("formatUsd / formatUsdWhole", () => {
  it("two decimals with thousands separators; whole dollars round down", () => {
    expect(formatUsd(12)).toBe("$12.00");
    expect(formatUsd(100)).toBe("$100.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsdWhole(56.7)).toBe("$56");
    expect(formatUsdWhole(0.99)).toBe("$0");
    expect(formatUsdWhole(-3)).toBe("$0");
    expect(formatUsdWhole(undefined)).toBe("—");
  });
});
