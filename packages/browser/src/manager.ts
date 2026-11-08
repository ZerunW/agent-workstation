/**
 * BrowserManager — the hub's entry point. One Chromium per user at most, started on demand (agent tool call, POST
 * /api/browser/start, ensure()), stopped after `idleMinutes` without activity or on stop(); the profile is never
 * deleted. Owns the agents' MCP endpoint and the live view (frames + person input).
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import type { BrowserInput, BrowserState } from "@agent-workstation/protocol";
import { connectCdp, type CdpConnector } from "./cdp.js";
import { effectiveMaxConcurrent, resolveBrowserConfig, type BrowserConfig, type BrowserConfigInput } from "./config.js";
import { BrowserError } from "./errors.js";
import { realTimers, type GateFrame, type Timers } from "./frameGate.js";
import type { MapOptions } from "./input.js";
import { BrowserInstance } from "./instance.js";
import { chromiumArgs, resolveExecutable, spawnChromium, type BrowserLauncher, type ResolvedExecutable } from "./launcher.js";
import { McpGateway, tokenEquals } from "./mcp/gateway.js";
import { BROWSER_TOOL_POLICY, classifyBrowserTool } from "./mcp/policy.js";
import type { PlaywrightBundle } from "./playwright.js";
import { assertProfileFree, clearProfileLock, ensurePrivateDir, writeProfileLock } from "./profileLock.js";

/** One live-view frame; forward as `{ type: "browser_frame", ...frame }`. */
export interface BrowserFrame {
  /** Base64 JPEG. */
  data: string;
  /** CSS viewport size of the page (live-view input coordinates use the same space). */
  width: number;
  height: number;
  /** ISO capture time. */
  at: string;
}

export interface McpEndpoint {
  /** e.g. http://127.0.0.1:41234/mcp/alice — Streamable HTTP. */
  url: string;
  headers: Record<string, string>;
}

/** Whether `user` allowed the browser on `origin` (scheme://host[:port]) for hub session `hubSessionId` (null = none). */
export type SiteAllowed = (user: string, hubSessionId: string | null, origin: string) => boolean;

export interface BrowserManagerEvents {
  /** Any BrowserState field changed (running, url, title, controlledBy, sessionId, viewers, viewport). */
  state: [user: string, state: BrowserState];
  /** The browser of `user` crashed or failed in the background (launch errors are thrown from ensure()). */
  error: [user: string, error: Error];
}

export interface BrowserManagerDeps {
  launcher?: BrowserLauncher;
  connectCdp?: CdpConnector;
  timers?: Timers;
  /** Available memory in bytes (default os.freemem(), MemAvailable on Linux). */
  freeMemory?: () => number;
  totalMemory?: number;
  resolveExecutable?: () => ResolvedExecutable;
  playwright?: () => PlaywrightBundle;
  input?: MapOptions;
  log?: (msg: string, err?: unknown) => void;
}

interface Viewer {
  maxWidth: number | undefined;
  onFrame: (frame: BrowserFrame) => void;
}

interface Slot {
  user: string;
  instance: BrowserInstance | null;
  starting: Promise<BrowserInstance> | null;
  stopping: Promise<void> | null;
  /** stop() in progress or done: the exit is expected. */
  stopRequested: boolean;
  viewers: Map<string, Viewer>;
  lastActivity: number;
  inflight: number;
  controlledBy: "agent" | "user" | null;
  lastControlAt: number;
  sessionId: string | null;
  token: string;
  lastEmitted: string;
  emitQueued: boolean;
}

const USER_RE = /^[a-z0-9_-]{1,32}$/;

export class BrowserManager extends EventEmitter<BrowserManagerEvents> {
  readonly config: BrowserConfig;
  /** Tool classification for the hub's permission layer (see policy.ts). */
  readonly toolPolicy = BROWSER_TOOL_POLICY;
  readonly classifyTool = classifyBrowserTool;
  private readonly slots = new Map<string, Slot>();
  private readonly launcher: BrowserLauncher;
  private readonly connect: CdpConnector;
  private readonly timers: Timers;
  private readonly freeMemory: () => number;
  private readonly gateway: McpGateway;
  private executable: ResolvedExecutable | null = null;
  private sweepTimer: unknown = null;
  private closed = false;
  private siteAllowed: SiteAllowed | null = null;

