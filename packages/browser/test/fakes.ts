/** Test doubles: a scripted CDP browser, a launcher that never spawns anything, and a manual clock. */
import type { CdpClient, CdpHandler } from "../src/cdp.js";
import type { Timers } from "../src/frameGate.js";
import type { PwContext } from "../src/playwright.js";
import type { BrowserLauncher, ExitInfo, LaunchedBrowser, LaunchSpec } from "../src/launcher.js";
import type { TargetInfo } from "../src/targets.js";

export interface Call {
  method: string;
  params: any;
  sessionId?: string;
}

/** A fake Chromium speaking the subset of CDP the package uses. */
export class FakeCdp implements CdpClient {
  readonly calls: Call[] = [];
  readonly targets = new Map<string, TargetInfo>();
  /** sessionId → targetId */
  readonly sessions = new Map<string, string>();
  /** sessions with a running screencast → params */
  readonly screencasts = new Map<string, any>();
  private readonly handlers = new Map<string, Set<CdpHandler>>();
  private readonly closeHandlers: (() => void)[] = [];
  private isClosed = false;
  private seq = 0;
  private frameSeq = 0;
  onBrowserClose: () => void = () => undefined;
  history: { currentIndex: number; entries: { id: number; url: string }[] } = { currentIndex: 0, entries: [{ id: 1, url: "about:blank" }] };

  constructor(initialTabs: Partial<TargetInfo>[] = [{ url: "about:blank", title: "" }]) {
    for (const t of initialTabs) this.addTarget(t, false);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  addTarget(t: Partial<TargetInfo>, announce = true): TargetInfo {
    const info: TargetInfo = { targetId: t.targetId ?? `T${++this.seq}`, type: t.type ?? "page", url: t.url ?? "about:blank", title: t.title ?? "" };
    this.targets.set(info.targetId, info);
    if (announce) this.emit("Target.targetCreated", { targetInfo: { ...info } });
    return info;
  }

  updateTarget(targetId: string, patch: Partial<TargetInfo>, announce = true): void {
    const t = this.targets.get(targetId)!;
    Object.assign(t, patch);
    if (announce) this.emit("Target.targetInfoChanged", { targetInfo: { ...t } });
  }

  destroyTarget(targetId: string): void {
    this.targets.delete(targetId);
    this.emit("Target.targetDestroyed", { targetId });
  }

  sessionFor(targetId: string): string | undefined {
    for (const [s, t] of this.sessions) if (t === targetId) return s;
    return undefined;
  }

  /** Emit a screencast frame on a session (default: the one currently screencasting). */
  frame(sessionId = [...this.screencasts.keys()][0], meta: { deviceWidth?: number; deviceHeight?: number } = {}): number {
    if (!sessionId) throw new Error("no screencast running");
    const id = ++this.frameSeq;
    this.emit("Page.screencastFrame", { data: `JPEG${id}`, sessionId: id, metadata: { deviceWidth: meta.deviceWidth ?? 1280, deviceHeight: meta.deviceHeight ?? 800, timestamp: 1_700_000_000 + id } }, sessionId);
    return id;
  }

  acks(sessionId?: string): number[] {
    return this.calls.filter((c) => c.method === "Page.screencastFrameAck" && (!sessionId || c.sessionId === sessionId)).map((c) => c.params.sessionId);
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  emit(method: string, params: any, sessionId?: string): void {
    for (const h of [...(this.handlers.get(method) ?? [])]) h(params, sessionId);
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.isClosed) throw new Error(`${method}: connection closed`);
    this.calls.push({ method, params, sessionId });
    await Promise.resolve();
    const r = this.respond(method, params, sessionId);
    return r as T;
  }

  private respond(method: string, params: any, sessionId?: string): unknown {
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [...this.targets.values()].map((t) => ({ ...t })) };
      case "Target.getTargetInfo": {
        const t = this.targets.get(params.targetId);
        if (!t) throw new Error("No target with given id found");
        return { targetInfo: { ...t } };
      }
      case "Target.attachToTarget": {
        if (!this.targets.has(params.targetId)) throw new Error("No target with given id found");
        const sid = `S-${params.targetId}-${++this.seq}`;
        this.sessions.set(sid, params.targetId);
        return { sessionId: sid };
      }
      case "Target.detachFromTarget":
        this.sessions.delete(params.sessionId);
        this.screencasts.delete(params.sessionId);
        return {};
      case "Target.createTarget":
        return { targetId: this.addTarget({ url: params.url }).targetId };
      case "Browser.getWindowForTarget":
        return { windowId: 1, bounds: {} };
      case "Page.startScreencast":
        this.screencasts.set(sessionId!, params);
        return {};
      case "Page.stopScreencast":
        this.screencasts.delete(sessionId!);
        return {};
      case "Page.captureScreenshot":
        return { data: "SHOT" };
      case "Page.navigate": {
        const tid = this.sessions.get(sessionId!);
        if (tid) this.updateTarget(tid, { url: params.url });
        return { frameId: "F" };
      }
      case "Page.getNavigationHistory":
        return this.history;
      case "Browser.close":
        queueMicrotask(() => this.onBrowserClose());
        return {};
      default:
        return {};
    }
  }

  on(method: string, handler: CdpHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.drop();
  }

  /** Simulate the socket dropping. */
  drop(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const h of this.closeHandlers.splice(0)) h();
  }
}

