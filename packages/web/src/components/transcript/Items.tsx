import { AlertTriangle, CheckCircle2, CircleAlert, RotateCcw, Scissors, Trash2, XCircle } from "lucide-react";
import { Fragment, memo, useState, type ReactNode } from "react";
import { downloadFiles } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useElapsed } from "../../hooks/useElapsed";
import { formatCost, formatDuration, formatElapsed, formatKTokens } from "../../lib/format";
import { agentName } from "../../lib/agent";
import { parseResetFromText } from "../../lib/sdk";
import type { PermissionEntry, PendingUser } from "../../lib/session-reducer";
import { parsePartialJson, type AssistantBlock, type PartialBlock, type TranscriptItem } from "../../lib/transcript";
import { t, type I18nKey } from "../../i18n";
import { discardPending, retrySend, rewindSession } from "../../store/actions";
import { FileCard } from "../ui/FileCard";
import { Button } from "../ui/primitives";
import { MathText } from "./MathText";
import { AssistantActions, UserActions, useMessageCtx } from "./MessageActions";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { ToolGroup, type GroupEntry } from "./ToolGroup";
import { VisualFigure } from "./Visuals";
import { isVisualTool, parseVisual } from "../../lib/visual";
import { isTodoTool } from "../../lib/todos";
import { isHeadsUpTool, parseHeadsUp } from "../../lib/headsUp";
import { isSubagentTool } from "../../lib/subagent";
import { HeadsUpCard } from "./HeadsUpCard";
import { OutputChips } from "./OutputChips";

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
/** Chat Edit: the bubble becomes a textarea; Send rewinds to this message and sends the new text. */
function UserEditor({ item, sessionId, onClose }: { item: Item<"user">; sessionId: string; onClose: () => void }) {
  const [text, setText] = useState(item.text);
  const ready = text.trim().length > 0;
  const send = () => {
    if (!ready) return;
    onClose();
    void rewindSession(sessionId, { messageUuid: item.uuid, resend: { text } });
  };
  return (
    <div className="flex w-[min(80vw,640px)] flex-col gap-2 rounded-2xl border border-strong bg-surface p-2" data-testid="user-editor">
      <textarea
        autoFocus
        value={text}
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        aria-label={t("tx.edit")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
            e.preventDefault();
            send();
          }
        }}
        className="w-full resize-none bg-transparent px-2 py-1 text-[14.5px] leading-relaxed outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("app.cancel")}
        </Button>
        <Button variant="primary" disabled={!ready} onClick={send}>
          {t("tx.edit.send")}
        </Button>
      </div>
    </div>
  );
}

export const UserBubble = memo(function UserBubble({ item }: { item: Item<"user"> }) {
  const ctx = useMessageCtx();
  const [editing, setEditing] = useState(false);
  return (
    <div className="group/msg flex flex-col items-end gap-1" data-testid="user-message">
      {item.images.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {item.images.map((src, i) => (
            <img key={i} src={src} alt={t("tx.userImage")} className="max-h-48 max-w-[240px] rounded-xl border border-line object-cover" />
          ))}
        </div>
      )}
      {item.files.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2" data-testid="user-files">
          {item.files.map((f) => (
            <FileCard key={f.path} name={f.name} size={f.size} onClick={() => void downloadFiles(f.path)} />
          ))}
        </div>
      )}
      {item.text &&
        (editing && ctx ? (
          <UserEditor item={item} sessionId={ctx.sessionId} onClose={() => setEditing(false)} />
        ) : (
          <div className={cn("max-w-[min(80vw,640px)] whitespace-pre-wrap break-words rounded-2xl bg-bubble px-4 py-2.5 text-[14.5px] leading-relaxed", item.command && "font-mono text-[13px]")}>{item.command ? item.text : <MathText text={item.text} />}</div>
        ))}
      {!editing && <UserActions item={item} onEdit={item.text ? () => setEditing(true) : undefined} />}
    </div>
  );
});

