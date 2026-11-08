import { Check, FolderTree, Ghost, Globe, GitCompare, History, LayoutList, MessageSquare, PanelLeftOpen, PanelRight, RefreshCw, Square, SquareTerminal, CodeXml } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Session, SessionKind } from "@agent-workstation/protocol";
import { cn } from "../../lib/cn";
import { isBusyStatus } from "../../lib/session-reducer";
import { useSyncProjectId, useSyncStatus } from "../../lib/sync";
import { t } from "../../i18n";
import { recallSession, useApp, type RightTab } from "../../store/app";
import { renameSession, stopSession } from "../../store/actions";
import { useComposer } from "../../store/composer";
import { useSessions } from "../../store/sessions";
import { IconButton } from "../ui/primitives";
import { Tip } from "../ui/overlays";
import { NO_AUTOFILL } from "../../lib/noAutofill";

function TitleEditor({ session }: { session: Session }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(session.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(session.title), [session.title]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== session.title) void renameSession(session.id, next);
    else setValue(session.title);
  };
  if (editing) {
    return (
      <input {...NO_AUTOFILL}
        ref={ref}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setValue(session.title);
            setEditing(false);
          }
        }}
        aria-label={t("topbar.rename")}
        maxLength={200}
        className="h-8 w-full max-w-md rounded-lg border border-accent bg-surface px-2 text-sm font-medium outline-none"
      />
    );
  }
  return (
    <Tip label={t("topbar.rename")}>
      <button type="button" onClick={() => setEditing(true)} className="max-w-full truncate rounded-lg px-2 py-1 text-left text-sm font-medium hover:bg-hover" data-testid="session-title">
        {session.title || t("topbar.untitled")}
      </button>
    </Tip>
  );
}

const PANELS: Array<{ tab: RightTab; icon: typeof FolderTree; label: "topbar.panel.overview" | "topbar.panel.files" | "topbar.panel.changes" | "topbar.panel.history" | "topbar.panel.terminal" | "topbar.panel.browser" | "topbar.panel.sync" }> = [
  { tab: "overview", icon: LayoutList, label: "topbar.panel.overview" },
  { tab: "files", icon: FolderTree, label: "topbar.panel.files" },
  { tab: "changes", icon: GitCompare, label: "topbar.panel.changes" },
  { tab: "history", icon: History, label: "topbar.panel.history" },
  { tab: "terminal", icon: SquareTerminal, label: "topbar.panel.terminal" },
  { tab: "browser", icon: Globe, label: "topbar.panel.browser" },
  { tab: "sync", icon: RefreshCw, label: "topbar.panel.sync" },
];