  constructor(
    config: BrowserConfig | BrowserConfigInput,
    private readonly deps: BrowserManagerDeps = {},
  ) {
    super();
    this.config = resolveBrowserConfig(config);
    this.launcher = deps.launcher ?? spawnChromium;
    this.connect = deps.connectCdp ?? connectCdp;
    this.timers = deps.timers ?? realTimers;
    this.freeMemory = deps.freeMemory ?? freemem;
    this.gateway = new McpGateway(
      {
        checkToken: (user, token) => {
          const slot = this.config.enabled && USER_RE.test(user) ? this.slots.get(user) : undefined;
          return !!slot && tokenEquals(token, slot.token);
        },
        userDir: (user) => this.userDir(user),
        outputDir: (user) => join(this.userDir(user), ".browser", "output"),
        context: async (user) => {
          await this.ensure(user);
          const inst = this.slot(user).instance;
          if (!inst) throw new BrowserError("not_running", "The browser stopped while connecting.");
          return inst.context;
        },
        toolStarted: (user, _tool, sessionId) => this.agentActivity(user, sessionId, +1),
        toolFinished: (user) => this.agentActivity(user, null, -1),
        activateTarget: (user, targetId) => this.slots.get(user)?.instance?.tracker.activate(targetId),
        siteAllowed: (user, hubSessionId, origin) => (this.siteAllowed ? this.siteAllowed(user, hubSessionId, origin) : true),
        capabilities: this.config.mcp.capabilities,
        log: (msg, err) => this.log(msg, err),
      },
      { host: this.config.mcp.host, port: this.config.mcp.port, sessionIdleMs: this.config.mcp.sessionIdleMinutes * 60_000, playwright: deps.playwright },
    );
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Binds the MCP endpoint (loopback) and starts the idle sweeper. No-op when disabled. */
  async start(): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    await this.gateway.listen();
    this.scheduleSweep();
  }

  /** Hub shutdown: stops every browser gracefully (profiles stay) and closes the MCP endpoint. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer !== null) this.timers.clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.all([...this.slots.keys()].map((u) => this.stop(u).catch(() => undefined)));
    await this.gateway.close();
  }

  /**
   * The hub's per-website permission (without asking): after every agent tool call, a page the call opened, navigated
   * or selected must be on an origin this returns true for, or the tool result is withheld. null = no check.
   */
  setSiteCheck(fn: SiteAllowed | null): void {
    this.siteAllowed = fn;
  }

  /** Users whose browser is running. */
  runningUsers(): string[] {
    return [...this.slots.values()].filter((s) => s.instance?.alive).map((s) => s.user);
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  state(user: string): BrowserState {
    this.checkUser(user);
    return this.buildState(this.slot(user));
  }

  /** Starts the user's browser if it is not running (concurrent calls share one launch). */
  async ensure(user: string): Promise<BrowserState> {
    this.checkUser(user);
    if (!this.config.enabled) throw new BrowserError("disabled", "The server browser is disabled.");
    if (this.closed) throw new BrowserError("disabled", "The browser manager is shut down.");
    const slot = this.slot(user);
    slot.lastActivity = this.timers.now();
    if (slot.stopping) await slot.stopping;
    if (slot.instance?.alive) return this.buildState(slot);
    if (!slot.starting) {
      slot.starting = this.launch(slot).finally(() => {
        slot.starting = null;
      });
    }
    await slot.starting;
    return this.buildState(slot);
  }

  /** Stops the user's browser (graceful; the profile with its logins stays on disk). */
  async stop(user: string): Promise<BrowserState> {
    this.checkUser(user);
    const slot = this.slots.get(user);
    if (!slot) return this.state(user);
    if (slot.starting) await slot.starting.catch(() => undefined);
    const inst = slot.instance;
    if (inst && !slot.stopping) {
      slot.stopRequested = true;
      slot.stopping = inst.close().finally(() => {
        slot.stopping = null;
      });
    }
    if (slot.stopping) await slot.stopping;
    return this.buildState(slot);
  }

  /**
   * Live view: registers `viewerId` (e.g. a WebSocket connection id) and streams frames while the browser runs; the
   * screencast only runs while at least one viewer is subscribed. Subscribing again with the same id replaces the
   * previous subscription. Does not start the browser. Returns the unsubscribe function.
   */
  subscribeFrames(user: string, viewerId: string, opts: { maxWidth?: number }, onFrame: (frame: BrowserFrame) => void): () => void {
    this.checkUser(user);
    const slot = this.slot(user);
    const viewer: Viewer = { maxWidth: opts.maxWidth, onFrame };
    slot.viewers.set(viewerId, viewer);
    slot.lastActivity = this.timers.now();
    this.updateDemand(slot);
    this.queueEmit(slot);
    return () => {
      if (slot.viewers.get(viewerId) !== viewer) return;
      slot.viewers.delete(viewerId);
      slot.lastActivity = this.timers.now();
      this.updateDemand(slot);
      this.queueEmit(slot);
    };
  }

  /** Person input from the live view; marks `controlledBy: "user"`. Throws `not_running` when stopped. */
  async input(user: string, input: BrowserInput): Promise<void> {
    this.checkUser(user);
    if (!this.config.enabled) throw new BrowserError("disabled", "The server browser is disabled.");
    const slot = this.slot(user);
    const inst = slot.instance;
    if (!inst?.alive) throw new BrowserError("not_running", "The browser is not running.");
    this.markControl(slot, "user");
    await inst.input(input);
  }

  /**
   * Where agents reach this user's browser tools. `mcpServers.browser = { type: "http", url, headers }`. Pass the hub session id to attribute tool calls.
   */
  mcpEndpoint(user: string, opts: { sessionId?: string } = {}): McpEndpoint {
    this.checkUser(user);
    if (!this.gateway.listening) throw new BrowserError("not_started", "BrowserManager.start() has not been called (or the browser is disabled).");
    const host = this.config.mcp.host === "::1" ? "[::1]" : this.config.mcp.host;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.slot(user).token}` };
    if (opts.sessionId) headers["X-Workstation-Session"] = opts.sessionId;
    return { url: `http://${host}:${this.gateway.port}/mcp/${user}`, headers };
  }

