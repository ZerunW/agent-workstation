/** Child-process seam for health checks. `realExec` never rejects; failures are described in the result. */
import { execFile } from "node:child_process";

export interface ExecResult {
  /** Exit code, null when the process did not run to completion (spawn failure, timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not be run or was killed. */
  error: null | "ENOENT" | "TIMEOUT" | "SPAWN";
  message?: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type ExecFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const realExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts?.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024, env: opts?.env ?? process.env, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, error: null });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", error: "ENOENT", message: e.message });
        if (e.killed) return resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", error: "TIMEOUT", message: "timed out" });
        if (typeof e.code === "number") return resolve({ code: e.code, stdout: stdout ?? "", stderr: stderr ?? "", error: null });
        return resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", error: "SPAWN", message: e.message });
      },
    );
  });
