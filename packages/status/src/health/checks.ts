/**
 * The health checks shown on the status page. Each check is a small async function over an
 * injected `CheckContext` (exec / fetch / readers / DNS), so they are unit-tested with mocks.
 *
 * Conventions: `ok` green, `warn` amber (degraded), `fail` red, `unknown` grey (cannot tell, or the
 * thing is not installed).
 */
import { HubHealth, UsageLimits } from "@agent-workstation/protocol";
import type { z } from "zod";
import type { CheckContext, CheckDef, CheckOutcome } from "./types.js";
import type { AppConfig } from "../config.js";

const NOT_SYSTEMD = /system has not been booted|failed to connect to bus|can't operate/i;

export function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timed out";
  const code = e?.cause?.code;
  switch (code) {
    case "ECONNREFUSED":
      return "connection refused";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "DNS lookup failed";
    case "ENOENT":
      return "socket not found";
    case "EACCES":
      return "socket permission denied";
    case "ENETUNREACH":
    case "EHOSTUNREACH":
      return "network unreachable";
    case "UND_ERR_CONNECT_TIMEOUT":
    case "ETIMEDOUT":
      return "connection timed out";
    default:
      return code ?? e?.cause?.message ?? e?.message ?? String(err);
  }
}

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";

// ---------------------------------------------------------------------------
// systemd units
// ---------------------------------------------------------------------------

type UnitStatus = { kind: "ok" | "warn" | "fail" | "unknown"; detail: string } | { kind: "missing" };

/** One systemd unit: active / activating / stopped, told apart from "not installed" and from "no systemd here". */
async function unitStatus(ctx: CheckContext, unit: string): Promise<UnitStatus> {
  const r = await ctx.exec("systemctl", ["is-active", unit], { timeoutMs: 5000 });
  if (r.error === "ENOENT") return { kind: "unknown", detail: "systemctl not available on this host" };
  if (r.error) return { kind: "unknown", detail: r.message ?? "systemctl failed" };
  if (NOT_SYSTEMD.test(r.stderr)) return { kind: "unknown", detail: "systemd not running on this host" };
  const active = r.stdout.trim();
  if (active === "active") return { kind: "ok", detail: "active" };
  if (active === "activating" || active === "reloading") return { kind: "warn", detail: active };
  // Not running: tell "not installed" apart from "installed but stopped".
  const l = await ctx.exec("systemctl", ["show", unit, "--property=LoadState", "--value"], { timeoutMs: 5000 });
  if (l.stdout.trim() === "not-found") return { kind: "missing" };
  return { kind: "fail", detail: active || "inactive" };
}

export function unitCheck(o: { id: string; label: string; unit: string; optional?: boolean }): CheckDef {
  return {
    id: o.id,
    label: o.label,
    timeoutMs: 10_000,
    async run(ctx) {
      const u = await unitStatus(ctx, o.unit);
      if (u.kind !== "missing") return { state: u.kind, detail: u.detail };
      return o.optional ? { state: "unknown", detail: "not installed" } : { state: "fail", detail: "unit not found" };
    },
  };
}

/** The HTTPS proxies the machine may run, preferred first (deploy/nginx-tailscale.sh installs nginx). */
export const HTTPS_PROXIES = ["nginx", "caddy"] as const;

/** Reports whichever of nginx / caddy is installed: a running unit is ok, an installed but stopped one fails, neither is unknown. */
export const httpsProxyCheck: CheckDef = {
  id: "https-proxy",
  label: "HTTPS proxy (nginx)",
  timeoutMs: 20_000,
  async run(ctx) {
    const found: Array<{ name: string; u: Exclude<UnitStatus, { kind: "missing" }> }> = [];
    for (const name of HTTPS_PROXIES) {
      const u = await unitStatus(ctx, name);
      if (u.kind === "unknown") return { state: "unknown", detail: u.detail };
      if (u.kind !== "missing") found.push({ name, u });
    }
    if (found.length === 0) return { state: "unknown", detail: "not installed" };
    const best = found.find((f) => f.u.kind === "ok") ?? found.find((f) => f.u.kind === "warn") ?? found[0]!;
    return { state: best.u.kind as "ok" | "warn" | "fail", detail: `${best.name} ${best.u.detail}` };
  },
};

// ---------------------------------------------------------------------------
// hub
// ---------------------------------------------------------------------------

