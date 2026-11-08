/**
 * Pure parsers for the Linux pseudo-files the collector reads. Nothing here
 * touches the filesystem, so every parser is unit-tested on macOS with fixtures.
 */

// ---------------------------------------------------------------------------
// /proc/stat
// ---------------------------------------------------------------------------

export interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

export interface ProcStat {
  total: CpuTimes;
  /** Index = core number (cpu0, cpu1, ...). */
  cores: CpuTimes[];
}

function cpuLine(fields: string[]): CpuTimes | null {
  const n = fields.map((f) => Number(f));
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return null;
  return {
    user: n[0] ?? 0,
    nice: n[1] ?? 0,
    system: n[2] ?? 0,
    idle: n[3] ?? 0,
    iowait: n[4] ?? 0,
    irq: n[5] ?? 0,
    softirq: n[6] ?? 0,
    steal: n[7] ?? 0,
  };
}

export function parseProcStat(text: string): ProcStat | null {
  let total: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split("\n")) {
    const m = /^(cpu\d*)\s+(.*)$/.exec(line);
    if (!m) continue;
    const times = cpuLine((m[2] ?? "").trim().split(/\s+/));
    if (!times) continue;
    if (m[1] === "cpu") total = times;
    else {
      const idx = Number((m[1] ?? "").slice(3));
      cores[idx] = times;
    }
  }
  if (!total) return null;
  return { total, cores: cores.filter((c): c is CpuTimes => c !== undefined) };
}

function busyAndTotal(t: CpuTimes): { busy: number; total: number } {
  const idle = t.idle + t.iowait;
  const busy = t.user + t.nice + t.system + t.irq + t.softirq + t.steal;
  return { busy, total: busy + idle };
}

/** Busy percentage between two snapshots, null when no time elapsed or counters went backwards. */
export function cpuUsagePercent(prev: CpuTimes, cur: CpuTimes): number | null {
  const a = busyAndTotal(prev);
  const b = busyAndTotal(cur);
  const dTotal = b.total - a.total;
  const dBusy = b.busy - a.busy;
  if (dTotal <= 0 || dBusy < 0) return null;
  return clampPercent((dBusy / dTotal) * 100);
}

