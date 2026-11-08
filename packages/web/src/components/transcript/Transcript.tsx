import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { hasEarlierMessages, isBusyStatus, type PermissionEntry, type SessionView } from "../../lib/session-reducer";
import { agentName } from "../../lib/agent";
import { handleCopyWithMath } from "../../lib/mathCopy";
import { buildTranscript, type TranscriptItem } from "../../lib/transcript";
import { t } from "../../i18n";
import { loadEarlier } from "../../store/hub";
import { EmptyState, Skeleton } from "../ui/primitives";
import { AssistantItem, DividerRow, LocalOutputRow, NoticeRow, PendingUserRow, ResultRow, StreamingTail, TurnIndicator, UserBubble } from "./Items";
import { latestTodos } from "../../lib/todos";
import { NextStepBox } from "./NextStepBox";
import { PermissionCard } from "./PermissionCard";
import { TodoCard } from "./TodoCard";
import { ToolGroup } from "./ToolGroup";
import { ChildItemsContext, ExpandedContext, ExpandedMap, FindQueryContext, TranscriptHostContext, TranscriptSessionContext, useTranscriptHost, type TranscriptHost } from "./host";
import { FindBar } from "./FindBar";
import { MessageCtxContext, type MessageCtx } from "./MessageActions";
import { registerFind } from "../../lib/find";
import { useSessionProject } from "../changes/useSessionProject";

const NO_PERMS: Map<string, PermissionEntry[]> = new Map();

/**
 * `compact`: a read-only transcript nested in a row (a subagent's): its own short scroll area, no permission cards (a
 * child's requests are answered in the parent), end-of-turn box, task list or turn timer.
 */
