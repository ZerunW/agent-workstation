import { useEffect, useState } from "react";
import { isDarkScheme } from "../lib/theme";

/** Whether the dark palette is showing; follows `<html data-theme>` changes and the OS scheme. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(isDarkScheme);
  useEffect(() => {
    const update = () => setDark(isDarkScheme());
    update();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq?.removeEventListener?.("change", update);
      mo.disconnect();
    };
  }, []);
  return dark;
}
