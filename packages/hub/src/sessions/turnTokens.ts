/**
 * Live output-token counter of a running turn (the "↓ N tokens" Claude Code shows while it works).
 *
 * Authoritative numbers come from the stream: `message_start.message.usage.output_tokens` and
 * `message_delta.usage.output_tokens` (cumulative within one message). The API usually sends a single
 * `message_delta` at the end of a message, so between those the in-flight message is estimated from the text,
 * thinking and tool input streamed so far (≈ 4 characters per token, CJK ≈ 1); the exact count replaces the
 * estimate as soon as it arrives. Subagent messages (parent_tool_use_id set) count towards the turn total too;
 * each thread has at most one message in flight.
 */
import { tokenWeight } from "./context.js";

/** Minimum growth of the estimate before another usage delta is sent (exact counts are always sent). */
export const USAGE_DELTA_STEP = 32;

interface OpenMessage {
  messageId: string;
  reported: number;
  /** Estimated tokens streamed so far (fractional). */
  streamed: number;
  /** A message_delta carried the exact count. */
  exact: boolean;
}

const tokensOf = (m: OpenMessage): number => (m.exact ? m.reported : Math.max(m.reported, Math.round(m.streamed)));

export class TurnTokens {
  /** Output tokens of finished messages of this turn. */
  private done = 0;
  /** In-flight message per thread ("" = main loop, else the parent tool_use id). */
  private readonly open = new Map<string, OpenMessage>();
  /** The main loop's current (or last) message, for `outputTokens` in usage deltas. */
  private main: { messageId: string; tokens: number } = { messageId: "", tokens: 0 };
  private sent = 0;

  reset(): void {
    this.done = 0;
    this.open.clear();
    this.main = { messageId: "", tokens: 0 };
    this.sent = 0;
  }

  get total(): number {
    let n = this.done;
    for (const m of this.open.values()) n += tokensOf(m);
    return n;
  }

  get mainMessage(): { messageId: string; outputTokens: number } {
    const m = this.open.get("");
    return m ? { messageId: m.messageId, outputTokens: tokensOf(m) } : { messageId: this.main.messageId, outputTokens: this.main.tokens };
  }

  /** Id of the thread's in-flight message ("" when none). */
  messageIdOf(thread: string): string {
    return this.open.get(thread)?.messageId ?? "";
  }

  /** Every in-flight message with its (estimated or exact) output tokens so far. */
  inFlight(): { messageId: string; outputTokens: number }[] {
    return [...this.open.values()].map((m) => ({ messageId: m.messageId, outputTokens: tokensOf(m) }));
  }

  start(thread: string, messageId: string, outputTokens: unknown): void {
    this.finish(thread);
    this.open.set(thread, { messageId, reported: nonneg(outputTokens), streamed: 0, exact: false });
    if (thread === "") this.main = { messageId, tokens: nonneg(outputTokens) };
  }

  /** `message_delta.usage.output_tokens` (cumulative within the message). */
  report(thread: string, outputTokens: unknown): boolean {
    const m = this.open.get(thread);
    if (!m || typeof outputTokens !== "number" || !Number.isFinite(outputTokens)) return false;
    m.reported = Math.max(m.reported, nonneg(outputTokens));
    m.exact = true;
    this.syncMain(thread, m);
    return true;
  }

  /** Streamed text / thinking / tool-input characters of the in-flight message. */
  streamed(thread: string, text: string): void {
    const m = this.open.get(thread);
    if (!m || m.exact || !text) return;
    m.streamed += tokenWeight(text);
    this.syncMain(thread, m);
  }

  finish(thread: string): void {
    const m = this.open.get(thread);
    if (!m) return;
    this.done += tokensOf(m);
    this.syncMain(thread, m);
    this.open.delete(thread);
  }

  /** Whether a usage delta is due: always after an exact count, else once the total grew by USAGE_DELTA_STEP. */
  due(force: boolean): boolean {
    const t = this.total;
    if (t === this.sent || (!force && t - this.sent < USAGE_DELTA_STEP)) return false;
    this.sent = t;
    return true;
  }

  private syncMain(thread: string, m: OpenMessage): void {
    if (thread === "") this.main = { messageId: m.messageId, tokens: tokensOf(m) };
  }
}

function nonneg(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}
