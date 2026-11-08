import type { SearchHit } from "@agent-workstation/protocol";
import { CodeXml, MessageSquare, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import { formatShortDate, formatDateTime } from "../../lib/format";
import { parseSnippet } from "../../lib/search";
import { useSearchResults, type Column } from "../../hooks/useSearchResults";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "../ui/overlays";
import { Skeleton } from "../ui/primitives";
import { NO_AUTOFILL } from "../../lib/noAutofill";

type Kind = "keyword" | "relevant";

function Hit({ hit, kind, id, selected, onOpen, onHover }: { hit: SearchHit; kind: Kind; id: string; selected: boolean; onOpen: () => void; onHover: () => void }) {
  const s = hit.session;
  const Icon = s.kind === "chat" ? MessageSquare : CodeXml;
  const parts = kind === "keyword" ? parseSnippet(hit.snippet) : [];
  return (
    <li role="presentation">
      <button
        type="button"
        role="option"
        id={id}
        aria-selected={selected}
        data-testid="search-hit"
        data-kind={kind}
        data-session={s.id}
        onClick={onOpen}
        onMouseMove={onHover}
        className={cn("flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left", selected ? "bg-hover" : "hover:bg-hover/60")}
      >
        <span className="flex items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" data-testid="search-hit-title">
            {s.title || t("topbar.untitled")}
          </span>
          <time dateTime={hit.at} title={formatDateTime(hit.at)} className="shrink-0 text-[11px] tabular-nums text-subtle" data-testid="search-hit-date">
            {formatShortDate(hit.at)}
          </time>
        </span>
        {kind === "keyword" && parts.length > 0 && (
          <span className="line-clamp-2 break-words text-xs leading-snug text-muted" data-testid="search-snippet">
            {parts.map((p, i) => (p.mark ? <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-fg">{p.text}</mark> : <span key={i}>{p.text}</span>))}
          </span>
        )}
        {kind === "relevant" && hit.reason && (
          <span className="truncate text-xs text-muted" data-testid="search-reason" title={hit.reason}>
            {hit.reason}
          </span>
        )}
      </button>
    </li>
  );
}

function Skeletons() {
  return (
    <div className="space-y-2.5 px-2.5 py-1" aria-busy data-testid="relevant-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

function Note({ children, testid }: { children: string; testid: string }) {
  return (
    <p className="px-2.5 py-2 text-xs text-muted" data-testid={testid}>
      {children}
    </p>
  );
}

function Results({ kind, col, offset, active, setActive, open }: { kind: Kind; col: Column; offset: number; active: number; setActive: (i: number) => void; open: (hit: SearchHit) => void }) {
  const label = t(kind === "keyword" ? "search.results.keyword" : "search.results.relevant");
  return (
    <section aria-label={label} className="min-w-0" data-testid={`search-col-${kind}`}>
      <h3 className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
        {t(kind === "keyword" ? "search.keyword" : "search.relevant")}
        {col.status === "ready" && col.hits.length > 0 && <span className="font-normal normal-case tabular-nums">{col.hits.length}</span>}
      </h3>
      {kind === "relevant" && col.status === "loading" ? (
        <Skeletons />
      ) : col.status === "unavailable" ? (
        <Note testid="search-unavailable">{t("search.unavailable.relevant")}</Note>
      ) : col.status === "error" ? (
        <Note testid={`search-error-${kind}`}>{t("search.failed")}</Note>
      ) : col.status === "idle" ? null : col.hits.length === 0 ? (
        col.status === "ready" ? <Note testid={`search-empty-${kind}`}>{t(kind === "keyword" ? "search.empty.keyword" : "search.empty.relevant")}</Note> : null
      ) : (
        <ul role="listbox" aria-label={label} className="space-y-px">
          {col.hits.map((hit, i) => (
            <Hit key={hit.session.id} hit={hit} kind={kind} id={`search-${kind}-${i}`} selected={active === offset + i} onOpen={() => open(hit)} onHover={() => setActive(offset + i)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * ⌘K / sidebar "Search": one input, two result columns side by side (stacked on narrow screens): "Keyword" follows the
 * typing, "Relevant" is the ranking by meaning, asked for once typing has paused. Arrow keys walk the left list and
 * then the right one, Enter opens the session, Esc closes.
 */
export function SearchDialog() {
  const open = useApp((s) => s.searchOpen);
  const setOpen = useApp((s) => s.setSearchOpen);
  const rankDown = useApp((s) => !!s.me && s.me.apiAvailable !== true);
  const setMode = useApp((s) => s.setMode);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { keyword, relevant } = useSearchResults(query, { enabled: open, rankDown });

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);

  // the keyboard order is the left list, then the right one
  const flat = useMemo(() => [...keyword.hits, ...relevant.hits], [keyword.hits, relevant.hits]);
  const current = Math.min(active, Math.max(0, flat.length - 1));

  const activeId = flat.length === 0 ? undefined : current < keyword.hits.length ? `search-keyword-${current}` : `search-relevant-${current - keyword.hits.length}`;
  useEffect(() => {
    if (activeId) listRef.current?.querySelector<HTMLElement>(`#${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const openHit = (hit: SearchHit) => {
    setOpen(false);
    setMode(hit.session.kind);
    navigate(`/s/${hit.session.id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(flat.length - 1, current + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, current - 1));
    } else if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      e.preventDefault();
      const hit = flat[current];
      if (hit) openHit(hit);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay className="anim-fade fixed inset-0 z-[110] bg-black/40" />
        <DialogContent
          className="anim-pop fixed left-1/2 top-[10vh] z-[111] w-[calc(100vw-24px)] max-w-4xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-pop)]"
          aria-describedby={undefined}
          data-testid="search-dialog"
        >
          <DialogTitle className="sr-only">{t("search.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("search.placeholder")}</DialogDescription>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 text-subtle" />
            <input {...NO_AUTOFILL}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("search.placeholder")}
              aria-label={t("search.title")}
              role="combobox"
              aria-expanded
              aria-controls="search-results"
              aria-activedescendant={activeId}
              data-testid="search-input"
              className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-subtle"
            />
          </div>
          <div ref={listRef} id="search-results" className="max-h-[66vh] overflow-y-auto p-1.5">
            {/* narrow: one column, Keyword above Relevant; from 640px: side by side */}
            <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2" data-testid="search-columns">
              <Results kind="keyword" col={keyword} offset={0} active={current} setActive={setActive} open={openHit} />
              <Results kind="relevant" col={relevant} offset={keyword.hits.length} active={current} setActive={setActive} open={openHit} />
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
}
