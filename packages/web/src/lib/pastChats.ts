import { isRecord } from "./sdk";
import { truncate } from "./format";

/**
 * The hub's read-only history tools: `search_conversations` finds past chats, `read_conversation` reads one. The MCP
 * server prefix is the hub's business (`mcp__workstation-history__…`), so only the suffix counts.
 */
export type PastChatTool = "search" | "read";

export function pastChatTool(toolName: string): PastChatTool | null {
  if (/search_conversations$/.test(toolName)) return "search";
  if (/read_conversation$/.test(toolName)) return "read";
  return null;
}

const firstString = (input: unknown, keys: readonly string[]): string => {
  if (!isRecord(input)) return "";
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

/** What the search call asked for; tolerant of the argument name and of half-streamed input. */
export function searchQueryOf(input: unknown): string {
  return firstString(input, ["query", "q", "text", "keywords", "search"]);
}

/** The session a read call targets (an id; the title is looked up by the caller). */
export function readTargetOf(input: unknown): string {
  return firstString(input, ["session_id", "sessionId", "conversation_id", "conversationId", "id"]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (s: string): boolean => UUID.test(s);

/** A title the read result states about itself ("# Title", "Title: …" or JSON `{ "title": … }`), when it does. */
export function titleFromResult(text: string | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const o: unknown = JSON.parse(trimmed);
      const t = firstString(o, ["title", "name"]);
      if (t) return truncate(t, 120);
    } catch {
      /* not JSON: fall through to the text forms */
    }
  }
  const m = /^\s*(?:#\s+|title:\s*)(.+)$/im.exec(text);
  return m?.[1] ? truncate(m[1].trim(), 120) : "";
}
