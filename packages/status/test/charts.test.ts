import { describe, expect, it } from "vitest";
import { buildSpecs } from "../ui/src/chartSpecs.js";
import type { SystemInfo } from "../ui/src/types.js";

describe("chart specs", () => {
  const names = new Set(["mem_used_bytes", "mem_available_bytes", "zram_used_bytes"]);

  it("memory chart shows Used and zram only, not Available", () => {
    const mem = buildSpecs(names, null).find((s) => s.id === "memory")!;
    expect(mem.series.map((s) => s.label)).toEqual(["Used", "zram (compressed)"]);
    expect(mem.series.map((s) => s.name)).not.toContain("mem_available_bytes");
  });

  it("memory y-axis is fixed to total memory when known", () => {
    const total = 8 * 1024 ** 3;
    const sys = { memTotalBytes: total, interfaces: [], disks: [], thresholds: {} } as unknown as SystemInfo;
    const mem = buildSpecs(names, sys).find((s) => s.id === "memory")!;
    expect(mem.yRange?.(0, 1)).toEqual([0, total]);
  });
});
