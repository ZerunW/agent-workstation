/**
 * Hub configuration.
 *
 * Load order (first existing file wins):
 *   1. $WORKSTATION_CONFIG
 *   2. ./config/workstation.toml            (relative to the process cwd)
 *   3. /etc/agent-workstation/workstation.toml
 *   4. built-in defaults (= config/workstation.example.toml)
 * Missing keys fall back to the defaults below. (`npm run dev -w packages/hub`
 * sets WORKSTATION_CONFIG to the repo's config/workstation.toml when unset.)
 *
 * A few environment variables override the file for development:
 *   WORKSTATION_HUB_HOST, WORKSTATION_HUB_PORT, WORKSTATION_USERS_ROOT, WORKSTATION_DATA_DIR, WORKSTATION_CLAUDE_BIN,
 *   WORKSTATION_WEB_DIST, WORKSTATION_CLAUDE_HOME.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { resolveBrowserConfig, type BrowserConfig } from "@agent-workstation/browser";
import { pricingTable, type PricePeriod, type PricingTable } from "./pricing.js";

const here = dirname(fileURLToPath(import.meta.url));

export const CONFIG_PATH = "/etc/agent-workstation/workstation.toml";
export const API_KEY_FILE = "/etc/agent-workstation/anthropic.env";

/** The environment overrides the hub reads. */
export type WorkstationEnvName =
  | "WORKSTATION_CONFIG"
  | "WORKSTATION_HUB_HOST"
  | "WORKSTATION_HUB_PORT"
  | "WORKSTATION_USERS_ROOT"
  | "WORKSTATION_DATA_DIR"
  | "WORKSTATION_CLAUDE_BIN"
  | "WORKSTATION_WEB_DIST"
  | "WORKSTATION_CLAUDE_HOME";

/** `env[name]`. An empty value is a value (e.g. CLAUDE_BIN="" = bundled). */
export function envValue(env: NodeJS.ProcessEnv, name: WorkstationEnvName): string | undefined {
  return env[name];
}
/** packages/hub (works from both src/ and dist/). */
export const HUB_PACKAGE_DIR = resolve(here, "..");

/** Where the user API listens: Unix sockets (production, behind nginx) or one TCP port (development). */
export type ListenMode = "unix" | "tcp";

/** Production = started by systemd (INVOCATION_ID) or with NODE_ENV=production. */
export function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || Boolean(env.INVOCATION_ID);
}

/** `[server] listen` when it is not set: Unix sockets on Linux in production, a TCP port everywhere else. */
export function defaultListen(env: NodeJS.ProcessEnv, platform: string = process.platform): ListenMode {
  return platform === "linux" && isProductionEnv(env) ? "unix" : "tcp";
}

/** The runtime directory both services' sockets live in (created by tmpfiles.d and the hub pre-start step, deploy/install.sh). */
export const RUNTIME_DIR = "/run/agent-workstation";

const ServerSection = z
  .object({
    /** "unix": the public and local sockets below, no TCP listener. "tcp": `host` and `port`, for development only. Default: see defaultListen. */
    listen: z.enum(["unix", "tcp"]).optional(),
    /** Used with listen = "tcp". */
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(9000),
    /** Public socket: mode 0660, group `proxy_group`; only nginx connects here. */
    socket: z.string().startsWith("/").default(`${RUNTIME_DIR}/hub.sock`),
    /** Local socket: mode 0600, owned by the service account; the status service and root connect here. */
    local_socket: z.string().startsWith("/").default(`${RUNTIME_DIR}/hub-local.sock`),
    /** Group of the public socket: the nginx account's group, never the agent account's. A group name or a numeric id. */
    proxy_group: z.string().min(1).default("workstation-proxy"),
    public_url: z.string().default("http://localhost:9000"),
    /**
     * Extra origins (`https://host`) browsers may call the hub from, besides `public_url`, this server's Tailscale name and
     * addresses and the hub's own loopback address. Other origins get 403 `cross_site`.
     */
    allowed_origins: z.array(z.string()).default([]),
  })
  .prefault({});

