import type { SearchHit } from "@agent-workstation/protocol";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { newestFirst } from "../lib/search";

/** Subagent sessions never show in search (the hub leaves them out too; this is the safety net). */
const noChildren = (hits: SearchHit[]): SearchHit[] => hits.filter((h) => !h.session.parentSessionId);

/** Keyword results follow the typing; the relevance ranking waits until typing has stopped (it costs a model call). */
export const KEYWORD_DEBOUNCE_MS = 150;
export const RELEVANT_DEBOUNCE_MS = 600;
export const KEYWORD_LIMIT = 20;
export const RELEVANT_LIMIT = 10;

export type ColumnStatus = "idle" | "loading" | "ready" | "error" | "unavailable";
export interface Column {
  status: ColumnStatus;
  hits: SearchHit[];
}

const IDLE: Column = { status: "idle", hits: [] };

/** Relevant results per query, kept for the page's lifetime (the hub caches too, but a repeat should not even wait). */
const relevantCache = new Map<string, SearchHit[]>();
const CACHE_MAX = 50;
export const clearRelevantCache = (): void => relevantCache.clear();
const remember = (q: string, hits: SearchHit[]) => {
  if (relevantCache.size >= CACHE_MAX) relevantCache.delete(relevantCache.keys().next().value as string);
  relevantCache.set(q, hits);
};

const aborted = (e: unknown) => (e as Error)?.name === "AbortError";

/**
 * Both search columns for one query. `rankDown` = the account already says the ranking cannot run (no API credits): the right
 * column is "unavailable" without a request (a 503 from the hub flips it too, until `enabled` goes false again).
 */
export function useSearchResults(query: string, opts: { enabled: boolean; rankDown: boolean }): { keyword: Column; relevant: Column } {
  const q = query.trim();
  const [keyword, setKeyword] = useState<Column>(IDLE);
  const [relevant, setRelevant] = useState<Column>(IDLE);
  const unavailable = useRef(false);

  useEffect(() => {
    if (!opts.enabled) unavailable.current = false;
  }, [opts.enabled]);

  // keyword: live (debounced 150 ms); the previous hits stay up while the next ones load
  useEffect(() => {
    if (!opts.enabled || !q) {
      setKeyword(IDLE);
      return;
    }
    setKeyword((k) => ({ status: "loading", hits: k.hits }));
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      api
        .search(q, KEYWORD_LIMIT, ctl.signal)
        .then((res) => !ctl.signal.aborted && setKeyword({ status: "ready", hits: newestFirst(noChildren(res.hits)) }))
        .catch((e) => !aborted(e) && !ctl.signal.aborted && setKeyword({ status: "error", hits: [] }));
    }, KEYWORD_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, opts.enabled]);

  // relevant: 600 ms after the last keystroke, once per query
  useEffect(() => {
    if (!opts.enabled || !q) {
      setRelevant(IDLE);
      return;
    }
    if (opts.rankDown || unavailable.current) {
      setRelevant({ status: "unavailable", hits: [] });
      return;
    }
    const cached = relevantCache.get(q);
    if (cached) {
      setRelevant({ status: "ready", hits: cached });
      return;
    }
    setRelevant({ status: "loading", hits: [] });
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      api
        .searchRelevant(q, RELEVANT_LIMIT, ctl.signal)
        .then((res) => {
          if (ctl.signal.aborted) return;
          const hits = noChildren(res.hits);
          remember(q, hits);
          setRelevant({ status: "ready", hits });
        })
        .catch((e) => {
          if (aborted(e) || ctl.signal.aborted) return;
          if (e instanceof ApiError && (e.code === "api_unavailable" || e.status === 503)) {
            unavailable.current = true;
            setRelevant({ status: "unavailable", hits: [] });
          } else setRelevant({ status: "error", hits: [] });
        });
    }, RELEVANT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, opts.enabled, opts.rankDown]);

  return { keyword, relevant };
}
