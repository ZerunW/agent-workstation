/**
 * The hub's price table (USD per million tokens): what Claude requests cost (keyProxy.ts meters every request; billing.ts
 * sums them into the API-credit spend), the live cost estimate of a running turn (turnCost.ts), and the estimated
 * `cost_usd` of usage rows whose SDK reports none.
 *
 * Config `[pricing]` (per model id, a list of price periods; a period without `from` applies before the first dated
 * one; `from` = "YYYY-MM-DD" (hub local midnight) or a full ISO timestamp):
 *   [[pricing."claude-opus-5-5"]]
 *   input_per_mtok = 4
 *   output_per_mtok = 20
 *   cache_read_per_mtok = 0.20
 *   [[pricing."claude-opus-5-5"]]
 *   from = "2027-01-01"
 *   input_per_mtok = 5
 *   output_per_mtok = 25
 *   cache_read_per_mtok = 0.50
 * A configured model replaces the built-in periods of that model. Entries may give `cache_read_per_mtok`,
 * `cache_write_5m_factor` and `cache_write_1h_factor`; the daily price check (pricingCheck.ts) appends hub-owned
 * override periods on top.
 *
 * Claude defaults: Anthropic's first-party list prices as of 2026-10. Cache writes cost 1.25× (5-minute TTL) or 2×
 * (1-hour TTL) the input price, cache reads the listed cache-read price. Haiku 5.5 has a long-prompt tier: a request
 * whose input + cache tokens exceed 100K is billed at the higher prices throughout. `speed: "fast"` (Opus 5.5) costs
 * 2×. Web search costs $10 per 1,000 requests. Model ids are matched exactly, else by prefix (longest first, so dated or
 * suffixed ids such as `claude-haiku-4-5-20251001` or `claude-opus-5-5[1m]` find their entry; a further version number
 * such as `claude-opus-5-6` does not). An unknown Claude model is priced like the most expensive known family.
 */

/** Haiku 5.5-style long-prompt tier: above `above` input + cache tokens, the whole request uses these prices. */
export interface LongPromptTier {
  above: number;
  input: number;
  output: number;
  cacheRead: number;
}

export interface PricePeriod {
  /** Start of the period (null = from the beginning). */
  from: string | null;
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens (thinking included). */
  output: number;
  /** Cache-read tokens cost this share of the input price (used when `cacheRead` is not given). */
  cacheReadFactor: number;
  /** USD per million cache-read tokens (Claude). */
  cacheRead?: number;
  /** 5-minute cache writes cost this factor × input (default 1.25 for Claude, 1 otherwise). */
  cacheWrite5m?: number;
  /** 1-hour cache writes cost this factor × input (default 2 for Claude, 1 otherwise). */
  cacheWrite1h?: number;
  /** `speed: "fast"` multiplies every token price by this (absent = fast mode costs the same). */
  fastFactor?: number;
  /** Long-prompt tier (Haiku 5.5). */
  longPrompt?: LongPromptTier;
}

export type PricingTable = Record<string, PricePeriod[]>;

/** USD per web search request ($10 per 1,000). */
export const WEB_SEARCH_USD = 0.01;
export const CLAUDE_CACHE_WRITE_5M = 1.25;
export const CLAUDE_CACHE_WRITE_1H = 2;

const claude = (input: number, output: number, cacheRead: number, extra: Partial<PricePeriod> = {}): PricePeriod[] => [
  { from: null, input, output, cacheReadFactor: cacheRead / input, cacheRead, cacheWrite5m: CLAUDE_CACHE_WRITE_5M, cacheWrite1h: CLAUDE_CACHE_WRITE_1H, ...extra },
];

export const DEFAULT_PRICING: PricingTable = {
  "claude-fable-5-1": claude(10, 50, 0.25),
  "claude-fable-5": claude(10, 50, 1),
  "claude-opus-5-5": claude(4, 20, 0.2, { fastFactor: 2 }),
  "claude-opus-5": claude(5, 25, 0.5),
  "claude-opus-4-8": claude(5, 25, 0.5),
  "claude-opus-4-7": claude(5, 25, 0.5),
  "claude-opus-4-6": claude(5, 25, 0.5),
  "claude-sonnet-5-5": claude(2, 10, 0.2),
  "claude-sonnet-5": claude(2, 10, 0.2),
  "claude-sonnet-4-6": claude(3, 15, 0.3),
  "claude-haiku-5-5": claude(0.1, 0.5, 0.01, { longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } }),
  "claude-haiku-4-5": claude(1, 5, 0.1),
};

export const isClaudeModel = (model: string): boolean => model.startsWith("claude");

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes at the 5-minute rate (or writes whose TTL is unknown). */
  cacheCreate: number;
  /** Cache writes at the 1-hour rate. */
  cacheCreate1h?: number;
  webSearchRequests?: number;
  /** `fast` = fast mode (priced with the period's fastFactor). */
  speed?: string | null;
}

