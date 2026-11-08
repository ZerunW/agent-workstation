import { describe, expect, it } from "vitest";
import { LinuxCollector, rate } from "../src/collect/collector.js";
import { DISKSTATS_A, DISKSTATS_B, LOADAVG, MEMINFO, NET_DEV_A, NET_DEV_B, PROC_STAT_A, PROC_STAT_B, UPTIME, ZRAM_MM_STAT } from "./fixtures.js";
import { fakeReaders } from "./helpers.js";

function setup() {
  const readers = fakeReaders({
    files: {
      "/proc/stat": PROC_STAT_A,
      "/proc/loadavg": LOADAVG,
      "/proc/meminfo": MEMINFO,
      "/proc/net/dev": NET_DEV_A,
      "/proc/diskstats": DISKSTATS_A,
      "/proc/uptime": UPTIME,
      "/sys/block/zram0/mm_stat": ZRAM_MM_STAT,
      "/sys/class/thermal/thermal_zone0/temp": "45000\n",
      "/sys/class/thermal/thermal_zone1/temp": "52500\n",
    },
    dirs: { "/sys/block": ["nvme0n1", "zram0"], "/sys/class/thermal": ["thermal_zone0", "thermal_zone1", "cooling_device0"] },
    statfs: {
      "/": { totalBytes: 1000 * 4096, freeBytes: 400 * 4096, availBytes: 350 * 4096 },
      "/srv/agent-workstation/users": { totalBytes: 1000 * 4096, freeBytes: 400 * 4096, availBytes: 350 * 4096 },
    },
  });
  const collector = new LinuxCollector(readers, { interfaces: ["enp1s0", "tailscale0"], usersRoot: "/srv/agent-workstation/users", blockDevice: "nvme0n1" });
  return { readers, collector };
}

describe("LinuxCollector", () => {
  it("first sample has instantaneous values but no rates", async () => {
    const { collector } = setup();
    const s = await collector.collect();
    expect(s.cpu_total_pct).toBeNull();
    expect(s.cpu_core0_pct).toBeNull();
    expect(s["net_enp1s0_rx_bps"]).toBeNull();
    expect(s.disk_io_read_bps).toBeNull();
    expect(s.load_1).toBe(0.52);
    expect(s.load_15).toBe(0.3);
    expect(s.uptime_s).toBe(93784.25);
    expect(s.temp_c).toBe(52.5); // max of zones, cooling_device ignored
    expect(s.mem_used_bytes).toBe((8123456 - 5123456) * 1024);
    expect(s.mem_available_bytes).toBe(5123456 * 1024);
    expect(s.zram_used_bytes).toBe(36700160);
    expect(s.zram_orig_bytes).toBe(104857600);
    expect(s.disk_root_used_pct).toBeCloseTo(63.158, 2);
    expect(s.disk_users_used_bytes).toBe(600 * 4096);
  });

  it("computes CPU, network and disk IO rates from two snapshots", async () => {
    const { readers, collector } = setup();
    await collector.collect();
    readers.clockMs += 10_000;
    readers.files["/proc/stat"] = PROC_STAT_B;
    readers.files["/proc/net/dev"] = NET_DEV_B;
    readers.files["/proc/diskstats"] = DISKSTATS_B;
    const s = await collector.collect();
    expect(s.cpu_total_pct).toBeCloseTo(28.571, 2);
    expect(s.cpu_core0_pct).toBeCloseTo(60, 5);
    expect(s.cpu_core1_pct).toBeCloseTo(11.111, 2);
    expect(s["net_enp1s0_rx_bps"]).toBe(500_000);
    expect(s["net_enp1s0_tx_bps"]).toBe(100_000);
    expect(s.disk_io_read_bps).toBe(10 * 1024 * 1024 / 10);
    expect(s.disk_io_write_bps).toBe(20 * 1024 * 1024 / 10);
    expect(s.disk_io_util_pct).toBeCloseTo(20, 5); // 2000 ms busy in 10 s
  });

  it("reports a missing interface as null, never as an error", async () => {
    const { readers, collector } = setup();
    await collector.collect();
    readers.clockMs += 10_000;
    readers.files["/proc/net/dev"] = NET_DEV_B;
    const s = await collector.collect();
    expect(s["net_tailscale0_rx_bps"]).toBeNull();
    expect(s["net_tailscale0_tx_bps"]).toBeNull();
    expect("net_tailscale0_rx_bps" in s).toBe(true); // present as an explicit null so the gap is stored
  });

  it("treats a counter reset (interface restarted) as null for that tick", async () => {
    const { readers, collector } = setup();
    await collector.collect();
    readers.clockMs += 10_000;
    readers.files["/proc/net/dev"] = NET_DEV_B;
    await collector.collect();
    readers.clockMs += 10_000;
    readers.files["/proc/net/dev"] = NET_DEV_A; // counters went backwards
    const s = await collector.collect();
    expect(s["net_enp1s0_rx_bps"]).toBeNull();
  });

  it("survives a host with none of the Linux files (macOS dev box)", async () => {
    const collector = new LinuxCollector(fakeReaders(), { interfaces: ["en0"], usersRoot: "/nope", blockDevice: "nvme0n1" });
    await collector.collect();
    const s = await collector.collect();
    expect(s.cpu_total_pct).toBeNull();
    expect(s.mem_used_bytes).toBeNull();
    expect(s.temp_c).toBeNull();
    expect(s.zram_used_bytes).toBeNull();
    expect(s["net_en0_rx_bps"]).toBeNull();
  });

  it("rate() guards against resets and zero time", () => {
    expect(rate(100, 300, 2)).toBe(100);
    expect(rate(300, 100, 2)).toBeNull();
    expect(rate(1, 2, 0)).toBeNull();
  });
});
