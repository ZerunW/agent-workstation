import { describe, expect, it } from "vitest";
import { FrameGate, type GateFrame } from "../src/frameGate.js";
import { FakeClock, flush } from "./fakes.js";

function setup(opts: { maxFps?: number; settleMs?: number; capture?: () => Promise<GateFrame | null> } = {}) {
  const clock = new FakeClock();
  const acks: number[] = [];
  const delivered: GateFrame[] = [];
  let captures = 0;
  const gate = new FrameGate({
    maxFps: opts.maxFps ?? 10,
    settleMs: opts.settleMs ?? 250,
    ack: (id) => acks.push(id),
    deliver: (f) => delivered.push(f),
    capture:
      opts.capture ??
      (async () => {
        captures++;
        return { data: "SHOT", width: 1280, height: 800, at: clock.now() };
      }),
    timers: clock,
  });
  const frame = (n: number): GateFrame => ({ data: `F${n}`, width: 1280, height: 800, at: n });
  return { clock, gate, acks, delivered, frame, captures: () => captures };
}

describe("FrameGate", () => {
  it("delivers an isolated frame at once and acks it; no extra capture", async () => {
    const { clock, gate, acks, delivered, frame, captures } = setup();
    gate.push(1, frame(1));
    await clock.advance(0);
    expect(delivered.map((f) => f.data)).toEqual(["F1"]);
    expect(acks).toEqual([1]);
    await clock.advance(1000);
    expect(captures()).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it("caps delivery at maxFps, always delivering the newest frame, one ack per tick", async () => {
    const { clock, gate, acks, delivered, frame } = setup({ maxFps: 10 }); // 100 ms
    gate.push(1, frame(1));
    await clock.advance(0); // F1 delivered, acked
    gate.push(2, frame(2));
    gate.push(3, frame(3));
    gate.push(4, frame(4)); // Chromium's in-flight limit reached
    await clock.advance(50);
    expect(delivered.map((f) => f.data)).toEqual(["F1"]);
    expect(acks).toEqual([1]);
    await clock.advance(50); // tick at +100 ms
    expect(delivered.map((f) => f.data)).toEqual(["F1", "F4"]);
    expect(acks).toEqual([1, 2]); // only the oldest released → Chromium captures one fresh frame
    expect(gate.heldCount).toBe(2);
  });

  it("captures the final state once a throttled burst goes quiet, then releases every ack", async () => {
    const { clock, gate, acks, delivered, frame, captures } = setup({ maxFps: 10, settleMs: 250 });
    for (let i = 1; i <= 4; i++) gate.push(i, frame(i));
    await clock.advance(0);
    await clock.advance(100);
    expect(captures()).toBe(0);
    await clock.advance(300);
    expect(captures()).toBe(1);
    expect(delivered[delivered.length - 1]!.data).toBe("SHOT");
    expect(acks.sort()).toEqual([1, 2, 3, 4]);
    expect(gate.heldCount).toBe(0);
  });

  it("captures once after start when no frame arrives, but not when one does", async () => {
    const a = setup();
    a.gate.started();
    await a.clock.advance(300);
    expect(a.captures()).toBe(1);
    expect(a.delivered.map((f) => f.data)).toEqual(["SHOT"]);

    const b = setup();
    b.gate.started();
    b.gate.push(1, b.frame(1));
    await b.clock.advance(1000);
    expect(b.captures()).toBe(0);
    expect(b.delivered.map((f) => f.data)).toEqual(["F1"]);
  });

  it("drops a capture that a newer real frame overtook", async () => {
    let release!: (f: GateFrame) => void;
    const s = setup({ capture: () => new Promise((r) => (release = r)) });
    s.gate.started();
    await s.clock.advance(300); // capture in flight
    s.gate.push(9, s.frame(9));
    await s.clock.advance(0);
    release({ data: "STALE", width: 1, height: 1, at: 0 });
    await flush();
    expect(s.delivered.map((f) => f.data)).toEqual(["F9"]);
  });

  it("stop() releases held frames and delivers nothing afterwards", async () => {
    const { clock, gate, acks, delivered, frame } = setup();
    gate.push(1, frame(1));
    gate.push(2, frame(2));
    gate.stop();
    expect(acks.sort()).toEqual([1, 2]);
    gate.push(3, frame(3));
    expect(acks).toContain(3);
    await clock.advance(1000);
    expect(delivered).toHaveLength(0);
  });
});