export interface CostOptions {
  /** Price an unknown model like the most expensive known Claude family (the key proxy: every request is Claude). */
  fallback?: boolean;
  /**
   * The counts are a sum over several requests (a turn's usage row): the long-prompt tier cannot be told per request,
   * so the base prices apply.
   */
  aggregate?: boolean;
}

/** Start of a period in ms: "YYYY-MM-DD" = local midnight, anything else parsed as a timestamp. */
function startMs(from: string | null): number {
  if (!from) return Number.NEGATIVE_INFINITY;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from.trim());
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime();
  const t = Date.parse(from);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

const toMs = (at: Date | string | number): number => (at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at));
const nonneg = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** `key` is a prefix of `model` that ends at an id boundary and is not followed by a further version number. */
function prefixMatches(model: string, key: string): boolean {
  if (!model.startsWith(key) || model.length === key.length) return model === key;
  const rest = model.slice(key.length);
  if (/^[A-Za-z0-9.]/.test(rest)) return false; // claude-opus-5 vs claude-opus-50
  return !/^-\d{1,2}(?!\d)/.test(rest); // -6 is another version; -20260101 is a date
}

/** USD of `tokens` at period `p` (unrounded). */
export function periodCost(model: string, p: PricePeriod, tokens: TokenCounts, opts: CostOptions = {}): number {
  const input = nonneg(tokens.input);
  const output = nonneg(tokens.output);
  const cacheRead = nonneg(tokens.cacheRead);
  const write5m = nonneg(tokens.cacheCreate);
  const write1h = nonneg(tokens.cacheCreate1h);
  const isClaude = isClaudeModel(model) || p.cacheRead !== undefined;
  let inRate = p.input;
  let outRate = p.output;
  let readRate = p.cacheRead ?? p.input * p.cacheReadFactor;
  const tier = p.longPrompt;
  if (tier && !opts.aggregate && input + cacheRead + write5m + write1h > tier.above) {
    inRate = tier.input;
    outRate = tier.output;
    readRate = tier.cacheRead;
  }
  const f5 = p.cacheWrite5m ?? (isClaude ? CLAUDE_CACHE_WRITE_5M : 1);
  const f1 = p.cacheWrite1h ?? (isClaude ? CLAUDE_CACHE_WRITE_1H : 1);
  const speed = tokens.speed === "fast" && p.fastFactor ? p.fastFactor : 1;
  const usd = (input * inRate + write5m * inRate * f5 + write1h * inRate * f1 + cacheRead * readRate + output * outRate) * speed;
  return usd / 1_000_000 + nonneg(tokens.webSearchRequests) * WEB_SEARCH_USD;
}

export class Pricing {
  private readonly table: Map<string, { start: number; p: PricePeriod }[]>;
  /** Table keys, longest first (prefix matching). */
  private readonly keys: string[];

  /** `onUnknown`: a Claude model without an entry was priced with the fallback. */
  constructor(
    table: PricingTable = DEFAULT_PRICING,
    private readonly onUnknown?: (model: string) => void,
  ) {
    this.table = new Map(Object.entries(table).map(([model, periods]) => [model, periods.map((p) => ({ start: startMs(p.from), p })).sort((a, b) => a.start - b.start)]));
    this.keys = [...this.table.keys()].sort((a, b) => b.length - a.length);
  }

  /** The table entry pricing `model` (exact id, else the longest matching prefix; null = none). */
  entryFor(model: string): string | null {
    if (this.table.has(model)) return model;
    return this.keys.find((k) => prefixMatches(model, k)) ?? null;
  }

  /** Every model id in the table. */
  models(): string[] {
    return [...this.table.keys()];
  }

  /** The price period of `model` in force at `at` (null = no price configured). */
  rateAt(model: string, at: Date | string | number): PricePeriod | null {
    const key = this.entryFor(model);
    const periods = key ? this.table.get(key) : undefined;
    if (!periods?.length) return null;
    const t = toMs(at);
    let hit: PricePeriod | null = null;
    for (const { start, p } of periods) if (start <= t) hit = p;
    return hit;
  }

  /** The most expensive Claude period in force at `at` (by output, then input price): the fallback for unknown models. */
  fallbackAt(at: Date | string | number): { model: string; p: PricePeriod } | null {
    let best: { model: string; p: PricePeriod } | null = null;
    for (const model of this.table.keys()) {
      if (!isClaudeModel(model)) continue;
      const p = this.rateAt(model, at);
      if (p && (!best || p.output > best.p.output || (p.output === best.p.output && p.input > best.p.input))) best = { model, p };
    }
    return best;
  }

