import { AlertCircle, Check, ChevronRight, History, Loader2 } from "lucide-react";
import { useState } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import { isSessionId, readTargetOf, searchQueryOf, titleFromResult, type PastChatTool } from "../../lib/pastChats";
import { t } from "../../i18n";
import { useSessions } from "../../store/sessions";

export type PastChatState = "streaming" | "pending" | "done" | "failed";

interface Props {
  kind: PastChatTool;
  /** search: the query; read: the session title (or its id when the title is unknown). */
  label: string;
  /** read: the session to open on click. */
  sessionId?: string;
  result?: string;
  state: PastChatState;
}

function Card({ kind, label, sessionId, result, state, open: openSession }: Props & { open?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const live = state === "streaming" || state === "pending";
  const head = t(kind === "search" ? (live ? "pastChats.searching" : "pastChats.searched") : live ? "pastChats.reading" : "pastChats.read");
  const canOpen = kind === "read" && !!openSession && !!sessionId && isSessionId(sessionId);
  const status = live ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" aria-label={t("tx.tool.running")} /> : state === "failed" ? <AlertCircle className="size-3.5 shrink-0 text-danger" aria-label={t("tx.tool.error")} /> : <Check className="size-3.5 shrink-0 text-ok" />;
  const title = (
    <>
      <span className="font-medium">{head}</span>
      {label && <span className="text-muted"> · {label}</span>}
    </>
  );
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-surface/60 text-[13px]", state === "failed" ? "border-danger/40" : "border-line")} data-testid="pastchat-card" data-kind={kind} data-state={state}>
      <div className="flex items-center hover:bg-hover">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t("pastChats.result")} className="flex shrink-0 items-center gap-2 py-1.5 pl-3 pr-2" data-testid="pastchat-toggle">
          <ChevronRight className={cn("size-3.5 text-subtle transition-transform", open && "rotate-90")} />
          <History className="size-3.5 text-muted" />
        </button>
        {canOpen ? (
          <button type="button" onClick={() => openSession!(sessionId!)} title={t("pastChats.open")} className="min-w-0 flex-1 truncate py-1.5 text-left hover:underline" data-testid="pastchat-open">
            {title}
          </button>
        ) : (
          <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 truncate py-1.5 text-left" tabIndex={-1}>
            {title}
          </button>
        )}
        <span className="shrink-0 py-1.5 pl-2 pr-3">{status}</span>
      </div>
      {open && (
        <div className="border-t border-line px-3 py-3" data-testid="pastchat-result">
          {result ? (
            <pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed", state === "failed" ? "text-danger" : "text-muted")}>{result}</pre>
          ) : (
            <div className="text-xs text-subtle">{live ? t("tx.tool.running") : t("pastChats.noResult")}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Linked(props: Props) {
  const navigate = useNavigate();
  return <Card {...props} open={(id) => navigate(`/s/${id}`)} />;
}

/**
 * Compact stand-in for the history tools: "Searched past chats · <query>" and "Read · <session title or id>", the result one
 * click away. A read chip opens that session when the transcript runs inside a router (the embed shows a plain chip).
 */
export function PastChatCard(props: Props) {
  const inRouter = useInRouterContext();
  return inRouter ? <Linked {...props} /> : <Card {...props} />;
}

/** The card for one tool call: the query, or the session's title (from the sidebar's data, else the result, else its id). */
export function PastChatToolCard({ kind, input, result, state }: { kind: PastChatTool; input: unknown; result?: string; state: PastChatState }) {
  const id = kind === "read" ? readTargetOf(input) : "";
  const known = useSessions((s) => (id ? s.sessions[id]?.title : undefined));
  const label = kind === "search" ? searchQueryOf(input) : known || titleFromResult(result) || id;
  return <PastChatCard kind={kind} label={label} sessionId={id || undefined} result={result} state={state} />;
}
