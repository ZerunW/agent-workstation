import { useEffect } from "react";
import { requestFind } from "../lib/find";
import { useApp } from "../store/app";

/**
 * ⌘F / Ctrl+F: inside a session the find bar of its transcript, anywhere else the session search dialog (same as Search).
 * The browser's own find never opens. A focused terminal keeps its keys (Ctrl+F is a shell shortcut).
 */
export function useFindHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
      if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
      e.preventDefault();
      if (!requestFind()) useApp.getState().setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
