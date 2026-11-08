/**
 * Live list-price cost estimate of a running turn, from the usage on the stream (`message_start`, `message_delta`,
 * `assistant`), so clients can enforce budgets before the turn's `result` brings the exact figure.
 *
 * Per API message (keyed by message id, so repeated `assistant` records of one message count once) the largest value
 * seen of each token class wins; the turn is the sum over all messages, subagents included. Each message is priced
 * like one request with the hub's price table (pricing.ts: cache-write TTLs, cache reads, the Haiku 5.5 long-prompt
 * tier, fast mode, web search); unknown models are priced like the most expensive known Claude family so a budget is
 * never undercounted. The estimate only ever grows within a turn.
 */
import { Pricing, type CostOptions, type TokenCounts } from "../pricing.js";

/** What TurnCost needs from the price table (PricingService in the hub). */
export interface TurnPricer {
  cost(model: string, tokens: TokenCounts, at: Date | string | number, opts?: CostOptions): number | null;
}

/** The built-in table (when the runtime is given none). */
const builtin = new Pricing();

interface Entry {
  model: string | null;
  input: number;
  cacheCreate: number;
  cache1h: number;
  cacheRead: number;
  output: number;
  webSearch: number;
  speed: string | null;
}

const nonneg = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export class TurnCost {
  private readonly messages = new Map<string, Entry>();
  private peak = 0;

  constructor(
    private readonly pricer: TurnPricer = builtin,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  reset(): void {
    this.messages.clear();
    this.peak = 0;
  }

  /** Folds the usage of one message in (any of the fields may be missing). */
  note(messageId: string, model: string | null | undefined, usage: unknown): void {
    const u = obj(usage);
    const e = this.entry(messageId, model);
    e.input = Math.max(e.input, nonneg(u.input_tokens));
    e.cacheCreate = Math.max(e.cacheCreate, nonneg(u.cache_creation_input_tokens));
    e.cache1h = Math.max(e.cache1h, nonneg(obj(u.cache_creation).ephemeral_1h_input_tokens));
    e.cacheRead = Math.max(e.cacheRead, nonneg(u.cache_read_input_tokens));
    e.output = Math.max(e.output, nonneg(u.output_tokens));
    e.webSearch = Math.max(e.webSearch, nonneg(obj(u.server_tool_use).web_search_requests));
    if (typeof u.speed === "string") e.speed = u.speed;
  }

  /** Output tokens of a message that is still streaming (estimate or exact). */
  setOutput(messageId: string, tokens: number): void {
    const e = this.entry(messageId, null);
    e.output = Math.max(e.output, nonneg(tokens));
  }

  /** Estimated USD cost of the turn so far (never decreases). */
  get usd(): number {
    const at = this.clock();
    let usd = 0;
    for (const e of this.messages.values()) {
      const write1h = Math.min(e.cache1h, e.cacheCreate);
      const tokens: TokenCounts = { input: e.input, output: e.output, cacheRead: e.cacheRead, cacheCreate: e.cacheCreate - write1h, cacheCreate1h: write1h, webSearchRequests: e.webSearch, speed: e.speed };
      usd += this.pricer.cost(e.model ?? "unknown", tokens, at, { fallback: true }) ?? 0;
    }
    this.peak = Math.max(this.peak, Math.round(usd * 1e9) / 1e9);
    return this.peak;
  }

  private entry(messageId: string, model: string | null | undefined): Entry {
    let e = this.messages.get(messageId);
    if (!e) {
      e = { model: model ?? null, input: 0, cacheCreate: 0, cache1h: 0, cacheRead: 0, output: 0, webSearch: 0, speed: null };
      this.messages.set(messageId, e);
    } else if (model && !e.model) e.model = model;
    return e;
  }
}
