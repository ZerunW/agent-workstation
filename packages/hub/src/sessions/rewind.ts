/**
 * Rewind / fork helpers (pure): which stored messages are the person's prompts, the text a removed prompt goes back to
 * the composer with, where a Claude process resumes after a rewind or fork, and a prompt sent again with other text.
 */
import type { UserMessageMeta } from "@agent-workstation/protocol";
import type { MessageRow } from "../db/store.js";
import type { SDKUserMessage } from "./sdk.js";

type Payload = {
  type?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
  hub?: Partial<UserMessageMeta>;
};

export function parsePayload(m: Pick<MessageRow, "payload">): Payload {
  try {
    const v = JSON.parse(m.payload) as unknown;
    return v && typeof v === "object" ? (v as Payload) : {};
  } catch {
    return {};
  }
}

type Block = { type?: string; text?: unknown; name?: unknown; input?: unknown };
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : []);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
}

/**
 * A message the person sent (the prompt of a turn): a `user` row that is neither a tool result nor a subagent's
 * prompt. Rows the hub persisted from a send always count (they carry a delivery state).
 */
export function isPrompt(m: Pick<MessageRow, "kind" | "payload" | "delivery">): boolean {
  if (m.kind !== "user") return false;
  if (m.delivery !== null) return true;
  const p = parsePayload(m);
  if (p.parent_tool_use_id) return false;
  const content = p.message?.content;
  if (typeof content === "string") return true;
  const blocks = blocksOf(content);
  return blocks.length > 0 && !blocks.some((b) => b.type === "tool_result");
}

/** The text the person typed (without the attachment notes the hub added for the model). */
export function promptTextOf(m: Pick<MessageRow, "payload">): string {
  const p = parsePayload(m);
  if (typeof p.hub?.text === "string") return p.hub.text;
  return textOf(p.message?.content);
}

/**
 * Where the next Claude process resumes after a rewind / fork that keeps `kept` (the visible messages, oldest first):
 * the newest kept main-chain user / assistant message that reached Claude's transcript, in the Claude session it was
 * written to. null = nothing of the current conversation is kept (no such message, or a /clear after it): a fresh
 * session. `fallbackSession` is used when no kept message names its session.
 */
export function resumePoint(kept: readonly MessageRow[], fallbackSession: string | null): { from: string; at: string } | null {
  for (let i = kept.length - 1; i >= 0; i--) {
    const m = kept[i]!;
    if (m.kind === "reset") return null;
    if (m.kind !== "user" && m.kind !== "assistant") continue;
    // Never delivered: not in the transcript.
    if (m.delivery === "pending" || m.delivery === "cancelled") continue;
    const p = parsePayload(m);
    if (p.parent_tool_use_id) continue; // a subagent's message lives in its own sidechain
    const from = p.session_id || sessionAround(kept, i) || fallbackSession;
    return from ? { from, at: m.uuid } : null;
  }
  return null;
}

/** The Claude session of the messages next to kept[i] (its turn's init / assistant), not across a /clear. */
function sessionAround(kept: readonly MessageRow[], i: number): string | null {
  for (let j = i + 1; j < kept.length && kept[j]!.kind !== "reset"; j++) {
    const s = parsePayload(kept[j]!).session_id;
    if (s) return s;
  }
  for (let j = i - 1; j >= 0 && kept[j]!.kind !== "reset"; j--) {
    const s = parsePayload(kept[j]!).session_id;
    if (s) return s;
  }
  return null;
}

/**
 * A stored prompt sent again: the same content (its attachments as they were sent: images, inlined files, file notes)
 * with `text` in place of the text the person typed. Returns the SDK message and the `hub` meta (null without
 * attachments), like buildUserTurn. `empty` = nothing left to send.
 */
export function resendTurn(stored: Pick<MessageRow, "payload">, text: string, uuid: string, timestamp: string): { msg: SDKUserMessage; meta: UserMessageMeta | null; empty: boolean } {
  const p = parsePayload(stored);
  const original = p.message?.content;
  const meta = p.hub && Array.isArray(p.hub.attachments) ? { text, attachments: p.hub.attachments } : null;
  let content: unknown;
  let empty: boolean;
  if (typeof original === "string" || original === undefined) {
    content = text;
    empty = !text.trim();
  } else {
    const blocks = blocksOf(original).map((b) => ({ ...b }));
    const typed = typeof p.hub?.text === "string" ? p.hub.text : null;
    let i = -1;
    for (let k = blocks.length - 1; k >= 0; k--) if (blocks[k]!.type === "text") { i = k; break; }
    const last = i >= 0 ? (blocks[i]!.text as string) : null;
    if (typed !== null && last !== null && last.startsWith(typed)) {
      // The last text block is "<typed text>\n\n<attachment notes>" (or only the notes when nothing was typed).
      let rest = last.slice(typed.length).replace(/^\n+/, "");
      rest = rest ? (text ? `\n\n${rest}` : rest) : "";
      const next = `${text}${rest}`;
      if (next) blocks[i] = { ...blocks[i]!, text: next };
      else blocks.splice(i, 1);
    } else if (typed !== null && last === null) {
      if (text) blocks.push({ type: "text", text });
    } else if (i >= 0) {
      blocks[i] = { ...blocks[i]!, text };
    } else if (text) {
      blocks.push({ type: "text", text });
    }
    content = blocks;
    empty = blocks.length === 0;
  }
  const msg = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
    uuid,
    origin: { kind: "human" },
    timestamp,
  } as unknown as SDKUserMessage;
  return { msg, meta, empty };
}