export function PendingUserRow({ entry, sessionId }: { entry: PendingUser; sessionId: string }) {
  const ctx = useMessageCtx();
  return (
    <div className="flex flex-col items-end gap-1" data-testid="pending-user" data-state={entry.state}>
      {entry.images.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2 opacity-70">
          {entry.images.map((src, i) => (
            <img key={i} src={src} alt="" className="max-h-48 max-w-[240px] rounded-xl border border-line object-cover" />
          ))}
        </div>
      )}
      {entry.files && entry.files.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2 opacity-70">
          {entry.files.map((f) => (
            <FileCard key={f.path} name={f.name} size={f.size} />
          ))}
        </div>
      )}
      {entry.text && <div className={cn("max-w-[min(80vw,640px)] whitespace-pre-wrap break-words rounded-2xl bg-bubble px-4 py-2.5 text-[14.5px] leading-relaxed", entry.state !== "failed" && "opacity-70", entry.state === "failed" && "ring-1 ring-danger/60")}>{entry.text}</div>}
      <div className={cn("flex items-center gap-2 text-xs", entry.state === "failed" ? "text-danger" : "text-subtle")}>
        {ctx?.kind === "code" && entry.state !== "failed" && (
          <span role="img" aria-label={t("tx.sent")} title={t("tx.sent")} data-testid="sent-mark">
            ✓
          </span>
        )}
        {entry.state === "sending" && t("tx.sending")}
        {entry.state === "queued" && t("tx.queued", { n: entry.position ?? "…" })}
        {entry.state === "failed" && (
          <>
            <CircleAlert className="size-3.5" />
            <span>
              {t("tx.sendFailed")}
              {entry.error ? `: ${entry.error}` : ""}
            </span>
            <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => retrySend(sessionId, entry.uuid)}>
              <RotateCcw className="size-3" />
              {t("tx.retrySend")}
            </button>
            <button type="button" aria-label={t("app.dismiss")} className="rounded p-0.5 hover:bg-hover" onClick={() => discardPending(sessionId, entry.uuid)}>
              <Trash2 className="size-3" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------
function AssistantText({ text, caret }: { text: string; caret?: boolean }) {
  return (
    <div className={cn(caret && "[&_.prose-workstation>*:last-child]:caret")}>
      <Markdown text={text} />
    </div>
  );
}

export const LimitNotice = ({ code, text, agent = agentName() }: { code: string; text: string; agent?: string }) => {
  const label = (() => {
    const key = `tx.assistantError.${code}` as I18nKey;
    const v = t(key, { agent });
    return v === key ? t("tx.assistantError.unknown") : v;
  })();
  const reset = code === "rate_limit" ? parseResetFromText(text) : null;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-[13px]" data-testid="assistant-error" data-code={code}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0">
        <div className="font-medium">{code === "rate_limit" ? (reset ? t("banner.rateLimit", { when: reset }) : t("banner.rateLimit.noTime")) : label}</div>
        {text && code !== "rate_limit" && <div className="mt-0.5 break-words text-muted">{text}</div>}
        {text && code === "rate_limit" && <div className="mt-0.5 break-words text-xs text-muted">{text}</div>}
      </div>
    </div>
  );
};

export function AssistantBlocks({
  blocks,
  busy,
  permissionsByTool,
  sessionId,
  agent,
  chat,
  idPrefix = "",
  actions,
}: {
  chat?: boolean;
  /** The action row, placed right under the last text block. */
  actions?: ReactNode;
  blocks: AssistantBlock[];
  busy: boolean;
  permissionsByTool: Map<string, PermissionEntry[]>;
  sessionId: string;
  agent?: string;
  /** Makes the ids of thinking rows unique across messages. */
  idPrefix?: string;
}) {
  // Text and visuals stay inline; tools, thinking and resolved permissions between them fold into one group.
  // A pending permission request keeps its full card outside the group (and ends it).
  const nodes: ReactNode[] = [];
  const headsUps: ReactNode[] = [];
  let group: GroupEntry[] = [];
  const flush = () => {
    if (group.length) nodes.push(<ToolGroup key={`g${nodes.length}`} entries={group} chat={chat} />);
    group = [];
  };
  const lastText =blocks.map((b) => b.type).lastIndexOf("text");
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      flush();
      nodes.push(<AssistantText key={`t${i}`} text={b.text} />);
      if (i === lastText && actions) nodes.push(<Fragment key="actions">{actions}</Fragment>);
    } else if (b.type === "thinking") {
      group.push({ type: "thinking", id: `${idPrefix}think${i}`, text: b.text });
    } else {
      const perms = permissionsByTool.get(b.toolUseId) ?? [];
      const visual = isVisualTool(b.name) && !b.result?.isError ? parseVisual(b.input) : null;
      if (isTodoTool(b.name)) {
        // the pinned task list under the latest message replaces these calls
      } else if (isHeadsUpTool(b.name)) {
        // a card under the message, never a tool row
        const input = b.result?.isError ? null : parseHeadsUp(b.input);
        if (input) headsUps.push(<HeadsUpCard key={b.toolUseId} id={b.toolUseId} input={input} />);
      } else if (visual) {
        flush();
        nodes.push(<VisualFigure key={b.toolUseId} title={visual.title} svg={visual.svg} html={visual.html} sessionId={sessionId} />);
      } else if (isSubagentTool(b.name) && perms.some((p) => p.status === "pending")) {
        // the approval card stands for the call until the person answers
      } else {
        group.push({ type: "tool", tool: b, running: busy && !b.result });
      }
      for (const p of perms) {
        if (p.status === "pending") {
          flush();
          nodes.push(<PermissionCard key={p.request.requestId} entry={p} sessionId={sessionId} agent={agent} />);
        } else {
          group.push({ type: "perm", entry: p });
        }
      }
    }
  });
  flush();
  return <>{nodes}{headsUps}</>;
}

