/** Static-ish facts about the server for `GET /status/api/system`. */
import os from "node:os";
import { HubHealth } from "@agent-workstation/protocol";
import { diskUsedPercent, parseCpuGroups } from "./collect/parsers.js";
import type { Readers } from "./collect/readers.js";
import type { AppConfig } from "./config.js";
import type { ExecFn } from "./health/exec.js";

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
  /** "4× Cortex-A72" (cores grouped by part), or "<model> × <cores>" where /proc/cpuinfo has no parts. */
  cpu: string;
  cpuCores: number;
  memTotalBytes: number;
  uptimeS: number;
  bootedAt: string;
  serverTime: string;
  disks: DiskInfo[];
  blockDevice: string;
  node: string;
  versions: {
    status: string;
    /** workstation-hub, and Claude Code as the hub reports it (`GET /api/health`). */
    hub: string | null;
    claude: string | null;
    tailscale: string | null;
    /** The HTTPS proxy that is installed: "nginx 1.24.0" / "caddy v2.8.4", null when neither is. */
    proxy: string | null;
  };
  interfaces: string[];
  thresholds: { diskWarnPercent: number; diskBlockPercent: number };
  intervals: { sampleS: number; healthS: number; speedProbeMin: number };
  links: { hubPublicUrl: string | null; hubPort: number };
}

export interface SystemInfoDeps {
  config: AppConfig;
  readers: Readers;
  exec: ExecFn;
  fetch: typeof fetch;
  statusVersion: string;
  nowMs?: () => number;
}

const VERSION_TTL_MS = 10 * 60_000;
/** While the hub did not answer, ask again sooner. */
const RETRY_VERSION_TTL_MS = 30_000;

export class SystemInfoProvider {
  private versions: { at: number; value: SystemInfo["versions"] } | null = null;
  private model: string | null = null;

  constructor(private readonly d: SystemInfoDeps) {}

  async get(): Promise<SystemInfo> {
    const { config, readers } = this.d;
    const nowMs = this.d.nowMs ? this.d.nowMs() : Date.now();
    const uptimeS = os.uptime();
    const cpus = os.cpus();

    const disks: DiskInfo[] = [];
    const seen = new Set<string>();
    for (const [label, path] of [
      ["/", "/"],
      ["users", config.usersRoot],
    ] as const) {
      const s = await readers.statfs(path);
      if (!s) continue;
      const key = `${s.totalBytes}:${s.freeBytes}`;
      const sameFs = seen.has(key);
      seen.add(key);
      const used = s.totalBytes - s.freeBytes;
      disks.push({
        label: sameFs ? `${label} (same filesystem)` : label,
        path,
        totalBytes: s.totalBytes,
        usedBytes: used,
        freeBytes: s.freeBytes,
        usedPercent: diskUsedPercent(s.totalBytes, s.freeBytes, s.availBytes) ?? 0,
      });
    }

    return {
      model: await this.modelName(),
      hostname: os.hostname(),
      kernel: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpu: await this.cpuLine(cpus),
      cpuCores: cpus.length,
      memTotalBytes: os.totalmem(),
      uptimeS,
      bootedAt: new Date(nowMs - uptimeS * 1000).toISOString(),
      serverTime: new Date(nowMs).toISOString(),
      disks,
      blockDevice: config.nvmeDevice,
      node: process.version,
      versions: await this.serviceVersions(nowMs),
      interfaces: config.interfaces,
      thresholds: { diskWarnPercent: config.diskWarnPercent, diskBlockPercent: config.diskBlockPercent },
      intervals: { sampleS: config.sampleIntervalS, healthS: config.healthIntervalS, speedProbeMin: config.speedProbeIntervalMin },
      links: { hubPublicUrl: config.publicUrl, hubPort: config.hubPort },
    };
  }

  private async modelName(): Promise<string> {
    if (this.model) return this.model;
    const model = await this.d.readers.readText("/proc/device-tree/model");
    // The device-tree string is NUL-terminated.
    const cleaned = model?.replace(/\0/g, "").trim();
    this.model = cleaned || `${os.type()} ${os.arch()} (${os.hostname()})`;
    return this.model;
  }

  private async cpuLine(cpus: os.CpuInfo[]): Promise<string> {
    const groups = parseCpuGroups((await this.d.readers.readText("/proc/cpuinfo")) ?? "");
    return groups ?? `${cpus[0]?.model ?? os.arch()} × ${cpus.length}`;
  }

  private async serviceVersions(nowMs: number): Promise<SystemInfo["versions"]> {
    if (this.versions && nowMs - this.versions.at < (this.versions.value.hub === null ? RETRY_VERSION_TTL_MS : VERSION_TTL_MS)) return this.versions.value;
    const { exec } = this.d;
    const [tailscale, proxy, health] = await Promise.all([
      exec("tailscale", ["version"], { timeoutMs: 5000 }).then(versionFrom),
      this.proxyVersion(),
      this.hubHealth(),
    ]);
    const value = { status: this.d.statusVersion, hub: health?.version ?? null, claude: health?.agents?.claude ?? null, tailscale, proxy };
    this.versions = { at: nowMs, value };
    return value;
  }

  /** nginx (preferred) or caddy, whichever answers its version command; `nginx -v` writes to stderr. */
  private async proxyVersion(): Promise<string | null> {
    const { exec } = this.d;
    const nginx = await exec("nginx", ["-v"], { timeoutMs: 5000 });
    const n = /nginx\/(\S+)/.exec(`${nginx.stdout}\n${nginx.stderr}`)?.[1];
    if (!nginx.error && n) return `nginx ${n}`;
    const caddy = versionFrom(await exec("caddy", ["version"], { timeoutMs: 5000 }));
    return caddy ? `caddy ${caddy.split(/\s+/)[0]}` : null;
  }

  private async hubHealth(): Promise<HubHealth | null> {
    try {
      const res = await this.d.fetch(`${this.d.config.hubUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const parsed = HubHealth.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

function versionFrom(r: { stdout: string; error: string | null; code: number | null }): string | null {
  if (r.error || r.code !== 0) return null;
  const line = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? null;
}
