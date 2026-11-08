import type { AppConfig } from "../config.js";
import type { Readers } from "../collect/readers.js";
import type { ExecFn } from "./exec.js";

export type HealthStateValue = "ok" | "warn" | "fail" | "unknown";

export interface CheckOutcome {
  state: HealthStateValue;
  detail?: string | null;
  latencyMs?: number | null;
  /** Extra numeric metrics this check measured; the service stores them with the regular samples. */
  metrics?: Record<string, number | null>;
  /** The hub could not be reached: the monitor retries soon (30 s, 60 s, 120 s, ...) instead of at the normal interval. */
  retry?: boolean;
}

export interface CheckContext {
  config: AppConfig;
  exec: ExecFn;
  fetch: typeof fetch;
  readers: Readers;
  /** Resolve a hostname to its IPv4 addresses (system resolver). */
  lookupHost(host: string): Promise<string[]>;
}

export interface CheckDef {
  id: string;
  label: string;
  /** Minimum seconds between runs. Defaults to `health_interval_s`. */
  intervalS?: number;
  /** Hard cap enforced by the monitor; the check becomes "unknown" when exceeded. Default 15 s. */
  timeoutMs?: number;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}
