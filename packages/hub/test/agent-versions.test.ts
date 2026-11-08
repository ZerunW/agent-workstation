import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentExec, AgentExecError, agentInvocation, validateClaudeArgs, type AgentRunAs, type SpawnFn } from "../src/sessions/agentExec.js";
import { AGENT_VERSION_INTERVAL_MS, AgentVersionService } from "../src/sessions/agentVersions.js";

const ROOT = "/srv/agent-workstation/users";
const cfg: AgentRunAs = { user: "workstation-agent", exec: "/opt/agent-workstation/bin/workstation-agent-exec", sudo: "/usr/bin/sudo", workRoot: ROOT };

afterEach(() => {
  vi.useRealTimers();
});

describe("--version in the hub's mirrored pre-check", () => {
  it("claude accepts the bare --version flag", () => {
    expect(() => validateClaudeArgs(["--version"], ROOT)).not.toThrow();
    expect(agentInvocation(cfg, "claude", { cwd: ROOT, args: ["--version"] }).args).toEqual(["-n", "-u", "workstation-agent", "--", cfg.exec, "claude", ROOT, "--"].concat("--version"));
  });

  it("nothing like it passes: no value, no short form, no other flag", () => {
    for (const args of [["--version=1"], ["--version", "1"], ["-v"], ["--versions"], ["--help"], ["--version="]]) {
      expect(() => validateClaudeArgs(args, ROOT), `claude ${args.join(" ")}`).toThrow(AgentExecError);
    }
  });
});

/** A spawn() stand-in: each child prints `reply(mode)` and exits once its stdin ends. */
function fakeSpawn(reply: (mode: string) => { code?: number; stdout?: string }) {
  const calls: string[][] = [];
  const fn: SpawnFn = (command, args) => {
    const child = new EventEmitter() as ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null };
    const stdin = new PassThrough();
    Object.assign(child, { pid: 4000 + calls.length, stdin, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    stdin.resume();
    stdin.on("finish", () => {
      const r = reply(args[args.indexOf(cfg.exec) + 1] ?? "");
      if (r.stdout) child.stdout!.push(r.stdout);
      child.stdout!.push(null);
      child.stderr!.push(null);
      setImmediate(() => {
        child.exitCode = r.code ?? 0;
        child.emit("exit", child.exitCode, null);
      });
    });
    calls.push([command, ...args]);
    return child;
  };
  return { fn, calls };
}

describe("AgentVersionService", () => {
  it("runs `claude --version` as the agent account through the wrapper", async () => {
    const spawn = fakeSpawn(() => ({ stdout: "\n2.1.314 (Claude Code)\nbuild x\n" }));
    const svc = new AgentVersionService({ exec: new AgentExec(cfg, undefined, spawn.fn) });
    expect(svc.current()).toEqual({ claude: null });
    expect(await svc.refresh()).toEqual({ claude: "2.1.314 (Claude Code)" });
    expect(svc.current()).toEqual({ claude: "2.1.314 (Claude Code)" });
    expect(spawn.calls.map((c) => c.join(" "))).toEqual([`/usr/bin/sudo -n -u workstation-agent -- ${cfg.exec} claude ${ROOT} -- --version`]);
  });

  it("a failed run (non-zero exit, empty output) is null", async () => {
    const spawn = fakeSpawn(() => ({ code: 127, stdout: "claude is not installed" }));
    const svc = new AgentVersionService({ exec: new AgentExec(cfg, undefined, spawn.fn) });
    expect(await svc.refresh()).toEqual({ claude: null });
    const empty = fakeSpawn(() => ({ stdout: "\n" }));
    expect(await new AgentVersionService({ exec: new AgentExec(cfg, undefined, empty.fn) }).refresh()).toEqual({ claude: null });
  });

  it("a later failure replaces the old version with null", async () => {
    let healthy = true;
    const spawn = fakeSpawn(() => (healthy ? { stdout: "1.0.0\n" } : { code: 1 }));
    const svc = new AgentVersionService({ exec: new AgentExec(cfg, undefined, spawn.fn) });
    await svc.refresh();
    expect(svc.current().claude).toBe("1.0.0");
    healthy = false;
    await svc.refresh();
    expect(svc.current()).toEqual({ claude: null });
  });

  it("without an agent account nothing runs and it stays null", async () => {
    const svc = new AgentVersionService({ exec: undefined });
    svc.start();
    expect(await svc.refresh()).toEqual({ claude: null });
    svc.stop();
  });

  it("reads at start and every 6 hours, and stops", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ code: 0, stdout: "9.9.9\n", stderr: "", error: null }));
    const svc = new AgentVersionService({ exec: { cfg, run } });
    svc.start();
    svc.start(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(svc.current()).toEqual({ claude: "9.9.9" });
    await vi.advanceTimersByTimeAsync(AGENT_VERSION_INTERVAL_MS - 1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(AGENT_VERSION_INTERVAL_MS).toBe(6 * 3600_000);
    svc.stop();
    await vi.advanceTimersByTimeAsync(AGENT_VERSION_INTERVAL_MS * 2);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