export const AssistantItem = memo(function AssistantItem({
  item,
  busy,
  permissionsByTool,
  sessionId,
  agent: agentProp,
  chat,
  turnEnd,
  latest = false,
  userUuid = null,
}: {
  chat?: boolean;
  item: Item<"assistant">;
  busy: boolean;
  permissionsByTool: Map<string, PermissionEntry[]>;
  sessionId: string;
  /** The session's agent name; read from the store when the caller does not know it. */
  agent?: string;
  /** The last assistant message of its turn, and the turn is over: it gets the action row. */
  turnEnd?: boolean;
  /** The latest finished turn of the transcript: its action row stays visible instead of appearing on hover. */
  latest?: boolean;
  /** The user message that started the turn (Chat Retry rewinds to it). */
  userUuid?: string | null;
}) {
  const agent = agentProp ?? agentName();
  const errorText = item.error ? item.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n") : "";
  if (item.error) return <LimitNotice code={item.error} text={errorText} agent={agent} />;
  return (
    <div className="group/msg space-y-3" data-testid="assistant-message">
      <AssistantBlocks blocks={item.blocks} busy={busy} permissionsByTool={permissionsByTool} sessionId={sessionId} agent={agent} chat={chat} idPrefix={`${item.key}:`} actions={turnEnd ? <AssistantActions item={item} userUuid={userUuid} latest={latest} /> : undefined} />
      {chat && <OutputChips sessionId={sessionId} blocks={item.blocks} />}
    </div>
  );
});

/** In-flight assistant content from stream deltas. */
export function StreamingTail({ blocks, chat }: { blocks: PartialBlock[]; chat?: boolean }) {
  if (blocks.length === 0) return null;
  const last = blocks.length - 1;
  const nodes: ReactNode[] = [];
  let group: GroupEntry[] = [];
  const flush = () => {
    if (group.length) nodes.push(<ToolGroup key={`g${nodes.length}`} entries={group} chat={chat} />);
    group = [];
  };
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      flush();
      nodes.push(<AssistantText key={`t${i}`} text={b.text} caret={i === last} />);
    } else if (b.type === "thinking") {
      group.push({ type: "thinking", id: `stream:think${i}`, text: b.text, live: i === last });
    } else {
      const input = parsePartialJson(b.partialJson);
      if (isTodoTool(b.toolName)) {
        // shown by the pinned task list once the call is complete
      } else if (isHeadsUpTool(b.toolName)) {
        // the card appears once the call is complete (stored message)
      } else if (isVisualTool(b.toolName)) {
        flush();
        nodes.push(<VisualFigure key={b.toolUseId} title={parseVisual(input).title} streaming />);
      } else {
        group.push({ type: "tool", tool: { toolUseId: b.toolUseId, name: b.toolName, input }, running: true, streaming: true });
      }
    }
  });
  flush();
  return (
    <div className="space-y-3" data-testid="streaming">
      {nodes}
    </div>
  );
}

/**
 * The last line of the transcript while a turn runs: animated dots, the elapsed time and, once Claude has produced
 * some, the output tokens ("12s · 1.2k tokens"). It exists only while the session is busy.
 */
