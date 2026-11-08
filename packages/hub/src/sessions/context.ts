/**
 * Context-window usage (Claude Code's `/context`) and token estimates. Pure helpers used by the session runtime.
 *
 * Totals come from the API usage of the turn's last main-loop request (input + cache read + cache creation).
 * The per-category breakdown comes from the CLI's `get_context_usage` control request in `summary` detail
 * (the CLI answers from the last response's usage plus local estimates: no model turn, no token-count calls,
 * nothing written to the transcript), mapped onto the hub's category keys.
 */
import type { ContextUsage } from "@agent-workstation/protocol";
import type { SdkContextUsage } from "./sdk.js";

export const DEFAULT_CONTEXT_WINDOW = 200_000;

type Breakdown = NonNullable<ContextUsage["breakdown"]>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Rough token weight of `text`: CJK / full-width characters ≈ 1 token each, everything else ≈ 4 characters per token. */
export function tokenWeight(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c >= 0x20000) cjk++;
    else other++;
  }
  return cjk + other / 4;
}

export const estimateTokens = (text: string): number => Math.ceil(tokenWeight(text));

/** Tokens a request put into the context window: input + cache creation + cache read. */
export function requestContextTokens(usage: unknown): number {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
  return num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
}

/** Known context windows when the result's `modelUsage` has none for the model (null = unknown). */
export function knownContextWindow(model: string | null): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("[1m]")) return 1_000_000;
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return 200_000;
  return null;
}

/**
 * The context window of `model`: the result's `modelUsage[model].contextWindow` (exact key, then a key that
 * extends or prefixes the model id, then the only entry), else the per-model table; null when unknown.
 */
export function contextWindowFor(model: string | null, modelUsage: unknown): number | null {
  const mu = (modelUsage && typeof modelUsage === "object" ? modelUsage : {}) as Record<string, { contextWindow?: unknown } | undefined>;
  const keys = Object.keys(mu);
  let key: string | undefined;
  if (model) key = keys.find((k) => k === model) ?? keys.find((k) => k.startsWith(model) || model.startsWith(k));
  if (!key && keys.length === 1) key = keys[0];
  const fromUsage = key ? num(mu[key]?.contextWindow) : 0;
  return fromUsage || knownContextWindow(model ?? key ?? null);
}

/** The model a result's `modelUsage` is about when nothing else says (the entry with the most input). */
export function primaryModel(modelUsage: unknown): string | null {
  const mu = (modelUsage && typeof modelUsage === "object" ? modelUsage : {}) as Record<string, Record<string, unknown> | undefined>;
  let best: { key: string; n: number } | null = null;
  for (const [key, v] of Object.entries(mu)) {
    const n = num(v?.inputTokens) + num(v?.cacheReadInputTokens) + num(v?.cacheCreationInputTokens);
    if (!best || n > best.n) best = { key, n };
  }
  return best?.key ?? null;
}

/** Hub category key ← CLI category ids, in display order. */
const CATEGORIES: { key: string; label: string; ids: string[]; optional?: boolean }[] = [
  { key: "system_prompt", label: "System prompt", ids: ["system_prompt"] },
  { key: "system_tools", label: "System tools", ids: ["system_tools"] },
  { key: "mcp_tools", label: "MCP tools", ids: ["mcp_tools", "mcp_instructions"] },
  { key: "custom_agents", label: "Custom agents", ids: ["custom_agents"], optional: true },
  { key: "skills", label: "Skills", ids: ["skills"] },
  { key: "memory", label: "Memory", ids: ["memory_files"] },
  { key: "messages", label: "Messages", ids: ["messages"] },
  { key: "autocompact_buffer", label: "Autocompact buffer", ids: ["autocompact_buffer", "compact_buffer"] },
];

/**
 * Maps the CLI's `/context` categories onto the hub's keys. Deferred rows (out-of-window tool schemas) and free
 * space are left out (clients derive free space). Returns null when the CLI did not label its rows with ids
 * (older CLIs): rows are never classified by their English names.
 *
 * - `memory` = Claude Code memory files (CLAUDE.md) plus the hub's memory section, whose estimated size is
 *   moved out of `system_prompt` (the hub sends it as part of the system prompt).
 * - When `usedTokens` (the measured context of the last request) is given, `messages` is what remains of it
 *   after the other in-window rows, so the in-window rows add up to `usedTokens`.
 */
export function breakdownFromCli(r: SdkContextUsage, opts: { usedTokens: number | null; memorySectionTokens: number }): Breakdown | null {
  const cats = Array.isArray(r?.categories) ? r.categories : [];
  if (!cats.some((c) => typeof c.id === "string")) return null;
  const sums = new Map<string, number>();
  for (const c of cats) {
    if (!c.id || (c.kind !== "used" && c.kind !== "buffer") || c.isDeferred) continue;
    const cat = CATEGORIES.find((x) => x.ids.includes(c.id!));
    if (!cat) continue;
    sums.set(cat.key, (sums.get(cat.key) ?? 0) + num(c.tokens));
  }
  if (opts.memorySectionTokens > 0) {
    const moved = Math.min(opts.memorySectionTokens, sums.get("system_prompt") ?? 0);
    sums.set("system_prompt", (sums.get("system_prompt") ?? 0) - moved);
    sums.set("memory", (sums.get("memory") ?? 0) + moved);
  }
  if (opts.usedTokens !== null) {
    let fixed = 0;
    for (const [key, n] of sums) if (key !== "messages" && key !== "autocompact_buffer") fixed += n;
    sums.set("messages", Math.max(0, opts.usedTokens - fixed));
  }
  const out: Breakdown = [];
  for (const cat of CATEGORIES) {
    const tokens = sums.get(cat.key) ?? 0;
    if (cat.optional && tokens === 0) continue;
    out.push({ key: cat.key, label: cat.label, tokens });
  }
  return out;
}
