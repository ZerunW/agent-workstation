import { describe, expect, it } from "vitest";
import pino from "pino";
import type { Collector, Sample } from "../src/collect/collector.js";
import { HealthMonitor } from "../src/health/monitor.js";
import { BandwidthProbe } from "../src/probe.js";
import { StatusService } from "../src/service.js";
import { SseHub } from "../src/sse.js";
import { Store } from "../src/store.js";
import { makeCtx, testConfig } from "./helpers.js";

function rig(collector: Collector) {
  const store = new Store(":memory:");
  const sse = new SseHub();
  const sent: Array<{ event: string; data: unknown }> = [];
  const origBroadcast = sse.broadcast.bind(sse);
  sse.broadcast = (event, data) => {
    sent.push({ event, data });
    origBroadcast(event, data);
  };
  const config = testConfig({ status: { speed_probe_interval_min: 0 } });
  const monitor = new HealthMonitor({
    checks: [{ id: "x", label: "X", run: async () => ({ state: "ok", detail: "fine", metrics: { latency_ping_ms: 9.5 } }) }],
    ctx: makeCtx({ config }),
    store,
    defaultIntervalS: 60,
  });
  const probe = new BandwidthProbe({ store });
  const service = new StatusService({ config, store, collector, monitor, probe, sse, log: pino({ level: "silent" }) });
  return { store, service, sent, monitor };
}

describe("StatusService", () => {
  it("stores each sample at the aligned second and pushes it to SSE", async () => {
    const sample: Sample = { cpu_total_pct: 12.345, net_tailscale0_rx_bps: null };
    const { store, service, sent } = rig({ collect: async () => sample });
    await service.sampleTick(1_800_000_010);
    const rows = store.db.prepare("SELECT t, name, v FROM samples_raw ORDER BY name").all();
    expect(rows).toEqual([
      { t: 1_800_000_010, name: "cpu_total_pct", v: 12.35 },
      { t: 1_800_000_010, name: "net_tailscale0_rx_bps", v: null },
    ]);
    expect(sent).toEqual([{ event: "metrics", data: { t: 1_800_000_010, values: { cpu_total_pct: 12.35, net_tailscale0_rx_bps: null } } }]);
  });

  it("survives a collector that throws", async () => {
    const { store, service, sent } = rig({
      collect: async () => {
        throw new Error("proc vanished");
      },
    });
    await expect(service.sampleTick(1_800_000_010)).resolves.toBeUndefined();
    expect((store.db.prepare("SELECT COUNT(*) AS c FROM samples_raw").get() as { c: number }).c).toBe(0);
    expect(sent).toEqual([]);
  });

  it("does not overlap two sampling ticks", async () => {
    let running = 0;
    let maxRunning = 0;
    const { service } = rig({
      collect: async () => {
        maxRunning = Math.max(maxRunning, ++running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { a: 1 };
      },
    });
    await Promise.all([service.sampleTick(10), service.sampleTick(20)]);
    expect(maxRunning).toBe(1);
  });

  it("a health tick stores check metrics, broadcasts the snapshot and reports transitions", async () => {
    const { store, service, sent } = rig({ collect: async () => ({}) });
    await service.healthTick(true);
    expect(sent.map((s) => s.event)).toEqual(["health"]);
    const row = store.db.prepare("SELECT name, v FROM samples_raw WHERE name = 'latency_ping_ms'").get();
    expect(row).toEqual({ name: "latency_ping_ms", v: 9.5 });
  });
});
