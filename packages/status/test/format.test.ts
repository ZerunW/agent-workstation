import { describe, expect, it } from "vitest";
import { fmtAgo, fmtBitRate, fmtByteRate, fmtBytes, fmtDuration, fmtMbps, fmtUntil } from "../ui/src/format.js";

describe("UI formatting helpers", () => {
  it("bytes use IEC units", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1536)).toBe("1.5 KiB");
    expect(fmtBytes(8 * 1024 ** 3)).toBe("8.0 GiB");
    expect(fmtBytes(Number.NaN)).toBe("—");
  });
  it("rates", () => {
    expect(fmtByteRate(0)).toBe("0 B/s");
    expect(fmtByteRate(1_500_000)).toBe("1.5 MB/s");
    expect(fmtByteRate(52_000_000, true)).toBe("52 MB/s");
    expect(fmtBitRate(125_000)).toBe("1.0 Mbit/s");
    expect(fmtBitRate(12_500_000)).toBe("100 Mbit/s");
    expect(fmtMbps(312.4)).toBe("312 Mbps");
    expect(fmtMbps(null)).toBe("—");
  });
  it("durations", () => {
    expect(fmtDuration(42)).toBe("42s");
    expect(fmtDuration(3700)).toBe("1h 1m");
    expect(fmtDuration(93784)).toBe("1d 2h");
    expect(fmtDuration(-1)).toBe("—");
  });
  it("relative times", () => {
    expect(fmtAgo(1000)).toBe("just now");
    expect(fmtAgo(42_000)).toBe("42 s ago");
    expect(fmtAgo(5 * 60_000)).toBe("5 min ago");
    expect(fmtAgo(3 * 3600_000)).toBe("3 h ago");
    expect(fmtUntil(10 * 60_000, 0)).toBe("in 10m");
    expect(fmtUntil(134 * 60_000, 0)).toBe("in 2h 14m");
    expect(fmtUntil(1000, 0)).toBe("now");
    expect(fmtUntil(3 * 86400_000, 0)).toBe("in 3d 0h");
  });
});