  /** Open MCP sessions (diagnostics). */
  mcpSessionCount(user?: string): number {
    return this.gateway.sessionCount(user);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private log(msg: string, err?: unknown): void {
    this.deps.log?.(msg, err);
  }

  private checkUser(user: string): void {
    if (!USER_RE.test(user)) throw new BrowserError("bad_user", `Invalid user name: ${JSON.stringify(user)}`);
  }

  private userDir(user: string): string {
    return join(this.config.usersRoot, user);
  }

  private slot(user: string): Slot {
    let s = this.slots.get(user);
    if (!s) {
      s = {
        user,
        instance: null,
        starting: null,
        stopping: null,
        stopRequested: false,
        viewers: new Map(),
        lastActivity: this.timers.now(),
        inflight: 0,
        controlledBy: null,
        lastControlAt: 0,
        sessionId: null,
        token: randomBytes(32).toString("base64url"),
        lastEmitted: "",
        emitQueued: false,
      };
      this.slots.set(user, s);
    }
    return s;
  }

  private buildState(slot: Slot): BrowserState {
    const inst = slot.instance?.alive ? slot.instance : null;
    const page = inst?.page ?? null;
    return {
      running: !!inst,
      url: page?.url ?? null,
      title: page ? page.title || null : null,
      controlledBy: inst ? slot.controlledBy : null,
      sessionId: inst ? slot.sessionId : null,
      viewers: slot.viewers.size,
      viewport: inst ? { ...inst.viewport } : { ...this.config.viewport },
    };
  }

  /** Coalesces changes within one tick into a single `state` event, and only emits real changes. */
  private queueEmit(slot: Slot): void {
    if (slot.emitQueued) return;
    slot.emitQueued = true;
    queueMicrotask(() => {
      slot.emitQueued = false;
      const state = this.buildState(slot);
      const json = JSON.stringify(state);
      if (json === slot.lastEmitted) return;
      slot.lastEmitted = json;
      this.emit("state", slot.user, state);
    });
  }

  private demandOf(slot: Slot): number | null {
    if (slot.viewers.size === 0) return null;
    let w = 0;
    for (const v of slot.viewers.values()) w = Math.max(w, v.maxWidth ?? this.config.viewport.width);
    return w;
  }

  private updateDemand(slot: Slot): void {
    const inst = slot.instance;
    if (inst?.alive) void inst.setDemand(this.demandOf(slot));
  }

  private broadcast(slot: Slot, f: GateFrame): void {
    const frame: BrowserFrame = { data: f.data, width: f.width, height: f.height, at: new Date(f.at).toISOString() };
    for (const v of slot.viewers.values()) {
      try {
        v.onFrame(frame);
      } catch (e) {
        this.log("frame callback failed", e);
      }
    }
  }

  private markControl(slot: Slot, who: "agent" | "user", sessionId?: string | null): void {
    const now = this.timers.now();
    slot.lastActivity = now;
    slot.lastControlAt = now;
    slot.controlledBy = who;
    if (who === "agent" && sessionId) slot.sessionId = sessionId;
    this.queueEmit(slot);
  }

  private agentActivity(user: string, sessionId: string | null, delta: 1 | -1): void {
    const slot = this.slots.get(user);
    if (!slot) return;
    slot.inflight = Math.max(0, slot.inflight + delta);
    if (delta > 0) this.markControl(slot, "agent", sessionId);
    else {
      slot.lastActivity = this.timers.now();
      slot.instance?.refreshSoon();
    }
  }

  private async launch(slot: Slot): Promise<BrowserInstance> {
    const user = slot.user;
    const dir = this.userDir(user);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new BrowserError("no_user_dir", `No workspace folder for ${user}.`);
    const others = [...this.slots.values()].filter((s) => s !== slot && (s.instance?.alive || s.starting)).length;
    const max = effectiveMaxConcurrent(this.config, this.deps.totalMemory);
    if (others >= max) throw new BrowserError("too_many", `${others} browser(s) already running (limit ${max}). Stop one or try again later.`);
    const freeMb = Math.round(this.freeMemory() / 1024 / 1024);
    if (freeMb < this.config.minFreeMemoryMB) throw new BrowserError("low_memory", `Only ${freeMb} MB of memory available (need ${this.config.minFreeMemoryMB} MB).`);
    this.executable ??= (this.deps.resolveExecutable ?? (() => resolveExecutable({ executablePath: this.config.executablePath, flavor: this.config.flavor })))();
    const browserDir = join(dir, ".browser");
    const profileDir = join(browserDir, "profile");
    for (const d of [browserDir, profileDir, join(browserDir, "output")]) ensurePrivateDir(d);
    assertProfileFree(browserDir, profileDir);
    const launched = await this.launcher({
      executablePath: this.executable.path,
      args: chromiumArgs({ viewport: this.config.viewport, extraArgs: this.config.extraArgs }),
      profileDir,
      viewport: this.config.viewport,
      wrapper: this.config.wrapper,
    });
    writeProfileLock(browserDir, launched.pid, profileDir);
    void launched.exited.then(() => clearProfileLock(browserDir, launched.pid));
    let instance: BrowserInstance | null = null;
    try {
      const cdp = await this.connect(launched);
      instance = new BrowserInstance({
        user,
        launched,
        cdp,
        viewport: this.config.viewport,
        screencast: this.config.screencast,
        onFrame: (f) => this.broadcast(slot, f),
        input: this.deps.input,
        timers: this.timers,
        log: (msg, err) => this.log(`[${user}] ${msg}`, err),
      });
      const inst = instance;
      inst.on("change", () => {
        if (slot.instance === inst) this.queueEmit(slot);
      });
      inst.on("exit", (reason) => this.onExit(slot, inst, reason));
      await inst.init();
      if (!inst.alive) throw new BrowserError("launch_failed", `Chromium went away during startup. ${launched.stderrTail().slice(-400)}`);
      slot.instance = inst;
      slot.stopRequested = false;
      slot.controlledBy = null;
      slot.sessionId = null;
      slot.lastActivity = this.timers.now();
      await inst.setDemand(this.demandOf(slot));
      this.queueEmit(slot);
      return inst;
    } catch (e) {
      if (instance) await instance.close(1000).catch(() => undefined);
      else launched.kill("SIGKILL");
      throw e instanceof BrowserError ? e : new BrowserError("launch_failed", `Could not attach to Chromium: ${(e as Error).message}`);
    }
  }

  private onExit(slot: Slot, inst: BrowserInstance, reason: string): void {
    if (slot.instance !== inst) return;
    slot.instance = null;
    slot.controlledBy = null;
    slot.inflight = 0;
    if (!slot.stopRequested) this.emit("error", slot.user, new Error(`Browser for ${slot.user} stopped unexpectedly: ${reason}`));
    slot.stopRequested = false;
    this.queueEmit(slot);
  }

  private scheduleSweep(): void {
    if (this.closed) return;
    const idleMs = this.config.idleMinutes * 60_000;
    const every = Math.min(30_000, this.config.controlIdleSeconds * 500, idleMs > 0 ? Math.max(1000, idleMs / 4) : 30_000);
    this.sweepTimer = this.timers.setTimeout(() => {
      this.sweep();
      this.scheduleSweep();
    }, every);
  }

  /** Idle stop + controlledBy expiry. Public for tests / the hub's own scheduler. */
  sweep(): void {
    const now = this.timers.now();
    const idleMs = this.config.idleMinutes * 60_000;
    for (const slot of this.slots.values()) {
      if (!slot.instance?.alive) continue;
      if (slot.controlledBy && slot.inflight === 0 && now - slot.lastControlAt >= this.config.controlIdleSeconds * 1000) {
        slot.controlledBy = null;
        this.queueEmit(slot);
      }
      if (idleMs > 0 && slot.viewers.size === 0 && slot.inflight === 0 && !slot.stopping && now - slot.lastActivity >= idleMs) {
        this.log(`[${slot.user}] idle for ${this.config.idleMinutes} min, stopping the browser`);
        void this.stop(slot.user).catch((e) => this.log(`[${slot.user}] idle stop failed`, e));
      }
    }
  }
}
