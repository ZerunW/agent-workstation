/**
 * Billing: every Claude process is paid by the Anthropic API key configured on the server.
 *
 * - Key: `auth.anthropic_api_key_file` (default /etc/agent-workstation/anthropic.env), a line `ANTHROPIC_API_KEY=...` or a bare
 *   key. Read at start, on SIGHUP (main.ts) and when the file's mtime changed (checked every 60 s). The key lives only
 *   in memory: it is never logged, never put into the hub's own process.env, and never given to a child process. A
 *   Claude child gets the hub's loopback proxy (keyProxy.ts) as ANTHROPIC_BASE_URL and a per-process proxy token as
 *   ANTHROPIC_API_KEY (`billingEnv`); the proxy swaps the token for the key. Without a key no session starts
 *   (503 api_unavailable).
 * - Budget: `AdminSettings.apiMonthlyLimitUsd` (0 = nothing may start) per period from the most recent `apiResetDay`
 *   00:00 hub local time to the same day next month. Spend = the metered API requests of the period (`api_requests`:
 *   every 2xx Messages call through the key proxy and the hub's own Messages API calls, priced from Anthropic's
 *   reported usage with the hub's price table — also requests of turns that never reached a `result`). Turn costs stay
 *   usage figures only (per session / per user).
 * - Service reserve: the last `AdminSettings.serviceReserveUsd` (default $2) of the period are kept for Agent
 *   Workstation's own API services (the docs assistant, search ranking, summaries, the download check, the price
 *   check): sessions stop starting turns once remaining ≤ the service reserve (overBudget / assertCanSend); the services
 *   run while anything remains (servicesAvailable).
 */
import { readFileSync, statSync } from "node:fs";
import type { ApiCredits } from "@agent-workstation/protocol";
import type { Store } from "./db/store.js";
import { type ApiCredential, type MeteredUsage, PROXY_TOKEN_RE } from "./keyProxy.js";
import type { PricingService } from "./pricing.js";
import type { SettingsService } from "./settings.js";
import { reconcileSeverity } from "./sessions/usage.js";
import { HttpError } from "./util/errors.js";
import type { Logger } from "./util/log.js";
import { type Clock, systemClock } from "./util/time.js";

/** The key in a key file: `ANTHROPIC_API_KEY=...` (optionally `export`, quoted), else the first bare token line. */
export function parseKeyFile(text: string): string | null {
  let bare: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) {
      const v = m[1]!.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
      return v || null;
    }
    if (bare === null && !line.includes("=") && !/\s/.test(line)) bare = line;
  }
  return bare;
}

export interface ApiKeyStoreOptions {
  file: string;
  log: Logger;
  /** mtime check interval (default 60 s; 0 = no timer). */
  pollMs?: number;
  /** The key appeared, disappeared or changed. */
  onChange?: (present: boolean) => void;
}

