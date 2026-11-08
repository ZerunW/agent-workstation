/**
 * Plain text of stored messages, for the search index, session summaries and the read_conversation tool. Pure.
 *
 * - user messages: the text the person typed (`hub.text` when the message carried attachments, else the text blocks
 *   of the SDK message); tool_result-only messages (the SDK's tool round trips) and Claude Code's local-command
 *   echoes have no text.
 * - assistant messages: the text blocks of main-loop messages (no thinking, no tool calls, no subagent output, no
 *   synthetic hub error notes).
 * Everything else (results, system rows, resets) has no text.
 */

/** Longest text kept per message (long pastes / generated code would bloat the index). */
export const MAX_DOC_CHARS = 20_000;

const LOCAL_COMMAND_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string" && t.trim()) parts.push(t);
    }
  }
  return parts.join("\n\n");
}

/** The role and plain text of a stored message, or null when it has no searchable text. */
export function messagePlainText(kind: string, payload: unknown, maxChars = MAX_DOC_CHARS): { role: "user" | "assistant"; text: string } | null {
  let p: Record<string, unknown>;
  try {
    p = (typeof payload === "string" ? JSON.parse(payload) : payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  if (kind === "user") {
    const hub = p.hub as { text?: unknown } | undefined;
    const typed = hub && typeof hub.text === "string" ? hub.text : null;
    const text = (typed ?? textBlocks((p.message as { content?: unknown } | undefined)?.content)).trim();
    if (!text || LOCAL_COMMAND_RE.test(text)) return null;
    return { role: "user", text: text.slice(0, maxChars) };
  }
  if (kind === "assistant") {
    if (p.parent_tool_use_id) return null;
    const msg = p.message as { content?: unknown; model?: unknown } | undefined;
    if (msg?.model === "<synthetic>") return null;
    const text = textBlocks(msg?.content).trim();
    return text ? { role: "assistant", text: text.slice(0, maxChars) } : null;
  }
  return null;
}

/** Keeps the newest part of `text` within `max` characters (a marker says what was cut). */
export function keepTail(text: string, max: number, marker = "[… earlier messages omitted …]\n\n"): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - marker.length);
  let tail = text.slice(text.length - room);
  const nl = tail.indexOf("\n");
  if (nl > 0 && nl < 400) tail = tail.slice(nl + 1);
  return marker + tail;
}

/** Keeps the start (topic) and the end (outcome) of `text` within `max` characters. */
export function keepHeadAndTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "\n\n[…]\n\n";
  const head = Math.floor((max - marker.length) / 3);
  const tail = max - marker.length - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/** Truncates a UTF-8 string so that it fits `maxBytes` (argv entries are limited to 128 KiB on Linux). */
export function fitBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
