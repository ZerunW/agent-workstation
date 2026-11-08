/** Wire types used by the UI. The protocol ones are inferred from the shared zod schemas (type-only imports). */
import type { z } from "zod";
import type { HealthResponse as HealthSchema, MetricsResponse as MetricsSchema, UsageLimits as UsageSchema } from "@agent-workstation/protocol";

export type MetricsResponse = z.infer<typeof MetricsSchema>;
export type HealthResponse = z.infer<typeof HealthSchema>;
export type HealthCheck = HealthResponse["checks"][number];
export type HealthEvent = HealthResponse["events"][number];
/** What `/status/api/usage` serves: the hub's API credits, or why they are not available. */
export type UsageLimits = z.infer<typeof UsageSchema> & { error?: string };

export const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

export interface DiskInfo {
  label: string;
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export interface SystemInfo {
  model: string;
  hostname: string;
  kernel: string;
  arch: string;
  cpu: string;
  cpuCores: number;
  memTotalBytes: number;
  uptimeS: number;
  bootedAt: string;
  serverTime: string;
  disks: DiskInfo[];
  blockDevice: string;
  node: string;
  versions: { status: string; hub: string | null; claude: string | null; tailscale: string | null; proxy: string | null };
  interfaces: string[];
  thresholds: { diskWarnPercent: number; diskBlockPercent: number };
  intervals: { sampleS: number; healthS: number; speedProbeMin: number };
  links: { hubPublicUrl: string | null; hubPort: number };
}

export interface ProbeResult {
  trigger: "timer" | "manual";
  startedAt: string;
  finishedAt: string;
  downMbps: number | null;
  upMbps: number | null;
  error: string | null;
}

export interface ProbeState {
  running: boolean;
  last: ProbeResult | null;
  nextManualAt: number | null;
}

export type HealthState = HealthCheck["state"];
