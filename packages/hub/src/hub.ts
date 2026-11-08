/**
 * Wires every service together. `createHub` has no side effects beyond
 * opening the database and creating directories; `startHub` starts timers,
 * the disk monitor and the browser's MCP endpoint; `stopHub` shuts everything down.
 */
import { modelMatchesAllowlist } from "./sessions/models.js";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserManager } from "@agent-workstation/browser";
import { ApiKeyStore, BillingService, meteredCostUsd } from "./billing.js";
import { readReadmeDoc } from "./readme.js";
import type { HubConfig } from "./config.js";
import { KeyProxy } from "./keyProxy.js";
import { PricingService } from "./pricing.js";
import { fetchPricingPage, PriceCheckService } from "./pricingCheck.js";
import { DOWNLOAD_CHECK_MAX_TOKENS, helperAvailable, helperUnavailableReason, runHelper, type HelperRunner } from "./helper.js";
import { HUB_PACKAGE_DIR } from "./config.js";
import { Store } from "./db/store.js";
import { DiskMonitor, type DuFn, type StatFsFn } from "./disk/monitor.js";
import { UploadService } from "./files/upload.js";
import { WatcherHub } from "./files/watcher.js";
import { createIdentity, type IdentityHost, type IdentityResolver } from "./identity.js";
import { TailscaleWhoisClient, type TailscaleSelfSource, type TailscaleWhois } from "./tailscale.js";
import { OriginPolicy } from "./origin.js";
import { firewallUnitActive, FirewallWatch } from "./startupChecks.js";
import { MemoryService } from "./memory.js";
import { ProjectService } from "./projects/service.js";
import { historyTools } from "./search/history.js";
import { SearchService } from "./search/service.js";
import { SummaryService } from "./search/summaries.js";
import { SEARCH_INDEX_VERSION } from "./db/store.js";
import { Catalog } from "./sessions/catalog.js";
import { AGENT_SCRATCH_DIRNAME, AgentExec, agentRunAsConfig } from "./sessions/agentExec.js";
import { AgentVersionService } from "./sessions/agentVersions.js";
import { ensureTranscriptRetention } from "./sessions/claudeFiles.js";
import { SessionService } from "./sessions/runtime.js";
import { AgentFetcher, DirectFetcher, DownloadService, helperDownloadJudge, systemLookup, type DownloadFetcher, type Lookup } from "./sessions/download.js";
import type { DownloadCheck } from "@agent-workstation/protocol";
import { resolveClaudeExecutable, type SdkDeps } from "./sessions/sdk.js";
import { UsageLimitsService } from "./sessions/usage.js";
import { weeklyTokens } from "./sessions/usageReports.js";
import { SettingsService } from "./settings.js";
import { SkillService } from "./skills/service.js";
import { TerminalService } from "./terminal/pty.js";
import { UserService } from "./users.js";
import type { Logger } from "./util/log.js";
import { readMemAvailableMiB, readMemInfo } from "./util/meminfo.js";
import { errorMessage } from "./util/errors.js";
import { iso } from "./util/time.js";
import { WsHub } from "./ws/server.js";

