import type { FileRefMeta, StoredMessage } from "@agent-workstation/protocol";
import { t } from "../i18n";
import { agentName } from "./agent";
import {
  assistantError,
  assistantModel,
  classifyUserText,
  contentBlocks,
  imageSrc,
  isRecord,
  normalizeToolResult,
  parentToolUseId,
  resultInfo,
  type ImageBlock,
  type ToolResultBlock,
  type ToolResultContent,
  type ToolUseBlock,
} from "./sdk";

// ---------------------------------------------------------------------------
// Render model
// ---------------------------------------------------------------------------
export interface ToolItem {
  type: "tool";
  toolUseId: string;
  name: string;
  input: unknown;
  /** Matching tool_result from a following user message (undefined while pending). */
  result?: ToolResultContent & { isError: boolean };
  /** Sub-agent transcript (messages whose parent_tool_use_id === toolUseId). */
  children: TranscriptItem[];
  /** seq of the assistant message that issued the call (used to anchor permission cards). */
  seq: number;
}
export interface AssistantTextBlock {
  type: "text";
  text: string;
}
export interface AssistantThinkingBlock {
  type: "thinking";
  text: string;
}
export type AssistantBlock = AssistantTextBlock | AssistantThinkingBlock | ToolItem;

export type TranscriptItem =
  | { kind: "user"; key: string; seq: number; uuid: string; at: string; text: string; images: string[]; files: FileRefMeta[]; command?: boolean }
  | { kind: "local_output"; key: string; seq: number; text: string }
  | {
      kind: "assistant";
      key: string;
      seq: number;
      endSeq: number;
      /** uuid and time of the last message merged into this item (what Fork and Pin refer to). */
      uuid: string;
      at: string;
      /** uuids of every message merged into this item. */
      uuids: string[];
      /** Text blocks of the last message that has text, as Markdown (what Copy and Read aloud use). */
      finalText: string;
      blocks: AssistantBlock[];
      error: string | null;
      model: string | null;
    }
  | { kind: "result"; key: string; seq: number; subtype: string; isError: boolean; durationMs: number | null; costUsd: number | null; numTurns: number | null; text: string | null; errors: string[] }
  | { kind: "divider"; key: string; seq: number; variant: "compact" | "reset"; label?: string }
  | { kind: "notice"; key: string; seq: number; text: string; tone: "info" | "warn" | "error" };

export interface BuiltTranscript {
  items: TranscriptItem[];
  /** All tool items by id (top-level and nested) — handy for permission cards. */
  tools: Map<string, ToolItem>;
}

const HIDDEN_SYSTEM = new Set(["init", "status", "hook_started", "hook_progress", "hook_response", "files_persisted", "task_notification", "session_state_changed"]);

