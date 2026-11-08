import { FolderTree, GitCompare, History, Globe, LayoutList, RefreshCw, SquareTerminal, X } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { t } from "../../i18n";
import { useApp, type RightTab } from "../../store/app";
import { HistoryTab } from "../changes/HistoryTab";
import { useSyncProjectId, useSyncStatus } from "../../lib/sync";
import { FilesTab } from "../files/FilesTab";
import { OverviewTab } from "../overview/OverviewTab";
import { SyncTab } from "../sync/SyncTab";
import { IconButton, Spinner } from "../ui/primitives";

// The merge view (CodeMirror) and xterm are only needed once their tabs are opened.
const ChangesTab = lazy(() => import("../changes/ChangesTab").then((m) => ({ default: m.ChangesTab })));
const TerminalTab = lazy(() => import("../terminal/TerminalTab").then((m) => ({ default: m.TerminalTab })));
const BrowserTab = lazy(() => import("../browser/BrowserTab").then((m) => ({ default: m.BrowserTab })));

const TABS: Array<{ tab: RightTab; icon: typeof FolderTree; label: "topbar.panel.overview" | "topbar.panel.files" | "topbar.panel.changes" | "topbar.panel.history" | "topbar.panel.terminal" | "topbar.panel.browser" | "topbar.panel.sync" }> = [
  { tab: "overview", icon: LayoutList, label: "topbar.panel.overview" },
  { tab: "files", icon: FolderTree, label: "topbar.panel.files" },
  { tab: "changes", icon: GitCompare, label: "topbar.panel.changes" },
  { tab: "history", icon: History, label: "topbar.panel.history" },
  { tab: "terminal", icon: SquareTerminal, label: "topbar.panel.terminal" },
  { tab: "browser", icon: Globe, label: "topbar.panel.browser" },
  { tab: "sync", icon: RefreshCw, label: "topbar.panel.sync" },
];

export function RightPanel({ sessionId, overlay }: { sessionId: string | null; overlay: boolean }) {
  const mode = useApp((s) => s.mode);
  // Chat sessions have only the overview (no workspace, terminal or browser).
  const code = mode === "code";
  // The Sync tab exists only in AgentWorkstation.app, for a project linked on this Mac.
  const projectId = useSyncProjectId(sessionId);
  const syncStatus = useSyncStatus(projectId).status;
  const syncOn = !!syncStatus;
  const stored = useApp((s) => (s.mode === "code" ? s.rightTab : "overview"));
  const tab = stored === "sync" && !syncOn ? "files" : stored;
  const width = useApp((s) => s.rightWidth);
  const setRight = useApp((s) => s.setRight);
  const setRightWidth = useApp((s) => s.setRightWidth);
  // Tabs with live state (terminal socket, open diff) stay mounted after the first visit so they survive tab switches.
  const [seen, setSeen] = useState<Record<RightTab, boolean>>(() => ({ overview: true, files: true, changes: tab === "changes", history: tab === "history", terminal: tab === "terminal", browser: tab === "browser", sync: tab === "sync" }));
  useEffect(() => {
    setSeen((s) => (s[tab] ? s : { ...s, [tab]: true }));
  }, [tab]);

  const dragging = useRef(false);
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const w = window.innerWidth - e.clientX;
      setRightWidth(Math.max(280, Math.min(Math.round(window.innerWidth * 0.7), w)));
    },
    [setRightWidth],
  );
  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <aside
      className={cn("@container flex h-full shrink-0 flex-col border-l border-line bg-bg", overlay ? "absolute right-0 top-0 z-30 shadow-[var(--shadow-pop)]" : "relative")}
      style={{ width: overlay ? "min(92vw, 460px)" : `min(${width}px, max(300px, calc(100vw - 660px)))` }}
      aria-label="Right panel"
    >
      {!overlay && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/20 active:bg-accent/30"
        />
      )}
      {!overlay ? (
        // The top bar already holds the tab buttons: the panel only names the open tab.
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-3" data-testid="right-panel-title">
          {(() => {
            const cur = TABS.find((x) => x.tab === tab) ?? TABS[0]!;
            const Icon = cur.icon;
            return (
              <>
                <Icon className="size-3.5 text-muted" />
                <h2 className="text-[13px] font-medium text-fg">{t(cur.label)}</h2>
              </>
            );
          })()}
          <IconButton label={t("right.close")} size="xs" className="ml-auto" onClick={() => setRight(false)}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      ) : (
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-2" role="tablist">
        {TABS.filter((x) => (code && (x.tab !== "sync" || syncOn)) || x.tab === "overview").map(({ tab: id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setRight(true, id)}
            title={t(label)}
            className={cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted hover:bg-hover hover:text-fg", tab === id && "bg-active text-fg")}
          >
            <Icon className="size-3.5" />
            <span className={cn(tab !== id && "hidden @[420px]:inline")}>{t(label)}</span>
            {id === "sync" && !!syncStatus?.pending && <span className="min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-fg" data-testid="sync-tab-badge">{syncStatus.pending}</span>}
          </button>
        ))}
        <IconButton label={t("right.close")} size="xs" className="ml-auto" onClick={() => setRight(false)}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      )}
      <div className="min-h-0 flex-1">
        {tab === "overview" && <OverviewTab sessionId={sessionId} />}
        {code && (
          <div className={cn("h-full", tab !== "files" && "hidden")}>
            <FilesTab sessionId={sessionId} />
          </div>
        )}
        {code && seen.changes && (
          <div className={cn("h-full", tab !== "changes" && "hidden")} data-testid="changes-panel">
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
              <ChangesTab sessionId={sessionId} />
            </Suspense>
          </div>
        )}
        {code && seen.history && (
          <div className={cn("h-full", tab !== "history" && "hidden")} data-testid="history-panel">
            <HistoryTab sessionId={sessionId} />
          </div>
        )}
        {code && seen.terminal && (
          <div className={cn("h-full", tab !== "terminal" && "hidden")}>
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
              <TerminalTab active={tab === "terminal"} />
            </Suspense>
          </div>
        )}
        {code && syncOn && projectId && seen.sync && (
          <div className={cn("h-full", tab !== "sync" && "hidden")} data-testid="sync-panel">
            <SyncTab key={projectId} projectId={projectId} />
          </div>
        )}
        {code && seen.browser && (
          <div className={cn("h-full", tab !== "browser" && "hidden")} data-testid="browser-panel">
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
              <BrowserTab active={tab === "browser"} />
            </Suspense>
          </div>
        )}
      </div>
    </aside>
  );
}