export function ModeToggle() {
  const mode = useApp((s) => s.mode);
  const setMode = useApp((s) => s.setMode);
  const navigate = useNavigate();
  const sessions = useSessions((s) => s.sessions);
  const choose = (next: SessionKind) => {
    if (next === mode) return;
    setMode(next);
    const last = recallSession(next);
    navigate(last && sessions[last] ? `/s/${last}` : "/");
  };
  return (
    <div role="radiogroup" aria-label="Mode" className="flex rounded-lg bg-active p-0.5">
      {(["chat", "code"] as const).map((k) => {
        const Icon = k === "chat" ? MessageSquare : CodeXml;
        const active = mode === k;
        return (
          <Tip key={k} label={t(k === "chat" ? "topbar.mode.chat" : "topbar.mode.code")}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={t(k === "chat" ? "topbar.mode.chat" : "topbar.mode.code")}
              onClick={() => choose(k)}
              data-testid={`mode-${k}`}
              className={cn("flex h-7 w-9 items-center justify-center rounded-md transition-colors", active ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
            >
              <Icon className="size-4" />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** The ghost toggle on a new chat: the chat is created incognito (never listed, searched or remembered; deleted when left). */
export function IncognitoToggle() {
  const on = useComposer((s) => s.newIncognito);
  const set = useComposer((s) => s.setNewIncognito);
  return (
    <Tip label={t("incognito.toggle")}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t("incognito.label")}
        onClick={() => set(!on)}
        data-testid="incognito-toggle"
        className={cn("ml-1 flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors", on ? "bg-active font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}
      >
        <Ghost className="size-3.5" />
        <span className="max-sm:hidden">{t("incognito.label")}</span>
      </button>
    </Tip>
  );
}

/** One quiet line in the header of an incognito chat. */
export function IncognitoChip() {
  return (
    <span className="ml-1.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-active px-2 py-0.5 text-[11.5px] font-medium text-fg" data-testid="incognito-chip">
      <Ghost className="size-3" aria-hidden />
      {t("incognito.label")}
    </span>
  );
}

export function TopBar({ session, narrow }: { session: Session | null; narrow: boolean }) {
  const mode = useApp((s) => s.mode);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const rightOpen = useApp((s) => s.rightOpen);
  const rightTab = useApp((s) => s.rightTab);
  const setRight = useApp((s) => s.setRight);
  const busy = isBusyStatus(session?.status);
  // The Sync tab exists only in AgentWorkstation.app, for a project linked on this Mac.
  // A new Code draft has no session yet: its project comes from the draft's folder.
  const draftProjectId = useSyncProjectId(null);
  const syncStatus = useSyncStatus(session ? (session.projectId ?? null) : draftProjectId).status;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg px-3">
      {(!sidebarOpen || narrow) && (
        <Tip label={t("sidebar.expand")} shortcut={t("shortcut.sidebar")}>
          <IconButton label={t("sidebar.expand")} onClick={() => toggleSidebar(true)}>
            <PanelLeftOpen className="size-4" />
          </IconButton>
        </Tip>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        {session ? (
          <>
            <TitleEditor session={session} />
            {session.incognito && <IncognitoChip />}
          </>
        ) : (
          <>
            <span className="px-2 text-sm font-medium text-muted">{t(mode === "chat" ? "sidebar.newChat" : "sidebar.newSession")}</span>
            {mode === "chat" && <IncognitoToggle />}
          </>
        )}
      </div>

      {busy && session && (
        <Tip label={t("topbar.stop")} shortcut={t("shortcut.stop")}>
          <button type="button" onClick={() => void stopSession(session.id)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] text-muted hover:bg-hover hover:text-fg">
            <Square className="size-3 fill-current" />
            {t("topbar.stop")}
          </button>
        </Tip>
      )}

      <ModeToggle />

      {!narrow && (
        <div className="ml-1 flex items-center gap-0.5 border-l border-line pl-2">
          {PANELS.filter((p) => (mode === "code" && (p.tab !== "sync" || !!syncStatus)) || p.tab === "overview").map(({ tab, icon: Icon, label }) => {
            // Chat has only the overview, whatever tab Code last had open
            const active = rightOpen && (mode === "code" ? rightTab : "overview") === tab;
            return (
              <Tip key={tab} label={t(label)}>
                <IconButton label={t(label)} active={active} onClick={() => setRight(active ? false : true, tab)} data-testid={`panel-${tab}`}>
                  <span className="relative flex">
                    <Icon className="size-4" />
                    {tab === "sync" && !!syncStatus?.pending && (
                      <span className="absolute -right-2 -top-2 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-fg" data-testid="sync-badge">{syncStatus.pending}</span>
                    )}
                  </span>
                </IconButton>
              </Tip>
            );
          })}
        </div>
      )}
      {narrow && (
        <Tip label={t("topbar.panel.toggle")}>
          <IconButton label={t("topbar.panel.toggle")} active={rightOpen} onClick={() => setRight(!rightOpen)}>
            {rightOpen ? <Check className="size-4" /> : <PanelRight className="size-4" />}
          </IconButton>
        </Tip>
      )}
    </header>
  );
}