export function TurnIndicator({ startedAt, outputTokens }: { startedAt: number | null; outputTokens: number }) {
  const elapsed = useElapsed(startedAt);
  const parts = [elapsed != null ? formatElapsed(elapsed) : null, outputTokens > 0 ? t("tx.turn.tokens", { n: formatKTokens(outputTokens) }) : null].filter((p): p is string => p != null);
  return (
    // aria-live off: the timer ticks every second and must not be read out each time
    <div className="flex items-center gap-2 py-1 text-[12.5px] tabular-nums text-muted" role="status" aria-live="off" aria-label={t("tx.turn.working")} data-testid="turn-indicator">
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="turn-dot size-1.5 rounded-full bg-accent" style={{ animationDelay: `${i * 160}ms` }} />
        ))}
      </span>
      {parts.length > 0 && <span data-testid="turn-indicator-text">{parts.join(" · ")}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result / dividers / misc
// ---------------------------------------------------------------------------
export function ResultRow({ item, last }: { item: Item<"result">; last: boolean }) {
  const label = t(resultKey(item.subtype));
  const parts = [formatDuration(item.durationMs), item.costUsd != null ? formatCost(item.costUsd) : null, item.numTurns != null ? (item.numTurns === 1 ? t("tx.result.turn") : t("tx.result.turns", { n: item.numTurns })) : null].filter(Boolean) as string[];
  const Icon = item.isError ? XCircle : CheckCircle2;
  const detail = item.isError ? [...item.errors, item.text ?? ""].filter(Boolean).join("\n") : "";

  if (last) {
    return (
      <div className={cn("rounded-xl border px-3.5 py-2.5 text-[13px]", item.isError ? "border-danger/40 bg-danger-soft" : "border-line bg-surface/60")} data-testid="result-divider" data-subtype={item.subtype} data-error={item.isError}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={cn("inline-flex items-center gap-1.5 font-medium", item.isError ? "text-danger" : "text-fg")}>
            <Icon className={cn("size-4", item.isError ? "text-danger" : "text-ok")} />
            {label}
          </span>
          <span className="text-muted" title={item.costUsd != null ? t("tx.result.estimate") : undefined}>
            {parts.join(" · ")}
          </span>
        </div>
        {detail && <div className="mt-1.5 whitespace-pre-wrap break-words text-xs text-muted">{detail}</div>}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 py-1 text-[11.5px] text-subtle" data-testid="result-divider" data-subtype={item.subtype} data-error={item.isError}>
      <div className="h-px flex-1 bg-line" />
      <span className={cn("inline-flex items-center gap-1.5", item.isError && "text-danger")} title={detail || undefined}>
        {item.isError && <XCircle className="size-3.5" />}
        {item.isError ? label : null}
        {item.isError && parts.length ? " · " : ""}
        {parts.join(" · ")}
      </span>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

function resultKey(subtype: string): I18nKey {
  switch (subtype) {
    case "success":
      return "tx.result.success";
    case "error_max_turns":
      return "tx.result.error_max_turns";
    case "error_during_execution":
      return "tx.result.error_during_execution";
    case "error_max_budget_usd":
      return "tx.result.error_max_budget_usd";
    default:
      return "tx.result.error";
  }
}

export function DividerRow({ item }: { item: Item<"divider"> }) {
  const Icon = item.variant === "compact" ? Scissors : Trash2;
  const label = item.variant === "compact" ? (item.label ? t("tx.compactTokens", { n: item.label }) : t("tx.compact")) : t("tx.reset");
  return (
    <div className="flex items-center gap-3 py-1 text-[11.5px] text-subtle" data-testid="divider" data-variant={item.variant}>
      <div className="h-px flex-1 bg-line" />
      <span className="inline-flex items-center gap-1.5">
        <Icon className="size-3.5" />
        {label}
      </span>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

export function NoticeRow({ text, tone = "info" }: { text: string; tone?: "info" | "warn" | "error" }) {
  if (tone === "info") return <div className="text-center text-[11.5px] text-subtle">{text}</div>;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]", tone === "error" ? "border-danger/40 bg-danger-soft" : "border-warn/40 bg-warn-soft")} data-testid="hub-notice" data-tone={tone}>
      <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", tone === "error" ? "text-danger" : "text-warn")} />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

export function LocalOutputRow({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-line bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-muted" aria-label={t("tx.localOutput")}>
      <pre className="whitespace-pre-wrap break-words">{text}</pre>
    </div>
  );
}
