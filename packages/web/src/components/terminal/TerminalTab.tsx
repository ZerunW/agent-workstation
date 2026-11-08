import { Plus, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type TerminalInfo } from "../../lib/api";
import { cn } from "../../lib/cn";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { toast } from "../../store/toasts";
import { Button, EmptyState, Skeleton } from "../ui/primitives";
import { TerminalView } from "./TerminalView";

interface Tab {
  info: TerminalInfo;
  /** Stable display number ("Terminal 2") that survives closing other tabs. */
  n: number;
}

/**
 * Right-panel Terminal: a tab per hub terminal. Existing terminals (kept alive in tmux on the server)
 * are restored on mount; the first visit with none opens one. It stays mounted while another panel tab
 * is showing, so `active` tells it when to refit.
 */
export function TerminalTab({ active }: { active: boolean }) {
  const me = useApp((s) => s.me);
  const meError = useApp((s) => s.meError);
  const enabled = !(me && me.user.terminalEnabled === false);
  const ready = !!me || !!meError;

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const boot = useRef<Promise<TerminalInfo[]> | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const load = useCallback(() => {
    // One shared in-flight request: React StrictMode's double effect must not create two terminals.
    const p =
      boot.current ??
      (boot.current = (async () => {
        const list = await api.terminals();
        return list.length ? list : [await api.createTerminal()];
      })());
    setLoading(true);
    setError(null);
    return p.then(
      (list) => {
        setTabs((prev) => {
          if (prev.length) return prev;
          return list.map((info, i) => ({ info, n: i + 1 }));
        });
        setActiveId((cur) => cur ?? list[0]?.id ?? null);
        setLoading(false);
      },
      (e) => {
        boot.current = null;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    if (!ready || !enabled) return;
    void load();
  }, [ready, enabled, load]);

  const addTab = useCallback(async () => {
    setCreating(true);
    try {
      const info = await api.createTerminal();
      setTabs((prev) => [...prev, { info, n: Math.max(0, ...prev.map((x) => x.n)) + 1 }]);
      setActiveId(info.id);
    } catch (e) {
      toast.error(t("terminal.createFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, []);

  const closeTab = useCallback(
    async (id: string) => {
      try {
        await api.deleteTerminal(id);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) {
          toast.error(t("terminal.closeFailed"), e instanceof Error ? e.message : String(e));
          return;
        }
      }
      const prev = tabsRef.current;
      const idx = prev.findIndex((x) => x.info.id === id);
      const next = prev.filter((x) => x.info.id !== id);
      setTabs(next);
      setActiveId((cur) => (cur === id ? (next[Math.min(idx, next.length - 1)]?.info.id ?? null) : cur));
    },
    [],
  );

  /** The shell exited: replace that tab with a fresh terminal (best-effort cleanup of the old one). */
  const restartTab = useCallback(
    async (id: string) => {
      try {
        const info = await api.createTerminal();
        setTabs((prev) => prev.map((x) => (x.info.id === id ? { info, n: x.n } : x)));
        setActiveId((cur) => (cur === id ? info.id : cur));
        void api.deleteTerminal(id).catch(() => {});
      } catch (e) {
        toast.error(t("terminal.createFailed"), e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  if (!enabled)
    return (
      <EmptyState icon={<SquareTerminal className="size-6" />} title={t("terminal.disabled.title")} />
    );

  if (!ready || (loading && tabs.length === 0))
    return (
      <div className="space-y-2 p-4" aria-busy aria-label={t("terminal.loading")}>
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  if (error && tabs.length === 0)
    return (
      <EmptyState icon={<SquareTerminal className="size-6" />} title={t("terminal.loadFailed")} action={<Button onClick={() => void load()}>{t("app.retry")}</Button>}>
        {error}
      </EmptyState>
    );

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-1.5" role="tablist" aria-label="Terminals">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const selected = tab.info.id === activeId;
            return (
              <div
                key={tab.info.id}
                className={cn("group flex h-7 shrink-0 items-center rounded-md text-[13px]", selected ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={tab.info.cwd || undefined}
                  onClick={() => setActiveId(tab.info.id)}
                  className="h-7 rounded-l-md pl-2.5 pr-1 font-medium"
                >
                  {t("terminal.tab", { n: tab.n })}
                </button>
                <button
                  type="button"
                  aria-label={`${t("terminal.close")} ${t("terminal.tab", { n: tab.n })}`}
                  title={t("terminal.close")}
                  onClick={() => void closeTab(tab.info.id)}
                  className={cn("mr-1 flex size-5 items-center justify-center rounded text-subtle hover:bg-strong hover:text-fg", selected ? "opacity-100" : "opacity-0 focus:opacity-100 group-hover:opacity-100")}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={t("terminal.new")}
          title={t("terminal.new")}
          disabled={creating}
          onClick={() => void addTab()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <EmptyState icon={<SquareTerminal className="size-6" />} title={t("terminal.empty.title")} action={<Button variant="primary" icon={<Plus className="size-3.5" />} loading={creating} onClick={() => void addTab()}>{t("terminal.new")}</Button>} />
        ) : (
          tabs.map((tab) => {
            const selected = tab.info.id === activeId;
            return (
              <div key={tab.info.id} className={cn("absolute inset-0", !selected && "hidden")}>
                <TerminalView terminalId={tab.info.id} active={active && selected} onRestart={() => void restartTab(tab.info.id)} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