/** A launched "browser" whose exit we control. */
export class FakeProcess implements LaunchedBrowser {
  /** Beyond any pid_max, so the profile lock never mistakes it for a live process. */
  pid: number;
  /** Stand-in for the pipe-connected BrowserContext (the fake CDP never touches it). */
  readonly context = {} as PwContext;
  readonly exited: Promise<ExitInfo>;
  killed: NodeJS.Signals[] = [];
  private resolveExit!: (e: ExitInfo) => void;
  constructor(readonly spec: LaunchSpec, n: number) {
    this.pid = 2_000_000_000 + n;
    this.exited = new Promise((r) => (this.resolveExit = r));
  }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.resolveExit({ code, signal });
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed.push(signal);
    this.exit(null, signal);
  }
  stderrTail(): string {
    return "";
  }
}

export interface FakeBrowserWorld {
  launcher: BrowserLauncher;
  connect: (browser: { context: PwContext }) => Promise<FakeCdp>;
  processes: FakeProcess[];
  cdps: FakeCdp[];
  /** Latest CDP for a launch index. */
  cdp(i?: number): FakeCdp;
}

/** Launcher + connector pair: every launch gets a fresh FakeCdp wired to its FakeProcess. */
export function fakeBrowserWorld(tabs?: () => Partial<TargetInfo>[]): FakeBrowserWorld {
  const processes: FakeProcess[] = [];
  const cdps: FakeCdp[] = [];
  const byContext = new Map<PwContext, FakeCdp>();
  const world: FakeBrowserWorld = {
    processes,
    cdps,
    launcher: async (spec) => {
      const proc = new FakeProcess(spec, processes.length + 1);
      processes.push(proc);
      const cdp = new FakeCdp(tabs?.());
      cdp.onBrowserClose = () => {
        cdp.drop();
        proc.exit(0);
      };
      void proc.exited.then(() => cdp.drop());
      cdps.push(cdp);
      byContext.set(proc.context, cdp);
      return proc;
    },
    connect: async (browser) => {
      const cdp = byContext.get(browser.context);
      if (!cdp) throw new Error("unknown browser context");
      return cdp;
    },
    cdp: (i) => cdps[i ?? cdps.length - 1]!,
  };
  return world;
}

/** Manual clock implementing Timers. */
export class FakeClock implements Timers {
  private t = 1_000_000;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Advance time, running due timers in order (and flushing promises between them). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.pending) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.pending.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await flush(4);
    }
    this.t = end;
    await flush();
  }
  get size(): number {
    return this.pending.size;
  }
}

/** Let pending promise chains settle. */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
