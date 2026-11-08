/**
 * Session summaries for relevant search and the past-conversation tools.
 *
 * When a non-incognito session goes idle after new messages, the hub asks Claude Haiku (helper.ts)
 * for a 2–3 sentence summary of the title and the plain transcript (≤ 30k characters: the start and the end are kept)
 * and stores it in `session_summaries`. Debounced (a session must stay idle for `debounceMs`), at most once per
 * `minIntervalMs` (10 min) per session, one run at a time, skipped while the helper is unavailable (no key, budget
 * spent). The call is billed in api_requests (purpose `summary`, the session's user).
 */
import type { Store } from "../db/store.js";
import { errorMessage } from "../util/errors.js";
import type { Logger } from "../util/log.js";
import { SUMMARY_MAX_TOKENS, type HelperRunner } from "../helper.js";
import { HELPER_MODEL } from "../sessions/models.js";
import { keepHeadAndTail, messagePlainText } from "./text.js";

export const SUMMARY_TRANSCRIPT_CHARS = 30_000;
const MAX_SUMMARY_CHARS = 800;

export interface SummaryDeps {
  store: Store;
  helper: HelperRunner;
  available: () => boolean;
  /** The session has no turn running / queued. */
  isIdle: (sessionId: string) => boolean;
  log: Logger;
  /** How long a session must stay idle before it is summarized (default 90 s). */
  debounceMs?: number;
  /** At most one summary per session per this interval (default 10 min). */
  minIntervalMs?: number;
  clock?: () => number;
}

/** The plain user/assistant transcript of a session (oldest first). */
export function sessionTranscript(store: Pick<Store, "iterateMessages">, sessionId: string): { role: "user" | "assistant"; text: string; at: string }[] {
  const out: { role: "user" | "assistant"; text: string; at: string }[] = [];
  for (const m of store.iterateMessages(sessionId, 0)) {
    if (m.kind !== "user" && m.kind !== "assistant") continue;
    const t = messagePlainText(m.kind, m.payload, 500_000);
    if (t) out.push({ ...t, at: m.at });
  }
  return out;
}

export function buildSummaryPrompt(title: string, transcript: { role: "user" | "assistant"; text: string }[]): string {
  const body = keepHeadAndTail(transcript.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n"), SUMMARY_TRANSCRIPT_CHARS);
  return [
    "You write short summaries of a person's conversations with an AI assistant, for their private search index.",
    "Summarize the conversation below in 2–3 sentences: what it is about, the key facts, decisions or results. Write in the language the conversation mostly uses. Plain text only: no preamble, no lists, no Markdown.",
    "",
    `Title: ${title}`,
    "Conversation:",
    "<<<",
    body,
    ">>>",
  ].join("\n");
}

export class SummaryService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastRun = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: SummaryDeps) {}

  private now(): number {
    return (this.deps.clock ?? Date.now)();
  }

  /** A turn ended and nothing is queued: summarize after the debounce (if there is something new by then). */
  sessionIdle(sessionId: string): void {
    if (this.stopped) return;
    const row = this.deps.store.getSession(sessionId);
    if (!row || row.incognito || row.hidden || row.parentSessionId) return;
    const debounce = this.deps.debounceMs ?? 90_000;
    const last = this.lastRun.get(sessionId) ?? 0;
    const due = Math.max(this.now() + debounce, last + (this.deps.minIntervalMs ?? 10 * 60_000));
    this.schedule(sessionId, due - this.now());
  }

  private schedule(sessionId: string, ms: number): void {
    const prev = this.timers.get(sessionId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(sessionId);
      this.chain = this.chain.then(() => this.run(sessionId)).catch((err) => this.deps.log.warn({ sessionId, err: errorMessage(err) }, "session summary failed"));
    }, Math.max(0, ms));
    t.unref?.();
    this.timers.set(sessionId, t);
  }

  /** The session was deleted. */
  forget(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) clearTimeout(t);
    this.timers.delete(sessionId);
    this.lastRun.delete(sessionId);
  }

  /** Waits for the queued runs (tests). */
  async idle(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Summarizes now when due. Returns true when a summary was written. */
  async run(sessionId: string): Promise<boolean> {
    if (this.stopped) return false;
    const row = this.deps.store.getSession(sessionId);
    if (!row || row.incognito || row.hidden || row.parentSessionId) return false;
    const existing = this.deps.store.getSummary(sessionId);
    if (existing && existing.messageSeq >= row.lastSeq) return false; // nothing new
    if (!this.deps.isIdle(sessionId)) return false; // the next idle reschedules
    const minInterval = this.deps.minIntervalMs ?? 10 * 60_000;
    const last = this.lastRun.get(sessionId) ?? 0;
    if (this.now() - last < minInterval) {
      this.schedule(sessionId, last + minInterval - this.now());
      return false;
    }
    if (!this.deps.available()) return false;
    const transcript = sessionTranscript(this.deps.store, sessionId);
    if (!transcript.length) return false;
    this.lastRun.set(sessionId, this.now());
    const out = await this.deps.helper(buildSummaryPrompt(row.title, transcript), { purpose: "summary", user: row.user, maxTokens: SUMMARY_MAX_TOKENS });
    if (this.stopped) return false; // the hub is shutting down (the store may be closed)
    const current = this.deps.store.getSession(sessionId);
    if (!current || current.incognito) return false; // deleted meanwhile
    if (!out.ok) {
      this.deps.log.warn({ sessionId, err: out.error }, "could not summarize a session");
      return false;
    }
    const summary = out.text.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS);
    this.deps.store.upsertSummary({ sessionId, user: row.user, summary, model: HELPER_MODEL, messageSeq: row.lastSeq, updatedAt: new Date(this.now()).toISOString() });
    return true;
  }
}
