import { describe, expect, it } from "vitest";
import { formatLimit, parseTokenLimit, toggleAllowlist } from "./tokenLimit";
import { validateDisk } from "./GlobalSettings";
import { limitTone } from "./UsersTable";

describe("parseTokenLimit", () => {
  it("treats empty as unlimited and understands suffixes and separators", () => {
    expect(parseTokenLimit("")).toEqual({ ok: true, value: null });
    expect(parseTokenLimit("  ")).toEqual({ ok: true, value: null });
    expect(parseTokenLimit("500k")).toEqual({ ok: true, value: 500_000 });
    expect(parseTokenLimit("1.5m")).toEqual({ ok: true, value: 1_500_000 });
    expect(parseTokenLimit("2B")).toEqual({ ok: true, value: 2_000_000_000 });
    expect(parseTokenLimit("1,500,000")).toEqual({ ok: true, value: 1_500_000 });
    expect(parseTokenLimit("0")).toEqual({ ok: true, value: 0 });
  });
  it("rejects negatives, text and fractional raw tokens", () => {
    for (const bad of ["-5", "abc", "1.5", "12x", "1e6", "∞"]) expect(parseTokenLimit(bad)).toEqual({ ok: false });
  });
  it("formats limits", () => {
    expect(formatLimit(null)).toBe("Unlimited");
    expect(formatLimit(1_500_000)).toBe("1.50M");
  });
});

describe("toggleAllowlist", () => {
  const all = ["a", "b", "c"];
  it("unticking from 'all models' yields the remaining models", () => {
    expect(toggleAllowlist(null, all, "b")).toEqual(["a", "c"]);
  });
  it("re-ticking everything collapses back to null (no restriction)", () => {
    expect(toggleAllowlist(["a", "c"], all, "b")).toBeNull();
  });
  it("an empty selection also means no restriction", () => {
    expect(toggleAllowlist(["a"], all, "a")).toBeNull();
  });
  it("adds models to a partial list", () => {
    expect(toggleAllowlist(["a"], all, "c")).toEqual(["a", "c"]);
  });
});

describe("validators", () => {
  it("validates disk thresholds", () => {
    expect(validateDisk("80", "95")).toBe(true);
    expect(validateDisk("95", "95")).toBe(false);
    expect(validateDisk("0", "95")).toBe(false);
    expect(validateDisk("80", "101")).toBe(false);
    expect(validateDisk("8o", "95")).toBe(false);
  });
  it("colors weekly usage by threshold", () => {
    expect(limitTone(10, 100)).toBe("accent");
    expect(limitTone(80, 100)).toBe("warn");
    expect(limitTone(100, 100)).toBe("danger");
    expect(limitTone(100, null)).toBe("accent");
  });
});
