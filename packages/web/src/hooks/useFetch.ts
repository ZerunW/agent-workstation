import { useCallback, useEffect, useRef, useState } from "react";

export interface FetchState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Re-run now (keeps stale data visible while loading). */
  reload: () => void;
  /** Replace the cached data (optimistic updates). */
  setData: (next: T | undefined | ((prev: T | undefined) => T | undefined)) => void;
}

/**
 * Tiny data-loading hook: runs `fn` on mount and whenever `deps` change, optionally every `refreshMs`.
 * Late responses from superseded runs are dropped.
 */
export function useFetch<T>(fn: () => Promise<T>, deps: readonly unknown[], opts: { refreshMs?: number; enabled?: boolean } = {}): FetchState<T> {
  const { refreshMs, enabled = true } = opts;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const run = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(() => {
    const id = ++run.current;
    setLoading(true);
    fnRef.current().then(
      (d) => {
        if (id !== run.current) return;
        setData(d);
        setError(undefined);
        setLoading(false);
      },
      (e) => {
        if (id !== run.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    load();
    const timer = refreshMs ? setInterval(load, refreshMs) : null;
    const token = run;
    return () => {
      token.current++;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshMs, load, ...deps]);

  return { data, error, loading, reload: load, setData };
}
