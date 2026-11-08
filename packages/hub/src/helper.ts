/**
 * The hub's helper model: one-shot Claude Haiku calls over the Messages API with the hub's key (routes/messagesApi.ts),
 * for relevant search ranking, session summaries, the download safety check and the price check. No tools: the model
 * answers from the prompt only. Each call records its own api_requests row (session_id NULL, purpose = the helper,
 * user = whom it ran for), so it counts against the monthly budget like everything else.
 *
 * Available while Agent Workstation's services may use the API (BillingService.servicesAvailable: a key, a budget > 0,
 * credits not reported exhausted, anything of the budget left). Otherwise the callers degrade: relevant search is
 * hidden (503 api_unavailable), downloads from hosts outside the well-known list ask the person, no summaries are
 * written, the price check is skipped.
 */
import { HELPER_MODEL } from "./sessions/models.js";
import { streamMessages, type MessagesHub } from "./routes/messagesApi.js";

export type HelperPurpose = "summary" | "search" | "download" | "pricing";

/** Prompts are capped at this many bytes (callers fit their data into it). */
export const HELPER_PROMPT_MAX_BYTES = 100_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_TOKENS = 2000;
/** Answer budgets of the short helpers (leave room for the answer even when the model writes before it). */
export const DOWNLOAD_CHECK_MAX_TOKENS = 1000;
export const SUMMARY_MAX_TOKENS = 1000;

export interface HelperOptions {
  purpose: HelperPurpose;
  /** api_requests.user: the user it ran for ("" when nobody in particular). */
  user: string;
  system?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface HelperOutcome {
  ok: boolean;
  text: string;
  error: string | null;
  costUsd: number;
  durationMs: number;
}

export type HelperRunner = (prompt: string, opts: HelperOptions) => Promise<HelperOutcome>;

/** The helper may run now (key, budget, credits). */
export const helperAvailable = (hub: Pick<MessagesHub, "billing">): boolean => hub.billing.servicesAvailable() && !!hub.billing.apiKey();

/** Why the helper cannot run (for logs and error bodies). */
export function helperUnavailableReason(hub: Pick<MessagesHub, "billing">): string {
  if (!hub.billing.apiKey()) return "No Anthropic API key is configured on the server.";
  if (hub.billing.recentlyExhausted()) return "The Anthropic API reported that the credits are exhausted.";
  return "This month's API budget is used up.";
}

/** One helper call; never throws (failures come back as `ok: false`). */
export async function runHelper(hub: MessagesHub, prompt: string, opts: HelperOptions): Promise<HelperOutcome> {
  const started = Date.now();
  const fail = (error: string, costUsd = 0): HelperOutcome => ({ ok: false, text: "", error, costUsd, durationMs: Date.now() - started });
  const key = hub.billing.apiKey();
  if (!key || !hub.billing.servicesAvailable()) return fail(helperUnavailableReason(hub));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  let text = "";
  try {
    const out = await streamMessages(hub, {
      key,
      request: {
        model: HELPER_MODEL,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        // One-shot answers: no thinking, least effort.
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: prompt }],
      },
      user: opts.user,
      purpose: opts.purpose,
      signal: ac.signal,
      label: `${opts.purpose} helper`,
      onText: (t) => {
        text += t;
      },
    });
    if (ac.signal.aborted) return fail("the helper model did not answer in time");
    if (!out.ok) return fail(out.message);
    const answer = text.trim();
    if (!answer) return fail("the helper model gave an empty answer", out.costUsd);
    return { ok: true, text: answer, error: null, costUsd: out.costUsd, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** The JSON object in a model's answer (bare, in a code fence, or between the first "{" and the last "}"); null when none parses. */
export function answerJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1];
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  for (const c of [t, fenced, first >= 0 && last > first ? t.slice(first, last + 1) : undefined]) {
    if (!c) continue;
    try {
      const v = JSON.parse(c.trim()) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next */
    }
  }
  return null;
}