const PathsSection = z
  .object({
    users_root: z.string().default("/srv/agent-workstation/users"),
    data_dir: z.string().default("/var/lib/agent-workstation"),
    /** Claude Code binary. Empty string = use the binary bundled with the Agent SDK. */
    claude_bin: z.string().default(""),
    /** Built web UI. Default: ../web/dist next to this package. */
    web_dist: z.string().optional(),
    /** Claude's config dir (settings.json, projects/*.jsonl). Default: $CLAUDE_CONFIG_DIR or ~/.claude. */
    claude_home: z.string().optional(),
    /** Published app builds: <releases_dir>/mac/{release.json,AgentWorkstation.dmg}. Default: <app dir>/releases (two levels above this package). */
    releases_dir: z.string().optional(),
    /** The repo's docs/ (the readme pages are docs/readme/*.md, read per request). Default: <app dir>/docs (two levels above this package). */
    docs_dir: z.string().optional(),
    /**
     * Where the hub publishes the plugins it generates for code sessions (skills, commands, agents). The agent account must
     * be able to read it but never write or rename anything in it or above it. Default with `[agents] run_as`:
     * /var/lib/agent-workstation-plugins (deploy/install.sh creates it); otherwise <data_dir>/agent-plugins.
     */
    agent_plugins_dir: z.string().optional(),
  })
  .prefault({});

const AuthSection = z
  .object({
    /** Admins among requests without a Tailscale identity (LAN in `lan_access = "legacy"`, local tools on the server). */
    admin_usernames: z.array(z.string()).default([]),
    /**
     * Identify tailnet clients by their Tailscale login (tailscaled LocalAPI whois, cached 60 s per IP). A username is
     * bound to the first login that uses it; admin = the login is in `admin_logins`.
     */
    tailscale_identity: z.boolean().default(true),
    /** Tailscale logins (e.g. "someone@example.com") that are admin. */
    admin_logins: z.array(z.string()).default([]),
    /**
     * Requests that do not come from a Tailscale address (loopback without X-Forwarded-For excepted):
     * "legacy" = today's X-Workstation-User behaviour (admin only via admin_usernames), "deny" = 403 lan_denied.
     */
    lan_access: z.enum(["legacy", "deny"]).default("deny"),
    /**
     * Anthropic API key for API-credit billing of Claude sessions: a file with a line `ANTHROPIC_API_KEY=...` (or just
     * the key). Read at start, on SIGHUP and when its mtime changes (checked every 60 s); the key stays in memory and
     * only the hub's loopback key proxy uses it (API-billed Claude processes get a proxy token). Missing file = API
     * billing unavailable.
     * Unset = API_KEY_FILE.
     */
    anthropic_api_key_file: z.string().optional(),
  })
  .prefault({});

const BillingSection = z
  .object({
    /** Monthly API-credit budget in USD (0 = API billing off). Admin settings override it. */
    api_monthly_limit_usd: z.number().min(0).default(100),
    /** Day of month (1–28, hub local time) the API budget resets. */
    api_reset_day: z.number().int().min(1).max(28).default(1),
    /** The last this-many USD of the period are kept for Agent Workstation's own services (docs assistant, search ranking, summaries, download check, price check); API-billed sessions stop there. */
    service_reserve_usd: z.number().min(0).default(2),
    /** Port of the loopback API key proxy for API-billed Claude processes (0 = a random free port per start). */
    proxy_port: z.number().int().min(0).max(65535).default(0),
    /** Where the proxy forwards to (tests point it at a fake). */
    upstream: z
      .string()
      .regex(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/)
      .default("https://api.anthropic.com"),
  })
  .prefault({});

const SessionsSection = z
  .object({
    max_active_processes: z.number().int().min(1).default(6),
    min_free_mem_mib: z.number().int().min(0).default(1536),
    idle_minutes: z.number().min(0.05).default(10),
    permission_timeout_s: z.number().int().min(1).default(600),
    /** Model new sessions start with when neither the client nor the user's own preference says otherwise. */
    default_model: z.string().min(1).default("opus"),
    /** Effort for those sessions; null = the CLI's own default. */
    default_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().default("high"),
    /**
     * Memory cap (MiB) for the commands of a Claude chat or code session: Claude Code's CLAUDE_CODE_TOOL_MEMORY_LIMIT
     * (one cgroup for all commands of a Claude process). 0 = off, the default: it needs the cgroup setup in
     * deploy/README.md ("Per-command memory limits"); without it the CLI leaves commands uncapped anyway.
     */
    tool_memory_limit_mb: z.number().int().min(0).default(0),
    /**
     * Run the hooks and MCP servers a project defines itself (`.claude/settings.json` hooks, `.mcp.json`) in code
     * sessions. They run as the agent account, so a synced repository could start commands on the server. false
     * (default) = they do not run; the project's CLAUDE.md and skills still load.
     */
    project_settings: z.boolean().default(false),
  })
  .prefault({});