export const hubCheck: CheckDef = {
  id: "hub",
  label: "workstation-hub API (/healthz)",
  timeoutMs: 10_000,
  async run(ctx) {
    const base = ctx.config.hubUrl;
    const t0 = ctx.readers.monotonicMs();
    try {
      let res = await ctx.fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      if (res.status === 404) res = await ctx.fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      const latencyMs = Math.round(ctx.readers.monotonicMs() - t0);
      const body = await res.text().catch(() => "");
      if (!res.ok) return { state: "fail", detail: `HTTP ${res.status}`, latencyMs };
      let version: string | null = null;
      try {
        const v = (JSON.parse(body) as { version?: unknown }).version;
        if (typeof v === "string") version = v;
      } catch {
        /* plain "ok" body */
      }
      return { state: latencyMs > 1500 ? "warn" : "ok", detail: `HTTP ${res.status}${version ? `, v${version}` : ""}`, latencyMs };
    } catch (err) {
      return { state: "fail", detail: describeFetchError(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// internet
// ---------------------------------------------------------------------------

export function parsePingLatency(output: string): number | null {
  const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(output);
  return m ? Number(m[1]) : null;
}

export const pingCheck: CheckDef = {
  id: "internet-ping",
  label: "Internet (ICMP 1.1.1.1)",
  timeoutMs: 8000,
  async run(ctx) {
    const r = await ctx.exec("ping", ["-c1", "-W2", "1.1.1.1"], { timeoutMs: 6000 });
    if (r.error === "ENOENT") return { state: "unknown", detail: "ping not installed" };
    const ms = parsePingLatency(r.stdout);
    if (r.code === 0 && ms !== null) {
      return { state: ms > 300 ? "warn" : "ok", detail: `${ms.toFixed(1)} ms`, latencyMs: Math.round(ms), metrics: { latency_ping_ms: ms } };
    }
    return { state: "fail", detail: "no reply from 1.1.1.1", metrics: { latency_ping_ms: null } };
  },
};

export const httpsCheck: CheckDef = {
  id: "internet-https",
  label: "Internet (HTTPS api.anthropic.com)",
  timeoutMs: 12_000,
  async run(ctx) {
    const t0 = ctx.readers.monotonicMs();
    try {
      const res = await ctx.fetch("https://api.anthropic.com", { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(8000) });
      const latencyMs = Math.round(ctx.readers.monotonicMs() - t0);
      // Any HTTP answer proves DNS + TLS + routing work; 5xx means the far end is unhappy.
      const state = res.status >= 500 || latencyMs > 3000 ? "warn" : "ok";
      return { state, detail: `HTTP ${res.status}`, latencyMs, metrics: { latency_https_ms: latencyMs } };
    } catch (err) {
      return { state: "fail", detail: describeFetchError(err), metrics: { latency_https_ms: null } };
    }
  },
};

const SUDO_REFUSED = /password is required|not in the sudoers|may not run sudo|not allowed to (run|execute)|sorry, user|a terminal is required|no new privileges|refused/i;

/**
 * A GET of the hub as the hub-dependent checks see it: the parsed body, or the outcome to report when it cannot be read.
 * A hub that cannot be reached at all (down, refusing, timing out) asks the monitor for a quick retry.
 */
async function fetchHub<T>(ctx: CheckContext, path: string, schema: z.ZodType<T>, what: string): Promise<{ data: T } | { outcome: CheckOutcome }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (ctx.config.hubUser) headers["X-Workstation-User"] = ctx.config.hubUser;
  let res: Response;
  try {
    res = await ctx.fetch(`${ctx.config.hubUrl}${path}`, { headers, signal: AbortSignal.timeout(5000) });
  } catch (err) {
    // the hub check reports the outage itself; this one cannot tell
    return { outcome: { state: "unknown", detail: `hub unreachable: ${describeFetchError(err)}`, retry: true } };
  }
  if (!res.ok) return { outcome: { state: "unknown", detail: `hub answered HTTP ${res.status}` } };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { outcome: { state: "unknown", detail: `hub returned an unexpected ${what} payload` } };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { outcome: { state: "unknown", detail: `hub returned an unexpected ${what} payload` } };
  return { data: parsed.data };
}

/** The hub's `GET /api/usage/limits`: the parsed body, or the outcome to report when it cannot be read. */
async function fetchHubLimits(ctx: CheckContext): Promise<{ limits: UsageLimits } | { outcome: CheckOutcome }> {
  const r = await fetchHub(ctx, "/api/usage/limits", UsageLimits, "usage");
  return "data" in r ? { limits: r.data } : r;
}

// ---------------------------------------------------------------------------
// API credits
// ---------------------------------------------------------------------------

const usd = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Judge the `api` block of the hub's `/api/usage/limits` (this period's API-credit spend against the admin's monthly
 * budget): fail at critical severity or when the budget is used up, warn at warning severity, ok below that, unknown when
 * API billing is not set up (`api` null) or the hub does not report it (absent), or when no percentage can be told.
 */
export function evaluateApiUsage(limits: UsageLimits): CheckOutcome {
  const a = limits.api;
  if (a === undefined) return { state: "unknown", detail: "the hub does not report API credits" };
  if (a === null) return { state: "unknown", detail: "API billing is not set up on the hub" };
  const pct = a.percent ?? (a.limitUsd > 0 ? (a.spentUsd / a.limitUsd) * 100 : null);
  if (pct === null) return { state: "unknown", detail: `${usd(a.spentUsd)} spent, no limit set` };
  const detail = `${usd(a.spentUsd)} of ${usd(a.limitUsd)} used (${Math.round(pct)}%)`;
  if (a.severity === "critical" || pct >= 100) return { state: "fail", detail: pct >= 100 ? `budget used up: ${detail}` : detail };
  if (a.severity === "warning") return { state: "warn", detail };
  return { state: "ok", detail };
}

export const apiCreditsCheck: CheckDef = {
  id: "api-credits",
  label: "API credits",
  intervalS: 300,
  timeoutMs: 10_000,
  // Derived from the hub endpoint the status page already proxies; no API call is made from this service.
  async run(ctx) {
    const r = await fetchHubLimits(ctx);
    return "outcome" in r ? r.outcome : evaluateApiUsage(r.limits);
  },
};

// ---------------------------------------------------------------------------
// Tailscale and DNS
// ---------------------------------------------------------------------------

export const tailscaleCheck: CheckDef = {
  id: "tailscale",
  label: "Tailscale connection",
  timeoutMs: 12_000,
  async run(ctx) {
    const r = await ctx.exec("tailscale", ["status", "--json"], { timeoutMs: 8000 });
    if (r.error === "ENOENT") return { state: "unknown", detail: "not installed" };
    if (r.error) return { state: "unknown", detail: r.message ?? "tailscale failed" };
    let status: { BackendState?: string; Self?: { Online?: boolean; TailscaleIPs?: string[] } };
    try {
      status = JSON.parse(r.stdout) as typeof status;
    } catch {
      return { state: "fail", detail: firstLine(r.stderr) || firstLine(r.stdout) || "tailscaled not reachable" };
    }
    const backend = status.BackendState ?? "unknown";
    const ip = status.Self?.TailscaleIPs?.[0];
    if (backend === "Running" && status.Self?.Online !== false) return { state: "ok", detail: `online${ip ? `, ${ip}` : ""}` };
    if (backend === "Starting") return { state: "warn", detail: "starting" };
    if (backend === "NeedsLogin") return { state: "fail", detail: "needs login (`sudo tailscale up`)" };
    return { state: "fail", detail: backend === "Running" ? "running but node offline" : backend.toLowerCase() };
  },
};

export const dnsCheck: CheckDef = {
  id: "dns",
  label: "DNS name resolves to tailscale IP",
  timeoutMs: 8000,
  async run(ctx) {
    const host = ctx.config.dnsCheckHost;
    if (!host) return { state: "unknown", detail: "no DNS name configured (server.public_url is an IP)" };
    const tsIp = ctx.readers.interfaceAddresses()["tailscale0"]?.[0];
    if (!tsIp) return { state: "unknown", detail: "tailscale not installed or down (no tailscale0)" };
    const t0 = ctx.readers.monotonicMs();
    let addrs: string[];
    try {
      addrs = await ctx.lookupHost(host);
    } catch {
      return { state: "fail", detail: `${host} does not resolve` };
    }
    const latencyMs = Math.round(ctx.readers.monotonicMs() - t0);
    if (addrs.includes(tsIp)) return { state: "ok", detail: `${host} → ${tsIp}`, latencyMs };
    return { state: "fail", detail: `${host} → ${addrs.join(", ") || "nothing"}, expected ${tsIp}`, latencyMs };
  },
};

// ---------------------------------------------------------------------------
// Hardware / OS
// ---------------------------------------------------------------------------

export function parseSmartHealth(output: string): { state: "ok" | "fail"; detail: string } | null {
  const m = /overall-health self-assessment test result:\s*(\S+)/i.exec(output);
  if (!m) return null;
  const verdict = (m[1] ?? "").toUpperCase();
  return verdict === "PASSED" ? { state: "ok", detail: "SMART overall health: PASSED" } : { state: "fail", detail: `SMART overall health: ${verdict}` };
}

/** smartctl's arguments: exactly the command the sudoers drop-in of deploy/install.sh allows. */
export const smartctlArgs = (dev: string): string[] => ["-j", "-H", "-A", dev];

export function parseSmartJson(output: string): { state: "ok" | "fail"; detail: string } | null {
  try {
    const passed = (JSON.parse(output) as { smart_status?: { passed?: unknown } }).smart_status?.passed;
    if (typeof passed !== "boolean") return null;
    return passed ? { state: "ok", detail: "SMART overall health: PASSED" } : { state: "fail", detail: "SMART overall health: FAILED" };
  } catch {
    return null;
  }
}

export function smartCheck(device: string): CheckDef {
  const dev = `/dev/${device}`;
  return {
    id: "nvme-smart",
    label: "NVMe SMART health",
    intervalS: 1800,
    timeoutMs: 20_000,
    async run(ctx) {
      const r = await ctx.exec("sudo", ["-n", "/usr/sbin/smartctl", ...smartctlArgs(dev)], { timeoutMs: 10_000 });
      if (r.error === "ENOENT") return { state: "unknown", detail: "sudo not found" };
      if (r.error) return { state: "unknown", detail: r.message ?? "smartctl failed" };
      if (SUDO_REFUSED.test(r.stderr)) return { state: "unknown", detail: "smartctl needs sudo (rule missing)" };
      if (/command not found|no such file/i.test(r.stderr)) return { state: "unknown", detail: "smartmontools not installed" };
      // smartctl's exit status is a bit mask (disk problems set bits), so judge the output, not the code.
      return parseSmartJson(r.stdout) ?? parseSmartHealth(`${r.stdout}\n${r.stderr}`) ?? { state: "unknown", detail: firstLine(r.stderr) || "unrecognised smartctl output" };
    },
  };
}

export const inotifyCheck: CheckDef = {
  id: "inotify",
  label: "inotify watches",
  intervalS: 300,
  timeoutMs: 20_000,
  async run(ctx) {
    const maxText = await ctx.readers.readText("/proc/sys/fs/inotify/max_user_watches");
    const max = maxText ? Number.parseInt(maxText.trim(), 10) : NaN;
    if (!Number.isFinite(max) || max <= 0) return { state: "unknown", detail: "not available on this OS" };
    const r = await ctx.exec(
      "sh",
      ["-c", "find /proc -maxdepth 3 -path '/proc/[0-9]*/fdinfo/*' -type f -exec grep -h '^inotify' {} + 2>/dev/null | wc -l"],
      { timeoutMs: 15_000 },
    );
    if (r.error) return { state: "unknown", detail: r.message ?? "could not count watches" };
    const used = Number.parseInt(r.stdout.trim(), 10);
    if (!Number.isFinite(used)) return { state: "unknown", detail: "could not count watches" };
    const pct = (used / max) * 100;
    const detail = `${used.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} used (${pct.toFixed(1)}%), ${(max - used).toLocaleString("en-US")} free`;
    return { state: pct >= 98 ? "fail" : pct >= 90 ? "warn" : "ok", detail };
  },
};

/** The live Claude processes the hub's runtime holds (`GET /api/health` `processes`), not a count of command lines. */
export const claudeProcsCheck: CheckDef = {
  id: "claude-procs",
  label: "Active Claude processes",
  intervalS: 60,
  timeoutMs: 10_000,
  async run(ctx) {
    const r = await fetchHub(ctx, "/api/health", HubHealth, "health");
    if ("outcome" in r) return r.outcome;
    const p = r.data.processes;
    if (!p) return { state: "unknown", detail: "the hub does not report processes" };
    return { state: "ok", detail: `Claude ${p.claude}`, metrics: { claude_procs: p.claude } };
  },
};

// ---------------------------------------------------------------------------
// The default set, in display order
// ---------------------------------------------------------------------------

export function defaultChecks(config: AppConfig): CheckDef[] {
  return [
    unitCheck({ id: "unit-workstation-hub", label: "workstation-hub service", unit: "workstation-hub" }),
    hubCheck,
    unitCheck({ id: "unit-workstation-status", label: "workstation-status service", unit: "workstation-status" }),
    unitCheck({ id: "unit-ssh", label: "SSH server", unit: "ssh" }),
    httpsProxyCheck,
    unitCheck({ id: "unit-tailscaled", label: "tailscaled service", unit: "tailscaled", optional: true }),
    tailscaleCheck,
    dnsCheck,
    pingCheck,
    httpsCheck,
    apiCreditsCheck,
    claudeProcsCheck,
    smartCheck(config.nvmeDevice),
    inotifyCheck,
  ];
}

export type { CheckContext };
