import { describe, expect, it } from "vitest";
import { resetLine, usageGroups } from "../ui/src/usageModel.js";
import type { UsageLimits } from "../ui/src/types.js";
import { fmtResetTime, fmtUsd } from "../ui/src/format.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const api = (over: Partial<NonNullable<UsageLimits["api"]>> = {}): NonNullable<UsageLimits["api"]> => ({
  spentUsd: 12,
  limitUsd: 100,
  percent: 12,
  periodStart: "2026-12-15T00:00:00Z",
  resetsAt: "2027-01-15T00:00:00Z",
  severity: "normal",
  ...over,
});

describe("usageGroups", () => {
  it("shows one API-credits group: a 'This period' card with the dollar figures", () => {
    const groups = usageGroups({ api: api() });
    expect(groups.map((x) => x.id)).toEqual(["api"]);
    expect(groups[0]).toMatchObject({ title: "API credits", notes: [] });
    expect(groups[0]!.cards).toEqual([{ key: "api|period", label: "This period", percent: 12, severity: "normal", resetsAtMs: Date.parse("2027-01-15T00:00:00Z"), valueLabel: "$12.00 / $100.00" }]);
  });

  it("carries the hub's severity and keeps percent null and a missing reset as they are", () => {
    const [g] = usageGroups({ api: api({ spentUsd: 97, percent: 97, severity: "critical" }) });
    expect(g!.cards[0]).toMatchObject({ severity: "critical", percent: 97, valueLabel: "$97.00 / $100.00" });
    const [u] = usageGroups({ api: api({ percent: null, severity: "unknown", resetsAt: "" }) });
    expect(u!.cards[0]).toMatchObject({ percent: null, resetsAtMs: null, severity: "unknown" });
  });

  it("without credits it says why in one line: no key, or the hub's error", () => {
    expect(usageGroups({ api: null })[0]).toMatchObject({ cards: [], notes: [{ tone: "muted", text: "No Anthropic API key is configured." }] });
    expect(usageGroups({ api: null, error: "hub unreachable: connection refused" })[0]).toMatchObject({ cards: [], notes: [{ tone: "notice", text: "Usage data: hub unreachable: connection refused" }] });
  });
});

describe("the reset line", () => {
  it("counts down to the reset", () => {
    expect(resetLine(NOW + 37 * 60_000, NOW).until).toBe("in 37m");
    expect(resetLine(NOW + (2 * 60 + 14) * 60_000, NOW).until).toBe("in 2h 14m");
  });
  it("writes every reset time the same way: month, day, short clock time, no seconds, also for a reset later today", () => {
    const local = new Date(2027, 0, 15, 15, 20, 56); // local components: the same text in any time zone
    const laterToday = resetLine(local.getTime(), local.getTime() - (3 * 60 + 54) * 60_000);
    expect(laterToday.at).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
    expect(laterToday.at).not.toMatch(/:\d{2}:\d{2}/);
    expect(laterToday.until).toBe("in 3h 54m");
    expect(resetLine(local.getTime() + 10 * 86_400_000, local.getTime()).at).toMatch(/^[A-Z][a-z]{2} \d{1,2}, /);
  });
});

describe("fmtResetTime", () => {
  const utc = { locale: "en-US", timeZone: "UTC" };
  it("is month, day and a short clock time, without seconds or a leading zero", () => {
    expect(fmtResetTime(Date.parse("2027-01-15T15:20:56Z"), utc)).toBe("Jan 15, 3:20 PM");
    expect(fmtResetTime(Date.parse("2027-01-15T21:45:00Z"), utc)).toBe("Jan 15, 9:45 PM");
    expect(fmtResetTime(Date.parse("2027-02-15T00:00:00Z"), utc)).toBe("Feb 15, 12:00 AM");
    expect(fmtResetTime(Date.parse("2026-11-02T08:05:59.999Z"), utc)).toBe("Nov 2, 8:05 AM");
  });
  it("uses the local time zone by default and a plain space before AM/PM", () => {
    const local = new Date(2027, 0, 15, 15, 20, 56);
    expect(fmtResetTime(local.getTime(), { locale: "en-US" })).toBe("Jan 15, 3:20 PM");
    expect(fmtResetTime(local.getTime(), { locale: "en-US" })).not.toMatch(/[\u202f\u00a0]/);
  });
  it("is a dash for garbage", () => {
    expect(fmtResetTime(Number.NaN)).toBe("—");
  });
  it("fmtUsd has two decimals", () => {
    expect(fmtUsd(12)).toBe("$12.00");
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(Number.NaN)).toBe("—");
  });
});
