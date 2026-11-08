/**
 * Bandwidth probe against Cloudflare's speed endpoints: download 20 MB, upload 10 MB, record
 * the rates as the metrics `probe_down_mbps` / `probe_up_mbps`.
 *
 * The server got HTTP 403 from speed.cloudflare.com without a browser-like User-Agent, hence
 * BROWSER_UA. Runs are serialised; manual runs are rate-limited to one per minute.
 */
import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";

export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const DOWN_URL = "https://speed.cloudflare.com/__down?bytes=20000000";
export const UP_URL = "https://speed.cloudflare.com/__up";
export const DOWN_BYTES = 20_000_000;
export const UP_BYTES = 10_000_000;
export const MANUAL_MIN_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 60_000;

export interface ProbeResult {
  trigger: "timer" | "manual";
  startedAt: string;
  finishedAt: string;
  downMbps: number | null;
  upMbps: number | null;
  /** First error encountered, if any direction failed. */
  error: string | null;
}

export type ProbeRequest = { ok: true } | { ok: false; reason: "running" | "rate_limited"; retryAfterS: number };

export interface ProbeState {
  running: boolean;
  last: ProbeResult | null;
  /** Epoch ms from which a manual run is allowed again (null = now). */
  nextManualAt: number | null;
}

export interface ProbeOptions {
  store: Store;
  fetch?: typeof fetch;
  /** Monotonic ms clock (performance.now). */
  clock?: () => number;
  /** Wall clock epoch ms. */
  now?: () => number;
  downloadUrl?: string;
  uploadUrl?: string;
  uploadBytes?: number;
  onChange?: (state: ProbeState) => void;
  log?: (msg: string, err?: unknown) => void;
}

export class BandwidthProbe {
  private running = false;
  private last: ProbeResult | null = null;
  private lastManualMs: number | null = null;
  private payload: Uint8Array | null = null;

  private readonly fetchFn: typeof fetch;
  private readonly clock: () => number;
  private readonly now: () => number;

  constructor(private readonly o: ProbeOptions) {
    this.fetchFn = o.fetch ?? fetch;
    this.clock = o.clock ?? (() => performance.now());
    this.now = o.now ?? (() => Date.now());
  }

  state(): ProbeState {
    return {
      running: this.running,
      last: this.last,
      nextManualAt: this.lastManualMs === null ? null : this.lastManualMs + MANUAL_MIN_INTERVAL_MS,
    };
  }

  /** Check whether a manual run may start now. Does not start it. */
  canRunManual(): ProbeRequest {
    if (this.running) return { ok: false, reason: "running", retryAfterS: 5 };
    if (this.lastManualMs !== null) {
      const wait = this.lastManualMs + MANUAL_MIN_INTERVAL_MS - this.now();
      if (wait > 0) return { ok: false, reason: "rate_limited", retryAfterS: Math.ceil(wait / 1000) };
    }
    return { ok: true };
  }

  /**
   * Start a manual run in the background. Returns immediately; progress is published through
   * `onChange` (SSE) and the result lands in the metrics.
   */
  requestManual(): ProbeRequest {
    const verdict = this.canRunManual();
    if (!verdict.ok) return verdict;
    this.lastManualMs = this.now();
    void this.run("manual");
    return { ok: true };
  }

  /** Run one probe (download then upload). Returns null when another run is already in flight. */
  async run(trigger: "timer" | "manual"): Promise<ProbeResult | null> {
    if (this.running) return null;
    this.running = true;
    this.o.onChange?.(this.state());
    const startedAt = new Date(this.now()).toISOString();
    let downMbps: number | null = null;
    let upMbps: number | null = null;
    let error: string | null = null;
    try {
      try {
        downMbps = await this.download();
      } catch (err) {
        error = `download: ${describe(err)}`;
        this.o.log?.("bandwidth probe download failed", err);
      }
      try {
        upMbps = await this.upload();
      } catch (err) {
        error ??= `upload: ${describe(err)}`;
        this.o.log?.("bandwidth probe upload failed", err);
      }
      const t = Math.floor(this.now() / 1000);
      if (downMbps !== null) this.o.store.insertMetric(t, "probe_down_mbps", downMbps);
      if (upMbps !== null) this.o.store.insertMetric(t, "probe_up_mbps", upMbps);
      this.o.store.setKv("probe_last_at", String(this.now()));
    } finally {
      this.last = { trigger, startedAt, finishedAt: new Date(this.now()).toISOString(), downMbps, upMbps, error };
      this.running = false;
      this.o.onChange?.(this.state());
    }
    return this.last;
  }

  private async download(): Promise<number> {
    const t0 = this.clock();
    const res = await this.fetchFn(this.o.downloadUrl ?? DOWN_URL, {
      headers: { "User-Agent": BROWSER_UA, Accept: "*/*" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const firstByteAt = this.clock();
    let bytes = 0;
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) bytes += chunk.byteLength;
    } else {
      bytes = (await res.arrayBuffer()).byteLength;
    }
    const end = this.clock();
    // Time from the response headers to the last byte excludes DNS/TLS/connection setup;
    // fall back to the whole request when the body arrived in one piece.
    const bodyMs = end - firstByteAt;
    const ms = bodyMs >= 50 ? bodyMs : end - t0;
    return mbps(bytes, ms);
  }

  private async upload(): Promise<number> {
    const bytes = this.o.uploadBytes ?? UP_BYTES;
    if (!this.payload || this.payload.byteLength !== bytes) this.payload = randomBytes(bytes);
    const t0 = this.clock();
    const res = await this.fetchFn(this.o.uploadUrl ?? UP_URL, {
      method: "POST",
      headers: { "User-Agent": BROWSER_UA, "Content-Type": "text/plain", Accept: "*/*" },
      body: this.payload,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return mbps(bytes, this.clock() - t0);
  }
}

export function mbps(bytes: number, ms: number): number {
  if (ms <= 0) throw new Error("zero elapsed time");
  return (bytes * 8) / 1e6 / (ms / 1000);
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timed out";
  return e?.cause?.code ?? e?.message ?? String(err);
}
