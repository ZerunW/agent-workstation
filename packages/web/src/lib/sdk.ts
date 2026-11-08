/**
 * Tolerant views over the raw Claude Agent SDK messages stored in `StoredMessage.payload`.
 * The payload is `unknown` on the wire; everything here defends against missing/odd fields.
 */

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ImageBlock {
  type: "image";
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ImageBlock | ToolResultBlock | { type: string; [k: string]: unknown };

export function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Content blocks of a user/assistant SDK message ('string' content becomes one text block). */
export function contentBlocks(payload: unknown): ContentBlock[] {
  if (!isRecord(payload)) return [];
  const message = isRecord(payload.message) ? payload.message : payload;
  const content = message.content;
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content.filter((b): b is ContentBlock => isRecord(b) && typeof b.type === "string");
  return [];
}

export function parentToolUseId(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.parent_tool_use_id === "string" ? payload.parent_tool_use_id : null;
}

export function assistantError(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
}

export function assistantModel(payload: unknown): string | null {
  return isRecord(payload) && isRecord(payload.message) && typeof payload.message.model === "string" ? payload.message.model : null;
}

export function assistantMessageId(payload: unknown): string | null {
  return isRecord(payload) && isRecord(payload.message) && typeof payload.message.id === "string" ? payload.message.id : null;
}

export interface ToolResultContent {
  text: string;
  images: string[]; // data: URLs
}

/** Normalize a tool_result `content` (string | block[]) into text + inline images. */
export function normalizeToolResult(content: unknown): ToolResultContent {
  if (typeof content === "string") return { text: content, images: [] };
  if (Array.isArray(content)) {
    const texts: string[] = [];
    const images: string[] = [];
    for (const b of content) {
      if (!isRecord(b)) continue;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "image") {
        const url = imageSrc(b as ImageBlock);
        if (url) images.push(url);
      }
    }
    return { text: texts.join("\n"), images };
  }
  if (content == null) return { text: "", images: [] };
  try {
    return { text: JSON.stringify(content, null, 2), images: [] };
  } catch {
    return { text: String(content), images: [] };
  }
}

export function imageSrc(b: ImageBlock): string | null {
  const s = b.source;
  if (!s) return null;
  if (s.type === "base64" && s.data) return `data:${s.media_type ?? "image/png"};base64,${s.data}`;
  if (s.type === "url" && s.url) return s.url;
  return null;
}

export interface ResultInfo {
  subtype: string;
  isError: boolean;
  durationMs: number | null;
  costUsd: number | null;
  numTurns: number | null;
  text: string | null;
  errors: string[];
}

export function resultInfo(payload: unknown): ResultInfo {
  const p = isRecord(payload) ? payload : {};
  const subtype = typeof p.subtype === "string" ? p.subtype : "success";
  return {
    subtype,
    isError: p.is_error === true || (subtype !== "success" && subtype !== ""),
    durationMs: typeof p.duration_ms === "number" ? p.duration_ms : null,
    costUsd: typeof p.total_cost_usd === "number" ? p.total_cost_usd : null,
    numTurns: typeof p.num_turns === "number" ? p.num_turns : null,
    text: typeof p.result === "string" ? p.result : null,
    errors: Array.isArray(p.errors) ? p.errors.filter((e: unknown): e is string => typeof e === "string") : [],
  };
}

/** `You've hit your session limit · resets 3pm` -> "3pm". */
export function parseResetFromText(text: string): string | null {
  const m = /resets?\s+(?:at\s+)?([^\n.]+?)\s*(?:\(|$|\.)/i.exec(text);
  return m?.[1]?.trim() ?? null;
}

export function looksLikeLimitText(text: string): boolean {
  return /you['’]?ve hit your .*limit|usage limit reached|limit reached/i.test(text);
}

// Slash-command echo tags the CLI writes into user messages.
const CMD_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const CMD_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const LOCAL_STDOUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;

export type UserText = { kind: "text"; text: string } | { kind: "command"; text: string } | { kind: "local_output"; text: string };

export function classifyUserText(text: string): UserText {
  const out = LOCAL_STDOUT.exec(text);
  if (out) return { kind: "local_output", text: out[1]!.trim() };
  const name = CMD_NAME.exec(text);
  if (name) {
    const args = CMD_ARGS.exec(text)?.[1]?.trim();
    return { kind: "command", text: `${name[1]!.trim()}${args ? ` ${args}` : ""}` };
  }
  return { kind: "text", text };
}
