export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/** Live turn timer: "0s", "12s", "5m 21s", "1h 2m". Negative input (clock skew) clamps to 0. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${total % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Compact token counts with one decimal: "842", "1.2k", "12.5k", "1M", "1.5M" (a trailing ".0" is dropped). */
export function formatKTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  const k = Math.round(v / 100) / 10;
  if (k < 1000) return `${String(k.toFixed(1)).replace(/\.0$/, "")}k`;
  return `${(Math.round(v / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatPercent(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
}

const rtf = typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" }) : null;

/** "2m ago", "yesterday" … from an ISO timestamp. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
    ["week", 604800],
    ["month", 2592000],
    ["year", 31536000],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [u, s] of units) {
    if (abs >= s) {
      unit = u;
      size = s;
    }
  }
  const value = Math.round(diff / size);
  if (rtf) return rtf.format(value, unit);
  return `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? "" : "s"} ${value < 0 ? "ago" : "from now"}`;
}

export type DayBucket = "today" | "yesterday" | "week" | "month" | "older";

export function dayBucket(iso: string, now = new Date()): DayBucket {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "older";
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  if (days < 30) return "month";
  return "older";
}

/** "in 2h 15m", "in 3d 4h", "now" — countdown to an ISO timestamp. */
export function formatCountdown(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  let s = Math.round((t - now) / 1000);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * The one way every usage card writes a reset moment: "Jan 15, 3:20 PM". Local time zone, always month + day, no seconds
 * (a narrow no-break space before AM/PM becomes a plain one so the text compares and copies cleanly).
 */
export function formatResetTime(at: string | number | Date | null | undefined, opts: { locale?: string; timeZone?: string } = {}): string {
  if (at == null || at === "") return "—";
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(opts.locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) }).replace(/[\u202f\u00a0]/g, " ");
}

/** "$12.00" (two decimals). */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Whole dollars, rounded down so a remaining budget is never overstated: 12.34 → "$12". */
export function formatUsdWhole(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  return `$${Math.floor(Math.max(0, usd)).toLocaleString("en-US")}`;
}

export function basename(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

export function dirname(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function uuid(): string {
  const c: Crypto | undefined = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // RFC 4122 v4 fallback for insecure contexts (plain http on a LAN has no crypto.randomUUID in some browsers).
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** "Jan 15, 2026, 9:00 AM" from an ISO timestamp (the tooltip of a message's relative time); "" when it does not parse. */
export function formatMessageTime(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "";
  // newer ICU puts a narrow no-break space before AM/PM: plain spaces keep the tooltip the same everywhere
  // eslint-disable-next-line no-irregular-whitespace
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(/[  ]/g, " ");
}

/** "Jan 15" (with the year when it is not this one): the date a search hit or a list row carries. */
export function formatShortDate(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