export function clampPercent(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// ---------------------------------------------------------------------------
// /proc/meminfo
// ---------------------------------------------------------------------------

/** All values in bytes when the file gave a kB unit, otherwise raw counts. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s*(kB))?/.exec(line);
    if (!m) continue;
    const value = Number(m[2]);
    out[m[1] ?? ""] = m[3] ? value * 1024 : value;
  }
  return out;
}

export interface MemorySnapshot {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export function memorySnapshot(info: Record<string, number>): MemorySnapshot | null {
  const total = info.MemTotal;
  if (!total) return null;
  // Old kernels have no MemAvailable; approximate like `free` did.
  const available = info.MemAvailable ?? (info.MemFree ?? 0) + (info.Buffers ?? 0) + (info.Cached ?? 0);
  const used = Math.max(0, total - available);
  return { totalBytes: total, availableBytes: available, usedBytes: used, usedPercent: clampPercent((used / total) * 100) };
}

// ---------------------------------------------------------------------------
// /sys/block/zram*/mm_stat
// ---------------------------------------------------------------------------

export interface ZramStat {
  origDataSize: number;
  comprDataSize: number;
  memUsedTotal: number;
}

export function parseZramMmStat(text: string): ZramStat | null {
  const f = text.trim().split(/\s+/).map(Number);
  if (f.length < 3 || f.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
  return { origDataSize: f[0] ?? 0, comprDataSize: f[1] ?? 0, memUsedTotal: f[2] ?? 0 };
}

// ---------------------------------------------------------------------------
// /proc/net/dev
// ---------------------------------------------------------------------------

export interface NetCounters {
  rxBytes: number;
  txBytes: number;
}

export function parseNetDev(text: string): Record<string, NetCounters> {
  const out: Record<string, NetCounters> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue; // the two header lines contain no colon
    const name = line.slice(0, idx).trim();
    if (!name || name.includes("|")) continue;
    const f = line
      .slice(idx + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (f.length < 9 || f.some((x) => !Number.isFinite(x))) continue;
    out[name] = { rxBytes: f[0] ?? 0, txBytes: f[8] ?? 0 };
  }
  return out;
}

// ---------------------------------------------------------------------------
// /proc/diskstats
// ---------------------------------------------------------------------------

export interface DiskCounters {
  readsCompleted: number;
  readBytes: number;
  writesCompleted: number;
  writeBytes: number;
  /** Milliseconds the device spent doing IO (field 13, "io_ticks"). */
  ioMs: number;
}

const SECTOR_BYTES = 512;

export function parseDiskstats(text: string): Record<string, DiskCounters> {
  const out: Record<string, DiskCounters> = {};
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (!name) continue;
    const nums = f.slice(3, 14).map(Number);
    if (nums.some((x) => !Number.isFinite(x))) continue;
    out[name] = {
      readsCompleted: nums[0] ?? 0,
      readBytes: (nums[2] ?? 0) * SECTOR_BYTES,
      writesCompleted: nums[4] ?? 0,
      writeBytes: (nums[6] ?? 0) * SECTOR_BYTES,
      ioMs: nums[9] ?? 0,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small ones
// ---------------------------------------------------------------------------

/** "0.15 0.20 0.18 1/234 5678" -> [1m, 5m, 15m] */
export function parseLoadavg(text: string): [number, number, number] | null {
  const f = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (f.length < 3 || f.some((x) => !Number.isFinite(x))) return null;
  return [f[0] ?? 0, f[1] ?? 0, f[2] ?? 0];
}

/** "12345.67 54321.00" -> 12345.67 */
export function parseUptime(text: string): number | null {
  const first = text.trim().split(/\s+/)[0] ?? "";
  if (first === "") return null;
  const v = Number(first);
  return Number.isFinite(v) ? v : null;
}

/** Thermal zone files hold millidegrees Celsius. Returns the plausible maximum in degrees, or null. */
export function maxThermalCelsius(rawValues: string[]): number | null {
  let max: number | null = null;
  for (const raw of rawValues) {
    if (raw.trim() === "") continue; // an unreadable sensor must not count as 0 degrees
    const milli = Number(raw.trim());
    if (!Number.isFinite(milli)) continue;
    const c = milli / 1000;
    if (c < -40 || c > 150) continue; // sensor glitch / disconnected sensor
    if (max === null || c > max) max = c;
  }
  return max;
}

/** Arm core part numbers (the `CPU part` field of /proc/cpuinfo) of common Cortex and Neoverse cores. */
const ARM_PARTS: Record<string, string> = {
  "0xd03": "Cortex-A53",
  "0xd05": "Cortex-A55",
  "0xd07": "Cortex-A57",
  "0xd08": "Cortex-A72",
  "0xd09": "Cortex-A73",
  "0xd0a": "Cortex-A75",
  "0xd0b": "Cortex-A76",
  "0xd0c": "Neoverse-N1",
  "0xd0d": "Cortex-A77",
  "0xd40": "Neoverse-V1",
  "0xd41": "Cortex-A78",
  "0xd44": "Cortex-X1",
  "0xd46": "Cortex-A510",
  "0xd47": "Cortex-A710",
  "0xd48": "Cortex-X2",
  "0xd49": "Neoverse-N2",
};

/**
 * /proc/cpuinfo of a (possibly heterogeneous) Arm machine as "4× Cortex-A72": cores grouped by their `CPU part`,
 * the highest part number first. Parts without a known name show as "part 0x…", a core without a part as "unknown".
 * Null when no core reports a part (x86, macOS): the caller falls back to the model name.
 */
export function parseCpuGroups(cpuinfo: string): string | null {
  const parts: Array<string | null> = [];
  for (const line of cpuinfo.split("\n")) {
    const m = /^(processor|CPU part)\s*:\s*(\S*)/.exec(line);
    if (!m) continue;
    if (m[1] === "processor") parts.push(null);
    else if (parts.length > 0) parts[parts.length - 1] = m[2]!.toLowerCase() || null;
  }
  if (!parts.some((p) => p !== null)) return null;
  const counts = new Map<string | null, number>();
  for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
  const known = [...counts].filter((e): e is [string, number] => e[0] !== null).sort((a, b) => Number.parseInt(b[0], 16) - Number.parseInt(a[0], 16));
  const groups = known.map(([part, n]) => `${n}× ${ARM_PARTS[part] ?? `part ${part}`}`);
  const unknown = counts.get(null);
  if (unknown) groups.push(`${unknown}× unknown`);
  return groups.join(" + ");
}

/** Natural sort key so cpu_core2 sorts before cpu_core10. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/** statfs numbers to a `df`-style used percentage. */
export function diskUsedPercent(totalBytes: number, freeBytes: number, availBytes: number): number | null {
  const used = totalBytes - freeBytes;
  const denom = used + availBytes;
  if (totalBytes <= 0 || denom <= 0) return null;
  return clampPercent((used / denom) * 100);
}