export interface Hub {
  config: HubConfig;
  log: Logger;
  version: string;
  startedAt: number;
  store: Store;
  identity: IdentityResolver;
  /** Which web origins may call the hub (cross-site protection, origin.ts). */
  origins: OriginPolicy;
  settings: SettingsService;
  users: UserService;
  memories: MemoryService;
  ws: WsHub;
  catalog: Catalog;
  usageLimits: UsageLimitsService;
  sessions: SessionService;
  disk: DiskMonitor;
  uploads: UploadService;
  watchers: WatcherHub;
  terminals: TerminalService;
  projects: ProjectService;
  skills: SkillService;
  claudeExecutable: string | undefined;
  /** The Anthropic API key (memory only) and the API-credit budget. */
  apiKeys: ApiKeyStore;
  billing: BillingService;
  /** Loopback proxy that holds the key for API-billed Claude processes (they only get per-process tokens). */
  apiProxy: KeyProxy;
  /** Keyword and relevant search over the users' sessions. */
  search: SearchService;
  /** Claude Haiku summaries of idle sessions. */
  summaries: SummaryService;
  /** Price periods in force (config / built-in + hub-owned overrides). */
  pricing: PricingService;
  /** Daily price check at `[pricing] check_time` (and POST /api/admin/pricing/refresh). */
  priceCheck: PriceCheckService;
  /** The per-user server browser (Chromium + the agents' MCP endpoint + the live view). */
  browsers: BrowserManager;
  /** Version of claude as the agent account runs it (`GET /api/health` `agents`). */
  agentVersions: AgentVersionService;
  /** Re-checks every 10 minutes that the agent firewall unit is active while agents run as a separate account (null otherwise). */
  firewallWatch: FirewallWatch | null;
  memInfo:() => { totalMiB: number; availableMiB: number } | null;
}