const LimitsSection = z
  .object({
    disk_warn_percent: z.number().min(1).max(100).default(80),
    disk_block_percent: z.number().min(1).max(100).default(95),
    default_weekly_token_limit: z.number().int().min(0).default(0),
    remote_claude_enabled: z.boolean().default(true),
  })
  .prefault({});

const TerminalSection = z
  .object({
    enabled: z.boolean().default(true),
    shell: z.string().default("/bin/bash"),
  })
  .prefault({});

/**
 * The account every AI process runs as (Claude Code, terminal shells). Empty `run_as` = the hub's own user
 * (dev machines, tests). Set: everything goes through `sudo -n -u <run_as> <exec> …` (sessions/agentExec.ts).
 */
const AgentsSection = z
  .object({
    run_as: z
      .string()
      .regex(/^([a-z_][a-z0-9_-]{0,31})?$/, "agents.run_as must be a plain account name")
      .default(""),
    /** The root-owned wrapper the sudoers drop-in allows (deploy/workstation-agent-exec). */
    exec: z.string().startsWith("/").default("/opt/agent-workstation/bin/workstation-agent-exec"),
    sudo: z.string().startsWith("/").default("/usr/bin/sudo"),
    /** Home of run_as (its ~/.claude). Default: /home/<run_as>. */
    home: z.string().optional(),
  })
  .prefault({});

/**
 * The per-user server browser (@agent-workstation/browser). Chromium is a direct child of the hub (DevTools over a pipe), so there
 * is no `wrapper`: the browser always runs as the hub account. Missing keys = the package defaults (resolveBrowserConfig).
 */
const BrowserSection = z
  .object({
    enabled: z.boolean().default(true),
    /** Absolute path of the Chromium binary; empty = Playwright's bundled build (`flavor`). */
    executable_path: z.string().default(""),
    flavor: z.enum(["headless-shell", "chromium"]).optional(),
    idle_minutes: z.number().min(0).optional(),
    max_concurrent: z.union([z.number().int().min(1), z.literal("auto")]).optional(),
    min_free_memory_mb: z.number().min(0).optional(),
    extra_args: z.array(z.string()).optional(),
    control_idle_seconds: z.number().min(1).optional(),
    viewport: z.object({ width: z.number().int().optional(), height: z.number().int().optional() }).optional(),
    screencast: z.object({ quality: z.number().int().optional(), max_fps: z.number().int().optional(), settle_ms: z.number().int().optional() }).optional(),
    mcp: z
      .object({
        host: z.string().optional(),
        /** 0 = a random free port (new on every hub start; sessions rebuild their MCP config on each spawn). */
        port: z.number().int().min(0).max(65535).optional(),
        capabilities: z.array(z.enum(["vision", "pdf"])).optional(),
        session_idle_minutes: z.number().min(1).optional(),
      })
      .optional(),
  })
  .prefault({});

/** `[chats]`: limits of the chats' download_file (sessions/download.ts). */
const ChatsSection = z
  .object({
    download_max_mb: z.number().int().min(1).max(10_240).default(2048),
    download_timeout_s: z.number().int().min(10).max(7200).default(600),
  })
  .prefault({});

/** `[baseline]`: limits of one baseline upload (POST /api/projects/:id/baseline; sync-core archive.ts). */
const BaselineSection = z
  .object({
    /** Bytes of the uploaded archive (default 4 GiB). */
    max_compressed_bytes: z.number().int().min(1).default(4 * 1024 ** 3),
    /** Total bytes of the files in it (default 8 GiB). */
    max_extracted_bytes: z.number().int().min(1).default(8 * 1024 ** 3),
    /** Entries (files, folders, links) in it (default 200 000). */
    max_files: z.number().int().min(1).default(200_000),
    /** Minutes to receive and extract it (default 30). */
    max_minutes: z.number().min(0.01).default(30),
  })
  .prefault({});