  /**
   * Estimated USD cost of `tokens` of `model` at `at` (null = no price configured). Unknown Claude models (or any model
   * with `opts.fallback`) are priced like the most expensive known Claude family.
   */
  cost(model: string, tokens: TokenCounts, at: Date | string | number, opts: CostOptions = {}): number | null {
    let r = this.rateAt(model, at);
    if (!r && (opts.fallback || isClaudeModel(model))) {
      const fb = this.fallbackAt(at);
      if (fb) {
        r = fb.p;
        this.onUnknown?.(model);
      }
    }
    if (!r) return null;
    return Math.round(periodCost(model, r, tokens, opts) * 1e9) / 1e9;
  }
}

/** Merges configured periods over the defaults (a configured model replaces its default periods). */
export function pricingTable(configured: PricingTable | undefined): PricingTable {
  return { ...DEFAULT_PRICING, ...(configured ?? {}) };
}

/** Where a price period comes from. */
export type PeriodSource = "builtin" | "config" | "override";

export interface SourcedPeriod extends PricePeriod {
  model: string;
  source: PeriodSource;
}

/** A hub-owned period as the store keeps it (pricing_overrides). */
export interface StoredOverride {
  model: string;
  from: string;
  input: number;
  output: number;
  cacheReadFactor: number;
  cacheRead?: number | null;
  cacheWrite5m?: number | null;
  cacheWrite1h?: number | null;
  fastFactor?: number | null;
  longPrompt?: LongPromptTier | null;
}

/** What PricingService needs from the store. */
export interface PricingOverrideStore {
  listPricingOverrides(): StoredOverride[];
}

/** The period fields of a stored override (nulls dropped). */
export function overridePeriod(o: StoredOverride): PricePeriod {
  const p: PricePeriod = { from: o.from, input: o.input, output: o.output, cacheReadFactor: o.cacheReadFactor };
  if (o.cacheRead != null) p.cacheRead = o.cacheRead;
  if (o.cacheWrite5m != null) p.cacheWrite5m = o.cacheWrite5m;
  if (o.cacheWrite1h != null) p.cacheWrite1h = o.cacheWrite1h;
  if (o.fastFactor != null) p.fastFactor = o.fastFactor;
  if (o.longPrompt) p.longPrompt = o.longPrompt;
  return p;
}

const periodOnly = (p: SourcedPeriod): PricePeriod => {
  const { model: _model, source: _source, ...rest } = p;
  return rest;
};

/**
 * The prices in force: config / built-in periods with the hub-owned overrides (pricing_overrides, appended by the
 * daily price check) merged over them — an override period with the same `from` as a configured one replaces it,
 * otherwise it is added. `rebuild()` after an override was written; costs already stored are never recomputed (only
 * Store.backfillEstimatedCosts touches rows still at 0).
 */
export class PricingService {
  private pricing!: Pricing;
  private periodsList: SourcedPeriod[] = [];
  private readonly warned = new Set<string>();

  /** `configured` = config periods merged over the built-in ones (HubConfig.pricing). */
  constructor(
    private readonly configured: PricingTable,
    private readonly store: PricingOverrideStore,
    private readonly log?: { warn(obj: object, msg: string): void },
  ) {
    this.rebuild();
  }

  rebuild(): void {
    const merged = new Map<string, SourcedPeriod[]>();
    for (const [model, periods] of Object.entries(this.configured)) {
      const source: PeriodSource = DEFAULT_PRICING[model] === periods ? "builtin" : "config";
      merged.set(model, periods.map((p) => ({ ...p, model, source })));
    }
    for (const o of this.store.listPricingOverrides()) {
      const list = merged.get(o.model) ?? [];
      const period: SourcedPeriod = { ...overridePeriod(o), model: o.model, source: "override" };
      const same = list.findIndex((p) => p.from === o.from);
      if (same >= 0) list[same] = period;
      else list.push(period);
      merged.set(o.model, list);
    }
    const table: PricingTable = {};
    const all: SourcedPeriod[] = [];
    for (const [model, list] of merged) {
      const sorted = [...list].sort((a, b) => startMs(a.from) - startMs(b.from));
      table[model] = sorted.map(periodOnly);
      all.push(...sorted);
    }
    this.pricing = new Pricing(table, (model) => this.warnUnknown(model));
    this.periodsList = all;
  }

  private warnUnknown(model: string): void {
    if (this.warned.has(model)) return;
    this.warned.add(model);
    this.log?.warn({ model }, "no price for this model: priced like the most expensive known Claude family");
  }

  rateAt(model: string, at: Date | string | number): PricePeriod | null {
    return this.pricing.rateAt(model, at);
  }

  entryFor(model: string): string | null {
    return this.pricing.entryFor(model);
  }

  /** Every priced model id. */
  models(): string[] {
    return this.pricing.models();
  }

  cost(model: string, tokens: TokenCounts, at: Date | string | number, opts: CostOptions = {}): number | null {
    return this.pricing.cost(model, tokens, at, opts);
  }

  /** Every period of every priced model, in start order per model, with its source. */
  periods(): SourcedPeriod[] {
    return this.periodsList.map((p) => ({ ...p }));
  }
}

/** Start of a period in ms (exported for the price check). */
export const periodStartMs = startMs;
