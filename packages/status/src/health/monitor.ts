/**
 * Runs health checks in parallel (each with its own timeout), tracks the last state of every
 * check and records state transitions as events.
 */
import type { EventRow, HealthStateRow, Store } from "../store.js";
import type { CheckContext, CheckDef, CheckOutcome, HealthStateValue } from "./types.js";

export interface HealthCheckView {
  id: string;
  label: string;
  state: HealthStateValue;
  detail: string | null;
  checkedAt: string;
  latencyMs: number | null;
}

export interface RunSummary {
  ran: string[];
  transitions: EventRow[];
  /** Metrics reported by the checks that ran (to be stored with the regular samples). */
  metrics: Record<string, number | null>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** A check whose interval is a multiple of the tick must not be skipped because the tick fired a hair early. */
const DUE_SLACK_MS = 5000;

const RETRY_BASE_MS = 30_000;

/** Wait before the next run of a check whose hub was unreachable `failures` times in a row: 30 s, 60 s, 120 s, ... up to the normal interval. */
export function retryDelayMs(failures: number, intervalMs: number): number {
  return Math.min(intervalMs, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Pure transition rule. The first observation of a check (no previous state) is not a
 * transition; afterwards an event is produced whenever the state value changes.
 */
export function applyOutcome(
  prev: Pick<HealthStateRow, "state"> | undefined,
  id: string,
  outcome: CheckOutcome,
  atIso: string,
): { next: HealthStateRow; event: EventRow | null } {
  const next: HealthStateRow = {
    id,
    state: outcome.state,
    detail: outcome.detail ?? null,
    checkedAt: atIso,
    latencyMs: outcome.latencyMs ?? null,
  };
  const event: EventRow | null =
    prev && prev.state !== outcome.state ? { at: atIso, id, from: prev.state, to: outcome.state, detail: next.detail } : null;
  return { next, event };
}

export class HealthMonitor {
  private readonly records = new Map<string, HealthStateRow>();
  private readonly lastRunMs = new Map<string, number>();
  /** Consecutive "hub unreachable" runs per check, and the wait until its next run while that lasts. */
  private readonly retryFailures = new Map<string, number>();
  private readonly retryWaitMs = new Map<string, number>();
  private running = false;
  private readonly startedIso: string;

  constructor(
    private readonly opts: {
      checks: CheckDef[];
      ctx: CheckContext;
      store: Store;
      defaultIntervalS: number;
      nowMs?: () => number;
      onTransition?: (e: EventRow) => void;
    },
  ) {
    const now = this.now();
    this.startedIso = new Date(now).toISOString();
    for (const [id, row] of opts.store.loadHealthState()) this.records.set(id, row);
  }

  private now(): number {
    return this.opts.nowMs ? this.opts.nowMs() : Date.now();
  }

  get checkIds(): string[] {
    return this.opts.checks.map((c) => c.id);
  }

  /** Run every check that is due (all of them with `force`). Overlapping calls are ignored. */
  async runDue(force = false): Promise<RunSummary> {
    const summary: RunSummary = { ran: [], transitions: [], metrics: {} };
    if (this.running) return summary;
    this.running = true;
    try {
      const startMs = this.now();
      const due = this.opts.checks.filter((c) => {
        if (force) return true;
        const last = this.lastRunMs.get(c.id);
        const waitMs = this.retryWaitMs.get(c.id) ?? this.intervalMs(c);
        return last === undefined || startMs - last >= waitMs - DUE_SLACK_MS;
      });

      const results = await Promise.all(due.map(async (c) => ({ check: c, outcome: await this.runOne(c) })));

      const atIso = new Date(this.now()).toISOString();
      for (const { check, outcome } of results) {
        this.lastRunMs.set(check.id, startMs);
        if (outcome.retry) {
          const failures = (this.retryFailures.get(check.id) ?? 0) + 1;
          this.retryFailures.set(check.id, failures);
          this.retryWaitMs.set(check.id, retryDelayMs(failures, this.intervalMs(check)));
        } else {
          this.retryFailures.delete(check.id);
          this.retryWaitMs.delete(check.id);
        }
        const { next, event } = applyOutcome(this.records.get(check.id), check.id, outcome, atIso);
        this.records.set(check.id, next);
        this.opts.store.saveHealthState(next);
        summary.ran.push(check.id);
        if (outcome.metrics) Object.assign(summary.metrics, outcome.metrics);
        if (event) {
          this.opts.store.recordEvent(event);
          summary.transitions.push(event);
          this.opts.onTransition?.(event);
        }
      }
    } finally {
      this.running = false;
    }
    return summary;
  }

  private intervalMs(c: CheckDef): number {
    return (c.intervalS ?? this.opts.defaultIntervalS) * 1000;
  }

  /** Milliseconds until the soonest pending retry is due (0 = now), or null when no check is waiting for one. */
  nextRetryInMs(): number | null {
    let soonest: number | null = null;
    for (const [id, waitMs] of this.retryWaitMs) {
      const due = (this.lastRunMs.get(id) ?? 0) + waitMs - this.now();
      soonest = soonest === null ? due : Math.min(soonest, due);
    }
    return soonest === null ? null : Math.max(0, soonest);
  }

  private async runOne(check: CheckDef): Promise<CheckOutcome> {
    const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<CheckOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ state: "unknown", detail: `check timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}` }), timeoutMs);
    });
    try {
      return await Promise.race([
        check.run(this.opts.ctx).catch(
          (err: unknown): CheckOutcome => ({ state: "unknown", detail: `check crashed: ${(err as Error)?.message ?? String(err)}` }),
        ),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Current view of every check in display order; checks that never ran report "unknown / not checked yet". */
  checks(): HealthCheckView[] {
    return this.opts.checks.map((c) => {
      const r = this.records.get(c.id);
      return {
        id: c.id,
        label: c.label,
        state: (r?.state as HealthStateValue | undefined) ?? "unknown",
        detail: r ? r.detail : "not checked yet",
        checkedAt: r?.checkedAt ?? this.startedIso,
        latencyMs: r?.latencyMs ?? null,
      };
    });
  }

  events(limit = 100): EventRow[] {
    return this.opts.store.listEvents(limit);
  }

  snapshot(): { checks: HealthCheckView[]; events: EventRow[] } {
    return { checks: this.checks(), events: this.events() };
  }
}