/** "HH:MM" (24 h, hub local time). */
const CHECK_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_PRICE_CHECK_TIME = "04:30";

/**
 * `[pricing]`: `check_time` ("HH:MM", hub local time of the daily price check, default 04:30) and
 * `[[pricing."<model id>"]]` price periods (see pricing.ts), merged over the built-in Claude prices.
 */
const PricingSection = z
  .object({ check_time: z.string().regex(CHECK_TIME_RE, 'pricing.check_time must be "HH:MM"').optional() })
  .catchall(
    z.array(
      z.object({
        from: z.string().optional(),
        input_per_mtok: z.number().min(0),
        output_per_mtok: z.number().min(0),
        cache_read_factor: z.number().min(0).max(1).default(0.25),
        cache_read_per_mtok: z.number().min(0).optional(),
        cache_write_5m_factor: z.number().min(0).optional(),
        cache_write_1h_factor: z.number().min(0).optional(),
      }),
    ),
  )
  .optional();

const RawConfig = z
  .object({
    server: ServerSection,
    paths: PathsSection,
    auth: AuthSection,
    sessions: SessionsSection,
    limits: LimitsSection,
    terminal: TerminalSection,
    billing: BillingSection,
    agents: AgentsSection,
    browser: BrowserSection,
    chats: ChatsSection,
    baseline: BaselineSection,
    pricing: PricingSection,
  })
  // [status] and future sections belong to other services; ignore them.
  .loose();

export interface HubConfig {
  /** Absolute path of the file that was loaded, or null when running on defaults. */
  source: string | null;
  server: {
    listen: ListenMode;
    /** listen = "tcp" only. */
    host: string;
    port: number;
    /** listen = "unix" only: the public socket (group `proxyGroup`, 0660), the local socket (0600) and the public socket's group. */
    socket: string;
    localSocket: string;
    proxyGroup: string;
    publicUrl: string;
    allowedOrigins: string[];
  };
  paths: {
    usersRoot: string;
    dataDir: string;
    claudeBin: string;
    webDist: string;
    claudeHome: string;
    releasesDir: string;
    /** The repo's docs/ folder (readme pages under readme/). */
    docsDir: string;
    /** Published plugins for code sessions (see `[paths] agent_plugins_dir`). */
    agentPluginsDir: string;
  };
  auth: {
    adminUsernames: string[];
    tailscaleIdentity: boolean;
    /** Lower-cased. */
    adminLogins: string[];
    lanAccess: "legacy" | "deny";
    anthropicApiKeyFile: string;
  };
  sessions: {
    maxActiveProcesses: number;
    minFreeMemMib: number;
    idleMinutes: number;
    permissionTimeoutS: number;
    defaultModel: string;
    defaultEffort: "low" | "medium" | "high" | "xhigh" | "max" | null;
    /** MiB; 0 = the commands of Claude sessions are not capped. */
    toolMemoryLimitMb: number;
    /** Code sessions run the hooks and MCP servers of a project's own settings. */
    projectSettings: boolean;
  };
  limits: { diskWarnPercent: number; diskBlockPercent: number; defaultWeeklyTokenLimit: number; remoteClaudeEnabled: boolean };
  terminal: { enabled: boolean; shell: string };
  billing: { apiMonthlyLimitUsd: number; apiResetDay: number; serviceReserveUsd: number; proxyPort: number; upstream: string };
  /** `runAs` "" = AI processes run as the hub's own user. `home` is runAs's home ("" when runAs is empty). */
  agents: { runAs: string; exec: string; sudo: string; home: string };
  /** `[browser]`, resolved (defaults and clamps applied; `usersRoot` = paths.usersRoot; `wrapper` always empty). */
  browser: BrowserConfig;
  /** `[chats]`: download_file's size (MB) and time (s) limits. */
  chats: { downloadMaxMb: number; downloadTimeoutS: number };
  /** Limits of one baseline upload. */
  baseline: { maxCompressedBytes: number; maxExtractedBytes: number; maxFiles: number; maxMs: number };
  /** The price table: built-in Claude prices with `[pricing]` periods merged over them. */
  pricing: PricingTable;
  /** `[pricing] check_time`: hub local "HH:MM" of the daily price check. */
  pricingCheckTime: string;
}