/** Pure: folds persisted messages (any order, may contain duplicates) into the transcript to render. */
export function buildTranscript(messages: readonly StoredMessage[], opts: { agent?: string } = {}): BuiltTranscript {
  const agent = opts.agent ?? agentName();
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolItem>();
  const children = new Map<string, TranscriptItem[]>();
  const orphanResults = new Map<string, ToolResultContent & { isError: boolean }>();

  const listFor = (parent: string | null): TranscriptItem[] => {
    if (!parent) return items;
    let c = children.get(parent);
    if (!c) {
      c = [];
      children.set(parent, c);
    }
    return c;
  };

  const attachResult = (b: ToolResultBlock) => {
    const content = { ...normalizeToolResult(b.content), isError: b.is_error === true };
    const tool = tools.get(b.tool_use_id);
    if (tool) tool.result = content;
    else orphanResults.set(b.tool_use_id, content);
  };

  for (const m of sorted) {
    const p = m.payload;
    const parent = parentToolUseId(p);
    const list = listFor(parent);

    switch (m.kind) {
      case "assistant": {
        const blocks: AssistantBlock[] = [];
        const texts: string[] = [];
        for (const b of contentBlocks(p)) {
          if (b.type === "text" && typeof (b as any).text === "string") {
            const text = (b as any).text as string;
            if (text.trim()) {
              blocks.push({ type: "text", text });
              texts.push(text);
            }
          } else if (b.type === "thinking" || b.type === "redacted_thinking") {
            const text = typeof (b as any).thinking === "string" ? ((b as any).thinking as string) : "";
            if (text.trim()) blocks.push({ type: "thinking", text });
          } else if (b.type === "tool_use") {
            const tu = b as ToolUseBlock;
            if (tools.has(tu.id)) continue; // duplicate delivery of the same block
            const tool: ToolItem = { type: "tool", toolUseId: tu.id, name: tu.name, input: tu.input, children: listFor(tu.id) as any, seq: m.seq };
            const early = orphanResults.get(tu.id);
            if (early) {
              tool.result = early;
              orphanResults.delete(tu.id);
            }
            tools.set(tu.id, tool);
            blocks.push(tool);
          }
        }
        const error = assistantError(p);
        if (blocks.length === 0 && !error) break;
        const last = list[list.length - 1];
        if (last && last.kind === "assistant" && !error && !last.error) {
          last.blocks.push(...blocks);
          last.endSeq = m.seq;
          last.uuid = m.uuid;
          last.at = m.at;
          last.uuids.push(m.uuid);
          if (texts.length) last.finalText = texts.join("\n\n");
        } else {
          list.push({ kind: "assistant", key: `a-${m.seq}`, seq: m.seq, endSeq: m.seq, uuid: m.uuid, at: m.at, uuids: [m.uuid], finalText: texts.join("\n\n"), blocks, error, model: assistantModel(p) });
        }
        break;
      }
      case "user": {
        if (isRecord(p) && (p.isSynthetic === true || p.isMeta === true)) break;
        const blocks = contentBlocks(p);
        const texts: string[] = [];
        const images: string[] = [];
        for (const b of blocks) {
          if (b.type === "tool_result") attachResult(b as ToolResultBlock);
          else if (b.type === "text" && typeof (b as any).text === "string") texts.push((b as any).text);
          else if (b.type === "image") {
            const src = imageSrc(b as ImageBlock);
            if (src) images.push(src);
          }
        }
        // `hub` (set by the hub when the message had attachments) carries what the person typed and the files
        // they attached; the content blocks hold the prompt as sent to Claude (path notes, inlined documents).
        const hub = isRecord(p) && isRecord(p.hub) ? p.hub : null;
        const files = fileRefs(hub?.attachments);
        const text = typeof hub?.text === "string" ? hub.text.trim() : texts.join("\n").trim();
        if (!text && images.length === 0 && files.length === 0) break;
        const c = classifyUserText(text);
        if (c.kind === "local_output") {
          list.push({ kind: "local_output", key: `l-${m.seq}`, seq: m.seq, text: c.text });
        } else {
          list.push({ kind: "user", key: `u-${m.seq}`, seq: m.seq, uuid: m.uuid, at: m.at, text: c.text, images, files, command: c.kind === "command" });
        }
        break;
      }
      case "result": {
        const r = resultInfo(p);
        items.push({ kind: "result", key: `r-${m.seq}`, seq: m.seq, ...r });
        break;
      }
      case "reset":
        items.push({ kind: "divider", key: `d-${m.seq}`, seq: m.seq, variant: "reset" });
        break;
      case "system": {
        const sub = isRecord(p) && typeof p.subtype === "string" ? p.subtype : "";
        if (sub === "compact_boundary") {
          const meta = isRecord(p) && isRecord(p.compact_metadata) ? p.compact_metadata : null;
          const pre = meta && typeof meta.pre_tokens === "number" ? meta.pre_tokens : null;
          items.push({ kind: "divider", key: `d-${m.seq}`, seq: m.seq, variant: "compact", label: pre != null ? String(pre) : undefined });
        } else if (sub === "api_retry") {
          const attempt = isRecord(p) && typeof p.attempt === "number" ? p.attempt : null;
          const max = isRecord(p) && typeof p.max_retries === "number" ? p.max_retries : null;
          items.push({ kind: "notice", key: `n-${m.seq}`, seq: m.seq, tone: "info", text: `API retry${attempt != null ? ` ${attempt}${max != null ? `/${max}` : ""}` : ""}` });
        } else if (sub === "local_command_output") {
          const text = isRecord(p) && typeof p.content === "string" ? p.content.trim() : "";
          if (text) items.push({ kind: "local_output", key: `l-${m.seq}`, seq: m.seq, text });
        } else if (sub === "informational") {
          const text = isRecord(p) && typeof p.content === "string" ? p.content.trim() : "";
          const level = isRecord(p) && typeof p.level === "string" ? p.level : "info";
          if (text) items.push({ kind: "notice", key: `n-${m.seq}`, seq: m.seq, tone: level === "error" ? "error" : level === "warning" ? "warn" : "info", text });
        } else if (sub === "hub_process_died") {
          const error = isRecord(p) && typeof p.error === "string" ? p.error : "";
          items.push({ kind: "notice", key: `n-${m.seq}`, seq: m.seq, tone: "error", text: t("tx.hub.processDied", { agent, error: error || "unknown error" }) });
        } else if (sub === "hub_stop_timeout") {
          items.push({ kind: "notice", key: `n-${m.seq}`, seq: m.seq, tone: "warn", text: t("tx.hub.stopTimeout") });
        } else if (sub === "hub_cancelled") {
          const n = isRecord(p) && Array.isArray(p.message_uuids) ? p.message_uuids.length : 0;
          items.push({ kind: "notice", key: `n-${m.seq}`, seq: m.seq, tone: "info", text: t("tx.hub.cancelled", { n }) });
        } else if (!HIDDEN_SYSTEM.has(sub)) {
          // unknown system messages are not shown; they stay in the store for debugging
        }
        break;
      }
    }
  }
  return { items, tools };
}

