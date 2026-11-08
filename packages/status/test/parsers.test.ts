import { describe, expect, it } from "vitest";
import {
  cpuUsagePercent,
  diskUsedPercent,
  maxThermalCelsius,
  memorySnapshot,
  naturalCompare,
  parseCpuGroups,
  parseDiskstats,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseUptime,
  parseZramMmStat,
} from "../src/collect/parsers.js";
import { DISKSTATS_A, DISKSTATS_B, LOADAVG, MEMINFO, NET_DEV_A, PROC_STAT_A, PROC_STAT_B, UPTIME, ZRAM_MM_STAT } from "./fixtures.js";

describe("/proc/stat", () => {
  it("parses the aggregate line and every core", () => {
    const s = parseProcStat(PROC_STAT_A);
    expect(s).not.toBeNull();
    expect(s?.total.user).toBe(1000);
    expect(s?.total.idle).toBe(8000);
    expect(s?.cores).toHaveLength(2);
    expect(s?.cores[1]?.idle).toBe(5000);
  });

  it("computes busy percentage between two snapshots", () => {
    const a = parseProcStat(PROC_STAT_A);
    const b = parseProcStat(PROC_STAT_B);
    if (!a || !b) throw new Error("fixture did not parse");
    expect(cpuUsagePercent(a.total, b.total)).toBeCloseTo(28.571, 2);
    expect(cpuUsagePercent(a.cores[0]!, b.cores[0]!)).toBeCloseTo(60, 5);
    expect(cpuUsagePercent(a.cores[1]!, b.cores[1]!)).toBeCloseTo(11.111, 2);
  });

  it("returns null when no time elapsed or counters went backwards", () => {
    const a = parseProcStat(PROC_STAT_A)!;
    const b = parseProcStat(PROC_STAT_B)!;
    expect(cpuUsagePercent(a.total, a.total)).toBeNull();
    expect(cpuUsagePercent(b.total, a.total)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("cpu  a b c d")).toBeNull();
  });
});

describe("/proc/meminfo", () => {
  it("converts kB to bytes and keeps unitless counters", () => {
    const m = parseMeminfo(MEMINFO);
    expect(m.MemTotal).toBe(8123456 * 1024);
    expect(m.MemAvailable).toBe(5123456 * 1024);
    expect(m.HugePages_Total).toBe(0);
    expect(m.Hugepagesize).toBe(2048 * 1024);
  });

  it("derives used memory from MemAvailable", () => {
    const snap = memorySnapshot(parseMeminfo(MEMINFO));
    expect(snap?.usedBytes).toBe((8123456 - 5123456) * 1024);
    expect(snap?.usedPercent).toBeCloseTo((3000000 / 8123456) * 100, 6);
  });

  it("falls back to free+buffers+cached on kernels without MemAvailable", () => {
    const snap = memorySnapshot({ MemTotal: 1000, MemFree: 100, Buffers: 50, Cached: 150 });
    expect(snap?.availableBytes).toBe(300);
    expect(snap?.usedBytes).toBe(700);
  });

  it("returns null without MemTotal", () => {
    expect(memorySnapshot({})).toBeNull();
  });
});

describe("zram mm_stat", () => {
  it("reads original, compressed and total memory used", () => {
    expect(parseZramMmStat(ZRAM_MM_STAT)).toEqual({ origDataSize: 104857600, comprDataSize: 31457280, memUsedTotal: 36700160 });
  });
  it("rejects short or non-numeric input", () => {
    expect(parseZramMmStat("1 2")).toBeNull();
    expect(parseZramMmStat("a b c")).toBeNull();
  });
});

describe("/proc/net/dev", () => {
  it("skips the two header lines and reads rx/tx bytes per interface", () => {
    const n = parseNetDev(NET_DEV_A);
    expect(Object.keys(n).sort()).toEqual(["enp1s0", "lo"]);
    expect(n.enp1s0).toEqual({ rxBytes: 1000000, txBytes: 200000 });
  });

  it("copes with no space after the colon", () => {
    const n = parseNetDev(" eth0:123 1 0 0 0 0 0 0 456 1 0 0 0 0 0 0\n");
    expect(n.eth0).toEqual({ rxBytes: 123, txBytes: 456 });
  });

  it("returns an empty object for empty input", () => {
    expect(parseNetDev("")).toEqual({});
  });
});

