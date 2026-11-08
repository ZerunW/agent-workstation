import { Brain, ChevronRight, Loader2, X } from "lucide-react";
import { useContext, useEffect } from "react";
import { cn } from "../../lib/cn";
import { isDownloadTool } from "../../lib/download";
import { truncate } from "../../lib/format";
import { memoryToolKind, memoryToolText } from "../../lib/memory";
import { pastChatTool } from "../../lib/pastChats";
import type { PermissionEntry } from "../../lib/session-reducer";
import { capitalise, liveLabel, summarizeTools, type GroupTool } from "../../lib/toolGroups";
import { isSubagentTool, subagentCalls, subagentsNotStarted } from "../../lib/subagent";
import { useSubagentFocus } from "../../store/subagentFocus";
import { webTool } from "../../lib/webTools";
import { t } from "../../i18n";
import { DownloadRow } from "./DownloadRow";
import { TranscriptSessionContext, useExpanded, useOpenOnFind } from "./host";
import { SubagentRows } from "./SubagentCard";
import { MemoryChip } from "./MemoryChip";
import { PastChatToolCard } from "./PastChatCard";
import { PermissionRow } from "./PermissionCard";
import { ToolCard, type ToolCardProps } from "./ToolCard";
import { WebChip } from "./WebChip";

export type GroupEntry =
  | {
      type: "tool";
      /** `input` is the parsed (partial, while streaming) input. */
      tool: ToolCardProps["tool"];
      running: boolean;
      streaming?: boolean;
    }
  | { type: "thinking"; id: string; text: string; live?: boolean }
  | { type: "perm"; entry: PermissionEntry };

const entryId = (e: GroupEntry): string => (e.type === "tool" ? e.tool.toolUseId : e.type === "thinking" ? e.id : e.entry.request.requestId);

const json = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
};

/** What a row shows once opened (the find bar opens a group when this holds a match). */
const entryText = (e: GroupEntry): string => (e.type === "tool" ? `${e.tool.name}\n${json(e.tool.input)}\n${e.tool.result?.text ?? ""}` : e.type === "thinking" ? e.text : `${e.entry.request.toolName}\n${json(e.entry.request.input)}`);

function ThinkingRow({ id, text, live }: { id: string; text: string; live?: boolean }) {
  const [open, setOpen] = useExpanded(`row:${id}`);
  useOpenOnFind(() => text, setOpen);
  const first = text.trim().split("\n")[0] ?? "";
  return (
    <div className="text-[12.5px]" data-testid="thinking">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted hover:bg-hover hover:text-fg">
        <Brain className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-fg">{live ? t("tx.thinkingLive") : t("tx.thinking")}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px]">{truncate(first, 140)}</span>
        <ChevronRight className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className={cn("mb-1 ml-5 mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words pr-1 text-[12px] leading-relaxed text-muted", live && "caret")}>{text}</div>}
    </div>
  );
}

/** One row per tool. Web, memory and past-chat calls keep their own compact rows (they already collapse their detail). */
function ToolRow({ entry, chat, denied }: { entry: Extract<GroupEntry, { type: "tool" }>; chat?: boolean; denied: boolean }) {
  const { tool, running, streaming } = entry;
  const state = tool.result ? (tool.result.isError ? "failed" : "done") : streaming ? "streaming" : "pending";
  if (isSubagentTool(tool.name)) return <SubagentRows tool={tool} state={state} denied={denied} />;
  if (isDownloadTool(tool.name)) return <DownloadRow input={tool.input} result={tool.result?.text} state={state} />;
  const past = pastChatTool(tool.name);
  if (past) return <PastChatToolCard kind={past} input={tool.input} result={tool.result?.text} state={state} />;
  const web = webTool(tool.name, !!chat);
  if (web) return <WebChip kind={web} input={tool.input} result={tool.result?.text} state={state} />;
  const memory = memoryToolKind(tool.name);
  if (memory) {
    // a call the hub refused or could not match comes back as an error result: show its reason, not a check
    const text = state === "streaming" ? "" : tool.result?.isError ? tool.result.text.trim() || memoryToolText(tool.input) : memoryToolText(tool.input);
    return <MemoryChip kind={memory} text={text} state={state} />;
  }
  return <ToolCard tool={tool} running={running} streaming={streaming} />;
}

/** The person denied this subagent batch. */
const isDenied = (e: Extract<GroupEntry, { type: "tool" }>, entries: readonly GroupEntry[]): boolean =>
  isSubagentTool(e.tool.name) && entries.some((x) => x.type === "perm" && x.entry.request.toolUseId === e.tool.toolUseId && x.entry.status === "denied");