export function Transcript({ view, className, host, compact }: { view: SessionView; className?: string; host?: TranscriptHost; compact?: boolean }) {
  const sessionId = view.id;
  const parentHost = useTranscriptHost();
  const kind = view.session?.kind ?? "code";
  const busy = isBusyStatus(view.session?.status);
  const agent = agentName();
  const built = useMemo(() => buildTranscript(view.messages, { agent }), [view.messages, agent]);
  // which tool groups / rows are open: lives as long as this page view, nothing is stored
  const expanded = useRef(new ExpandedMap());
  const todos = useMemo(() => (compact ? null : latestTodos(built.tools)), [built.tools, compact]);
  const { project } = useSessionProject(sessionId);
  const pinnedList = view.session?.pinnedMessages;
  const messageCtx = useMemo<MessageCtx>(
    () => ({ sessionId, kind, child: !!view.session?.parentSessionId, inProject: project != null, pinned: new Set(pinnedList ?? []) }),
    [sessionId, kind, view.session?.parentSessionId, project, pinnedList],
  );

  // Permission cards: inline under their tool card when it exists, otherwise anchored by arrival order.
  const { byTool, loose } = useMemo(() => {
    const byTool = new Map<string, PermissionEntry[]>();
    const loose: PermissionEntry[] = [];
    for (const p of compact ? [] : view.permissions) {
      const id = p.request.toolUseId;
      if (id && built.tools.has(id)) byTool.set(id, [...(byTool.get(id) ?? []), p]);
      else loose.push(p);
    }
    return { byTool: byTool.size ? byTool : NO_PERMS, loose };
  }, [view.permissions, built.tools, compact]);

  // A successful result has no row of its own (the live turn indicator marks the turn); failures keep their error box.
  const items = useMemo(() => built.items.filter((it) => !(it.kind === "result" && !it.isError)), [built.items]);
  const lastItem = items[items.length - 1];

  // The last assistant message of each turn gets the action row once the turn is over; Chat Retry needs the turn's user message.
  const turns = useMemo(() => {
    const info = new Map<string, { turnEnd: boolean; userUuid: string | null }>();
    let userUuid: string | null = null;
    let last: string | null = null;
    const close = (live: boolean) => {
      if (last && !live) info.get(last)!.turnEnd = true;
      last = null;
    };
    for (const it of items) {
      if (it.kind === "user") {
        close(false);
        userUuid = it.uuid;
      } else if (it.kind === "assistant" && !it.error) {
        info.set(it.key, { turnEnd: false, userUuid });
        last = it.key;
      }
    }
    close(busy);
    return info;
  }, [items, busy]);
  // The latest finished turn keeps its action row visible (like the Claude apps); older ones show it on hover.
  const latestTurnEnd = useMemo(() => {
    let key: string | null = null;
    for (const [k, v] of turns) if (v.turnEnd) key = k;
    return key;
  }, [turns]);

  // ---- find in session (⌘F) ----------------------------------------------------------------
  const [find, setFind] = useState({ open: false, tick: 0 });
  const [findQuery, setFindQuery] = useState("");
  // only the main transcript takes ⌘F; a compact one (a subagent's, inline) never does
  useEffect(() => (compact ? undefined : registerFind(() => setFind((f) => ({ open: true, tick: f.tick + 1 })))), [compact]);
  const closeFind = useCallback(() => {
    setFind((f) => ({ ...f, open: false }));
    setFindQuery("");
  }, []);

  // ---- scrolling ---------------------------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = gap < 80;
    setShowJump(gap > 240);
  }, []);

  // New session in the same pane: start pinned to the bottom.
  useEffect(() => {
    stick.current = true;
    setShowJump(false);
  }, [sessionId]);

  // Older messages are inserted above the viewport: keep what the user was reading in place.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const earlier = hasEarlierMessages(view);
  const onLoadEarlier = useCallback(() => {
    const el = scrollRef.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    stick.current = false;
    void loadEarlier(sessionId);
  }, [sessionId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (a && el) {
      if (el.scrollHeight !== a.height) {
        el.scrollTop = a.top + (el.scrollHeight - a.height);
        anchor.current = null;
        return;
      }
      if (!view.loadingEarlier) anchor.current = null; // the request ended without adding anything
    }
    if (stick.current) scrollToBottom();
  }, [items.length, view.partial, view.pendingUser.length, view.permissions.length, view.loadingEarlier, view.nextStep, todos, busy, scrollToBottom]);

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  // ---- rendering ---------------------------------------------------------------------------
  const renderItem = useCallback(
    (item: TranscriptItem, isLast: boolean): ReactNode => {
      switch (item.kind) {
        case "user":
          return <UserBubble item={item} />;
        case "assistant": {
          const turn = turns.get(item.key);
          return <AssistantItem item={item} busy={busy} permissionsByTool={byTool} sessionId={sessionId} agent={agent} chat={kind === "chat"} turnEnd={turn?.turnEnd} latest={item.key === latestTurnEnd} userUuid={turn?.userUuid} />;
        }
        case "result":
          return item.isError ? <ResultRow item={item} last={isLast && !busy} /> : null;
        case "divider":
          return <DividerRow item={item} />;
        case "notice":
          return <NoticeRow text={item.text} tone={item.tone} />;
        case "local_output":
          return <LocalOutputRow text={item.text} />;
      }
    },
    [busy, byTool, sessionId, agent, kind, turns, latestTurnEnd],
  );

  // a subagent's own messages are not the session's: no actions on them
  const renderChildren = useCallback(
    (list: TranscriptItem[]) => (
      <MessageCtxContext.Provider value={null}>
        {list.map((it) => (
          <div key={it.key}>{renderItem(it, false)}</div>
        ))}
      </MessageCtxContext.Provider>
    ),
    [renderItem],
  );

  const loading = !view.snapshotReceived && view.messages.length === 0 && view.pendingUser.length === 0;
  const empty = !compact && !loading && items.length === 0 && view.pendingUser.length === 0 && view.permissions.length === 0 && view.partial.blocks.length === 0;
  const pendingPerms = loose.filter((p) => p.status === "pending");
  const resolvedLoose = loose.filter((p) => p.status !== "pending");

  // Resolved loose permissions render after the last item that precedes their arrival.
  const looseAfter = useMemo(() => {
    const m = new Map<number, PermissionEntry[]>();
    for (const p of resolvedLoose) {
      let idx = -1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        const end = it.kind === "assistant" ? it.endSeq : it.seq;
        if (end <= p.afterSeq) idx = i;
        else break;
      }
      m.set(idx, [...(m.get(idx) ?? []), p]);
    }
    return m;
  }, [resolvedLoose, items]);

  // Answered permission requests whose tool call is not in the transcript: one muted group, like the ones in assistant messages.
  const looseGroup = (list: PermissionEntry[] | undefined, className?: string): ReactNode =>
    list?.length ? (
      <div className={className}>
        <ToolGroup entries={list.map((entry) => ({ type: "perm" as const, entry }))} />
      </div>
    ) : null;

  return (
    <TranscriptHostContext.Provider value={host ?? parentHost}>
      <ExpandedContext.Provider value={expanded.current}>
      <ChildItemsContext.Provider value={renderChildren}>
      <TranscriptSessionContext.Provider value={sessionId}>
      <MessageCtxContext.Provider value={messageCtx}>
      <FindQueryContext.Provider value={findQuery}>
        <div className={cn("relative flex min-h-0 flex-1 flex-col", compact && "max-h-80", className)}>
          {find.open && !compact && <FindBar rootRef={innerRef} focusTick={find.tick} earlier={earlier} loadingEarlier={view.loadingEarlier} messageCount={view.messages.length} onLoadEarlier={onLoadEarlier} onApply={setFindQuery} onClose={closeFind} />}
          <div ref={scrollRef} onScroll={onScroll} onCopy={handleCopyWithMath} className="min-h-0 flex-1 overflow-y-auto" data-testid="transcript" role="log" aria-live="polite" aria-label="Conversation">
            <div ref={innerRef} className={cn("mx-auto w-full max-w-3xl", compact ? "space-y-3 p-2.5" : "space-y-5 px-4 pb-6 pt-6 sm:px-6")}>
              {loading && (
                <div className="space-y-4" aria-busy aria-label={t("tx.loading")}>
                  <Skeleton className="ml-auto h-10 w-2/5" />
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              )}
              {empty && (
                <EmptyState title={kind === "chat" ? t("workbench.empty.title.chat") : t("workbench.empty.title.code")} />
              )}

              {earlier && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={onLoadEarlier}
                    disabled={view.loadingEarlier}
                    className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted shadow-sm hover:bg-hover hover:text-fg disabled:opacity-60"
                    data-testid="load-earlier"
                  >
                    {view.loadingEarlier ? t("tx.earlier.loading") : t("tx.earlier")}
                  </button>
                </div>
              )}
              {looseGroup(looseAfter.get(-1))}
              {items.map((item, i) => (
                <div key={item.key} data-seq={item.seq} data-uuids={item.kind === "user" ? item.uuid : item.kind === "assistant" ? item.uuids.join(" ") : undefined}>
                  {renderItem(item, item === lastItem)}
                  {looseGroup(looseAfter.get(i), "mt-3")}
                </div>
              ))}

              {view.pendingUser.map((p) => (
                <PendingUserRow key={p.uuid} entry={p} sessionId={sessionId} />
              ))}
              <StreamingTail blocks={view.partial.blocks} chat={kind === "chat"} />
              {todos && <TodoCard todos={todos} />}
              {busy && !compact && <TurnIndicator startedAt={view.turn.startedAt} outputTokens={view.turn.outputTokens} />}
              {pendingPerms.map((p) => (
                <PermissionCard key={p.request.requestId} entry={p} sessionId={sessionId} agent={agent} />
              ))}
              {view.nextStep && !compact && <NextStepBox sessionId={sessionId} step={view.nextStep} />}
              {/* pending permissions inline under a tool card still need the page to scroll: handled by ResizeObserver */}
            </div>
          </div>
          {showJump && !compact && (
            <button
              type="button"
              onClick={() => {
                stick.current = true;
                scrollToBottom(true);
              }}
              className="anim-pop absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium shadow-[var(--shadow-pop)] hover:bg-hover"
              data-testid="jump-latest"
            >
              <ArrowDown className="size-3.5" />
              {t("tx.jumpLatest")}
            </button>
          )}
        </div>
      </FindQueryContext.Provider>
      </MessageCtxContext.Provider>
      </TranscriptSessionContext.Provider>
      </ChildItemsContext.Provider>
      </ExpandedContext.Provider>
    </TranscriptHostContext.Provider>
  );
}