describe("/proc/diskstats", () => {
  it("converts sectors to bytes and reads io ticks", () => {
    const d = parseDiskstats(DISKSTATS_A);
    expect(d.nvme0n1).toEqual({ readsCompleted: 1000, readBytes: 80000 * 512, writesCompleted: 500, writeBytes: 40000 * 512, ioMs: 700 });
    expect(d.loop0?.readBytes).toBe(80 * 512);
  });

  it("shows the deltas the collector turns into rates", () => {
    const a = parseDiskstats(DISKSTATS_A).nvme0n1!;
    const b = parseDiskstats(DISKSTATS_B).nvme0n1!;
    expect(b.readBytes - a.readBytes).toBe(10 * 1024 * 1024);
    expect(b.writeBytes - a.writeBytes).toBe(20 * 1024 * 1024);
    expect(b.ioMs - a.ioMs).toBe(2000);
  });
});

describe("parseCpuGroups (/proc/cpuinfo of heterogeneous cores)", () => {
  const core = (i: number, part?: string) => `processor\t: ${i}\nBogoMIPS\t: 48.00\nCPU implementer\t: 0x41\n${part ? `CPU part\t: ${part}\n` : ""}CPU revision\t: 0\n`;
  const info = (parts: Array<string | undefined>) => parts.map((p, i) => core(i, p)).join("\n");

  it("groups mixed A53 and A72 cores, higher part numbers first", () => {
    const text = info(["0xd03", "0xd03", "0xd03", "0xd03", "0xd08", "0xd08", "0xd08", "0xd08"]);
    expect(parseCpuGroups(text)).toBe("4× Cortex-A72 + 4× Cortex-A53");
  });
  it("one group for identical cores", () => {
    expect(parseCpuGroups(info(["0xd08", "0xd08"]))).toBe("2× Cortex-A72");
  });
  it("other parts show their number, a core without a part is unknown", () => {
    expect(parseCpuGroups(info(["0xd99", "0xd03", undefined]))).toBe("1× part 0xd99 + 1× Cortex-A53 + 1× unknown");
  });
  it("null without any part (x86, macOS, empty)", () => {
    expect(parseCpuGroups("processor\t: 0\nmodel name\t: Intel(R) Core(TM)\n")).toBeNull();
    expect(parseCpuGroups("")).toBeNull();
  });
});

describe("small parsers", () => {
  it("loadavg", () => {
    expect(parseLoadavg(LOADAVG)).toEqual([0.52, 0.41, 0.3]);
    expect(parseLoadavg("x")).toBeNull();
  });
  it("uptime", () => {
    expect(parseUptime(UPTIME)).toBe(93784.25);
    expect(parseUptime("")).toBeNull();
  });
  it("thermal zones: max in degrees, glitches ignored", () => {
    expect(maxThermalCelsius(["45000\n", "51500\n", "38000\n"])).toBe(51.5);
    expect(maxThermalCelsius(["-274000", "999999", "oops"])).toBeNull();
    expect(maxThermalCelsius([])).toBeNull();
  });
  it("disk used percent matches df semantics (reserved blocks excluded)", () => {
    // 1000 blocks, 400 free, 350 available to users: used 600 / (600 + 350)
    expect(diskUsedPercent(1000, 400, 350)).toBeCloseTo(63.158, 2);
    expect(diskUsedPercent(0, 0, 0)).toBeNull();
  });
  it("natural sort", () => {
    expect(["cpu_core10_pct", "cpu_core2_pct", "cpu_core1_pct"].sort(naturalCompare)).toEqual(["cpu_core1_pct", "cpu_core2_pct", "cpu_core10_pct"]);
  });
});
