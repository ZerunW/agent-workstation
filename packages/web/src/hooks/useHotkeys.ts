import { useEffect } from "react";

export interface Hotkey {
  /** KeyboardEvent.key (case-insensitive) or `code:Period` for physical keys */
  key: string;
  /** Require ⌘ (Mac) / Ctrl (others). Default true. */
  mod?: boolean;
  shift?: boolean;
  /** Fire even when typing in an input/textarea. Default true for mod combos. */
  allowInInput?: boolean;
  handler: (e: KeyboardEvent) => void;
}

function matches(e: KeyboardEvent, h: Hotkey): boolean {
  const mod = h.mod ?? true;
  if (mod !== (e.metaKey || e.ctrlKey)) return false;
  if (!!h.shift !== e.shiftKey) return false;
  if (e.altKey) return false;
  if (h.key.startsWith("code:")) return e.code === h.key.slice(5);
  return e.key.toLowerCase() === h.key.toLowerCase();
}

export function useHotkeys(hotkeys: Hotkey[]): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const h of hotkeys) {
        if (!matches(e, h)) continue;
        const t = e.target as HTMLElement | null;
        const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (typing && h.allowInInput === false) continue;
        e.preventDefault();
        h.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}
