import { BarChart3, CodeXml, FolderTree, MessageSquare, PanelLeft, Plus, Search, Shield, SquareTerminal, Square, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fuzzyMatch } from "../../lib/fuzzy";
import { relativeTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { t } from "../../i18n";
import { recallSession, useApp } from "../../store/app";
import { useComposer } from "../../store/composer";
import { listable } from "../../store/incognito";
import { useSessions } from "../../store/sessions";
import { stopSession } from "../../store/actions";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "../ui/overlays";
import { NO_AUTOFILL } from "../../lib/noAutofill";

interface Entry {
  id: string;
  group: "sessions" | "actions";
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const sessions = useSessions((s) => s.sessions);
  const me = useApp((s) => s.me);
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const app = useApp.getState();
    const close = () => app.setPaletteOpen(false);
    const act = (label: string, icon: ReactNode, run: () => void, hint?: string): Entry => ({ id: `a:${label}`, group: "actions", label, icon, hint, run: () => (close(), run()) });
    const actions: Entry[] = [
      act(t("palette.action.newSession"), <Plus className="size-4" />, () => {
        navigate("/");
        useComposer.getState().requestFocus();
      }, t("shortcut.newSession")),
      act(t("palette.action.toggleSidebar"), <PanelLeft className="size-4" />, () => app.toggleSidebar(), t("shortcut.sidebar")),
      act(t("palette.action.modeChat"), <MessageSquare className="size-4" />, () => switchMode("chat")),
      act(t("palette.action.modeCode"), <CodeXml className="size-4" />, () => switchMode("code")),
      act(t("palette.action.files"), <FolderTree className="size-4" />, () => (app.setMode("code"), app.setRight(true, "files"))),
      act(t("palette.action.terminal"), <SquareTerminal className="size-4" />, () => (app.setMode("code"), app.setRight(true, "terminal"))),
      act(t("palette.action.usage"), <BarChart3 className="size-4" />, () => navigate("/usage")),
      act(t("palette.action.switchUser"), <Users className="size-4" />, () => navigate("/login")),
    ];
    if (me?.user.isAdmin) actions.push(act(t("palette.action.admin"), <Shield className="size-4" />, () => navigate("/admin")));
    if (sessionId) actions.push(act(t("palette.action.stop"), <Square className="size-4" />, () => void stopSession(sessionId), t("shortcut.stop")));

    function switchMode(kind: "chat" | "code") {
      app.setMode(kind);
      const last = recallSession(kind);
      navigate(last && useSessions.getState().sessions[last] ? `/s/${last}` : "/");
    }

    const sess: Entry[] = listable(Object.values(sessions))
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
      .map((s) => ({
        id: `s:${s.id}`,
        group: "sessions" as const,
        label: s.title || t("topbar.untitled"),
        hint: `${s.kind === "chat" ? t("topbar.mode.chat") : t("topbar.mode.code")} · ${relativeTime(s.lastActiveAt)}`,
        icon: s.kind === "chat" ? <MessageSquare className="size-4" /> : <CodeXml className="size-4" />,
        run: () => {
          useApp.getState().setPaletteOpen(false);
          useApp.getState().setMode(s.kind);
          navigate(`/s/${s.id}`);
        },
      }));
    return [...sess, ...actions];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, me, sessionId, open]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return [...entries.filter((e) => e.group === "sessions").slice(0, 8), ...entries.filter((e) => e.group === "actions")];
    return entries
      .map((e) => ({ e, m: fuzzyMatch(q, e.label) }))
      .filter((x): x is { e: Entry; m: NonNullable<typeof x.m> } => !!x.m)
      .sort((a, b) => b.m.score - a.m.score)
      .map((x) => x.e)
      .slice(0, 30);
  }, [entries, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[index]?.run();
    }
  };

  let lastGroup = "";
  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay className="anim-fade fixed inset-0 z-[110] bg-black/40" />
        <DialogContent className="anim-pop fixed left-1/2 top-[16vh] z-[111] w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-pop)]" aria-describedby={undefined}>
          <DialogTitle className="sr-only">{t("palette.placeholder")}</DialogTitle>
          <DialogDescription className="sr-only">{t("palette.placeholder")}</DialogDescription>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 text-subtle" />
            <input {...NO_AUTOFILL} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder={t("palette.placeholder")} aria-label={t("palette.placeholder")} className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-subtle" role="combobox" aria-expanded aria-controls="palette-list" />
          </div>
          <ul id="palette-list" ref={listRef} role="listbox" className="max-h-[48vh] overflow-y-auto p-1.5">
            {filtered.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">{t("palette.empty")}</li>}
            {filtered.map((e, i) => {
              const header = e.group !== lastGroup ? (lastGroup = e.group) : null;
              return (
                <li key={e.id} role="presentation">
                  {header && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{t(e.group === "sessions" ? "palette.sessions" : "palette.actions")}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === index}
                    data-idx={i}
                    onMouseMove={() => setIndex(i)}
                    onClick={e.run}
                    className={cn("flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px]", i === index && "bg-hover")}
                  >
                    <span className="text-muted">{e.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                    {e.hint && <span className="shrink-0 text-xs text-subtle">{e.hint}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
}