/** Holds the API key read from the key file (memory only). */
export class ApiKeyStore {
  private value: string | null = null;
  private mtimeMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: ApiKeyStoreOptions) {}

  get file(): string {
    return this.o.file;
  }

  /** The key, or null when none is configured. Never log it. */
  key(): string | null {
    return this.value;
  }

  present(): boolean {
    return this.value !== null;
  }

  /** Reads the file now. Returns true when the key changed (appeared, disappeared or differs). */
  reload(): boolean {
    let next: string | null = null;
    let mtime: number | null = null;
    try {
      mtime = statSync(this.o.file).mtimeMs;
      next = parseKeyFile(readFileSync(this.o.file, "utf8"));
      if (!next) this.o.log.warn({ file: this.o.file }, "the Anthropic API key file holds no key; sessions cannot start");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.o.log.warn({ file: this.o.file, code }, "could not read the Anthropic API key file; sessions cannot start");
    }
    this.mtimeMs = mtime;
    const changed = next !== this.value;
    this.value = next;
    if (changed) {
      this.o.log.info({ file: this.o.file, present: next !== null }, next ? "Anthropic API key loaded" : "no Anthropic API key configured");
      this.o.onChange?.(next !== null);
    }
    return changed;
  }

  /** Re-reads the file when its mtime changed (or it appeared / vanished). */
  checkMtime(): boolean {
    let mtime: number | null = null;
    try {
      mtime = statSync(this.o.file).mtimeMs;
    } catch {
      mtime = null;
    }
    if (mtime === this.mtimeMs) return false;
    return this.reload();
  }

  start(): void {
    this.reload();
    const every = this.o.pollMs ?? 60_000;
    if (every > 0 && !this.timer) {
      this.timer = setInterval(() => this.checkMtime(), every);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Environment for a Claude child process: any inherited ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL is
 * replaced by the proxy's base URL and the process's proxy token (never the real key). Mutates and returns `env`.
 * Throws (503 api_unavailable) without a credential, and refuses anything but a proxy token.
 */
export function billingEnv(env: Record<string, string | undefined>, cred: ApiCredential | null): Record<string, string | undefined> {
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  if (!cred) throw new HttpError(503, "api_unavailable", "No Anthropic API key is configured on the server.");
  if (!PROXY_TOKEN_RE.test(cred.token)) throw new HttpError(500, "internal", "refusing to give a Claude process anything but a proxy token");
  env.ANTHROPIC_BASE_URL = cred.baseUrl;
  env.ANTHROPIC_API_KEY = cred.token;
  return env;
}

/** The budget period containing `now`: from the most recent `resetDay` 00:00 (local time) to the next one. */
export function apiPeriod(now: Date, resetDay: number): { start: Date; end: Date } {
  const day = Math.min(28, Math.max(1, Math.trunc(resetDay) || 1));
  const y = now.getFullYear();
  const m = now.getMonth();
  const thisMonth = new Date(y, m, day);
  const start = now.getTime() >= thisMonth.getTime() ? thisMonth : new Date(y, m - 1, day);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, day);
  return { start, end };
}

/**
 * The cost (USD) of one metered API request with the hub's price table, as recorded in api_requests: the key proxy's
 * requests (hub.ts) and the hub's own (routes/messagesApi.ts). 0 when no tokens were reported.
 */
export function meteredCostUsd(pricing: Pick<PricingService, "cost">, m: MeteredUsage, at: string): number {
  const model = m.model ?? "unknown";
  const tokens = { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheCreate: m.cacheWrite5m, cacheCreate1h: m.cacheWrite1h, webSearchRequests: m.webSearchRequests, speed: m.speed };
  const any = m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h + m.webSearchRequests > 0;
  return any ? (pricing.cost(model, tokens, at, { fallback: true }) ?? 0) : 0;
}

/** "Credit balance is too low" — the API's answer when the organisation's credits are used up. */
export function isCreditBalanceText(text: string): boolean {
  return /credit balance is too low|insufficient (?:credit|credits|balance)|purchase (?:more )?credits/i.test(text);
}

/** After the API reported exhausted credits, sends are refused for this long (or until the key changes). */
const EXHAUSTED_HOLD_MS = 15 * 60_000;

export interface BillingDeps {
  store: Pick<Store, "apiSpend">;
  settings: Pick<SettingsService, "get">;
  keys: Pick<ApiKeyStore, "key" | "present">;
  clock?: Clock;
}

export class BillingService {
  private exhaustedAt: number | null = null;

  constructor(private readonly deps: BillingDeps) {}

  private now(): Date {
    return (this.deps.clock ?? systemClock)();
  }

  limitUsd(): number {
    const v = this.deps.settings.get().apiMonthlyLimitUsd;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 100;
  }

  /**
   * The last this-many USD of the period's budget are kept for Agent Workstation's own services: sessions stop starting
   * turns once remaining ≤ this (default 2).
   */
  serviceReserveUsd(): number {
    const v = this.deps.settings.get().serviceReserveUsd;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 2;
  }

  /** limit − spent of this period, in cents. */
  private remainingCents(): number {
    return Math.round((this.limitUsd() - this.spentUsd()) * 100);
  }

  /**
   * Agent Workstation's own API services (the docs assistant, search ranking, summaries, the download check, the price
   * check) may run: a key is configured, the budget is > 0, the
   * API has not just reported exhausted credits and anything of the budget remains (they may use the service reserve).
   */
  servicesAvailable(): boolean {
    if (!this.available() || this.recentlyExhausted()) return false;
    return this.remainingCents() > 0;
  }

  /** The API recently reported the credits exhausted (sessions and services pause for a while). */
  recentlyExhausted(): boolean {
    return this.exhaustedAt !== null && this.now().getTime() - this.exhaustedAt < EXHAUSTED_HOLD_MS;
  }

  resetDay(): number {
    const v = this.deps.settings.get().apiResetDay;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 28 ? v : 1;
  }

  period(): { start: Date; end: Date } {
    return apiPeriod(this.now(), this.resetDay());
  }

  spentUsd(): number {
    const p = this.period();
    return this.deps.store.apiSpend(p.start.toISOString(), p.end.toISOString());
  }

  apiKey(): string | null {
    return this.deps.keys.key();
  }

  /** A key is configured and the budget is > 0 (Me.apiAvailable). */
  available(): boolean {
    return this.deps.keys.present() && this.limitUsd() > 0;
  }

  /**
   * Sessions may not start a turn: this period's remaining budget is down to the service reserve (or used
   * up), or the API recently said the credits are exhausted.
   */
  overBudget(): boolean {
    if (this.recentlyExhausted()) return true;
    return this.remainingCents() <= Math.round(this.serviceReserveUsd() * 100);
  }

  /** The API answered "credit balance is too low": refuse turns for a while. */
  markCreditsExhausted(): void {
    this.exhaustedAt = this.now().getTime();
  }

  /** The key changed or the admin changed the budget: forget the exhausted flag. */
  clearCreditsExhausted(): void {
    this.exhaustedAt = null;
  }

  assertAvailable(): void {
    if (!this.deps.keys.present()) throw new HttpError(503, "api_unavailable", "No Anthropic API key is configured on the server (see /etc/agent-workstation/anthropic.env).");
    if (this.limitUsd() <= 0) throw new HttpError(503, "api_unavailable", "The monthly API budget is 0.");
  }

  /** Before a turn: 503 when unavailable, 429 api_limit_reached when only the service reserve remains. */
  assertCanSend(): void {
    this.assertAvailable();
    if (this.overBudget()) {
      const p = this.period();
      throw new HttpError(429, "api_limit_reached", `This month's API budget is used up for sessions (the rest is kept for Agent Workstation's own services; resets ${p.end.toISOString()}).`, {
        spentUsd: round2(this.spentUsd()),
        limitUsd: this.limitUsd(),
        serviceReserveUsd: this.serviceReserveUsd(),
        resetsAt: p.end.toISOString(),
      });
    }
  }

  /** UsageLimits.api (null when no key is configured). */
  limits(): ApiCredits | null {
    if (!this.deps.keys.present()) return null;
    const p = this.period();
    const spent = Math.max(0, this.spentUsd());
    const limit = this.limitUsd();
    const percent = limit > 0 ? Math.round((spent / limit) * 1000) / 10 : null;
    const severity = this.recentlyExhausted() ? "critical" : reconcileSeverity(percent, percent === null ? "unknown" : "normal");
    return { spentUsd: round4(spent), limitUsd: limit, percent, periodStart: p.start.toISOString(), resetsAt: p.end.toISOString(), severity };
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
