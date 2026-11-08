import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { DirState } from "./fileTree";

const NONE: ReadonlySet<string> = new Set();

/**
 * Lazily loaded workspace tree starting at `root` (workspace-relative, "" = whole workspace). Each directory is
 * one `GET /api/files/tree?path=&depth=1` call, fetched the first time it is expanded; `refresh*` re-fetches
 * silently (no spinner) so live file events don't flicker. Paths stay workspace-relative; nothing above `root`
 * is ever requested. Expanded folders are remembered per `scope` (the session) for as long as the hook lives.
 */
export function useFileTree(enabled = true, root = "", scope = "") {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expandedByScope, setExpandedByScope] = useState<Record<string, ReadonlySet<string>>>({});
  const expanded = expandedByScope[scope] ?? NONE;
  const seq = useRef<Record<string, number>>({});
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const rootRef = useRef(root);
  rootRef.current = root;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (path: string, silent = false) => {
    const id = (seq.current[path] = (seq.current[path] ?? 0) + 1);
    if (!silent) setDirs((d) => ({ ...d, [path]: { entries: d[path]?.entries ?? null, loading: true, error: null } }));
    try {
      const entries = await api.filesTree(path, 1);
      if (!mounted.current || seq.current[path] !== id) return;
      setDirs((d) => ({ ...d, [path]: { entries, loading: false, error: null } }));
    } catch (e) {
      if (!mounted.current || seq.current[path] !== id) return;
      const message = e instanceof Error ? e.message : String(e);
      setDirs((d) => ({ ...d, [path]: { entries: d[path]?.entries ?? null, loading: false, error: message } }));
    }
  }, []);

  // `enabled` waits for the hub identity: child effects run before the shell connects the API user.
  // Re-rooting (another session) refreshes the new root and its remembered folders; cached listings show meanwhile.
  useEffect(() => {
    if (!enabled) return;
    void load(root, !!dirsRef.current[root]?.entries);
    for (const p of expandedRef.current) void load(p, !!dirsRef.current[p]?.entries);
  }, [load, enabled, root, scope]);

  const ensureLoaded = useCallback(
    (path: string) => {
      const st = dirsRef.current[path];
      if (!st || (!st.entries && !st.loading)) void load(path);
    },
    [load],
  );

  const update = useCallback((fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
    const k = scopeRef.current;
    setExpandedByScope((all) => {
      const prev = all[k] ?? NONE;
      const next = fn(prev);
      return next === prev ? all : { ...all, [k]: next };
    });
  }, []);

  const expand = useCallback(
    (path: string) => {
      update((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
      ensureLoaded(path);
    },
    [ensureLoaded, update],
  );

  const collapse = useCallback(
    (path: string) => {
      update((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    },
    [update],
  );

  const toggle = useCallback(
    (path: string) => {
      if (expandedRef.current.has(path)) collapse(path);
      else expand(path);
    },
    [collapse, expand],
  );

  const expandMany = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      update((prev) => {
        if (paths.every((p) => prev.has(p))) return prev;
        const next = new Set(prev);
        for (const p of paths) next.add(p);
        return next;
      });
      // load top-down so parents resolve before their children are asked for
      for (const p of paths) ensureLoaded(p);
    },
    [ensureLoaded, update],
  );

  /** Silent re-fetch of the root and every expanded folder. */
  const refreshAll = useCallback(() => {
    void load(rootRef.current, true);
    for (const p of expandedRef.current) void load(p, true);
  }, [load]);

  /** Re-fetch one folder (silently when it was loaded before). */
  const refreshDir = useCallback(
    (path: string) => {
      void load(path, !!dirsRef.current[path]?.entries);
    },
    [load],
  );

  return { dirs, expanded, load, toggle, expand, collapse, expandMany, refreshAll, refreshDir };
}
