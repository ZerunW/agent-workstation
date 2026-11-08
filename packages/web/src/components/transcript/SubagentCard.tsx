import { Asterisk, Check, ChevronRight, Loader2, X } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { describeModel } from "../../lib/modelNames";
import { emptyView } from "../../lib/session-reducer";
import { parseSubagentsResult, splitSubagentType, subagentCalls, subagentTask, subagentsNotStarted, type SubagentCall, type SubagentResult } from "../../lib/subagent";
import { t } from "../../i18n";
import { subscribeSession } from "../../store/hub";
import { useSessions } from "../../store/sessions";
import { useSubagentFocus } from "../../store/subagentFocus";
import { TranscriptSessionContext, useExpanded } from "./host";
import { Markdown } from "./Markdown";
import { Transcript } from "./Transcript";
import type { ToolCardProps } from "./ToolCard";

type Tool = ToolCardProps["tool"];
type CallState = "streaming" | "pending" | "done" | "failed";
/** `skipped`: the batch was not started. */
type RowState = "live" | "done" | "failed" | "skipped";

export function ModelChip({ model, className, ...rest }: { model: string; className?: string; "data-testid"?: string }) {
  if (!model) return null;
  return (
    <span className={cn("shrink-0 rounded bg-hover px-1.5 py-px text-[10.5px] font-medium text-muted", className)} {...rest}>
      {describeModel(model).label}
    </span>
  );
}

/** The agent's icon. */
export function AgentIcon() {
  return <Asterisk className="size-3.5 shrink-0 text-accent" />;
}

const MAX_CHIPS = 6;

/** The agent's file area as small monospace chips: at most 6, `+N` shows the rest. */
export function PathChips({ paths, className }: { paths: readonly string[]; className?: string }) {
  const [all, setAll] = useState(false);
  if (!paths.length) return null;
  const shown = all ? paths : paths.slice(0, MAX_CHIPS);
  return (
    <div className={cn("flex flex-wrap gap-1", className)} data-testid="agent-paths">
      {shown.map((p, i) => (
        <span key={i} className="max-w-full truncate rounded bg-hover px-1.5 py-px font-mono text-[10.5px] text-muted" data-testid="agent-path">
          {p}
        </span>
      ))}
      {!all && paths.length > MAX_CHIPS && (
        <button type="button" onClick={() => setAll(true)} className="rounded bg-hover px-1.5 py-px font-mono text-[10.5px] text-muted hover:text-fg" data-testid="agent-paths-more">
          {t("sub.more", { n: paths.length - MAX_CHIPS })}
        </button>
      )}
    </div>
  );
}

