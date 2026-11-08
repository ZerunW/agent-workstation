/**
 * Samples the server's vitals. One `collect()` call reads /proc and /sys through the
 * injected `Readers` and returns a flat `name -> value` map. Rates (CPU %, bytes/s)
 * need two snapshots, so the first call after construction reports null for them.
 *
 * Metric naming convention (the unit is implied by the suffix, see `metricUnit`):
 *   _pct  percent 0..100     _bytes  bytes        _bps  bytes per second
 *   _c    degrees Celsius    _mbps   megabit/s    _ms   milliseconds
 *   _s    seconds            (none)  plain number (load average, counts)
 */
import {
  clampPercent,
  cpuUsagePercent,
  diskUsedPercent,
  maxThermalCelsius,
  memorySnapshot,
  parseDiskstats,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseUptime,
  parseZramMmStat,
  type DiskCounters,
  type NetCounters,
  type ProcStat,
} from "./parsers.js";
import type { Readers } from "./readers.js";

export type Sample = Record<string, number | null>;

export interface CollectorOptions {
  /** Interface names to graph; missing ones yield null points instead of errors. */
  interfaces: string[];
  /** Path whose filesystem is reported as the "root" disk. */
  rootPath?: string;
  /** Path whose filesystem is reported as the "users" disk (paths.users_root). */
  usersRoot: string;
  /** Block device for IO counters, e.g. "nvme0n1". */
  blockDevice: string;
}

export interface Collector {
  collect(): Promise<Sample>;
}

interface Prev {
  atMs: number;
  stat: ProcStat | null;
  net: Record<string, NetCounters>;
  disk: DiskCounters | null;
}

export class LinuxCollector implements Collector {
  private prev: Prev | null = null;

  constructor(
    private readonly readers: Readers,
    private readonly opts: CollectorOptions,
  ) {}

  async collect(): Promise<Sample> {
    const r = this.readers;
    const [statText, loadText, memText, netText, diskText, uptimeText, root, users, zram, temps] = await Promise.all([
      r.readText("/proc/stat"),
      r.readText("/proc/loadavg"),
      r.readText("/proc/meminfo"),
      r.readText("/proc/net/dev"),
      r.readText("/proc/diskstats"),
      r.readText("/proc/uptime"),
      r.statfs(this.opts.rootPath ?? "/"),
      r.statfs(this.opts.usersRoot),
      this.readZram(),
      this.readTemps(),
    ]);
    const nowMs = r.monotonicMs();

    const stat = statText ? parseProcStat(statText) : null;
    const net = netText ? parseNetDev(netText) : {};
    const disks = diskText ? parseDiskstats(diskText) : {};
    const disk = disks[this.opts.blockDevice] ?? null;

    const out: Sample = {};
    const prev = this.prev;
    const dtS = prev ? (nowMs - prev.atMs) / 1000 : 0;
    const haveDt = prev !== null && dtS > 0.2;

    // CPU
    out.cpu_total_pct = haveDt && prev?.stat && stat ? cpuUsagePercent(prev.stat.total, stat.total) : null;
    const coreCount = Math.max(stat?.cores.length ?? 0, prev?.stat?.cores.length ?? 0);
    for (let i = 0; i < coreCount; i++) {
      const a = prev?.stat?.cores[i];
      const b = stat?.cores[i];
      out[`cpu_core${i}_pct`] = haveDt && a && b ? cpuUsagePercent(a, b) : null;
    }

    // Load, uptime
    const load = loadText ? parseLoadavg(loadText) : null;
    out.load_1 = load?.[0] ?? null;
    out.load_5 = load?.[1] ?? null;
    out.load_15 = load?.[2] ?? null;
    out.uptime_s = uptimeText ? parseUptime(uptimeText) : null;

    // Memory
    const mem = memText ? memorySnapshot(parseMeminfo(memText)) : null;
    out.mem_used_pct = mem?.usedPercent ?? null;
    out.mem_used_bytes = mem?.usedBytes ?? null;
    out.mem_available_bytes = mem?.availableBytes ?? null;
    out.zram_used_bytes = zram?.used ?? null;
    out.zram_orig_bytes = zram?.orig ?? null;

    // Disk usage
    out.disk_root_used_pct = root ? diskUsedPercent(root.totalBytes, root.freeBytes, root.availBytes) : null;
    out.disk_root_used_bytes = root ? root.totalBytes - root.freeBytes : null;
    out.disk_users_used_pct = users ? diskUsedPercent(users.totalBytes, users.freeBytes, users.availBytes) : null;
    out.disk_users_used_bytes = users ? users.totalBytes - users.freeBytes : null;

    // Disk IO
    out.disk_io_read_bps = haveDt && prev?.disk && disk ? rate(prev.disk.readBytes, disk.readBytes, dtS) : null;
    out.disk_io_write_bps = haveDt && prev?.disk && disk ? rate(prev.disk.writeBytes, disk.writeBytes, dtS) : null;
    out.disk_io_util_pct =
      haveDt && prev?.disk && disk ? ratePercent(prev.disk.ioMs, disk.ioMs, dtS * 1000) : null;

    // Network
    for (const iface of this.opts.interfaces) {
      const a = prev?.net[iface];
      const b = net[iface];
      out[`net_${iface}_rx_bps`] = haveDt && a && b ? rate(a.rxBytes, b.rxBytes, dtS) : null;
      out[`net_${iface}_tx_bps`] = haveDt && a && b ? rate(a.txBytes, b.txBytes, dtS) : null;
    }

    out.temp_c = temps;

    this.prev = { atMs: nowMs, stat, net, disk };
    return out;
  }

  private async readZram(): Promise<{ used: number; orig: number } | null> {
    const entries = (await this.readers.listDir("/sys/block")).filter((n) => /^zram\d+$/.test(n));
    if (entries.length === 0) return null;
    let used = 0;
    let orig = 0;
    let seen = 0;
    for (const dev of entries) {
      const text = await this.readers.readText(`/sys/block/${dev}/mm_stat`);
      const st = text ? parseZramMmStat(text) : null;
      if (!st) continue;
      used += st.memUsedTotal;
      orig += st.origDataSize;
      seen++;
    }
    return seen > 0 ? { used, orig } : null;
  }

  private async readTemps(): Promise<number | null> {
    const zones = (await this.readers.listDir("/sys/class/thermal")).filter((n) => /^thermal_zone\d+$/.test(n));
    const raws = await Promise.all(zones.map((z) => this.readers.readText(`/sys/class/thermal/${z}/temp`)));
    return maxThermalCelsius(raws.filter((x): x is string => x !== null));
  }
}

/** Bytes (or any counter) per second; null when the counter went backwards (reset / wrap). */
export function rate(prev: number, cur: number, dtS: number): number | null {
  if (dtS <= 0) return null;
  const d = cur - prev;
  return d < 0 ? null : d / dtS;
}

function ratePercent(prevMs: number, curMs: number, dtMs: number): number | null {
  const v = rate(prevMs, curMs, dtMs);
  return v === null ? null : clampPercent(v * 100);
}
