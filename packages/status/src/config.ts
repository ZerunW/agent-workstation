/**
 * Configuration loading for workstation-status.
 *
 * Same lookup order as workstation-hub: `$WORKSTATION_CONFIG`, `./config/workstation.toml`,
 * `/etc/agent-workstation/workstation.toml`, then built-in defaults. Only the keys the status
 * service needs are interpreted; unknown sections (the hub's `[auth]`, `[sessions]`,
 * ...) are ignored, unknown keys inside `[status]` produce a warning.
 */
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/** "unix": the status socket below (production, behind nginx). "tcp": `host` and `port`, for development. */
export type ListenMode = "unix" | "tcp";

/** The runtime directory the hub's and the status service's sockets live in (created by tmpfiles.d, deploy/install.sh). */
const RUNTIME_DIR = "/run/agent-workstation";

/** Production = started by systemd (INVOCATION_ID) or with NODE_ENV=production, on Linux. */
function isProductionLinux(env: NodeJS.ProcessEnv, platform: string): boolean {
  return platform === "linux" && (env.NODE_ENV === "production" || Boolean(env.INVOCATION_ID));
}

export function defaultListen(env: NodeJS.ProcessEnv, platform: string = process.platform): ListenMode {
  return isProductionLinux(env, platform) ? "unix" : "tcp";
}

const StatusSection = z.object({
  /** Default: Unix sockets on Linux in production, a TCP port everywhere else (the same rule as the hub's [server] listen). */
  listen: z.enum(["unix", "tcp"]).optional(),
  /** Public socket: mode 0660, group `[server] proxy_group`; only nginx connects here. */
  socket: z.string().startsWith("/").default(`${RUNTIME_DIR}/status.sock`),
  /** Address the status service listens on with listen = "tcp" (the hub's [server] host is not used for it). */
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(9100),
  sample_interval_s: z.number().int().min(2).max(300).default(10),
  health_interval_s: z.number().int().min(5).max(3600).default(60),
  interfaces: z.array(z.string().min(1)).default(["tailscale0"]),
  /** 0 = periodic bandwidth probe disabled. */
  speed_probe_interval_min: z.number().min(0).default(60),
  /** Where the hub lives over TCP (development). Unset: the hub's local socket when the hub listens on sockets, else derived from [server]. */
  hub_url: z.string().url().optional(),
  /** The hub's local socket (mode 0600, the service account's). Default: `[server] local_socket`. */
  hub_socket: z.string().startsWith("/").optional(),
  /** Username sent as X-Workstation-User when asking the hub (its API needs one). The only name the status service ever sends. */
  hub_user: z.string().min(1).default("status"),
  /** Name that must resolve to this machine's tailscale IP. Default: host of server.public_url when it is a DNS name. */
  dns_check_host: z.string().optional(),
  /** Block device whose IO is graphed and whose SMART health is checked. */
  nvme_device: z.string().min(1).default("nvme0n1"),
});

const ConfigFile = z.object({
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(9000),
      public_url: z.string().optional(),
      listen: z.enum(["unix", "tcp"]).optional(),
      local_socket: z.string().startsWith("/").default(`${RUNTIME_DIR}/hub-local.sock`),
      proxy_group: z.string().min(1).default("workstation-proxy"),
    })
    .prefault({}),
  paths: z
    .object({
      users_root: z.string().default("/srv/agent-workstation/users"),
      data_dir: z.string().default("/var/lib/agent-workstation"),
    })
    .prefault({}),
  limits: z
    .object({
      disk_warn_percent: z.number().default(80),
      disk_block_percent: z.number().default(95),
    })
    .prefault({}),
  status: StatusSection.prefault({}),
});

export interface AppConfig {
  /** File the config was read from, null when running on defaults. */
  source: string | null;
  listen: ListenMode;
  /** listen = "unix": the status socket and its group. */
  socket: string;
  proxyGroup: string;
  /** listen = "tcp". */
  host: string;
  port: number;
  publicUrl: string | null;
  usersRoot: string;
  dataDir: string;
  dbPath: string;
  diskWarnPercent: number;
  diskBlockPercent: number;
  sampleIntervalS: number;
  healthIntervalS: number;
  interfaces: string[];
  speedProbeIntervalMin: number;
  /** Base URL of the hub; with `hubSocket` only the host part is used (`http://localhost`). */
  hubUrl: string;
  /** The hub's local socket the status service calls the hub through; null = over TCP at `hubUrl`. */
  hubSocket: string | null;
  hubPort: number;
  hubUser: string;
  dnsCheckHost: string | null;
  nvmeDevice: string;
  warnings: string[];
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test seams. */
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
}

