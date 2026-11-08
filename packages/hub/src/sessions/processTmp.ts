/**
 * A private temp directory for every Claude Code process the hub starts (code and chat sessions, their subagents): `CLAUDE_CODE_TMPDIR=/tmp/hs/<22 random base64url characters>`, created 0700 by the account
 * the process runs as just before it starts and removed when it ends. Nothing of a session is then left in the CLI's
 * shared per-uid directory (`/tmp/claude-<uid>`: every session's per-project folders with command output), which a
 * chat's sandbox could otherwise read.
 *
 * Why so short: Claude Code (CLI 2.1.316) keeps its files in `<CLAUDE_CODE_TMPDIR>/claude-<uid>` and gives sandboxed
 * commands that directory as $TMPDIR only while it is at most 44 bytes (AF_UNIX socket paths); a longer one silently
 * falls back to the shared `/tmp/claude-<uid>`, which the sandbox then opens to the command. `/tmp/hs/` + 22 is 30
 * bytes, `/claude-<uid>` adds 8 + the uid's digits.
 *
 * With `[agents] run_as` the wrapper (deploy/workstation-agent-exec) creates the directory as the agent account, accepts no
 * other CLAUDE_CODE_TMPDIR, and removes it in its `rmtmp` mode (AgentExec.removeTmp, called when the process exits).
 * Without it (dev machines), claudeProcessOptions() does both here.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { errorMessage } from "../util/errors.js";
import type { Logger } from "../util/log.js";
import type { AgentExec } from "./agentExec.js";

/** Parent of the processes' temp directories (the wrapper's TMP_ROOT is the same). */
export const PROCESS_TMP_ROOT = "/tmp/hs";

const NAME_RE = /^[A-Za-z0-9_-]{22}$/;

/** A fresh temp directory path for one Claude process (not created yet). */
export function newProcessTmpDir(root = PROCESS_TMP_ROOT): string {
  return `${root}/${randomBytes(16).toString("base64url")}`;
}

/** True when `dir` is exactly `<root>/<22 base64url characters>` (what newProcessTmpDir makes). */
export function isProcessTmpDir(dir: unknown, root = PROCESS_TMP_ROOT): boolean {
  return typeof dir === "string" && dir.startsWith(`${root}/`) && NAME_RE.test(dir.slice(root.length + 1));
}

/** Creates the directory (and its parent) 0700 as the hub's own account. Throws if it already exists. */
export function createProcessTmpDir(dir: string, root = PROCESS_TMP_ROOT): void {
  if (!isProcessTmpDir(dir, root)) throw new Error(`not a process temp directory: ${dir}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
}

/** Removes the directory with everything in it (no-op for anything that is not a process temp directory). */
export function removeProcessTmpDir(dir: unknown, root = PROCESS_TMP_ROOT): void {
  if (typeof dir !== "string" || !isProcessTmpDir(dir, root)) return;
  rmSync(dir, { recursive: true, force: true });
}

type ChildInfo = { pid?: number | undefined; stderr: NodeJS.ReadableStream | null };

/**
 * The SDK options that start one Claude process: through the agent wrapper (`agentExec`), or spawned here (the
 * configured binary, else the SDK's own). Either way the process's CLAUDE_CODE_TMPDIR (from its env) is created before
 * it starts and removed when it exits. `onChild`: pid / stderr (otherwise stderr is drained).
 */
export function claudeProcessOptions(p: {
  agentExec?: AgentExec | undefined;
  claudeExecutable?: string | undefined;
  log?: Logger | undefined;
  onChild?: ((child: ChildInfo) => void) | undefined;
}): { pathToClaudeCodeExecutable?: string; spawnClaudeCodeProcess: (o: SpawnOptions) => SpawnedProcess } {
  if (p.agentExec) return p.agentExec.claudeOptions(p.onChild);
  return {
    ...(p.claudeExecutable ? { pathToClaudeCodeExecutable: p.claudeExecutable } : {}),
    spawnClaudeCodeProcess: (o: SpawnOptions): SpawnedProcess => {
      const tmp = o.env?.CLAUDE_CODE_TMPDIR;
      if (typeof tmp === "string" && isProcessTmpDir(tmp)) {
        try {
          createProcessTmpDir(tmp);
        } catch (err) {
          p.log?.warn({ dir: tmp, err: errorMessage(err) }, "could not create the Claude process's temp directory");
        }
      }
      const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, signal: o.signal, stdio: ["pipe", "pipe", "pipe"] });
      if (p.onChild) p.onChild(child);
      else child.stderr?.resume();
      let removed = false;
      const cleanup = () => {
        if (removed) return;
        removed = true;
        try {
          removeProcessTmpDir(tmp);
        } catch (err) {
          p.log?.warn({ dir: tmp, err: errorMessage(err) }, "could not remove the Claude process's temp directory");
        }
      };
      child.once("exit", cleanup);
      child.on("error", (err) => {
        p.log?.warn({ err: errorMessage(err) }, "claude process error");
        if (child.pid === undefined) cleanup(); // never started: no exit event
      });
      return child as unknown as SpawnedProcess;
    },
  };
}