/** The child's transcript, read-only and compact; loaded when the row opens and live while the child runs. */
function ChildTranscript({ id }: { id: string }) {
  const known = useSessions((s) => s.views[id]?.session ?? s.sessions[id]);
  const stored = useSessions((s) => s.views[id]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => subscribeSession(id), [id]);
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      try {
        const [session, messages] = await Promise.all([useSessions.getState().sessions[id] ? null : api.session(id), api.messages(id, 0, 500)]);
        if (cancelled) return;
        const st = useSessions.getState();
        if (session) st.upsertSession(session);
        if (messages.length) st.dispatch(id, { type: "replay", sessionId: id, messages });
      } catch (e) {
        console.warn("[subagent] load failed", e);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const view = useMemo(() => {
    const v = stored ?? emptyView(id, known ?? null);
    return loaded && !v.snapshotReceived ? { ...v, snapshotReceived: true } : v;
  }, [stored, id, known, loaded]);

  return (
    <div className="overflow-hidden rounded-md border border-line" data-testid="subagent-transcript" data-session={id}>
      <Transcript view={view} compact />
    </div>
  );
}

/**
 * One agent of a batch inside an open tool group: icon, description, model chip, state. Opening it shows the child's
 * transcript inline (read-only) and the agent's answer below. The child comes from the result's section, or while it
 * runs from the background task with the same description (`nth`: which of several agents sharing one).
 */
function SubagentRow({ id, call, nth, section, state }: { id: string; call: SubagentCall; nth: number; section: SubagentResult | null; state: RowState }) {
  const parentId = useContext(TranscriptSessionContext);
  const [open, setOpen] = useExpanded(`row:${id}`);
  const tasks = useSessions((s) => (parentId ? s.views[parentId]?.backgroundTasks : undefined));
  const task = subagentTask(tasks, call.description, nth);
  // a finished call whose section has no `session:` line never got a child: the task (long gone) must not stand in for it
  const childId = section ? section.sessionId : state === "live" ? (task?.taskId ?? null) : null;
  const childModel = useSessions((s) => (childId ? (s.views[childId]?.session ?? s.sessions[childId])?.model : undefined));
  const model = call.model || childModel || splitSubagentType(task?.subagentType).model;
  const answer = section?.answer ?? "";
  const files = section?.files ?? [];
  const rowRef = useRef<HTMLDivElement>(null);

  // "show in transcript" from the Overview tasks card
  const focus = useSubagentFocus((s) => s.focus);
  const clearFocus = useSubagentFocus((s) => s.clear);
  useEffect(() => {
    if (!focus || focus.sessionId !== parentId || focus.description !== call.description) return;
    setOpen(true);
    clearFocus();
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focus, parentId, call.description, setOpen, clearFocus]);

  return (
    <div ref={rowRef} className="text-[12.5px]" data-testid="subagent-row" data-state={state} data-description={call.description} data-session={childId ?? undefined}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted hover:bg-hover hover:text-fg">
        <AgentIcon />
        <span className="min-w-0 flex-1 truncate font-medium text-fg" data-testid="subagent-label">
          {call.description}
        </span>
        <ModelChip model={model} data-testid="subagent-model" />
        {state === "live" ? (
          <span className="flex shrink-0 items-center gap-1 text-subtle" data-testid="subagent-running">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t("tx.tool.running")}
          </span>
        ) : state === "failed" ? (
          <X className="size-3.5 shrink-0 text-danger" aria-label={t("tx.tool.error")} />
        ) : state === "done" ? (
          <Check className="size-3.5 shrink-0 text-ok" />
        ) : null}
        <ChevronRight className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mb-1 ml-5 mt-1 space-y-2 text-[12px]">
          <PathChips paths={call.paths} />
          {childId && <ChildTranscript id={childId} />}
          {answer && (
            <div data-testid="subagent-answer">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-subtle">{t("sub.answer")}</div>
              {state === "failed" ? <div className="whitespace-pre-wrap break-words text-danger">{answer}</div> : <Markdown text={answer} className="!text-[13px]" />}
              {files.length > 0 && (
                <div className="mt-1 truncate font-mono text-[11px] text-subtle" data-testid="subagent-files">
                  {files.join(", ")}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const NO_SECTION: SubagentResult = { sessionId: null, answer: "", files: [] };

/**
 * The rows of a `run_subagents` call inside an open tool group: one per agent, each mapped to its result section by
 * position. A denied or failed-to-start batch lists its agents without children.
 */
export function SubagentRows({ tool, state, denied }: { tool: Tool; state: CallState; denied: boolean }) {
  const calls = subagentCalls(tool.input);
  const sections = useMemo(() => (tool.result ? parseSubagentsResult(tool.result.text) : null), [tool.result]);
  const live = state === "streaming" || state === "pending";
  // an error before any child existed: one text for the whole batch, not an answer of the first agent
  const notStarted = !denied && subagentsNotStarted(tool.result);
  const seen = new Map<string, number>();
  return (
    <>
      {calls.map((call, i) => {
        const nth = seen.get(call.description) ?? 0;
        seen.set(call.description, nth + 1);
        // once the result is in, the section decides (a missing one: no child)
        const section = !sections ? null : notStarted ? NO_SECTION : (sections[i] ?? NO_SECTION);
        const rowState: RowState = denied || notStarted ? "skipped" : live ? "live" : section?.sessionId ? "done" : "failed";
        return <SubagentRow key={i} id={`${tool.toolUseId}:${i}`} call={call} nth={nth} section={section} state={rowState} />;
      })}
      {notStarted && tool.result && (
        <div className="ml-1.5 whitespace-pre-wrap break-words px-1.5 py-1 text-[12px] text-danger" data-testid="subagents-error">
          {tool.result.text.trim()}
        </div>
      )}
    </>
  );
}