// ---------------------------------------------------------------------------
// In-flight streaming (fold of StreamDelta events)
// ---------------------------------------------------------------------------
export type PartialBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolUseId: string; toolName: string; partialJson: string };

export interface PartialState {
  messageId: string | null;
  blocks: PartialBlock[];
  ended: boolean;
}

export const emptyPartial = (): PartialState => ({ messageId: null, blocks: [], ended: false });

export type DeltaLike =
  | { part: "text"; messageId: string; text: string }
  | { part: "thinking"; messageId: string; text: string }
  | { part: "tool_use_start"; messageId: string; toolUseId: string; toolName: string }
  | { part: "tool_use_input"; messageId: string; toolUseId: string; partialJson: string }
  | { part: "message_end"; messageId: string }
  | { part: "usage"; messageId: string; outputTokens: number; turnOutputTokens: number };

/** Pure reducer: fold one delta into the in-flight assistant content. `usage` carries no content: it is ignored here (the session reducer keeps the token count). */
export function foldDelta(state: PartialState, d: DeltaLike): PartialState {
  if (d.part === "usage") return state;
  // A different messageId means a new assistant message started: drop leftovers of the previous one.
  const base: PartialState = state.messageId === d.messageId || state.messageId == null ? state : emptyPartial();
  const next: PartialState = { messageId: d.messageId, blocks: base.blocks, ended: base.ended && base.messageId === d.messageId };

  switch (d.part) {
    case "text":
    case "thinking": {
      const blocks = next.blocks.slice();
      const last = blocks[blocks.length - 1];
      if (last && last.type === d.part) blocks[blocks.length - 1] = { type: d.part, text: last.text + d.text };
      else blocks.push({ type: d.part, text: d.text });
      return { ...next, blocks, ended: false };
    }
    case "tool_use_start": {
      if (next.blocks.some((b) => b.type === "tool_use" && b.toolUseId === d.toolUseId)) return next;
      return { ...next, blocks: [...next.blocks, { type: "tool_use", toolUseId: d.toolUseId, toolName: d.toolName, partialJson: "" }], ended: false };
    }
    case "tool_use_input": {
      let found = false;
      const blocks = next.blocks.map((b) => {
        if (b.type === "tool_use" && b.toolUseId === d.toolUseId) {
          found = true;
          return { ...b, partialJson: b.partialJson + d.partialJson };
        }
        return b;
      });
      if (!found) blocks.push({ type: "tool_use", toolUseId: d.toolUseId, toolName: "tool", partialJson: d.partialJson });
      return { ...next, blocks };
    }
    case "message_end":
      return { ...next, ended: true };
  }
}

