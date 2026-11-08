/**
 * Flow control for `Page.startScreencast`. Measured behaviour that shapes it (Chromium 156/157):
 *   - `everyNthFrame > 1` drops the final state of a change on a static page (a single DOM change yields one
 *     compositor frame, which is skipped every other time) — so it stays 1;
 *   - Chromium keeps up to 3 unacknowledged frames in flight and captures nothing while the limit is reached; acking
 *     late therefore throttles production (60 → 15 fps cut Chromium's CPU on an animated page from ~200 % to ~130 %
 *     of one core on a small arm64 server), but a change that happens while the limit is reached is never sent.
 * So: deliver at most `maxFps` (always the newest frame), release one ack per tick so Chromium captures one fresh
 * frame per tick, and once a throttled burst goes quiet take one screenshot so the last state is always shown.
 */

export interface GateFrame {
  /** Base64 JPEG. */
  data: string;
  /** CSS viewport size of the page the frame shows. */
  width: number;
  height: number;
  /** Capture time, ms since epoch. */
  at: number;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface FrameGateOptions {
  maxFps: number;
  settleMs: number;
  ack(screencastSessionId: number): void;
  deliver(frame: GateFrame): void;
  /** One-off capture of the current state (Page.captureScreenshot); null if it failed. */
  capture(): Promise<GateFrame | null>;
  timers?: Timers;
}

export class FrameGate {
  private readonly interval: number;
  private readonly t: Timers;
  private held: number[] = [];
  private latest: GateFrame | null = null;
  private dirty = false;
  private lastDeliverAt = -Infinity;
  private tickTimer: unknown = null;
  private settleTimer: unknown = null;
  /** Frames were held back since the last settle: Chromium may have skipped a capture. */
  private throttled = false;
  /** started() was called and no frame has arrived yet. */
  private awaitingFirst = false;
  private stopped = false;
  private captureSeq = 0;

  constructor(private readonly o: FrameGateOptions) {
    this.interval = 1000 / Math.max(1, o.maxFps);
    this.t = o.timers ?? realTimers;
  }

  /** Called right after Page.startScreencast: if no frame shows up, capture once. */
  started(): void {
    this.awaitingFirst = true;
    this.throttled = true;
    this.armSettle();
  }

  /** A `Page.screencastFrame` arrived. */
  push(screencastSessionId: number, frame: GateFrame): void {
    if (this.stopped) {
      this.o.ack(screencastSessionId);
      return;
    }
    if (this.awaitingFirst) {
      this.awaitingFirst = false;
      this.throttled = false;
    }
    this.held.push(screencastSessionId);
    this.latest = frame;
    this.dirty = true;
    this.captureSeq++; // a real frame supersedes a capture in progress
    this.clearSettle();
    if (this.tickTimer === null) this.tickTimer = this.t.setTimeout(() => this.tick(), Math.max(0, this.lastDeliverAt + this.interval - this.t.now()));
  }

  /** Stop delivering; release every held frame (Chromium stops the screencast separately). */
  stop(): void {
    this.stopped = true;
    if (this.tickTimer !== null) this.t.clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.clearSettle();
    for (const id of this.held.splice(0)) this.o.ack(id);
  }

  /** Frames waiting for an ack (for tests/diagnostics). */
  get heldCount(): number {
    return this.held.length;
  }

  private tick(): void {
    this.tickTimer = null;
    if (this.stopped) return;
    if (this.dirty && this.latest) {
      this.dirty = false;
      this.lastDeliverAt = this.t.now();
      this.safeDeliver(this.latest);
    }
    const id = this.held.shift();
    if (id !== undefined) this.o.ack(id);
    if (this.held.length > 0) this.throttled = true;
    this.armSettle();
  }

  private armSettle(): void {
    this.clearSettle();
    this.settleTimer = this.t.setTimeout(() => void this.settle(), this.o.settleMs);
  }

  private clearSettle(): void {
    if (this.settleTimer !== null) this.t.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private async settle(): Promise<void> {
    this.settleTimer = null;
    if (this.stopped) return;
    const wasThrottled = this.throttled;
    this.throttled = false;
    // release everything: with nothing in flight the next change is captured immediately
    for (const id of this.held.splice(0)) this.o.ack(id);
    if (!wasThrottled) return;
    const seq = ++this.captureSeq;
    let frame: GateFrame | null = null;
    try {
      frame = await this.o.capture();
    } catch {
      frame = null;
    }
    if (!frame || this.stopped || seq !== this.captureSeq) return;
    this.latest = frame;
    this.lastDeliverAt = this.t.now();
    this.safeDeliver(frame);
  }

  private safeDeliver(frame: GateFrame): void {
    try {
      this.o.deliver(frame);
    } catch {
      // a viewer callback must not break the pipeline
    }
  }
}
