import type { ITheme } from "@xterm/xterm";
import { isDarkScheme } from "../../lib/theme";

const LIGHT_ANSI = {
  black: "#16191d",
  red: "#c23b2b",
  green: "#2f8456",
  yellow: "#a96a0c",
  blue: "#3a69b0",
  magenta: "#a8326a",
  cyan: "#0e7490",
  white: "#5b6270",
  brightBlack: "#8a919c",
  brightRed: "#d4574a",
  brightGreen: "#3f9d68",
  brightYellow: "#c07f1a",
  brightBlue: "#4f82cc",
  brightMagenta: "#c2478a",
  brightCyan: "#1b8ca8",
  brightWhite: "#2a2f36",
};

const DARK_ANSI = {
  black: "#2c3137",
  red: "#ef7a6b",
  green: "#5fc08a",
  yellow: "#e0a54a",
  blue: "#7aa7e8",
  magenta: "#f08ab8",
  cyan: "#6fd0e6",
  white: "#cfd5dc",
  brightBlack: "#7d8590",
  brightRed: "#f59286",
  brightGreen: "#7dd3a2",
  brightYellow: "#ecbc6c",
  brightBlue: "#9bbdf0",
  brightMagenta: "#f5a6c9",
  brightCyan: "#90e0f0",
  brightWhite: "#eef1f4",
};

export { isDarkScheme };

const cssVar = (name: string): string => (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim());

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rrggbb` + alpha -> `rgba(r, g, b, a)` (xterm parses the comma form everywhere). null for non-hex input. */
export function hexToRgba(hex: string, alpha: number): string | null {
  if (!HEX.test(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** xterm theme from the app's CSS tokens (re-run when the scheme or data-theme changes). */
export function buildXtermTheme(getVar: (name: string) => string = cssVar, dark: boolean = isDarkScheme()): ITheme {
  const pick = (name: string, fallback: string) => {
    const v = getVar(name);
    return HEX.test(v) ? v : fallback;
  };
  const background = pick("--code-bg", dark ? "#16191c" : "#f1f3f6");
  const foreground = pick("--fg", dark ? "#eef1f4" : "#15181b");
  const accent = pick("--accent", dark ? "#2a9d8f" : "#0f766e");
  return {
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: hexToRgba(accent, dark ? 0.35 : 0.28) ?? undefined,
    selectionInactiveBackground: hexToRgba(accent, 0.18) ?? undefined,
  };
}
