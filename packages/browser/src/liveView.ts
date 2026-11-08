/**
 * The CDP screencast of the active tab. It runs only while there is demand (at least one viewer) and a tab session;
 * `setSession` follows the active tab, `setDemand` follows the viewers' largest `maxWidth`. Frames go through the
 * FrameGate (rate limit + acks + final-state capture) to `onFrame`.
 */
import type { CdpClient } from "./cdp.js";
import { FrameGate, type GateFrame, type Timers } from "./frameGate.js";

export interface LiveViewOptions {
  cdp: CdpClient;
  quality: number;
  maxFps: number;
  settleMs: number;
  /** Current CSS viewport (for maxHeight and capture dimensions). */
  viewport(): { width: number; height: number };
  onFrame(frame: GateFrame): void;
  /** The page's CSS size as reported by frames changed (agent resized the viewport). */
  onViewport?(width: number, height: number): void;
  timers?: Timers;
  log?(msg: string, err?: unknown): void;
}

interface Running {
  sessionId: string;
  maxWidth: number;
  gate: FrameGate;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number };
}

export class LiveView {
  private session: string | null = null;
  private demand: number | null = null;
  private running: Running | null = null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly unsub: () => void;
  private lastCss: { width: number; height: number } | null = null;

  constructor(private readonly o: LiveViewOptions) {
    this.unsub = o.cdp.on("Page.screencastFrame", (p: ScreencastFrameEvent, sid?: string) => this.onFrame(p, sid));
  }

  /** The active tab's flattened session (null = no tab). */
  setSession(sessionId: string | null): Promise<void> {
    this.session = sessionId;
    return this.reconcile();
  }

  /** Largest requested frame width, or null when nobody watches. */
  setDemand(maxWidth: number | null): Promise<void> {
    this.demand = maxWidth;
    return this.reconcile();
  }

  get active(): boolean {
    return this.running !== null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsub();
    this.running?.gate.stop();
    this.running = null;
  }

  private reconcile(): Promise<void> {
    this.chain = this.chain.then(() => this.apply()).catch((e) => this.o.log?.("screencast update failed", e));
    return this.chain;
  }

  private widthFor(demand: number): number {
    const vp = this.o.viewport();
    return Math.max(160, Math.min(Math.round(demand), vp.width));
  }

  private async apply(): Promise<void> {
    if (this.disposed) return;
    const want = this.session && this.demand !== null ? { sessionId: this.session, maxWidth: this.widthFor(this.demand) } : null;
    const cur = this.running;
    if (cur && want && cur.sessionId === want.sessionId && cur.maxWidth === want.maxWidth) return;
    if (cur) {
      this.running = null;
      cur.gate.stop();
      await this.o.cdp.send("Page.stopScreencast", {}, cur.sessionId).catch(() => undefined);
    }
    if (!want) return;
    const vp = this.o.viewport();
    const gate = new FrameGate({
      maxFps: this.o.maxFps,
      settleMs: this.o.settleMs,
      timers: this.o.timers,
      ack: (id) => void this.o.cdp.send("Page.screencastFrameAck", { sessionId: id }, want.sessionId).catch(() => undefined),
      deliver: (f) => this.o.onFrame(f),
      capture: () => this.capture(want.sessionId),
    });
    this.running = { ...want, gate };
    await this.o.cdp.send("Page.startScreencast", { format: "jpeg", quality: this.o.quality, maxWidth: want.maxWidth, maxHeight: Math.round((want.maxWidth * vp.height) / vp.width), everyNthFrame: 1 }, want.sessionId);
    gate.started();
  }

  private onFrame(p: ScreencastFrameEvent, sid: string | undefined): void {
    const r = this.running;
    if (!r || sid !== r.sessionId) {
      // a frame from a tab we no longer show: release it so that tab's screencast does not stall
      if (sid) void this.o.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => undefined);
      return;
    }
    const width = Math.round(p.metadata.deviceWidth);
    const height = Math.round(p.metadata.deviceHeight);
    if (width > 0 && height > 0 && (!this.lastCss || this.lastCss.width !== width || this.lastCss.height !== height)) {
      this.lastCss = { width, height };
      this.o.onViewport?.(width, height);
    }
    r.gate.push(p.sessionId, { data: p.data, width, height, at: p.metadata.timestamp ? Math.round(p.metadata.timestamp * 1000) : Date.now() });
  }

  private async capture(sessionId: string): Promise<GateFrame | null> {
    if (this.running?.sessionId !== sessionId) return null;
    const { data } = await this.o.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: this.o.quality, optimizeForSpeed: true }, sessionId);
    const css = this.lastCss ?? this.o.viewport();
    return { data, width: css.width, height: css.height, at: Date.now() };
  }
}
