/** Pure formatting helpers (no DOM access, unit-tested). */

const IEC = ["B", "KiB", "MiB", "GiB", "TiB"];

export function fmtBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < IEC.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : digits);
  return `${n < 0 ? "-" : ""}${s} ${IEC[i]}`;
}

/** Bytes per second as bytes ("MB/s"). `compact` drops the decimal from two-digit values (axis labels). */
export function fmtByteRate(bps: number, compact = false): string {
  if (!Number.isFinite(bps)) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = Math.abs(bps);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= (compact ? 10 : 100) || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Bytes per second shown as bits ("Mbit/s"), the unit people compare with speed tests. */
export function fmtBitRate(bytesPerSecond: number, compact = false): string {
  if (!Number.isFinite(bytesPerSecond)) return "—";
  const units = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"];
  let v = Math.abs(bytesPerSecond) * 8;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= (compact ? 10 : 100) || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtPercent(v: number, digits = 1): string {
  return Number.isFinite(v) ? `${v.toFixed(digits)}%` : "—";
}

export function fmtMbps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} Mbps`;
}

/** 93784 -> "1d 2h", 3700 -> "1h 1m", 42 -> "42s". At most two units. */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** "12 s ago", "3 min ago", "5 h ago", "2 d ago" */
export function fmtAgo(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** "in 2h 14m" / "now" for a reset moment relative to `nowMs`. */
export function fmtUntil(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  if (!Number.isFinite(diff)) return "—";
  if (diff <= 30_000) return "now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `in ${hrs}h ${mins % 60}m`;
  return `in ${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

export function fmtClock(ms: number, withSeconds = false): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
}

/** Time for events: clock for today, date + clock otherwise. */
export function fmtEventTime(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const today = new Date(nowMs);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? fmtClock(ms, true) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${fmtClock(ms)}`;
}

/**
 * The one way every usage card writes a reset moment: "Jan 15, 3:20 PM". Local time zone, always month + day, no seconds
 * (a narrow no-break space before AM/PM becomes a plain one).
 */
export function fmtResetTime(ms: number, opts: { locale?: string; timeZone?: string } = {}): string {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(opts.locale ?? [], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) }).replace(/[\u202f\u00a0]/g, " ");
}

/** "$12.00" */
export function fmtUsd(v: number): string {
  return Number.isFinite(v) ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
}

/** Natural sort so core2 < core10. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}
