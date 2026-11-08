import { readFileSync } from "node:fs";

/**
 * MemAvailable from /proc/meminfo in MiB. Returns Infinity where /proc is
 * unavailable (macOS dev machines), which disables the memory gate.
 */
export function readMemAvailableMiB(path = "/proc/meminfo"): number {
  const info = readMemInfo(path);
  return info ? info.availableMiB : Number.POSITIVE_INFINITY;
}

export function readMemInfo(path = "/proc/meminfo"): { totalMiB: number; availableMiB: number } | null {
  try {
    const text = readFileSync(path, "utf8");
    return parseMemInfo(text);
  } catch {
    return null;
  }
}

export function parseMemInfo(text: string): { totalMiB: number; availableMiB: number } | null {
  const get = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) / 1024 : null;
  };
  const total = get("MemTotal");
  const avail = get("MemAvailable");
  if (total == null || avail == null) return null;
  return { totalMiB: Math.round(total), availableMiB: Math.round(avail) };
}

/** RSS of a process in MiB via /proc/<pid>/status (Linux only). */
export function readProcessRssMiB(pid: number): number | null {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}
