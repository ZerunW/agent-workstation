export type ThemeChoice = "light" | "dark" | "system";

/** True when the document currently renders the dark palette (data-theme override, else the OS scheme). */
export function isDarkScheme(): boolean {
  if (typeof document === "undefined") return false;
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

let settle: ReturnType<typeof setTimeout> | null = null;

/**
 * Set `<html data-theme>` ("system" / undefined removes it so the OS scheme applies) and make every surface switch
 * at once. Components fade their colors (`transition-colors`); an embedded webview that is not painting (hidden,
 * snapshotting) never finishes such a fade and would keep showing the old palette, so transitions are switched off
 * (`[data-theme-switching]` in index.css) around the change. A plain timer ends the window: animation frames do not
 * fire in a hidden page.
 */
export function applyRootTheme(theme: ThemeChoice | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const next = theme === "light" || theme === "dark" ? theme : null;
  if (root.getAttribute("data-theme") === next) return;
  root.setAttribute("data-theme-switching", "");
  if (next) root.setAttribute("data-theme", next);
  else root.removeAttribute("data-theme");
  void root.offsetHeight; // style recalc happens now, with transitions disabled
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    root.removeAttribute("data-theme-switching");
  }, 120);
}
