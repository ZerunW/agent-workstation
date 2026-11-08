import { describe, expect, it } from "vitest";
import { agentsValue, systemRows } from "../ui/src/systemModel.js";
import type { SystemInfo } from "../ui/src/types.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const info = (versions: Partial<SystemInfo["versions"]> = {}): SystemInfo => ({
  model: "Example Server",
  hostname: "workstation",
  kernel: "Linux 6.1.99",
  arch: "arm64",
  cpu: "4× Cortex-A72",
  cpuCores: 4,
  memTotalBytes: 16 * 1024 ** 3,
  uptimeS: 100,
  bootedAt: "2026-10-30T12:00:00Z",
  serverTime: "2026-10-31T12:00:00Z",
  disks: [{ label: "/", path: "/", totalBytes: 1000, usedBytes: 400, freeBytes: 600, usedPercent: 40 }],
  blockDevice: "nvme0n1",
  node: "v22.0.0",
  versions: { status: "0.1.0", hub: "0.7.1", claude: "2.1.314 (Claude Code)", tailscale: "1.80.0", proxy: "nginx 1.24.0", ...versions },
  interfaces: ["eth0"],
  thresholds: { diskWarnPercent: 80, diskBlockPercent: 95 },
  intervals: { sampleS: 10, healthS: 60, speedProbeMin: 60 },
  links: { hubPublicUrl: null, hubPort: 9000 },
});
const rows = (s: SystemInfo) => Object.fromEntries(systemRows(s, NOW));

describe("System panel rows", () => {
  it("shows the CPU line, the hub and Claude Code versions from the hub, and the HTTPS proxy", () => {
    const r = rows(info());
    expect(r["CPU"]).toBe("4× Cortex-A72");
    expect(r["workstation-hub"]).toBe("0.7.1");
    expect(r["Claude Code"]).toBe("2.1.314 (Claude Code)");
    expect(r["HTTPS proxy"]).toBe("nginx 1.24.0");
    expect(r["Proxy"]).toBeUndefined();
  });
  it("keeps the order: hub, Claude Code, Tailscale, HTTPS proxy", () => {
    const keys = systemRows(info(), NOW).map(([k]) => k);
    expect(keys.slice(keys.indexOf("workstation-hub"), keys.indexOf("HTTPS proxy") + 1)).toEqual(["workstation-hub", "Claude Code", "Tailscale", "HTTPS proxy"]);
  });
  it("unknown versions are null (rendered as —); a missing Tailscale or proxy says 'not installed'", () => {
    const r = rows(info({ hub: null, claude: null, tailscale: null, proxy: null }));
    expect([r["workstation-hub"], r["Claude Code"]]).toEqual([null, null]);
    expect([r["Tailscale"], r["HTTPS proxy"]]).toEqual(["not installed", "not installed"]);
  });
});

describe("Agents tile", () => {
  it("shows the Claude process count", () => {
    expect(agentsValue(2)).toBe("Claude 2");
    expect(agentsValue(0)).toBe("Claude 0");
    expect(agentsValue(null)).toBe("Claude —");
  });
});
