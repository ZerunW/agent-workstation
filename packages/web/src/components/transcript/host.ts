import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { TranscriptItem } from "../../lib/transcript";

/**
 * Host hooks for things the transcript can trigger that differ between the browser app and the macOS embed
 * (open a file reference natively, open links in the default browser).
 */
export interface TranscriptHost {
  openExternal?: (url: string) => void;
  /** When set, path-looking inline code becomes clickable and calls this. */
  openFile?: (path: string) => void;
}

export const TranscriptHostContext = createContext<TranscriptHost>({});
export const useTranscriptHost = () => useContext(TranscriptHostContext);

/** Renders nested items (sub-agent transcripts) inside a tool card; provided by Transcript. */
export const ChildItemsContext = createContext<(items: TranscriptItem[]) => ReactNode>(() => null);
export const useChildItems = () => useContext(ChildItemsContext);

/** The session the surrounding transcript shows (a subagent row looks up its running task in that session's view). */
export const TranscriptSessionContext = createContext<string | null>(null);

/**
 * Which tool groups and rows are open. Held by the Transcript for as long as it is mounted (the current page view, no
 * storage); everything starts collapsed. Without a provider each component keeps its own state.
 */
export const ExpandedContext = createContext<Map<string, boolean> | null>(null);

/** The open/closed map, telling mounted rows when a key changes (the find bar opens folded groups from outside). */
export class ExpandedMap extends Map<string, boolean> {
  private listeners = new Set<(key: string) => void>();
  subscribe(fn: (key: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  override set(key: string, value: boolean): this {
    const changed = this.get(key) !== value;
    super.set(key, value);
    if (changed) this.listeners.forEach((fn) => fn(key));
    return this;
  }
}

export function useExpanded(key: string): [boolean, (open: boolean) => void] {
  const store = useContext(ExpandedContext);
  const [open, setOpenState] = useState(() => store?.get(key) ?? false);
  useEffect(() => {
    if (!(store instanceof ExpandedMap)) return;
    return store.subscribe((k) => k === key && setOpenState(store.get(key) ?? false));
  }, [store, key]);
  const setOpen = useCallback(
    (v: boolean) => {
      store?.set(key, v);
      setOpenState(v);
    },
    [store, key],
  );
  return [open, setOpen];
}

/**
 * The find bar's applied query ("" = no find): folded tool groups and rows whose detail holds a match open themselves,
 * the others stay folded.
 */
export const FindQueryContext = createContext("");

/** Opens `setOpen(true)` once when the query occurs in `text()` (computed only while a query is set). */
export function useOpenOnFind(text: () => string, setOpen: (open: boolean) => void): void {
  const query = useContext(FindQueryContext);
  const hit = query !== "" && text().toLocaleLowerCase().includes(query.toLocaleLowerCase());
  useEffect(() => {
    if (hit) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit, query]);
}
