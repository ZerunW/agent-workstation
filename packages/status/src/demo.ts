/**
 * Demo mode (`WORKSTATION_STATUS_DEMO=1`, `npm run demo -w packages/status`): synthetic metrics, health
 * checks and speed-test results so the UI can be developed and reviewed on a machine that is not
 * the server. Never enabled by the service unit.
 */
import type { Collector, Sample } from "./collect/collector.js";
import type { CheckDef, CheckOutcome } from "./health/types.js";
import type { Store } from "./store.js";

const CORES = 4;

/** Cheap deterministic noise in [0, 1). */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function demoSample(tS: number, bootS: number): Sample {
  const wave = (period: number, phase = 0) => Math.sin((tS + phase) / period);
  const s: Sample = {};
  let total = 0;
  for (let i = 0; i < CORES; i++) {
    const v = Math.max(1, Math.min(100, 18 + 14 * wave(280, i * 40) + 9 * wave(43, i * 7) + noise(tS + i) * 8));
    s[`cpu_core${i}_pct`] = v;
    total += v;
  }
  s.cpu_total_pct = total / CORES;
  s.load_1 = 0.6 + 0.5 * (1 + wave(310)) + noise(tS) * 0.2;
  s.load_5 = 0.7 + 0.3 * (1 + wave(900));
  s.load_15 = 0.8 + 0.2 * (1 + wave(2400));
  const memTotal = 16 * 1024 ** 3;
  const used = (2.1 + 0.5 * wave(1700) + noise(tS / 30) * 0.05) * 1024 ** 3;
  s.mem_used_bytes = used;
  s.mem_available_bytes = memTotal - used;
  s.mem_used_pct = (used / memTotal) * 100;
  s.zram_used_bytes = (180 + 40 * wave(2500)) * 1024 ** 2;
  s.zram_orig_bytes = (520 + 90 * wave(2500)) * 1024 ** 2;
  const disk = 256 * 1024 ** 3;
  s.disk_root_used_pct = 41 + (tS - bootS) / 86400 / 40;
  s.disk_root_used_bytes = (s.disk_root_used_pct / 100) * disk;
  s.disk_users_used_pct = s.disk_root_used_pct;
  s.disk_users_used_bytes = s.disk_root_used_bytes;
  const burst = noise(Math.floor(tS / 60)) > 0.8 ? 60 : 1;
  s.disk_io_read_bps = (0.4 + noise(tS)) * 1024 ** 2 * burst;
  s.disk_io_write_bps = (0.8 + noise(tS + 1)) * 1024 ** 2 * burst;
  s.disk_io_util_pct = Math.min(100, 2 + noise(tS + 2) * 6 * burst);
  const netBurst = noise(Math.floor(tS / 90)) > 0.75 ? 40 : 1;
  s["net_tailscale0_rx_bps"] = (30 + 80 * noise(tS + 3)) * 1024 * netBurst;
  s["net_tailscale0_tx_bps"] = (12 + 30 * noise(tS + 4)) * 1024 * netBurst;
  s.temp_c = 47 + 8 * wave(900) + 5 * wave(77) + noise(tS) * 1.5;
  s.uptime_s = tS - bootS;
  return s;
}

export function createDemoCollector(nowS: () => number = () => Math.floor(Date.now() / 1000)): Collector {
  const bootS = nowS() - 3 * 86400 - 4 * 3600;
  return { collect: async () => demoSample(nowS(), bootS) };
}

/** Write `hours` of history (10 s raw samples, minute latencies, hourly speed tests) and roll it up. */
export function backfillDemo(store: Store, nowS: number, hours = 36): void {
  const bootS = nowS - 3 * 86400 - 4 * 3600;
  const start = Math.floor(nowS / 10) * 10 - hours * 3600;
  store.db.transaction(() => {
    for (let t = start; t <= nowS; t += 10) {
      store.insertSamples(t, demoSample(t, bootS));
      if (t % 60 === 0) store.insertSamples(t, { latency_ping_ms: 11 + noise(t) * 4, latency_https_ms: 120 + noise(t + 5) * 60, claude_procs: Math.floor(noise(Math.floor(t / 600)) * 4) });
      if (t % 3600 === 0) {
        store.insertMetric(t, "probe_down_mbps", 240 + noise(t) * 80);
        store.insertMetric(t, "probe_up_mbps", 38 + noise(t + 1) * 12);
      }
    }
  })();
  store.rollup(nowS);
}

export function demoChecks(): CheckDef[] {
  let tick = 0;
  const ok = (detail: string, latencyMs: number | null = null): CheckOutcome => ({ state: "ok", detail, latencyMs });
  const def = (id: string, label: string, run: () => CheckOutcome): CheckDef => ({ id, label, run: async () => run() });
  return [
    def("unit-workstation-hub", "workstation-hub service", () => ok("active")),
    def("hub", "workstation-hub API (/healthz)", () => ok("HTTP 200, v0.1.0", 6)),
    def("unit-workstation-status", "workstation-status service", () => ok("active")),
    def("unit-ssh", "SSH server", () => ok("active")),
    def("https-proxy", "HTTPS proxy (nginx)", () => ok("nginx active")),
    def("unit-tailscaled", "tailscaled service", () => ({ state: "unknown", detail: "not installed" })),
    def("tailscale", "Tailscale connection", () => ({ state: "unknown", detail: "not installed" })),
    def("dns", "DNS name resolves to tailscale IP", () => ({ state: "unknown", detail: "tailscale not installed or down (no tailscale0)" })),
    def("internet-ping", "Internet (ICMP 1.1.1.1)", () => ok("12.4 ms", 12)),
    def("internet-https", "Internet (HTTPS api.anthropic.com)", () => {
      tick++;
      return Math.floor(tick / 3) % 2 === 1 ? { state: "warn", detail: "HTTP 200", latencyMs: 3400 } : ok("HTTP 200", 180);
    }),
    def("api-credits", "API credits", () => ok("$12.00 of $100.00 used (12%)")),
    def("claude-procs", "Active Claude processes", () => ok("Claude 2")),
    def("nvme-smart", "NVMe SMART health", () => ok("SMART overall health: PASSED")),
    def("inotify", "inotify watches", () => ok("12,340 of 524,288 used (2.4%), 511,948 free")),
  ];
}

/** A fetch that imitates speed.cloudflare.com: ~1 s download of 20 MB, ~0.7 s upload. */
export const demoFetch: typeof fetch = async (input) => {
  const url = String(input);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (url.includes("__down")) {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= 20) return controller.close();
        await sleep(60);
        sent++;
        controller.enqueue(new Uint8Array(1_000_000));
      },
    });
    return new Response(stream, { status: 200 });
  }
  await sleep(700);
  return new Response("ok", { status: 200 });
};
