/**
 * One running Chromium: its process handle, the manager's own CDP connection, tab tracking, the live view and person
 * input. Created and owned by BrowserManager; never more than one per user.
 */
import { EventEmitter } from "node:events";
import type { BrowserInput } from "@agent-workstation/protocol";
import type { CdpClient } from "./cdp.js";
import { BrowserError } from "./errors.js";
import type { GateFrame, Timers } from "./frameGate.js";
import { isAllowedNavigation, mapInput, newInputState, type InputState, type MapOptions } from "./input.js";
import type { LaunchedBrowser } from "./launcher.js";
import { LiveView } from "./liveView.js";
import type { PwContext } from "./playwright.js";
import { TargetTracker, type TargetInfo } from "./targets.js";

export interface InstanceOptions {
  user: string;
  launched: LaunchedBrowser;
  cdp: CdpClient;
  viewport: { width: number; height: number };
  screencast: { quality: number; maxFps: number; settleMs: number };
  onFrame(frame: GateFrame): void;
  input?: MapOptions;
  timers?: Timers;
  log?(msg: string, err?: unknown): void;
}

export interface InstanceEvents {
  /** url/title/viewport of the active tab changed. */
  change: [];
  /** The browser went away (process exit or CDP connection lost). */
  exit: [reason: string];
}

type QueuedInput = { input: BrowserInput; resolve: () => void; reject: (e: unknown) => void };

export class BrowserInstance extends EventEmitter<InstanceEvents> {
  readonly user: string;
  readonly tracker: TargetTracker;
  readonly liveView: LiveView;
  viewport: { width: number; height: number };
  private readonly cdp: CdpClient;
  private readonly launched: LaunchedBrowser;
  /** Flattened session attached to the active tab. */
  private attached: { targetId: string; sessionId: string } | null = null;
  private attachChain: Promise<void> = Promise.resolve();
  private readonly inputStates = new Map<string, InputState>();
  private queue: QueuedInput[] = [];
  private draining = false;
  private exited = false;
  private closing = false;
  private pollTimer: unknown = null;
  private refreshTimer: unknown = null;

  constructor(private readonly o: InstanceOptions) {
    super();
    this.user = o.user;
    this.cdp = o.cdp;
    this.launched = o.launched;
    this.viewport = { ...o.viewport };
    this.tracker = new TargetTracker(o.cdp);
    this.liveView = new LiveView({
      cdp: o.cdp,
      ...o.screencast,
      viewport: () => this.viewport,
      onFrame: o.onFrame,
      onViewport: (width, height) => {
        if (width === this.viewport.width && height === this.viewport.height) return;
        this.viewport = { width, height };
        this.emit("change");
      },
      timers: o.timers,
      log: o.log,
    });
  }

  /** The pipe-connected BrowserContext (shared with the agents' Playwright MCP). */
  get context(): PwContext {
    return this.launched.context;
  }

