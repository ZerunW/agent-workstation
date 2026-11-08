import { BarChart3, Bell, BookMarked, BookOpen, ChevronDown, Ellipsis, FolderGit2, FolderOpen, Globe, MessageSquare, PanelLeftClose, Pencil, Plus, ScrollText, Search, Settings, Shield, SlidersHorizontal, Sparkles, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import type { Session } from "@agent-workstation/protocol";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { groupSessions } from "../../lib/groups";
import { t } from "../../i18n";
import { useApp, usageSeverity, type Theme } from "../../store/app";
import { useComposer } from "../../store/composer";
import { useProjects } from "../../store/projects";
import { useSessions } from "../../store/sessions";
import { listable } from "../../store/incognito";
import { deleteSession, renameSession, setNotificationsEnabled } from "../../store/actions";
import { Switch } from "../admin/Switch";
import { Skeleton, IconButton } from "../ui/primitives";
import { ConfirmDialog, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Tip } from "../ui/overlays";
import { SessionDefaultsDialog } from "./SessionDefaultsDialog";
import { NO_AUTOFILL } from "../../lib/noAutofill";

const topItem = "flex h-8 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-muted hover:bg-hover hover:text-fg";
const footerItem = "relative flex h-8 min-w-0 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted hover:bg-hover hover:text-fg";

function StatusDot({ status }: { status: Session["status"] }) {
  if (status === "idle" || status === "dead") return null;
  const label = status === "running" ? t("sidebar.running") : status === "queued" ? t("sidebar.queued") : t("sidebar.needsInput");
  const color = status === "running" ? "bg-ok" : status === "queued" ? "bg-subtle" : "bg-warn";
  return (
    <span title={label} aria-label={label} role="img" className="relative flex size-2 shrink-0">
      {status !== "queued" && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", color)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}

function SessionRow({ session, active, onNavigate }: { session: Session; active: boolean; onNavigate: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [confirm, setConfirm] = useState(false);
  // The menu is anchored to its button: keep the button laid out while the menu is open (focus and the pointer are in
  // the menu then, so the row's hover/focus styles no longer apply), or the menu would jump to the window's corner.
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setTitle(session.title), [session.title]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = title.trim();
    if (next && next !== session.title) void renameSession(session.id, next);
    else setTitle(session.title);
  };

  return (
    <li className="group relative">
      {editing ? (
        <input {...NO_AUTOFILL}
          ref={inputRef}
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setTitle(session.title);
              setEditing(false);
            }
          }}
          aria-label={t("sidebar.rename")}
          className="mx-1 h-8 w-[calc(100%-8px)] rounded-lg border border-accent bg-surface px-2 text-[13px] outline-none"
        />
      ) : (
        <NavLink
          to={`/s/${session.id}`}
          onClick={onNavigate}
          onDoubleClick={() => setEditing(true)}
          className={cn("flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-fg", active ? "bg-active" : "hover:bg-hover")}
          aria-current={active ? "page" : undefined}
        >
          <span className="min-w-0 flex-1 truncate">{session.title || t("topbar.untitled")}</span>
          <StatusDot status={session.status} />
          <span className={cn("shrink-0 text-[11px] text-subtle group-hover:hidden group-focus-within:hidden", menuOpen && "hidden")}>{relativeTime(session.lastActiveAt)}</span>
        </NavLink>
      )}
      {!editing && (
        <div className={cn("absolute right-1 top-1 group-focus-within:block group-hover:block", menuOpen ? "block" : "hidden")}>
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger asChild>
              <button type="button" aria-label="Session menu" className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-strong hover:text-fg">
                <Ellipsis className="size-4" />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<Pencil className="size-3.5" />} onSelect={() => setEditing(true)}>
                {t("sidebar.rename")}
              </MenuItem>
              <MenuItem danger icon={<Trash2 className="size-3.5" />} onSelect={() => setConfirm(true)}>
                {t("sidebar.deleteSession")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title={t("sidebar.deleteConfirmTitle")}
        description={t("sidebar.deleteConfirmBody", { title: session.title })}
        confirmLabel={t("app.delete")}
        cancelLabel={t("app.cancel")}
        onConfirm={async () => {
          const ok = await deleteSession(session.id);
          if (ok && active) navigate("/");
        }}
      />
    </li>
  );
}

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const mode = useApp((s) => s.mode);
  const user = useApp((s) => s.user);
  const me = useApp((s) => s.me);
  const notificationsOn = me?.user.notificationsEnabled !== false;
  const limits = useApp((s) => s.limits);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const sessions = useSessions((s) => s.sessions);
  const listLoaded = useSessions((s) => s.listLoaded);
  const setNewCwd = useComposer((s) => s.setNewCwd);
  const requestFocus = useComposer((s) => s.requestFocus);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const projects = useProjects((s) => s.list);
  const sev = usageSeverity(limits);

  // incognito chats never show here (the hub does not list them; this covers the one just created in this tab)
  const groups = useMemo(() => groupSessions(listable(Object.values(sessions)), mode, "", new Date(), projects), [sessions, mode, projects]);

  const startNew = (cwd = "") => {
    setNewCwd(cwd);
    navigate("/");
    requestFocus();
    onNavigate();
  };

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-sidebar" aria-label="Sessions">
      <div className="flex items-center gap-1 px-2 pt-2.5">
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left hover:bg-hover" aria-label={t("sidebar.signedInAs")}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-semibold uppercase text-accent-fg">{user?.[0] ?? "?"}</span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{user}</span>
              <ChevronDown className="size-3.5 text-subtle" />
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>{t("sidebar.signedInAs")}</MenuLabel>
            <div className="px-2.5 pb-1.5 text-[13px] font-medium">{user}</div>
            <MenuSeparator />
            <MenuItem icon={<Users className="size-3.5" />} onSelect={() => navigate("/login")}>
              {t("login.switchUser")}
            </MenuItem>
          </MenuContent>
        </Menu>
        <SessionDefaultsDialog open={defaultsOpen} onOpenChange={setDefaultsOpen} />
        <Tip label={t("sidebar.collapse")} shortcut={t("shortcut.sidebar")}>
          <IconButton label={t("sidebar.collapse")} onClick={() => toggleSidebar(false)}>
            <PanelLeftClose className="size-4" />
          </IconButton>
        </Tip>
      </div>

      {/* The top list, like the Claude desktop app: New, Search, Projects (Artifacts and Scheduled come later). Settings live in the gear menu. */}
      <nav className="flex flex-col gap-px px-2 pb-1 pt-2" aria-label="Main" data-testid="sidebar-top">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => startNew(useComposer.getState().newCwd)} className={cn(topItem, "flex-1 text-fg")} data-testid="nav-new" aria-label={mode === "chat" ? t("sidebar.newChat") : t("sidebar.newSession")}>
            <Plus className="size-4 shrink-0 text-accent" />
            <span className="flex-1 truncate text-left">{t("nav.new")}</span>
            <kbd className="font-mono text-[10.5px] text-subtle">{t("shortcut.newSession")}</kbd>
          </button>
          {mode === "code" && (
            <Menu>
              <MenuTrigger asChild>
                <IconButton label={t("sidebar.newIn")} data-testid="nav-new-in">
                  <ChevronDown className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>{t("sidebar.newIn")}</MenuLabel>
                <MenuItem icon={<FolderOpen className="size-3.5" />} onSelect={() => startNew("")}>
                  {t("sidebar.workspace")}
                </MenuItem>
                {projects.map((p) => (
                  <MenuItem key={p.id} icon={<FolderOpen className="size-3.5" />} onSelect={() => startNew(p.path)}>
                    {p.name}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )}
        </div>
        <button type="button" onClick={() => (setSearchOpen(true), onNavigate())} className={topItem} data-testid="nav-search">
          <Search className="size-4 shrink-0" />
          <span className="flex-1 truncate text-left">{t("nav.search")}</span>
          <kbd className="font-mono text-[10.5px] text-subtle">{t("shortcut.search")}</kbd>
        </button>
        <NavLink to="/projects" onClick={onNavigate} data-testid="nav-projects" className={({ isActive }) => cn(topItem, isActive && "bg-active text-fg")}>
          <FolderGit2 className="size-4 shrink-0" />
          <span className="truncate">{t("nav.projects")}</span>
        </NavLink>
      </nav>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Session list">
        {!listLoaded ? (
          <div className="space-y-2 px-1 pt-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-[13px] leading-relaxed text-muted">
            <MessageSquare className="mx-auto mb-2 size-5 text-subtle" />
            {mode === "chat" ? t("sidebar.noSessions.chat") : t("sidebar.noSessions.code")}
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="mb-2" data-testid="session-group" data-group={g.bucket ?? (g.label || "workspace")}>
              <div className="group/h flex items-center gap-1 px-2.5 pb-1 pt-2">
                <h3 className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-subtle">
                  {g.bucket ? t(`sidebar.group.${g.bucket}` as const) : g.label || t("sidebar.workspace")}
                </h3>
                {mode === "code" && g.projectId && (projects.find((p) => p.id === g.projectId)?.pendingFiles ?? 0) > 0 && (
                  <Link
                    to={`/projects/${g.projectId}`}
                    onClick={onNavigate}
                    title={t("changes.count", { n: projects.find((p) => p.id === g.projectId)?.pendingFiles ?? 0 })}
                    className="rounded-full bg-warn-soft px-1.5 text-[10.5px] font-semibold tabular-nums text-warn hover:underline"
                    data-testid="group-pending"
                  >
                    {projects.find((p) => p.id === g.projectId)?.pendingFiles}
                  </Link>
                )}
                {mode === "code" && (
                  <button type="button" aria-label={`${t("sidebar.newSession")} — ${g.label || t("sidebar.workspace")}`} onClick={() => startNew(g.cwd ?? "")} className="rounded p-0.5 text-subtle opacity-0 hover:bg-hover hover:text-fg group-hover/h:opacity-100 focus-visible:opacity-100">
                    <Plus className="size-3.5" />
                  </button>
                )}
              </div>
              <ul className="space-y-px">
                {g.sessions.map((s) => (
                  <SessionRow key={s.id} session={s} active={s.id === sessionId} onNavigate={onNavigate} />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>

      {/* Footer: Usage, Admin (admins) and the settings gear flush right. */}
      <div className="flex items-center gap-0.5 border-t border-line p-2" data-testid="sidebar-footer">
        <NavLink to="/usage" onClick={onNavigate} className={({ isActive }) => cn(footerItem, isActive && "bg-active text-fg")}>
          <BarChart3 className="size-4 shrink-0" />
          <span className="truncate">{t("sidebar.usage")}</span>
          {sev !== "normal" && <span aria-label={sev} className="absolute left-6 top-1.5 size-2 rounded-full bg-danger ring-2 ring-sidebar" data-testid="usage-dot" />}
        </NavLink>
        {me?.user.isAdmin && (
          <NavLink to="/admin" onClick={onNavigate} data-testid="nav-admin" className={({ isActive }) => cn(footerItem, isActive && "bg-active text-fg")}>
            <Shield className="size-4 shrink-0" />
            <span className="truncate">{t("sidebar.admin")}</span>
          </NavLink>
        )}
        <div className="ml-auto shrink-0">
          <Menu>
            <Tip label={t("sidebar.settings")}>
              <MenuTrigger asChild>
                <IconButton label={t("sidebar.settings")}>
                  <Settings className="size-4" />
                </IconButton>
              </MenuTrigger>
            </Tip>
            <MenuContent align="end" side="top">
              <MenuLabel>Theme</MenuLabel>
              <MenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                <MenuRadioItem value="system">System</MenuRadioItem>
                <MenuRadioItem value="light">Light</MenuRadioItem>
                <MenuRadioItem value="dark">Dark</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem
                icon={<Bell className="size-3.5" />}
                onSelect={(e) => {
                  e.preventDefault(); // the menu stays open
                  void setNotificationsEnabled(!notificationsOn);
                }}
                data-testid="menu-notifications"
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{t("overview.notifications")}</span>
                  <span className="pointer-events-none" aria-hidden>
                    <Switch checked={notificationsOn} onChange={() => {}} label={t("overview.notifications")} testId="menu-notifications-switch" />
                  </span>
                </span>
              </MenuItem>
              <MenuItem icon={<SlidersHorizontal className="size-3.5" />} onSelect={() => setDefaultsOpen(true)} data-testid="menu-session-defaults">
                {t("defaults.menu")}
              </MenuItem>
              <MenuItem icon={<ScrollText className="size-3.5" />} onSelect={() => navigate("/instructions")} data-testid="menu-instructions">
                {t("instructions.menu")}
              </MenuItem>
              <MenuItem icon={<BookMarked className="size-3.5" />} onSelect={() => navigate("/memory")} data-testid="menu-memory">
                {t("memory.menu")}
              </MenuItem>
              <MenuItem icon={<Sparkles className="size-3.5" />} onSelect={() => navigate("/skills")} data-testid="menu-skills">
                {t("skills.menu")}
              </MenuItem>
              <MenuItem icon={<Globe className="size-3.5" />} onSelect={() => navigate("/browser-sites")} data-testid="menu-browser-sites">
                {t("sites.menu")}
              </MenuItem>
              <MenuItem icon={<BookOpen className="size-3.5" />} onSelect={() => navigate("/readme")} data-testid="menu-docs">
                {t("readme.menu")}
              </MenuItem>
              <MenuItem icon={<Users className="size-3.5" />} onSelect={() => navigate("/login")}>
                {t("login.switchUser")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
    </aside>
  );
}
