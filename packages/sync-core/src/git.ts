import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { MAX_SYNC_FILE_BYTES } from "@agent-workstation/protocol";
import { SyncCoreError } from "./errors.js";

/**
 * Thin wrapper around the system `git` binary. No shell is ever involved
 * (execFile/spawn with an argv array). Every invocation:
 *  - passes `--git-dir=<gitDir> --work-tree=<workTree>` (the bare repo lives
 *    outside the work tree, so Claude never sees a `.git` in its cwd);
 *  - runs with cwd = work tree;
 *  - pins config that affects output or content (`core.quotepath=false`, no
 *    autocrlf, no external diff, no hooks, ...) and ignores the user's
 *    global/system config so results are identical on every machine;
 *  - gets its own `GIT_INDEX_FILE` (callers pass a per-operation temp index;
 *    commands that need no index get a never-created placeholder path).
 */

export interface GitRunOptions {
  input?: Buffer | string;
  /** Extra environment (e.g. GIT_INDEX_FILE), merged over the sanitised base env. */
  env?: Record<string, string>;
  /** Exit codes treated as success (default [0]); "any" accepts everything. */
  okCodes?: readonly number[] | "any";
  /** Pass `--literal-pathspecs` (default true; `check-ignore` does not support it). */
  literalPathspecs?: boolean;
  /** Override the work tree for this call (baseline import from a staging dir). */
  workTree?: string;
  /** Extra `-c key=value` settings (appended after the defaults, so they win). */
  config?: readonly string[];
  maxBuffer?: number;
}

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export class GitError extends SyncCoreError {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], res: GitResult) {
    super("git", `git ${args.slice(0, 3).join(" ")} exited ${res.code}: ${res.stderr.trim().slice(0, 500)}`);
    this.args = args;
    this.exitCode = res.code;
    this.stderr = res.stderr;
  }
}

/** Settings applied to every invocation. */
export const GIT_CONFIG: readonly string[] = [
  "core.quotepath=false",
  "core.autocrlf=false",
  "core.safecrlf=false",
  "core.fileMode=true",
  "core.symlinks=true",
  "core.excludesFile=/dev/null",
  "core.attributesFile=/dev/null",
  "core.hooksPath=/dev/null",
  "core.untrackedCache=false",
  "commit.gpgSign=false",
  "gc.autoDetach=false",
  "maintenance.auto=false",
  "color.ui=false",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.renames=true",
  "diff.algorithm=myers",
  "diff.indentHeuristic=true",
  "status.renames=true",
  "merge.conflictStyle=merge",
  "user.name=Agent Workstation",
  "user.email=workstation@localhost",
];

/** Large enough to read a MAX_SYNC_FILE_BYTES blob plus slack. */
export const DEFAULT_MAX_BUFFER = MAX_SYNC_FILE_BYTES * 2 + 16 * 1024 * 1024;

let cachedBaseEnv: Record<string, string> | null = null;

/** process.env minus every GIT_* variable, plus isolation settings. */
export function gitBaseEnv(): Record<string, string> {
  if (cachedBaseEnv) return cachedBaseEnv;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GIT_")) continue;
    env[k] = v;
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Agent Workstation",
    GIT_AUTHOR_EMAIL: "workstation@localhost",
    GIT_COMMITTER_NAME: "Agent Workstation",
    GIT_COMMITTER_EMAIL: "workstation@localhost",
    LC_ALL: "C",
  });
  cachedBaseEnv = env;
  return env;
}

export class GitRunner {
  constructor(
    readonly gitDir: string,
    readonly workTree: string,
    /** GIT_INDEX_FILE used when the caller does not pass one; never created. */
    readonly placeholderIndex: string,
  ) {}

  argv(args: readonly string[], o: GitRunOptions = {}): string[] {
    const cfg: string[] = [];
    for (const c of [...GIT_CONFIG, ...(o.config ?? [])]) cfg.push("-c", c);
    return [
      `--git-dir=${this.gitDir}`,
      `--work-tree=${o.workTree ?? this.workTree}`,
      ...cfg,
      ...(o.literalPathspecs === false ? [] : ["--literal-pathspecs"]),
      ...args,
    ];
  }

  env(o: GitRunOptions = {}): Record<string, string> {
    return { ...gitBaseEnv(), GIT_INDEX_FILE: this.placeholderIndex, ...o.env };
  }

  run(args: readonly string[], o: GitRunOptions = {}): Promise<GitResult> {
    return runGit(this.argv(args, o), { ...o, cwd: o.workTree ?? this.workTree, env: this.env(o) }, args);
  }

  /** Streaming invocation (stdin/stdout/stderr pipes) for `cat-file --batch`. */
  spawn(args: readonly string[], o: GitRunOptions = {}): ChildProcessByStdio<Writable, Readable, Readable> {
    return spawn("git", this.argv(args, o), {
      cwd: o.workTree ?? this.workTree,
      env: this.env(o),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

/** Run git without `--git-dir/--work-tree` (only used for `git init`). */
export function runGitRaw(args: readonly string[], cwd: string): Promise<GitResult> {
  return runGit([...args], { cwd, env: gitBaseEnv() }, args);
}

function runGit(
  argv: string[],
  o: GitRunOptions & { cwd: string; env: Record<string, string> },
  displayArgs: readonly string[],
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      argv,
      { cwd: o.cwd, env: o.env, encoding: "buffer", maxBuffer: o.maxBuffer ?? DEFAULT_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const c = (err as { code?: unknown }).code;
          if (typeof c === "number") code = c;
          else {
            reject(new SyncCoreError("git", `git ${displayArgs.slice(0, 2).join(" ")} failed: ${err.message}`));
            return;
          }
        }
        const res: GitResult = { code, stdout: stdout as Buffer, stderr: (stderr as Buffer).toString("utf8") };
        const ok = o.okCodes === "any" || (o.okCodes ?? [0]).includes(code);
        if (!ok) reject(new GitError(displayArgs, res));
        else resolve(res);
      },
    );
    child.stdin?.on("error", () => undefined); // git may exit before reading all input
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });
}