export const CONFIG_PATH = "/etc/agent-workstation/workstation.toml";

/** $WORKSTATION_CONFIG when set. */
function envConfig(env: NodeJS.ProcessEnv): { name: string; path: string } | null {
  return env.WORKSTATION_CONFIG ? { name: "WORKSTATION_CONFIG", path: env.WORKSTATION_CONFIG } : null;
}

export function candidatePaths(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const list: string[] = [];
  const fromEnv = envConfig(env);
  if (fromEnv) list.push(fromEnv.path);
  list.push(join(cwd, "config", "workstation.toml"));
  list.push(CONFIG_PATH);
  return list;
}

export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const exists = opts.exists ?? existsSync;
  const read = opts.read ?? ((p: string) => readFileSync(p, "utf8"));

  const fromEnv = envConfig(env);
  if (fromEnv && !exists(fromEnv.path)) throw new Error(`${fromEnv.name} points to ${fromEnv.path} but that file does not exist`);
  const source = candidatePaths(env, cwd).find((p) => exists(p)) ?? null;

  let raw: unknown = {};
  if (source) {
    try {
      raw = parseToml(read(source));
    } catch (err) {
      throw new Error(`cannot parse ${source}: ${(err as Error).message}`);
    }
  }
  return resolveConfig(raw, source, env);
}

export function resolveConfig(raw: unknown, source: string | null = null, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): AppConfig {
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration${source ? ` in ${source}` : ""}: ${issues}`);
  }
  const c = parsed.data;
  const warnings: string[] = [];

  const rawStatus = (raw as { status?: Record<string, unknown> } | null)?.status;
  if (rawStatus && typeof rawStatus === "object") {
    const known = new Set(Object.keys(StatusSection.shape));
    for (const key of Object.keys(rawStatus)) {
      if (!known.has(key)) warnings.push(`unknown key [status].${key} ignored`);
    }
  }

  const wildcard = new Set(["", "0.0.0.0", "::", "[::]"]);
  const hubHost = wildcard.has(c.server.host) ? "127.0.0.1" : c.server.host;
  // The hub is asked through its local socket (`hub_socket`, else `[server] local_socket`) unless a hub_url is set or the hub listens on a TCP port.
  const hubListen = c.server.listen ?? defaultListen(env, platform);
  const hubSocket = c.status.hub_socket ?? (c.status.hub_url || hubListen !== "unix" ? null : c.server.local_socket);
  const hubUrl = hubSocket ? "http://localhost" : (c.status.hub_url ?? `http://${hubHost.includes(":") ? `[${hubHost}]` : hubHost}:${c.server.port}`).replace(/\/+$/, "");
  // The status API has no user identity (metrics, health, the speed test): in production only nginx may reach it, through
  // the status socket. A TCP port there would be open to every local account, the agent account included.
  const listen = c.status.listen ?? defaultListen(env, platform);
  if (listen === "tcp" && isProductionLinux(env, platform)) {
    throw new Error('[status] listen = "tcp" is refused in production: every local account could reach the status API. Use "unix" (the default there); "tcp" is for development.');
  }

  return {
    source,
    listen,
    socket: c.status.socket,
    proxyGroup: c.server.proxy_group,
    host: c.status.host,
    port: c.status.port,
    publicUrl: c.server.public_url ?? null,
    usersRoot: c.paths.users_root,
    dataDir: c.paths.data_dir,
    dbPath: join(c.paths.data_dir, "status.sqlite"),
    diskWarnPercent: c.limits.disk_warn_percent,
    diskBlockPercent: c.limits.disk_block_percent,
    sampleIntervalS: c.status.sample_interval_s,
    healthIntervalS: c.status.health_interval_s,
    interfaces: c.status.interfaces,
    speedProbeIntervalMin: c.status.speed_probe_interval_min,
    hubUrl,
    hubSocket,
    hubPort: c.server.port,
    hubUser: c.status.hub_user,
    dnsCheckHost: c.status.dns_check_host ?? hostFromPublicUrl(c.server.public_url),
    nvmeDevice: c.status.nvme_device,
    warnings,
  };
}

/** The DNS name of public_url, or null when it is missing, an IP literal or localhost. */
export function hostFromPublicUrl(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || isIP(host)) return null;
    return host;
  } catch {
    return null;
  }
}
