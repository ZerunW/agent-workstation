/**
 * Past-conversation tools (read-only, like claude.ai's "reference past chats"), offered to sessions that are not
 * incognito through the in-process MCP server `workstation-history`. Pre-approved (no permission card).
 *
 *   search_conversations {query, limit?}  — relevant (the helper model, when available) and keyword hits merged:
 *                                           session id, title, kind, date and why it matched / a snippet.
 *   read_conversation {sessionId, maxChars?} — the plain user/assistant text of one of the user's own non-incognito
 *                                           sessions, truncated to the newest `maxChars` (default 20k).
 */
import { z } from "zod";
import type { SearchHit } from "@agent-workstation/protocol";
import type { Store } from "../db/store.js";
import type { HubToolSpec } from "../sessions/sdk.js";
import { errorMessage } from "../util/errors.js";
import type { SearchService } from "./service.js";
import { sessionTranscript } from "./summaries.js";
import { keepTail } from "./text.js";

export { HISTORY_SERVER } from "../sessions/hubTools.js";
export const HISTORY_TOOL_NAMES = ["search_conversations", "read_conversation"] as const;
export const READ_DEFAULT_CHARS = 20_000;
const READ_MAX_CHARS = 100_000;
const SEARCH_DEFAULT_LIMIT = 8;

/** The line in the Agent Workstation guide (sessions/guide.ts), re-exported for the tools' callers and tests. */
export { HISTORY_GUIDANCE } from "../sessions/guide.js";

export interface HistoryDeps {
  store: Pick<Store, "getSession" | "iterateMessages">;
  search: Pick<SearchService, "keyword" | "relevant">;
  /** Whether relevant (helper model) search can run now. */
  relevantAvailable: () => boolean;
}

const dateOf = (iso: string) => iso.slice(0, 10);
const oneLine = (s: string | null | undefined, max = 300) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The tools for a session of `user` (`currentSessionId` is left out of search results). */
export function historyTools(deps: HistoryDeps, user: string, currentSessionId: string): HubToolSpec[] {
  return [
    {
      name: "search_conversations",
      description:
        "Search the user's earlier conversations (chat and code sessions) by topic or keywords. Returns matching conversations with their id, title, kind, date and why they match. Read one with read_conversation.",
      schema: {
        query: z.string().min(1).max(500).describe("What to look for: a topic, a question, or keywords."),
        limit: z.number().int().min(1).max(20).optional().describe(`How many conversations to return (default ${SEARCH_DEFAULT_LIMIT}).`),
      },
      handler: async (args) => {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return { text: "No query given.", isError: true };
        const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.min(20, Math.max(1, args.limit)) : SEARCH_DEFAULT_LIMIT;
        const merged = new Map<string, { hit: SearchHit; reason?: string; snippet?: string | null }>();
        let note = "";
        if (deps.relevantAvailable()) {
          try {
            const r = await deps.search.relevant(user, query, limit + 1);
            for (const h of r.hits) if (h.session.id !== currentSessionId) merged.set(h.session.id, { hit: h, reason: h.reason, snippet: h.snippet });
          } catch (err) {
            note = `(Meaning-based search failed: ${errorMessage(err)}; keyword matches only.)\n`;
          }
        }
        for (const h of deps.search.keyword(user, query, limit + 1)) {
          if (h.session.id === currentSessionId) continue;
          const cur = merged.get(h.session.id);
          if (cur) cur.snippet = h.snippet ?? cur.snippet;
          else merged.set(h.session.id, { hit: h, snippet: h.snippet });
        }
        const list = [...merged.values()].slice(0, limit);
        if (!list.length) return `${note}No earlier conversations match "${query}".`;
        const lines = [`${note}${list.length} earlier conversation${list.length === 1 ? "" : "s"} for "${query}":`];
        list.forEach(({ hit, reason, snippet }, i) => {
          const s = hit.session;
          lines.push(`${i + 1}. "${oneLine(s.title, 120)}" — ${s.kind} · ${dateOf(s.lastActiveAt)} · id: ${s.id}`);
          if (reason) lines.push(`   why: ${oneLine(reason)}`);
          if (snippet) lines.push(`   ${reason ? "summary/match" : "match"}: ${oneLine(snippet)}`);
        });
        lines.push("Use read_conversation with an id to read one.");
        return lines.join("\n");
      },
    },
    {
      name: "read_conversation",
      description: "Read the text of one of the user's earlier conversations by its id (from search_conversations). Long conversations are cut to their most recent part.",
      schema: {
        sessionId: z.string().min(1).max(100).describe("The conversation id."),
        maxChars: z.number().int().min(1000).max(READ_MAX_CHARS).optional().describe(`At most this many characters (default ${READ_DEFAULT_CHARS}); the newest part is kept.`),
      },
      handler: async (args) => {
        const id = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
        const row = id ? deps.store.getSession(id) : null;
        if (!row || row.user !== user || row.hidden || row.incognito || row.parentSessionId) return { text: "No conversation with that id.", isError: true };
        const max = typeof args.maxChars === "number" && Number.isFinite(args.maxChars) ? Math.min(READ_MAX_CHARS, Math.max(1000, Math.trunc(args.maxChars))) : READ_DEFAULT_CHARS;
        const transcript = sessionTranscript(deps.store, row.id);
        const head = `Conversation "${oneLine(row.title, 200)}" (${row.kind} · started ${dateOf(row.createdAt)}, last active ${dateOf(row.lastActiveAt)}):\n\n`;
        if (!transcript.length) return `${head}(no messages)`;
        const body = transcript.map((t) => `${t.role === "user" ? "User" : "Assistant"} (${t.at.slice(0, 16).replace("T", " ")}): ${t.text}`).join("\n\n");
        return head + keepTail(body, Math.max(500, max - head.length));
      },
    },
  ];
}
