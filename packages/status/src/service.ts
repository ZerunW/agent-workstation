/**
 * Orchestrates the periodic work of workstation-status: sampling on a wall-clock aligned grid, health
 * checks, rollups/retention and the periodic bandwidth probe. All timers live here so that
 * `stop()` can shut the process down cleanly.
 */
import type { Logger } from "pino";
import type { Collector } from "./collect/collector.js";
import type { AppConfig } from "./config.js";
import type { HealthMonitor } from "./health/monitor.js";
import type { BandwidthProbe } from "./probe.js";
import type { SseHub } from "./sse.js";
import { roundValue, type Store } from "./store.js";

export interface ServiceDeps {
  config: AppConfig;
  store: Store;
  collector: Collector;
  monitor: HealthMonitor;
  probe: BandwidthProbe;
  sse: SseHub;
  log: Logger;
  nowMs?: () => number;
}

const ROLLUP_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;
const FIRST_PROBE_DELAY_MS = 2 * 60_000;
const MIN_PROBE_DELAY_MS = 60_000;

export class StatusService {
  private stopped = false;
  private sampleTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly intervals: NodeJS.Timeout[] = [];
  private sampling = false;

  constructor(private readonly d: ServiceDeps) {}

  private now(): number {
    return this.d.nowMs ? this.d.nowMs() : Date.now();
  }

  async start(): Promise<void> {
    const { config, log, sse } = this.d;
    // Prime the rate counters so the first stored sample already has CPU / network rates.
    await this.d.collector.collect().catch((err) => log.warn({ err }, "initial collection failed"));

    this.scheduleSample();

    void this.healthTick(true);
    this.intervals.push(setInterval(() => void this.healthTick(false), config.healthIntervalS * 1000));
    this.intervals.push(setInterval(() => this.maintain(), ROLLUP_EVERY_MS));
    this.intervals.push(setInterval(() => this.prune(), PRUNE_EVERY_MS));
    setTimeout(() => {
      this.maintain();
      this.prune();
    }, 3000).unref();
    for (const t of this.intervals) t.unref();

    sse.startHeartbeat();
    this.scheduleProbe();
    log.info(
      { sampleIntervalS: config.sampleIntervalS, healthIntervalS: config.healthIntervalS, interfaces: config.interfaces, speedProbeIntervalMin: config.speedProbeIntervalMin },
      "collector started",
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sampleTimer) clearTimeout(this.sampleTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const t of this.intervals) clearInterval(t);
    this.d.sse.closeAll();
  }

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------

  private scheduleSample(): void {
    if (this.stopped) return;
    const intervalMs = this.d.config.sampleIntervalS * 1000;
    const now = this.now();
    const boundary = (Math.floor(now / intervalMs) + 1) * intervalMs;
    this.sampleTimer = setTimeout(() => {
      void this.sampleTick(Math.round(boundary / 1000)).finally(() => this.scheduleSample());
    }, Math.max(0, boundary - now));
  }

  /** Collect one sample, store it at second `tS` and push it to SSE subscribers. */
  async sampleTick(tS: number): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const raw = await this.d.collector.collect();
      const values: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(raw)) values[k] = roundValue(v);
      this.d.store.insertSamples(tS, values);
      this.d.sse.broadcast("metrics", { t: tS, values });
    } catch (err) {
      this.d.log.error({ err }, "sample tick failed");
    } finally {
      this.sampling = false;
    }
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async healthTick(force: boolean): Promise<void> {
    try {
      const summary = await this.d.monitor.runDue(force);
      this.scheduleRetry();
      if (summary.ran.length === 0) return;
      if (Object.keys(summary.metrics).length > 0) this.d.store.insertSamples(Math.floor(this.now() / 1000), summary.metrics);
      for (const e of summary.transitions) this.d.log.warn({ check: e.id, from: e.from, to: e.to, detail: e.detail }, "health state changed");
      this.d.sse.broadcast("health", this.d.monitor.snapshot());
    } catch (err) {
      this.d.log.error({ err }, "health tick failed");
    }
  }

  /** A check that could not reach the hub is due again before the next regular tick: wake up for it (30 s, 60 s, 120 s, ...). */
  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.stopped) return;
    const inMs = this.d.monitor.nextRetryInMs();
    if (inMs === null || inMs >= this.d.config.healthIntervalS * 1000) return;
    this.retryTimer = setTimeout(() => void this.healthTick(false), inMs + 1000);
    this.retryTimer.unref();
  }

  // -------------------------------------------------------------------------
  // Rollup, retention
  // -------------------------------------------------------------------------

  private maintain(): void {
    try {
      this.d.store.rollup(Math.floor(this.now() / 1000));
    } catch (err) {
      this.d.log.error({ err }, "rollup failed");
    }
  }

  private prune(): void {
    try {
      const r = this.d.store.prune(Math.floor(this.now() / 1000));
      if (r.raw > 0 || r.minute > 0) this.d.log.debug(r, "pruned old samples");
    } catch (err) {
      this.d.log.error({ err }, "prune failed");
    }
  }

  // -------------------------------------------------------------------------
  // Periodic bandwidth probe
  // -------------------------------------------------------------------------

  private scheduleProbe(): void {
    const { config, store } = this.d;
    if (config.speedProbeIntervalMin <= 0 || this.stopped) return;
    const intervalMs = config.speedProbeIntervalMin * 60_000;
    const last = store.getKvNumber("probe_last_at");
    // Survive restarts (every deploy restarts the service) without burning 30 MB each time.
    const delay = last === null ? FIRST_PROBE_DELAY_MS : Math.max(MIN_PROBE_DELAY_MS, last + intervalMs - this.now());
    this.probeTimer = setTimeout(() => {
      void this.d.probe
        .run("timer")
        .catch((err) => this.d.log.error({ err }, "scheduled bandwidth probe failed"))
        .finally(() => {
          this.probeTimer = null;
          if (!this.stopped) this.probeTimer = setTimeout(() => this.scheduleProbe(), 1000);
        });
    }, delay);
    this.probeTimer.unref();
  }
}
