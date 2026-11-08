/**
 * Proxy for the hub's API-credit usage (`GET /api/usage/limits`), so the status page can show the budget bar
 * without talking to the hub from the browser (no CORS, works through the single nginx upstream, and degrades to an
 * error notice when the hub is down). The hub is asked as the configured `[status] hub_user` (or with no user when
 * none is set), never as a name the caller sends: the hub creates a user for every name it sees.
 */
import { UsageLimits } from "@agent-workstation/protocol";
import type { z } from "zod";

/** The hub's usage limits, or why they are not available (`error`; `api` null then). */
export type UsageLimitsBody = z.infer<typeof UsageLimits> & { error?: string };

const CACHE_TTL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 4000;

export function unavailable(error: string): UsageLimitsBody {
  return { api: null, error };
}

export class UsageProxy {
  private cache: { at: number; body: UsageLimitsBody } | null = null;

  constructor(
    private readonly o: {
      hubUrl: string;
      /** The identity presented to the hub (config `status.hub_user`); null = none. */
      defaultUser: string | null;
      fetch?: typeof fetch;
      nowMs?: () => number;
    },
  ) {}

  async get(): Promise<UsageLimitsBody> {
    const now = this.o.nowMs ? this.o.nowMs() : Date.now();
    const user = this.o.defaultUser ?? "";
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.body;

    const doFetch = this.o.fetch ?? fetch;
    let body: UsageLimitsBody;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (user) headers["X-Workstation-User"] = user;
      const res = await doFetch(`${this.o.hubUrl}/api/usage/limits`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) {
        body = unavailable(`hub answered HTTP ${res.status}`);
      } else {
        const parsed = UsageLimits.safeParse(await res.json());
        body = parsed.success ? { api: parsed.data.api } : unavailable("hub returned an unexpected usage payload");
      }
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string }; message?: string };
      const why = e?.name === "TimeoutError" ? "timed out" : e?.cause?.code === "ECONNREFUSED" ? "connection refused" : (e?.message ?? "unreachable");
      body = unavailable(`hub unreachable: ${why}`);
    }
    this.cache = { at: now, body };
    return body;
  }
}
