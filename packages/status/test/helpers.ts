import type { Readers, StatfsResult } from "../src/collect/readers.js";
import { resolveConfig, type AppConfig } from "../src/config.js";
import type { ExecFn, ExecResult } from "../src/health/exec.js";
import type { CheckContext } from "../src/health/types.js";

export interface FakeReadersInit {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  statfs?: Record<string, StatfsResult>;
  interfaces?: Record<string, string[]>;
}

export interface FakeReaders extends Readers {
  files: Record<string, string>;
  clockMs: number;
}

export function fakeReaders(init: FakeReadersInit = {}): FakeReaders {
  const r: FakeReaders = {
    files: { ...(init.files ?? {}) },
    clockMs: 1000,
    async readText(path) {
      return r.files[path] ?? null;
    },
    async listDir(path) {
      return init.dirs?.[path] ?? [];
    },
    async statfs(path) {
      return init.statfs?.[path] ?? null;
    },
    monotonicMs: () => r.clockMs,
    interfaceAddresses: () => init.interfaces ?? {},
  };
  return r;
}

export function testConfig(raw: unknown = {}): AppConfig {
  return resolveConfig(raw, null);
}

export const ok = (stdout = "", stderr = ""): ExecResult => ({ code: 0, stdout, stderr, error: null });
export const exit = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr, error: null });
export const enoent = (): ExecResult => ({ code: null, stdout: "", stderr: "", error: "ENOENT", message: "spawn ENOENT" });

/** Exec fake driven by a table keyed by "cmd arg arg"; unknown commands behave like a missing binary. */
export function fakeExec(table: Record<string, ExecResult | ((args: string[]) => ExecResult)>): ExecFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const hit = table[key] ?? Object.entries(table).find(([k]) => key.startsWith(`${k} `))?.[1];
    if (!hit) return enoent();
    return typeof hit === "function" ? hit(args) : hit;
  }) as ExecFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export function makeCtx(over: Partial<CheckContext> & { config?: AppConfig } = {}): CheckContext {
  return {
    config: over.config ?? testConfig(),
    exec: over.exec ?? fakeExec({}),
    fetch: over.fetch ?? ((async () => new Response("ok")) as typeof fetch),
    readers: over.readers ?? fakeReaders(),
    lookupHost: over.lookupHost ?? (async () => []),
  };
}