/** A subagent batch that did not start: denied, or failed before any child existed. */
const isDeclined = (e: Extract<GroupEntry, { type: "tool" }>, entries: readonly GroupEntry[]): boolean => isSubagentTool(e.tool.name) && (subagentsNotStarted(e.tool.result) || isDenied(e, entries));

/**
 * Consecutive tool calls, resolved permission rows and thinking between two pieces of assistant text, folded into one
 * muted line ("Ran 2 commands ▸"). Collapsed by default; opening it lists one collapsed row per call.
 */
export function ToolGroup({ entries, chat }: { entries: GroupEntry[]; chat?: boolean }) {
  const [open, setOpen] = useExpanded(`group:${entryId(entries[0]!)}`);
  useOpenOnFind(() => entries.map(entryText).join("\n"), setOpen);

  // "show in transcript" from the Overview tasks card: open the group that holds the call (its row opens itself)
  const parentId = useContext(TranscriptSessionContext);
  const focus = useSubagentFocus((s) => s.focus);
  const focused = !!focus && focus.sessionId === parentId && entries.some((e) => e.type === "tool" && isSubagentTool(e.tool.name) && subagentCalls(e.tool.input).some((c) => c.description === focus.description));
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused, setOpen]);

  const tools = entries.flatMap((e): GroupTool[] => {
    if (e.type !== "tool") return [];
    const declined = isDeclined(e, entries);
    return [{ name: e.tool.name, input: e.tool.input, running: e.running, failed: e.tool.result?.isError && !declined, declined }];
  });
  // a group of resolved permissions only (the call itself is not in the transcript) is summed up from the requests
  const basis = tools.length
    ? tools
    : entries.flatMap((e): GroupTool[] => {
        if (e.type !== "perm") return [];
        const declined = isSubagentTool(e.entry.request.toolName) && e.entry.status === "denied";
        return [{ name: e.entry.request.toolName, input: e.entry.request.input, failed: e.entry.status === "denied" && !declined, declined }];
      });
  const { text, added, removed, failed } = summarizeTools(basis);

  // an answered permission row sits right after its call: the call is still the last thing that runs
  const last = [...entries].reverse().find((e) => e.type !== "perm") ?? entries[entries.length - 1]!;
  const liveTool = last.type === "tool" && last.running ? last : null;
  const liveThinking = last.type === "thinking" && last.live;
  const live = !!liveTool || !!liveThinking;
  // the approval of a batch is told by the group itself ("Subagents not started"): no row of its own
  const rows = entries.filter((e) => !(e.type === "perm" && isSubagentTool(e.entry.request.toolName) && entries.some((x) => x.type === "tool" && x.tool.toolUseId === e.entry.request.toolUseId)));
  const line = liveTool ? liveLabel({ name: liveTool.tool.name, input: liveTool.tool.input }) : liveThinking ? t("tx.thinkingLive") : text || capitalise(t("tg.think"));

  return (
    <div className="text-[13px] text-muted" data-testid="tool-group" data-open={open} data-state={live ? "running" : "done"}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-left hover:text-fg">
        {live && <Loader2 className="size-3 shrink-0 animate-spin" aria-label={t("tx.tool.running")} />}
        <span className="min-w-0 truncate" data-testid="tool-group-text">
          {line}
        </span>
        {live && liveTool && isSubagentTool(liveTool.tool.name) && (
          <span className="shrink-0 text-subtle" data-testid="tool-group-running">
            {t("tx.tool.running")}
          </span>
        )}
        {failed > 0 && (
          <span className="inline-flex shrink-0 items-center text-danger" aria-label={t("tg.failed", { n: failed })} data-testid="tool-group-failed">
            <X className="size-3" />
            {failed}
          </span>
        )}
        {(added > 0 || removed > 0) && (
          <span className="flex shrink-0 gap-1 tabular-nums" data-testid="tool-group-diff">
            {added > 0 && <span className="text-ok">+{added}</span>}
            {removed > 0 && <span className="text-danger">−{removed}</span>}
          </span>
        )}
        <ChevronRight className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 border-l border-line pl-2" data-testid="tool-group-rows">
          {rows.map((e) =>
            e.type === "tool" ? <ToolRow key={entryId(e)} entry={e} chat={chat} denied={isDenied(e, entries)} /> : e.type === "thinking" ? <ThinkingRow key={entryId(e)} id={e.id} text={e.text} live={e.live} /> : <PermissionRow key={entryId(e)} entry={e.entry} />,
          )}
        </div>
      )}
    </div>
  );
}