export function candidateConfigPaths(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string[] {
  const list: string[] = [];
  const fromEnv = envValue(env, "WORKSTATION_CONFIG");
  if (fromEnv) list.push(resolve(cwd, fromEnv));
  list.push(resolve(cwd, "config/workstation.toml"));
  list.push(CONFIG_PATH);
  return [...new Set(list)];
}

/** Parses TOML text (or an object) into a validated HubConfig. Exposed for tests. */
export function parseConfig(
  input: string | Record<string, unknown>,
  source: string | null,
  env: NodeJS.ProcessEnv = process.env,
): HubConfig {
  const obj = typeof input === "string" ? (parseToml(input) as Record<string, unknown>) : input;
  const raw = RawConfig.parse(obj);
  const fromEnv = (name: WorkstationEnvName) => envValue(env, name);
  const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const portEnv = fromEnv("WORKSTATION_HUB_PORT");
  const port = portEnv ? Number(portEnv) : raw.server.port;
  const runAs = raw.agents.run_as;
  const agentHome = runAs ? resolve(expand(raw.agents.home ?? `/home/${runAs}`)) : "";
  // Claude's files live in the home of whoever runs them: the agent account when run_as is set.
  const claudeHome = expand(fromEnv("WORKSTATION_CLAUDE_HOME") ?? raw.paths.claude_home ?? (runAs ? join(agentHome, ".claude") : (env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))));
  const apiKeyFile = raw.auth.anthropic_api_key_file ?? API_KEY_FILE;
  const usersRoot = resolve(expand(fromEnv("WORKSTATION_USERS_ROOT") ?? raw.paths.users_root));
  const b = raw.browser;
  // Throws (config error) on a non-loopback mcp.host or DevTools/profile switches in extra_args.
  const browser = resolveBrowserConfig({
    usersRoot,
    enabled: b.enabled,
    ...(b.executable_path ? { executablePath: resolve(expand(b.executable_path)) } : {}),
    ...(b.flavor ? { flavor: b.flavor } : {}),
    ...(b.idle_minutes !== undefined ? { idleMinutes: b.idle_minutes } : {}),
    ...(b.max_concurrent !== undefined ? { maxConcurrent: b.max_concurrent } : {}),
    ...(b.min_free_memory_mb !== undefined ? { minFreeMemoryMB: b.min_free_memory_mb } : {}),
    ...(b.extra_args ? { extraArgs: b.extra_args } : {}),
    ...(b.control_idle_seconds !== undefined ? { controlIdleSeconds: b.control_idle_seconds } : {}),
    viewport: { ...b.viewport },
    screencast: { quality: b.screencast?.quality, maxFps: b.screencast?.max_fps, settleMs: b.screencast?.settle_ms },
    mcp: { host: b.mcp?.host, port: b.mcp?.port, capabilities: b.mcp?.capabilities, sessionIdleMinutes: b.mcp?.session_idle_minutes },
  });
  const cfg: HubConfig = {
    source,
    server: {
      listen: raw.server.listen ?? defaultListen(env),
      host: fromEnv("WORKSTATION_HUB_HOST") ?? raw.server.host,
      port,
      socket: raw.server.socket,
      localSocket: raw.server.local_socket,
      proxyGroup: raw.server.proxy_group,
      publicUrl: raw.server.public_url,
      allowedOrigins: raw.server.allowed_origins,
    },
    paths: {
      usersRoot,
      dataDir: resolve(expand(fromEnv("WORKSTATION_DATA_DIR") ?? raw.paths.data_dir)),
      claudeBin: expand(fromEnv("WORKSTATION_CLAUDE_BIN") ?? raw.paths.claude_bin),
      webDist: resolve(expand(fromEnv("WORKSTATION_WEB_DIST") ?? raw.paths.web_dist ?? join(HUB_PACKAGE_DIR, "../web/dist"))),
      claudeHome: resolve(claudeHome),
      releasesDir: resolve(expand(raw.paths.releases_dir ?? join(HUB_PACKAGE_DIR, "../../releases"))),
      docsDir: resolve(expand(raw.paths.docs_dir ?? join(HUB_PACKAGE_DIR, "../../docs"))),
      agentPluginsDir: resolve(expand(raw.paths.agent_plugins_dir ?? (runAs ? "/var/lib/agent-workstation-plugins" : join(resolve(expand(fromEnv("WORKSTATION_DATA_DIR") ?? raw.paths.data_dir)), "agent-plugins")))),
    },
    auth: {
      adminUsernames: raw.auth.admin_usernames,
      tailscaleIdentity: raw.auth.tailscale_identity,
      adminLogins: raw.auth.admin_logins.map((l) => l.trim().toLowerCase()).filter(Boolean),
      lanAccess: raw.auth.lan_access,
      anthropicApiKeyFile: expand(apiKeyFile),
    },
    sessions: {
      maxActiveProcesses: raw.sessions.max_active_processes,
      minFreeMemMib: raw.sessions.min_free_mem_mib,
      idleMinutes: raw.sessions.idle_minutes,
      permissionTimeoutS: raw.sessions.permission_timeout_s,
      defaultModel: raw.sessions.default_model,
      defaultEffort: raw.sessions.default_effort,
      toolMemoryLimitMb: raw.sessions.tool_memory_limit_mb,
      projectSettings: raw.sessions.project_settings,
    },
    limits: {
      diskWarnPercent: raw.limits.disk_warn_percent,
      diskBlockPercent: raw.limits.disk_block_percent,
      defaultWeeklyTokenLimit: raw.limits.default_weekly_token_limit,
      remoteClaudeEnabled: raw.limits.remote_claude_enabled,
    },
    terminal: { enabled: raw.terminal.enabled, shell: raw.terminal.shell },
    billing: { apiMonthlyLimitUsd: raw.billing.api_monthly_limit_usd, apiResetDay: raw.billing.api_reset_day, serviceReserveUsd: raw.billing.service_reserve_usd, proxyPort: raw.billing.proxy_port, upstream: raw.billing.upstream },
    agents: { runAs, exec: raw.agents.exec, sudo: raw.agents.sudo, home: agentHome },
    browser,
    chats: { downloadMaxMb: raw.chats.download_max_mb, downloadTimeoutS: raw.chats.download_timeout_s },
    baseline: { maxCompressedBytes: raw.baseline.max_compressed_bytes, maxExtractedBytes: raw.baseline.max_extracted_bytes, maxFiles: raw.baseline.max_files, maxMs: Math.round(raw.baseline.max_minutes * 60_000) },
    pricing: pricingTable(configuredPricing(raw.pricing)),
    pricingCheckTime: raw.pricing?.check_time ?? DEFAULT_PRICE_CHECK_TIME,
  };
  if (!Number.isInteger(cfg.server.port) || cfg.server.port <= 0) throw new Error(`invalid port: ${String(portEnv)}`);
  if (cfg.limits.diskWarnPercent >= cfg.limits.diskBlockPercent) {
    throw new Error("limits.disk_warn_percent must be lower than limits.disk_block_percent");
  }
  return cfg;
}

