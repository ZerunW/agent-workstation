/**
 * The seam between the collector / health checks and the operating system.
 * Production uses `realReaders`; unit tests (and the demo mode) pass fakes, so the
 * whole pipeline runs on macOS where /proc and /sys do not exist.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";

export interface StatfsResult {
  totalBytes: number;
  freeBytes: number;
  availBytes: number;
}

export interface Readers {
  /** File contents, or null when the file is missing / unreadable. */
  readText(path: string): Promise<string | null>;
  /** Directory entries, or [] when missing / unreadable. */
  listDir(path: string): Promise<string[]>;
  statfs(path: string): Promise<StatfsResult | null>;
  /** Monotonic clock in milliseconds (used for rate computation). */
  monotonicMs(): number;
  /** IPv4 addresses per interface name. */
  interfaceAddresses(): Record<string, string[]>;
}

export const realReaders: Readers = {
  async readText(path) {
    try {
      return await fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async listDir(path) {
    try {
      return await fs.readdir(path);
    } catch {
      return [];
    }
  },
  async statfs(path) {
    try {
      const s = await fs.statfs(path);
      return { totalBytes: s.blocks * s.bsize, freeBytes: s.bfree * s.bsize, availBytes: s.bavail * s.bsize };
    } catch {
      return null;
    }
  },
  monotonicMs: () => performance.now(),
  interfaceAddresses() {
    const out: Record<string, string[]> = {};
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
      out[name] = (infos ?? []).filter((i) => i.family === "IPv4").map((i) => i.address);
    }
    return out;
  },
};