export interface HubOverrides {
  log: Logger;
  sdk: SdkDeps;
  memAvailableMiB?: () => number;
  statfs?: StatFsFn;
  du?: DuFn;
  /** Wrap CLI spawn to learn pids (default true). */
  captureProcess?: boolean;
  tmuxBin?: string | null;
  /** In-memory DB for tests. */
  dbFile?: string;
  /** Minimum spacing of review_changed per project (tests shorten it). */
  reviewNotifyMs?: number;
  /** Large-file threshold and chunk limit (default MAX_SYNC_FILE_BYTES / LARGE_FILE_CHUNK_BYTES; tests lower them). */
  largeFileMinBytes?: number;
  largeFileChunkBytes?: number;
  /** Session summaries: idle debounce / per-session minimum interval (tests shorten them). */
  summaryDebounceMs?: number;
  summaryMinIntervalMs?: number;
  /** API key file mtime check interval (default 60 s; 0 = no timer). */
  apiKeyPollMs?: number;
  clock?: () => Date;
  /** Replaces the one built from `[agents]` (null = none even when run_as is set). */
  agentExec?: AgentExec | null;
  /** Replaces the BrowserManager built from `[browser]` (tests pass one with a fake launcher). */
  browsers?: BrowserManager;
  /** Replaces the tailscaled whois client (tests pass a fake). */
  tailscaleWhois?: TailscaleWhois;
  /** Where this server's own Tailscale name and addresses come from (default: the real whois client; tests pass a fake, null = none). */
  tailscaleSelf?: TailscaleSelfSource | null;
  /** Whether the agent firewall unit is active, and the periodic check's interval (tests pass fakes). */
  firewallActive?: () => Promise<boolean>;
  /** What the identity check asks the machine (interface addresses; tests pass fakes). */
  identityHost?: IdentityHost;
  firewallWatchMs?: number;
  /** The price check's page fetch (tests pass a fake; default fetchPricingPage). */
  pricingFetch?: (url: string) => Promise<string>;
  /** Chats' download_file: the fetcher, DNS lookup and judge (tests pass fakes). */
  downloadFetcher?: DownloadFetcher;
  downloadLookup?: Lookup;
  downloadJudge?: (url: string) => Promise<DownloadCheck>;
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(HUB_PACKAGE_DIR, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createHub(config: HubConfig, o: HubOverrides): Hub {
  mkdirSync(config.paths.usersRoot, { recursive: true });
  mkdirSync(config.paths.dataDir, { recursive: true });
  const log = o.log;
  const store = new Store(o.dbFile ?? join(config.paths.dataDir, "hub.sqlite"));
  // The price table: metered API requests, live turn costs and estimated costs of usage rows without one. The daily
  // price check appends hub-owned periods (pricing_overrides).
  const pricing = new PricingService(config.pricing, store, log);
  store.setPricing(pricing);
  const whois = o.tailscaleWhois ?? new TailscaleWhoisClient();
  const tailscaleSelf = o.tailscaleSelf !== undefined ? o.tailscaleSelf : o.tailscaleWhois ? null : (whois as TailscaleWhoisClient);
  const origins = new OriginPolicy(config, tailscaleSelf, log);
  // The origin policy caches this server's own Tailscale addresses; the identity check reuses that answer.
  const identity = createIdentity(config, { log, whois, selfAddresses: () => origins.selfAddresses(), ...(o.identityHost ? { host: o.identityHost } : {}) });
  const settings = new SettingsService(store, config);
  const users = new UserService(store, config, settings, identity, log);
  const ws = new WsHub(log);
  const memories = new MemoryService(store, ws);
  const catalog = new Catalog(store, log);
  const usageLimits = new UsageLimitsService({ bus: ws, log });
  // `[agents] run_as`: Claude and terminals run as the agent account through the wrapper (sessions/agentExec.ts).
  const agentExec = o.agentExec !== undefined ? (o.agentExec ?? undefined) : config.agents.runAs ? new AgentExec(agentRunAsConfig(config), log) : undefined;
  const agentScratch = agentExec ? join(config.paths.usersRoot, AGENT_SCRATCH_DIRNAME) : null;
  if (agentScratch) mkdirSync(agentScratch, { recursive: true });
  // The wrapper runs its own claude binary; paths.claude_bin is for the hub's own user only.
  const claudeExecutable = agentExec ? undefined : resolveClaudeExecutable(config.paths.claudeBin);
  if (!agentExec && config.paths.claudeBin && !claudeExecutable) log.warn({ claudeBin: config.paths.claudeBin }, "paths.claude_bin not found; using the Claude binary bundled with the Agent SDK");
  const memAvailableMiB = o.memAvailableMiB ?? (() => readMemAvailableMiB());

  const projects = new ProjectService({
    store,
    log,
    bus: ws,
    userRoot: (u) => users.root(u),
    isConnected: (u) => ws.isConnected(u),
    ...(o.reviewNotifyMs !== undefined ? { notifyIntervalMs: o.reviewNotifyMs } : {}),
    ...(o.largeFileMinBytes !== undefined ? { largeFileMinBytes: o.largeFileMinBytes } : {}),
    ...(o.largeFileChunkBytes !== undefined ? { largeFileChunkBytes: o.largeFileChunkBytes } : {}),
  });
  const skills = new SkillService({
    usersRoot: config.paths.usersRoot,
    userRoot: (u) => users.root(u),
    dataDir: config.paths.dataDir,
    pluginsDir: config.paths.agentPluginsDir,
    // Claude reads the overlay (`--add-dir`): with run_as it cannot be in the hub's private data dir.
    ...(agentScratch ? { overlayRoot: join(agentScratch, "skill-overlays") } : {}),
    log,
  });

  // API-credit billing: the key (memory only) and the monthly budget.
  let billingRef: BillingService | null = null;
  const apiKeys = new ApiKeyStore({
    file: config.auth.anthropicApiKeyFile,
    log,
    pollMs: o.apiKeyPollMs ?? 60_000,
    onChange: () => {
      billingRef?.clearCreditsExhausted();
      if (billingRef) usageLimits.broadcast();
    },
  });
  const billing = new BillingService({ store, settings, keys: apiKeys, ...(o.clock ? { clock: o.clock } : {}) });
  billingRef = billing;
  // API-billed Claude processes get a token for this loopback proxy instead of the key (listens from startHub).
  // Every API-billed request is metered by the proxy (api_requests): the API-credit spend is their sum.
  const apiProxy = new KeyProxy({
    key: () => apiKeys.key(),
    // Claude processes cannot spend past the budget or use a model their user is not allowed, whatever the CLI asks for.
    gate: (owner) => {
      if (billing.overBudget()) {
        return { refuse: { status: 429, type: "rate_limit_error", message: "This month's API budget is used up for sessions." } };
      }
      const session = store.getSession(owner);
      const row = session ? users.get(session.user) : null;
      const allowlist = row?.modelAllowlist;
      if (!allowlist) return null;
      return { modelAllowed: (model) => modelMatchesAllowlist(allowlist, model) };
    },
    log,
    upstream: config.billing.upstream,
    port: config.billing.proxyPort,
    ...(o.clock ? { clock: o.clock } : {}),
    onMetered: (m) => {
      const user = store.getSession(m.owner)?.user ?? "";
      const model = m.model ?? "unknown";
      const costUsd = meteredCostUsd(pricing, m, m.at);
      store.insertApiRequest({ at: m.at, sessionId: m.owner, user, model, input: m.input, cacheWrite5m: m.cacheWrite5m, cacheWrite1h: m.cacheWrite1h, cacheRead: m.cacheRead, output: m.output, webSearchRequests: m.webSearchRequests, speed: m.speed, costUsd, complete: m.complete });
      if (user) onApiUsage(user);
      else usageLimits.broadcast();
    },
  });
  usageLimits.setApiSource(() => billing.limits());
  const warnedApi = new Map<string, number>();
  const onApiUsage = (user: string) => {
    usageLimits.broadcast();
    const lim = billing.limits();
    if (!lim || lim.percent === null) return;
    // Sessions stop at the service reserve (the rest is kept for Agent Workstation's own services): that counts as reached.
    const atReserve = Math.round((lim.limitUsd - lim.spentUsd) * 100) <= Math.round(billing.serviceReserveUsd() * 100);
    const bucket = lim.percent >= 100 || atReserve ? 100 : lim.percent >= 80 ? 80 : 0;
    const prev = warnedApi.get(lim.periodStart) ?? 0;
    if (bucket > prev) {
      warnedApi.set(lim.periodStart, bucket);
      ws.toUser(user, {
        type: "notice",
        level: bucket >= 100 ? "error" : "warning",
        code: bucket >= 100 ? "api_limit_reached" : "api_limit_warning",
        message:
          bucket >= 100
            ? "This month's API budget is used up for sessions (the rest is kept for Agent Workstation's own services); API-billed sessions are paused until it resets."
            : `${Math.round(lim.percent)}% of this month's API budget is used.`,
        at: iso(),
      });
    }
  };

  // Claude Haiku for summaries, relevant search, the download check and the price check (helper.ts; billed in api_requests).
  const helper: HelperRunner = (prompt, opts) => runHelper({ config, pricing, store, usageLimits, billing, log }, prompt, opts);
  const helperOk = () => helperAvailable({ billing });
  let sessionsRef: SessionService | null = null;
  const search = new SearchService({
    store,
    toSession: (row) => sessionsRef!.toProtocol(row),
    helper,
    helperAvailable: helperOk,
    helperUnavailableReason: () => helperUnavailableReason({ billing }),
    log,
  });
  const summaries = new SummaryService({
    store,
    helper,
    available: helperOk,
    isIdle: (id) => sessionsRef!.statusOf(id).status === "idle",
    log,
    ...(o.summaryDebounceMs !== undefined ? { debounceMs: o.summaryDebounceMs } : {}),
    ...(o.summaryMinIntervalMs !== undefined ? { minIntervalMs: o.summaryMinIntervalMs } : {}),
  });

  const priceCheck = new PriceCheckService({
    store,
    pricing,
    bus: ws,
    log,
    run: helper,
    fetchPage: o.pricingFetch ?? fetchPricingPage,
    available: helperOk,
    unavailableReason: () => helperUnavailableReason({ billing }),
    checkTime: config.pricingCheckTime,
    ...(o.clock ? { clock: o.clock } : {}),
  });

  // The server browser: Chromium runs as the hub account (a direct child, DevTools over a pipe); agents reach it through
  // the manager's loopback MCP endpoint (random port per hub start, so sessions build their MCP config on every spawn).
  const browsers =
    o.browsers ??
    new BrowserManager(config.browser, {
      log: (msg, err) => (err === undefined ? log.info({ svc: "browser" }, msg) : log.warn({ svc: "browser", err: errorMessage(err) }, msg)),
    });
  browsers.on("state", (user, state) => ws.toUser(user, { type: "browser_state", state }));
  browsers.on("error", (user, err) => {
    log.warn({ user, err: errorMessage(err) }, "browser failed");
    ws.toUser(user, { type: "notice", level: "warning", code: "browser_stopped", message: err.message, at: iso() });
  });
  const sessionBrowser = {
    endpoint: (user: string, sessionId: string) => {
      if (!browsers.config.enabled) return null;
      try {
        return browsers.mcpEndpoint(user, { sessionId });
      } catch (err) {
        log.warn({ user, sessionId, err: errorMessage(err) }, "no browser MCP endpoint for this session");
        return null;
      }
    },
    controlledBy: (user: string) => {
      try {
        return browsers.state(user).controlledBy;
      } catch {
        return null;
      }
    },
    // The active tab's page (what the website check asks about). BrowserManager does not list tabs by the agent's
    // index, so a tool naming a tab is checked against the active tab; selecting a tab only shows the tab list, and the
    // next call is checked against the newly active tab.
    pageUrl: (user: string, tab?: number): string | null => {
      if (tab !== undefined) return null;
      try {
        const s = browsers.state(user);
        return s.running ? s.url : null;
      } catch {
        return null;
      }
    },
  };

  // Chats' one-way download tool: curl in bubblewrap as the agent account (direct curl without run_as); hosts outside
  // the well-known download hosts are judged by Claude Haiku first (sessions/download.ts).
  const downloads = new DownloadService({
    fetcher: o.downloadFetcher ?? (agentExec ? new AgentFetcher(agentExec, log) : new DirectFetcher()),
    lookup: o.downloadLookup ?? systemLookup,
    judge: o.downloadJudge ?? helperDownloadJudge({ run: (prompt, timeoutMs) => helper(prompt, { purpose: "download", user: "", maxTokens: DOWNLOAD_CHECK_MAX_TOKENS, timeoutMs }), available: helperOk }),
    maxBytes: config.chats.downloadMaxMb * 1024 * 1024,
    timeoutS: config.chats.downloadTimeoutS,
    // read at call time (the disk monitor is created further down)
    diskBlocked: () => disk.level === "block",
    log,
  });

  const warnedWeekly = new Map<string, number>();
  const sessions = new SessionService({
    store,
    sdk: o.sdk,
    bus: ws,
    log,
    limits: {
      maxActiveProcesses: () => config.sessions.maxActiveProcesses,
      minFreeMemMib: () => config.sessions.minFreeMemMib,
      idleMs: () => config.sessions.idleMinutes * 60_000,
      permissionTimeoutMs: () => config.sessions.permissionTimeoutS * 1000,
    },
    memAvailableMiB,
    userRoot: (u) => users.root(u),
    claudeExecutable,
    ...(agentExec ? { agentExec } : {}),
    captureProcess: o.captureProcess ?? true,
    catalog,
    usageLimits,
    claudeHome: config.paths.claudeHome,
    projects,
    skillDirs: (u, cwdAbs) => skills.skillDirsFor(u, cwdAbs),
    projectPlugins: (u, cwdAbs) => skills.pluginsFor(u, cwdAbs),
    memories,
    instructions: (u) => store.userInstructions(u),
    knownHeadsUps: (u) => store.listKnownHeadsUps(u).map((k) => k.text),
    history: { tools: (user, sessionId) => historyTools({ store, search, relevantAvailable: helperOk }, user, sessionId) },
    billing,
    apiProxy,
    onApiUsage,
    pricing,
    browser: sessionBrowser,
    downloads,
    // read_workstation_docs: the readme pages from the deployed docs folder, read per call.
    docs: (doc) => readReadmeDoc(config.paths.docsDir, doc),
    toolMemoryLimitMb: () => config.sessions.toolMemoryLimitMb,
    projectSettings: () => config.sessions.projectSettings,
    // run_subagents' models: the user's allowlist and the model catalog when it is known (as GET /api/models).
    subagentModelAllowed: (user, model) => {
      const row = users.get(user);
      if (!row || !users.modelAllowed(row, model)) return false;
      const listed = catalog.getModels();
      return !listed || listed.some((m) => m.value === model);
    },
    onTurnIdle: (id) => summaries.sessionIdle(id),
    onSessionDeleted: (id) => summaries.forget(id),
    onUsageRecorded: (user) => {
      const row = users.get(user);
      if (!row) return;
      const limit = users.effectiveWeeklyLimit(row);
      if (!limit) return;
      const used = weeklyTokens(store, user);
      const pct = used / limit;
      const bucket = pct >= 1 ? 100 : pct >= 0.8 ? 80 : 0;
      if (bucket > (warnedWeekly.get(user) ?? 0)) {
        warnedWeekly.set(user, bucket);
        ws.toUser(user, {
          type: "notice",
          level: bucket >= 100 ? "error" : "warning",
          code: bucket >= 100 ? "weekly_limit" : "weekly_limit_warning",
          message: bucket >= 100 ? "You reached your weekly token limit; new turns are blocked until older usage rolls out of the 7-day window." : `You have used ${Math.round(pct * 100)}% of your weekly token limit.`,
          at: iso(),
        });
      } else if (bucket < (warnedWeekly.get(user) ?? 0)) {
        warnedWeekly.set(user, bucket);
      }
    },
  });

  sessionsRef = sessions;
  // After every agent tool call the browser's MCP gateway checks the pages the call left (redirects, link clicks,
  // new tabs) against the same website permissions, without asking.
  browsers.setSiteCheck((user, hubSessionId, origin) => sessions.browserSites.allowed(user, hubSessionId, origin));

  const disk = new DiskMonitor({
    usersRoot: config.paths.usersRoot,
    claudeHome: config.paths.claudeHome,
    store,
    bus: ws,
    log,
    thresholds: () => {
      const s = settings.get();
      return { warn: s.diskWarnPercent, block: s.diskBlockPercent };
    },
    listUsers: () => store.listUsers(false).map((u) => u.name),
    isAdmin: (u) => users.isAdmin(u),
    projectStats: () => projects.diskProjects(),
    ...(o.statfs ? { statfs: o.statfs } : {}),
    ...(o.du ? { du: o.du } : {}),
  });

  const uploads = new UploadService({
    store,
    dataDir: config.paths.dataDir,
    userRoot: (u) => users.root(u),
    log,
    freeBytes: () => {
      const c = disk.current();
      return c.totalBytes > 0 ? c.freeBytes : null;
    },
  });

  const watchers = new WatcherHub({
    userRoot: (u) => users.root(u),
    bus: ws,
    log,
    sessionFor: (u, rel) => sessions.runningSessionFor(u, rel),
    onPaths: (u, rels) => projects.pathsChanged(u, rels),
  });

  const terminals = new TerminalService({
    store,
    log,
    enabled: () => config.terminal.enabled,
    shell: config.terminal.shell,
    userRoot: (u) => users.root(u),
    ...(o.tmuxBin !== undefined ? { tmuxBin: o.tmuxBin } : {}),
    agentExec,
  });

  const hub: Hub = {
    config,
    log,
    version: packageVersion(),
    startedAt: Date.now(),
    store,
    identity,
    origins,
    settings,
    users,
    memories,
    ws,
    catalog,
    usageLimits,
    sessions,
    disk,
    uploads,
    watchers,
    terminals,
    projects,
    skills,
    claudeExecutable,
    apiKeys,
    billing,
    apiProxy,
    search,
    summaries,
    pricing,
    priceCheck,
    browsers,
    agentVersions: new AgentVersionService({ exec: agentExec, log }),
    // With a separate agent account its firewall unit should stay active: re-checked every 10 minutes, admins are told when it is not.
    firewallWatch: config.agents.runAs
      ? new FirewallWatch({
          runAs: config.agents.runAs,
          active: o.firewallActive ?? firewallUnitActive,
          onInactive: (message) => ws.toEachUser((user) => (users.isAdmin(user) ? { type: "notice", level: "error", code: "agent_firewall_inactive", message, at: iso() } : null)),
          onActive: (message) => ws.toEachUser((user) => (users.isAdmin(user) ? { type: "notice", level: "info", code: "agent_firewall_inactive", message, at: iso() } : null)),
          log,
          ...(o.firewallWatchMs !== undefined ? { intervalMs: o.firewallWatchMs } : {}),
        })
      : null,
    memInfo: () => readMemInfo(),
  };
  ws.bind(hub);
  return hub;
}

export async function startHub(hub: Hub, opts: { timers?: boolean; retention?: boolean } = {}): Promise<void> {
  hub.apiKeys.start();
  try {
    await hub.apiProxy.start();
  } catch (err) {
    // API-billed sessions then fail to start (503 api_unavailable); everything else keeps working.
    hub.log.error({ err: String(err), port: hub.config.billing.proxyPort }, "could not start the API key proxy; API billing is unavailable");
  }
  hub.sessions.recoverAfterRestart();
  // Incognito chats left over from before the restart: the user chose that they are not kept.
  await hub.sessions.purgeIncognito();
  // Search index for data from before it existed (background; incremental from here on).
  void hub.search.startBuild(SEARCH_INDEX_VERSION).catch((err) => hub.log.warn({ err: String(err) }, "search index build failed"));
  try {
    hub.skills.init();
  } catch (err) {
    hub.log.warn({ err: String(err) }, "could not prepare global skills");
  }
  // With run_as, ~/.claude belongs to the agent account (install.sh seeds cleanupPeriodDays there; every
  // session also passes it in its flag settings).
  if (opts.retention !== false && !hub.config.agents.runAs) {
    try {
      await ensureTranscriptRetention(hub.config.paths.claudeHome, hub.log);
    } catch (err) {
      hub.log.warn({ err: String(err) }, "could not ensure cleanupPeriodDays in Claude settings");
    }
  }
  await hub.terminals.init();
  // Binds the browser MCP endpoint (loopback, random port); browsers themselves start on demand.
  try {
    await hub.browsers.start();
  } catch (err) {
    hub.log.warn({ err: errorMessage(err) }, "could not start the server browser's MCP endpoint; browser tools are off");
  }
  hub.disk.start();
  if (opts.timers !== false) {
    hub.firewallWatch?.start();
  }
  if (opts.timers !== false) hub.priceCheck.start();
  if (opts.timers !== false) hub.agentVersions.start();
  hub.log.info(
    {
      usersRoot: hub.config.paths.usersRoot,
      dataDir: hub.config.paths.dataDir,
      claude: hub.config.agents.runAs ? `as ${hub.config.agents.runAs} via ${hub.config.agents.exec}` : (hub.claudeExecutable ?? "(bundled with the Agent SDK)"),
      config: hub.config.source ?? "(defaults)",
      apiKeyFile: hub.config.auth.anthropicApiKeyFile,
    },
    "workstation-hub started",
  );
}

export async function stopHub(hub: Hub): Promise<void> {
  hub.apiKeys.stop();
  hub.summaries.stop();
  hub.priceCheck.stop();
  hub.agentVersions.stop();
  hub.firewallWatch?.stop();
  hub.search.stop();
  hub.disk.stop();
  hub.ws.closeAll();
  await hub.sessions.shutdown();
  await hub.apiProxy.stop();
  // Stops every browser gracefully (cookies flushed; profiles stay) and closes the MCP endpoint.
  await hub.browsers.close().catch((err) => hub.log.warn({ err: errorMessage(err) }, "browser shutdown failed"));
  hub.projects.close();
  hub.terminals.shutdown();
  await hub.watchers.closeAll();
  hub.store.close();
}