  get pid(): number | undefined {
    return this.launched.pid;
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Active tab's url/title (null when there is no tab). */
  get page(): TargetInfo | null {
    return this.tracker.activeInfo();
  }

  async init(): Promise<void> {
    this.cdp.onClose(() => this.markExited("devtools connection closed"));
    void this.launched.exited.then(({ code, signal }) => this.markExited(`chromium exited (code ${code}, signal ${signal})`));
    this.tracker.on("active", (id) => {
      this.reattach(id);
      this.emit("change");
    });
    this.tracker.on("info", () => this.emit("change"));
    this.tracker.on("created", (t) => void this.applyViewport(t.targetId));
    for (const ev of ["Page.loadEventFired", "Page.domContentEventFired", "Page.navigatedWithinDocument"]) {
      this.cdp.on(ev, (_p: unknown, sid?: string) => {
        if (sid && sid === this.attached?.sessionId) this.refreshSoon(0);
      });
    }
    this.cdp.on("Target.detachedFromTarget", (p: { sessionId: string }) => {
      if (this.attached?.sessionId === p.sessionId) {
        this.attached = null;
        void this.liveView.setSession(null);
        this.reattach(this.tracker.active);
      }
    });
    await this.tracker.start();
    await Promise.all(this.tracker.list().map((t) => this.applyViewport(t.targetId)));
    await this.attachChain;
    this.poll();
  }

  /** Titles change without any CDP event: re-read the active tab every 2 s while running. */
  private poll(): void {
    if (this.exited || this.closing) return;
    const timers = this.o.timers;
    const schedule = timers ? (fn: () => void, ms: number) => timers.setTimeout(fn, ms) : (fn: () => void, ms: number) => setTimeout(fn, ms).unref();
    this.pollTimer = schedule(() => {
      void this.tracker.refresh().finally(() => this.poll());
    }, 2000);
  }

  /** Refresh url/title shortly after something happened (input, tool call, page load). */
  refreshSoon(ms = 300): void {
    if (this.exited || this.closing || this.refreshTimer !== null) return;
    const timers = this.o.timers;
    const run = (): void => {
      this.refreshTimer = null;
      void this.tracker.refresh();
    };
    this.refreshTimer = timers ? timers.setTimeout(run, ms) : setTimeout(run, ms).unref();
  }

  private clearTimers(): void {
    const timers = this.o.timers;
    for (const t of [this.pollTimer, this.refreshTimer]) {
      if (t === null) continue;
      if (timers) timers.clearTimeout(t);
      else clearTimeout(t as NodeJS.Timeout);
    }
    this.pollTimer = null;
    this.refreshTimer = null;
  }

  /** Viewer demand (largest maxWidth) or null. */
  setDemand(maxWidth: number | null): Promise<void> {
    return this.liveView.setDemand(maxWidth);
  }

  /** Person input; serialized, consecutive mouse moves coalesced. */
  input(input: BrowserInput): Promise<void> {
    if (this.exited) return Promise.reject(new BrowserError("not_running", "The browser is not running."));
    if (input.kind === "navigate" && !isAllowedNavigation(input.url)) return Promise.reject(new BrowserError("bad_url", "Only http(s) and about:blank can be opened from the live view."));
    return new Promise<void>((resolve, reject) => {
      const last = this.queue[this.queue.length - 1];
      if (input.kind === "mouse" && input.action === "move" && last?.input.kind === "mouse" && last.input.action === "move") {
        const prev = last;
        this.queue[this.queue.length - 1] = { input, resolve: () => (prev.resolve(), resolve()), reject: (e) => (prev.reject(e), reject(e)) };
      } else {
        this.queue.push({ input, resolve, reject });
      }
      void this.drain();
    });
  }

  /** Graceful shutdown: Browser.close (flushes cookies), then SIGTERM, then SIGKILL. The profile stays on disk. */
  async close(timeoutMs = 5000): Promise<void> {
    if (this.closing) {
      await this.waitExit(timeoutMs + 6000);
      return;
    }
    this.closing = true;
    this.clearTimers();
    this.tracker.stop();
    await this.liveView.dispose();
    if (!this.cdp.closed) await Promise.race([this.cdp.send("Browser.close").catch(() => undefined), sleep(timeoutMs)]);
    if (!(await this.waitExit(timeoutMs))) {
      this.launched.kill("SIGTERM");
      if (!(await this.waitExit(3000))) {
        this.launched.kill("SIGKILL");
        await this.waitExit(3000);
      }
    }
    await this.cdp.close().catch(() => undefined);
    this.markExited("stopped");
  }

  /** Waits for the process itself (the CDP socket may drop before the process is gone). */
  private waitExit(ms: number): Promise<boolean> {
    return Promise.race([this.launched.exited.then(() => true), sleep(ms).then(() => false)]);
  }

  private markExited(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    this.clearTimers();
    this.tracker.stop();
    void this.liveView.dispose();
    for (const q of this.queue.splice(0)) q.reject(new BrowserError("not_running", "The browser stopped."));
    if (!this.closing) {
      void this.cdp.close().catch(() => undefined);
      // lost the DevTools connection but the process may live on: do not leave an unmanaged browser on the profile
      this.launched.kill("SIGTERM");
    }
    this.emit("exit", reason);
  }

  private reattach(targetId: string | null): void {
    this.attachChain = this.attachChain
      .then(async () => {
        if (this.exited || this.closing) return;
        const want = this.tracker.active ?? targetId;
        if (this.attached?.targetId === want) return;
        const old = this.attached;
        this.attached = null;
        if (old) await this.cdp.send("Target.detachFromTarget", { sessionId: old.sessionId }).catch(() => undefined);
        if (!want) {
          await this.liveView.setSession(null);
          return;
        }
        const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: want, flatten: true });
        this.attached = { targetId: want, sessionId };
        await this.cdp.send("Page.enable", {}, sessionId).catch(() => undefined);
        await this.liveView.setSession(sessionId);
      })
      .catch((e) => this.o.log?.("attach to tab failed", e));
  }

  private async session(): Promise<{ targetId: string; sessionId: string } | null> {
    await this.attachChain;
    if (!this.attached && this.tracker.active) {
      this.reattach(this.tracker.active);
      await this.attachChain;
    }
    return this.attached;
  }

  private async applyViewport(targetId: string): Promise<void> {
    try {
      const { windowId } = await this.cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId });
      await this.cdp.send("Browser.setContentsSize", { windowId, width: this.o.viewport.width, height: this.o.viewport.height });
    } catch {
      // older Chromium without Browser.setContentsSize: --window-size is close enough
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const q = this.queue.shift()!;
        try {
          await this.apply(q.input);
          if (q.input.kind !== "mouse" || q.input.action !== "move") this.refreshSoon();
          q.resolve();
        } catch (e) {
          q.reject(e);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async apply(input: BrowserInput): Promise<void> {
    if (this.exited) throw new BrowserError("not_running", "The browser is not running.");
    const s = await this.session();
    if (input.kind === "navigate") {
      if (!s) {
        await this.cdp.send("Target.createTarget", { url: input.url });
        return;
      }
      await this.cdp.send("Page.navigate", { url: input.url }, s.sessionId);
      return;
    }
    if (!s) return;
    if (input.kind === "history") {
      if (input.action === "reload") {
        await this.cdp.send("Page.reload", {}, s.sessionId);
        return;
      }
      const h = await this.cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, s.sessionId);
      const entry = h.entries[h.currentIndex + (input.action === "back" ? -1 : 1)];
      if (entry) await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, s.sessionId);
      return;
    }
    let st = this.inputStates.get(s.targetId);
    if (!st) this.inputStates.set(s.targetId, (st = newInputState()));
    for (const cmd of mapInput(input, st, this.o.input)) await this.cdp.send(cmd.method, cmd.params, s.sessionId);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
