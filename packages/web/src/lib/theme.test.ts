import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme } from "../embed/bridge";
import { applyRootTheme, isDarkScheme } from "./theme";

const root = document.documentElement;
const reset = () => {
  root.removeAttribute("data-theme");
  root.removeAttribute("data-theme-switching");
};
beforeEach(() => {
  vi.useFakeTimers();
  reset();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  reset();
});

describe("applyRootTheme", () => {
  it("sets and clears <html data-theme>; 'system' and undefined mean 'follow the OS'", () => {
    applyRootTheme("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyRootTheme("light");
    expect(root.getAttribute("data-theme")).toBe("light");
    applyRootTheme("system");
    expect(root.hasAttribute("data-theme")).toBe(false);
    applyRootTheme("dark");
    applyRootTheme(undefined);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("disables color transitions for the change (so nothing lags behind the new palette) and re-enables them with a timer", () => {
    applyRootTheme("dark");
    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    vi.advanceTimersByTime(60);
    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    vi.advanceTimersByTime(100);
    expect(root.hasAttribute("data-theme-switching")).toBe(false);
  });

  it("back-to-back changes keep one window open until the last one settles", () => {
    applyRootTheme("dark");
    vi.advanceTimersByTime(100);
    applyRootTheme("light");
    vi.advanceTimersByTime(100);
    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    vi.advanceTimersByTime(40);
    expect(root.hasAttribute("data-theme-switching")).toBe(false);
  });

  it("a change to the theme that is already set does nothing", () => {
    applyRootTheme("dark");
    vi.advanceTimersByTime(200);
    applyRootTheme("dark");
    expect(root.hasAttribute("data-theme-switching")).toBe(false);
    applyRootTheme(undefined);
    vi.advanceTimersByTime(200);
    applyRootTheme(undefined);
    expect(root.hasAttribute("data-theme-switching")).toBe(false);
  });
});

describe("isDarkScheme / embed applyTheme", () => {
  it("a forced theme wins over the OS scheme", () => {
    applyTheme("dark");
    expect(isDarkScheme()).toBe(true);
    applyTheme("light");
    expect(isDarkScheme()).toBe(false);
    applyTheme(undefined);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});
