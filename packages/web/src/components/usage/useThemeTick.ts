import { useEffect, useState } from "react";

/**
 * Bumps whenever the effective theme may have changed (system color scheme or <html data-theme>),
 * so canvas charts can re-resolve their CSS-variable colors.
 */
export function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener?.("change", bump);
    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      mo = new MutationObserver(bump);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    }
    return () => {
      mq?.removeEventListener?.("change", bump);
      mo?.disconnect();
    };
  }, []);
  return tick;
}

/** Resolve a CSS custom property (e.g. "--accent") to a concrete color string for canvas drawing. */
export function cssVar(name: string, fallback = "#888"): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Stable categorical palette expressed as CSS variables (works in light and dark). */
export const SERIES_VARS = ["--accent", "--info", "--ok", "--warn", "--hl-attr", "--hl-built", "--hl-keyword", "--hl-number"] as const;
export const seriesVar = (i: number): string => SERIES_VARS[i % SERIES_VARS.length]!;