/** Build the partial from a snapshot (only aggregated text/thinking + current tool are available). */
export function partialFromSnapshot(s: { messageId: string | null; text: string; thinking: string; currentTool: { toolUseId: string; toolName: string; partialJson: string } | null }): PartialState {
  const blocks: PartialBlock[] = [];
  if (s.thinking) blocks.push({ type: "thinking", text: s.thinking });
  if (s.text) blocks.push({ type: "text", text: s.text });
  if (s.currentTool) blocks.push({ type: "tool_use", toolUseId: s.currentTool.toolUseId, toolName: s.currentTool.toolName, partialJson: s.currentTool.partialJson });
  return { messageId: s.messageId, blocks, ended: false };
}

/** Remove from the partial whatever a persisted assistant message now covers. */
export function reconcilePartial(state: PartialState, persistedPayload: unknown): PartialState {
  if (state.blocks.length === 0) return state;
  let blocks = state.blocks.slice();
  for (const b of contentBlocks(persistedPayload)) {
    if (b.type === "tool_use") {
      const id = (b as ToolUseBlock).id;
      blocks = blocks.filter((x) => !(x.type === "tool_use" && x.toolUseId === id));
    } else if (b.type === "text" || b.type === "thinking") {
      const idx = blocks.findIndex((x) => x.type === b.type);
      if (idx >= 0) blocks.splice(idx, 1);
    }
  }
  if (blocks.length === state.blocks.length) return state;
  return blocks.length === 0 && state.ended ? emptyPartial() : { ...state, blocks };
}

/** Best-effort parse of streamed partial tool JSON (for live summaries). */
export function parsePartialJson(src: string): unknown {
  if (!src) return {};
  try {
    return JSON.parse(src);
  } catch {}
  // Scan once, remembering the open-bracket stack at every top-level-safe comma so we can cut back to it.
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  const cuts: Array<{ at: number; closers: string }> = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") cuts.push({ at: i, closers: [...stack].reverse().join("") });
  }
  const attempts: string[] = [];
  let full = src;
  if (inStr) full += '"';
  attempts.push(full.replace(/,\s*$/, "").replace(/:\s*$/, ": null") + [...stack].reverse().join(""));
  for (let i = cuts.length - 1; i >= 0 && attempts.length < 6; i--) attempts.push(src.slice(0, cuts[i]!.at) + cuts[i]!.closers);
  attempts.push("{}");
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {}
  }
  return {};
}

function fileRefs(v: unknown): FileRefMeta[] {
  if (!Array.isArray(v)) return [];
  const out: FileRefMeta[] = [];
  for (const a of v) {
    if (!isRecord(a) || a.type !== "file_ref" || typeof a.path !== "string") continue;
    out.push({
      type: "file_ref",
      path: a.path,
      name: typeof a.name === "string" ? a.name : (a.path.split("/").pop() ?? a.path),
      size: typeof a.size === "number" ? a.size : 0,
      mediaType: typeof a.mediaType === "string" ? a.mediaType : "application/octet-stream",
    });
  }
  return out;
}