/** The `[[pricing."<model>"]]` periods of the config (check_time and other scalars skipped). */
function configuredPricing(raw: z.infer<typeof PricingSection>): PricingTable | undefined {
  if (!raw) return undefined;
  const out: PricingTable = {};
  for (const [model, periods] of Object.entries(raw)) {
    if (!Array.isArray(periods)) continue;
    out[model] = periods.map((p) => {
      const period: PricePeriod = { from: p.from ?? null, input: p.input_per_mtok, output: p.output_per_mtok, cacheReadFactor: p.cache_read_factor };
      if (p.cache_read_per_mtok !== undefined) {
        period.cacheRead = p.cache_read_per_mtok;
        if (p.input_per_mtok > 0) period.cacheReadFactor = p.cache_read_per_mtok / p.input_per_mtok;
      }
      if (p.cache_write_5m_factor !== undefined) period.cacheWrite5m = p.cache_write_5m_factor;
      if (p.cache_write_1h_factor !== undefined) period.cacheWrite1h = p.cache_write_1h_factor;
      return period;
    });
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): HubConfig {
  for (const path of candidateConfigPaths(env, cwd)) {
    if (existsSync(path)) {
      try {
        return parseConfig(readFileSync(path, "utf8"), path, env);
      } catch (err) {
        throw new Error(`failed to load ${path}: ${(err as Error).message}`);
      }
    }
  }
  return parseConfig({}, null, env);
}
