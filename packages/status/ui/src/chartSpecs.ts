import { fmtBytes, naturalCompare } from "./format.js";
import type { SystemInfo } from "./types.js";

export type Kind = "percent" | "bytes" | "bitrate" | "byterate" | "celsius" | "mbps" | "ms" | "count" | "load";

export interface SeriesDef {
  name: string;
  label: string;
  /** Index into the theme palette (or any CSS color). */
  color: number | string;
  width?: number;
  fill?: boolean;
  alpha?: number;
  hideLegend?: boolean;
  step?: boolean;
}

export interface RefLine {
  value: number;
  label: string;
  tone: "warn" | "crit";
}

export interface ChartSpec {
  id: string;
  title: string;
  subtitle?: string;
  kind: Kind;
  series: SeriesDef[];
  yRange?: (min: number | null, max: number | null) => [number, number];
  refLines?: RefLine[];
  /** Draw markers (sparse series such as speed tests). */
  points?: boolean;
  /** Connect across missing samples (sparse series). */
  spanGaps?: boolean;
  emptyText?: string;
  /** Reserve a slot in the card header for buttons. */
  actions?: boolean;
}

const softMax =
  (floor: number) =>
  (_min: number | null, max: number | null): [number, number] => [0, Math.max(floor, (max ?? 0) * 1.15)];

/** The chart set for the metrics that exist. Depends on which series names the server returned. */
export function buildSpecs(names: Set<string>, sys: SystemInfo | null): ChartSpec[] {
  const specs: ChartSpec[] = [];
  const cores = [...names].filter((n) => /^cpu_core\d+_pct$/.test(n)).sort(naturalCompare);

  specs.push({
    id: "cpu",
    title: "CPU",
    kind: "percent",
    yRange: () => [0, 100],
    // Cores first so the total is drawn on top of them.
    series: [
      ...cores.map((name, i): SeriesDef => ({ name, label: `core ${i}`, color: 7, width: 1, alpha: 0.55, hideLegend: true })),
      { name: "cpu_total_pct", label: "Total", color: 0, width: 2, fill: true },
    ],
  });

  specs.push({
    id: "load",
    title: "Load average",
    kind: "load",
    yRange: softMax(1),
    series: [
      { name: "load_1", label: "1 min", color: 0, width: 2 },
      { name: "load_5", label: "5 min", color: 1 },
      { name: "load_15", label: "15 min", color: 2 },
    ],
  });

  const memTotal = sys?.memTotalBytes ?? null;
  specs.push({
    id: "memory",
    title: "Memory",
    subtitle: memTotal ? `of ${fmtBytes(memTotal)}` : undefined,
    kind: "bytes",
    // Fixed to total memory so the headroom above "Used" stays visible without an Available series.
    yRange: (_min, max) => [0, memTotal ?? Math.max(1, (max ?? 0) * 1.1)],
    series: [
      { name: "mem_used_bytes", label: "Used", color: 0, width: 2, fill: true },
      { name: "zram_used_bytes", label: "zram (compressed)", color: 3 },
    ],
  });

  specs.push({
    id: "temp",
    title: "CPU temperature",
    kind: "celsius",
    yRange: (min, max) => [Math.min(20, min ?? 20), Math.max(80, max ?? 80)],
    series: [{ name: "temp_c", label: "Temperature", color: 1, width: 2, fill: true }],
  });

  const ifaces =
    sys?.interfaces ??
    [...names]
      .map((n) => /^net_(.+)_rx_bps$/.exec(n)?.[1])
      .filter((x): x is string => x !== undefined);
  for (const iface of ifaces) {
    specs.push({
      id: `net-${iface}`,
      title: `Network ${iface}`,
      kind: "bitrate",
      yRange: softMax(125_000), // at least 1 Mbit/s of headroom so idle noise is not blown up
      emptyText: "Interface not present (no samples)",
      series: [
        { name: `net_${iface}_rx_bps`, label: "Receive", color: 0, width: 2, fill: true },
        { name: `net_${iface}_tx_bps`, label: "Send", color: 1, width: 1.5 },
      ],
    });
  }

  specs.push({
    id: "diskio",
    title: sys ? `Disk IO (${sys.blockDevice})` : "Disk IO",
    kind: "byterate",
    yRange: softMax(1_000_000),
    series: [
      { name: "disk_io_read_bps", label: "Read", color: 0, width: 2 },
      { name: "disk_io_write_bps", label: "Write", color: 1, width: 1.5 },
    ],
  });

  const sameFs = sys?.disks.some((d) => d.label.includes("same filesystem")) ?? false;
  const warn = sys?.thresholds.diskWarnPercent ?? 80;
  const block = sys?.thresholds.diskBlockPercent ?? 95;
  specs.push({
    id: "diskusage",
    title: "Disk usage",
    subtitle: `warn ${warn}% · read-only ${block}%`,
    kind: "percent",
    yRange: () => [0, 100],
    refLines: [
      { value: warn, label: `${warn}% warn`, tone: "warn" },
      { value: block, label: `${block}% block`, tone: "crit" },
    ],
    series: [
      { name: "disk_root_used_pct", label: sameFs ? "/ and workspaces" : "/", color: 0, width: 2 },
      ...(sameFs ? [] : [{ name: "disk_users_used_pct", label: "Workspaces", color: 1, width: 1.5 } satisfies SeriesDef]),
    ],
  });

  specs.push({
    id: "probes",
    title: "Bandwidth probes",
    kind: "mbps",
    points: true,
    spanGaps: true,
    actions: true,
    emptyText: "No speed test results in this range yet",
    yRange: softMax(10),
    series: [
      { name: "probe_down_mbps", label: "Download", color: 0, width: 2 },
      { name: "probe_up_mbps", label: "Upload", color: 1, width: 2 },
    ],
  });

  specs.push({
    id: "latency",
    title: "Internet latency",
    kind: "ms",
    points: true,
    spanGaps: true,
    yRange: softMax(50),
    emptyText: "No latency samples in this range yet",
    series: [
      { name: "latency_ping_ms", label: "ICMP ping", color: 0, width: 2 },
      { name: "latency_https_ms", label: "HTTPS", color: 1, width: 2 },
    ],
  });

  specs.push({
    id: "claudeprocs",
    title: "Claude processes",
    kind: "count",
    points: true,
    spanGaps: true,
    yRange: (_min, max) => [0, Math.max(4, Math.ceil((max ?? 0) + 1))],
    emptyText: "No samples in this range yet",
    series: [
      { name: "claude_procs", label: "Claude", color: 4, width: 2, step: true },
    ],
  });

  return specs;
}
