/**
 * Usage accounting and the API-credit limits row.
 *
 * Token accounting: `result.modelUsage` holds totals for the whole Claude
 * session — including turns from earlier processes once it is resumed — not
 * for the turn. The hub keeps the last cumulative per session
 * (sessions.usage_cumulative) and persists only the delta in `turns`. If a
 * total goes down (after /clear, or a fresh conversation id) the new total
 * is taken as the delta.
 *
 * Limits: the only limit is the API-credit budget (billing.ts); this service
 * broadcasts it as `usage_limits`.
 */
import type { ApiCredits, UsageLimits } from "@agent-workstation/protocol";
import type { Logger } from "../util/log.js";
import type { Broadcaster } from "../ws/protocol.js";

export interface ModelTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cost: number;
}

export interface Cumulative {
  models: Record<string, ModelTotals>;
}

export interface UsageDelta extends ModelTotals {
  model: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function totalsOf(u: unknown): ModelTotals {
  const o = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
  return {
    input: num(o.inputTokens),
    output: num(o.outputTokens),
    cacheRead: num(o.cacheReadInputTokens),
    cacheCreate: num(o.cacheCreationInputTokens),
    cost: num(o.costUSD),
  };
}

export function parseCumulative(json: string | null): Cumulative | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Cumulative;
    return v && typeof v === "object" && v.models ? v : null;
  } catch {
    return null;
  }
}

/** Turns cumulative per-model totals into per-turn deltas. Pure. */
export function computeUsageDelta(prev: Cumulative | null, modelUsage: unknown): { deltas: UsageDelta[]; next: Cumulative } {
  const next: Cumulative = { models: { ...(prev?.models ?? {}) } };
  const deltas: UsageDelta[] = [];
  if (!modelUsage || typeof modelUsage !== "object") return { deltas, next };
  for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    const cur = totalsOf(raw);
    const p = prev?.models[model];
    const reset =
      !p || cur.input < p.input || cur.output < p.output || cur.cacheRead < p.cacheRead || cur.cacheCreate < p.cacheCreate || cur.cost < p.cost - 1e-9;
    const d: UsageDelta = reset
      ? { model, ...cur }
      : {
          model,
          input: cur.input - p.input,
          output: cur.output - p.output,
          cacheRead: cur.cacheRead - p.cacheRead,
          cacheCreate: cur.cacheCreate - p.cacheCreate,
          cost: Math.max(0, cur.cost - p.cost),
        };
    next.models[model] = cur;
    if (d.input || d.output || d.cacheRead || d.cacheCreate || d.cost > 0) deltas.push(d);
  }
  return { deltas, next };
}

// ---------------------------------------------------------------- limits

type Severity = ApiCredits["severity"];

/** Severity of a spent share: ≥ 95 → critical, ≥ 80 → warning, otherwise normal; `fallback` when unknown. */
export function reconcileSeverity(percent: number | null, fallback: Severity): Severity {
  if (percent === null || !Number.isFinite(percent)) return fallback;
  return percent >= 95 ? "critical" : percent >= 80 ? "warning" : "normal";
}

export interface UsageLimitsDeps {
  bus: Broadcaster;
  log: Logger;
}

/** Holds where the API-credit row comes from and broadcasts it. */
export class UsageLimitsService {
  private apiBlock: () => ApiCredits | null = () => null;

  constructor(private readonly deps: UsageLimitsDeps) {}

  current(): UsageLimits {
    let api: ApiCredits | null = null;
    try {
      api = this.apiBlock() ?? null;
    } catch (err) {
      this.deps.log.warn({ err: String(err) }, "could not compute the API budget row");
    }
    return { api };
  }

  /** Where UsageLimits.api comes from (the billing service). */
  setApiSource(fn: () => ApiCredits | null): void {
    this.apiBlock = fn;
  }

  /** Broadcasts the current limits (after metered usage or a budget change). */
  broadcast(): void {
    this.deps.bus.toAll({ type: "usage_limits", limits: this.current() });
  }
}
