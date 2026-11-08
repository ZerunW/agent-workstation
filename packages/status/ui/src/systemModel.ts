/** What the System panel and the Agents tile show, as plain data (main.ts only renders it). */
import { fmtBytes, fmtEventTime } from "./format.js";
import type { SystemInfo } from "./types.js";

/** "Claude 2"; a count the samples do not have yet is "—". */
export function agentsValue(claude: number | null): string {
  return `Claude ${claude === null ? "—" : String(Math.round(claude))}`;
}

/** The System panel's rows in display order; a null value renders as "—". */
export function systemRows(s: SystemInfo, nowMs: number): Array<[string, string | null]> {
  const v = s.versions;
  return [
    ["Server", s.model],
    ["CPU", s.cpu],
    ["Memory", fmtBytes(s.memTotalBytes)],
    ["Kernel", s.kernel],
    ["Booted", fmtEventTime(Date.parse(s.bootedAt), nowMs)],
    ...s.disks.map((d): [string, string] => [`Disk ${d.label}`, `${fmtBytes(d.usedBytes)} of ${fmtBytes(d.totalBytes)} (${d.usedPercent.toFixed(1)}%) · ${d.path}`]),
    ["Disk IO device", s.blockDevice],
    ["Interfaces", s.interfaces.join(", ")],
    ["Node.js", s.node],
    ["workstation-status", v.status],
    ["workstation-hub", v.hub],
    ["Claude Code", v.claude],
    ["Tailscale", v.tailscale ?? "not installed"],
    ["HTTPS proxy", v.proxy ?? "not installed"],
    ["Sampling", `every ${s.intervals.sampleS} s; health every ${s.intervals.healthS} s; speed probe ${s.intervals.speedProbeMin > 0 ? `every ${s.intervals.speedProbeMin} min` : "off"}`],
    ["Disk thresholds", `warn ${s.thresholds.diskWarnPercent}%, read-only ${s.thresholds.diskBlockPercent}%`],
  ];
}
