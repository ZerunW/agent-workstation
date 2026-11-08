/**
 * The one place that starts AI processes as the agent account (`[agents] run_as`, `workstation-agent` by default):
 * Claude Code (sessions, subagents) and the tmux of web terminals. Every one runs as
 *
 *   sudo -n -u <run_as> -- <exec> <mode> <cwd> [--env NAME=VALUE]... [--stdin-secrets] -- <target args>
 *   sudo -n -u <run_as> -- <exec> signal <TERM|INT|HUP|KILL> <pid of that sudo>
 *
 * where <exec> is the root-owned wrapper deploy/workstation-agent-exec (installed to /opt/agent-workstation/bin by
 * deploy/install.sh; the sudoers drop-in allows the hub account that one command as the agent account and nothing
 * else). The wrapper picks the binary for <mode> itself, rebuilds the environment from an allowlist, requires the cwd
 * under the workspace root and validates every argument. This module applies the same rules first, so a bad call
 * fails here with a readable error rather than as a sudo exit code; deploy/test/workstation-agent-exec.test.sh checks
 * the wrapper's side.
 *
 * Nothing secret goes into argv (sudo logs every command line, and argv is world-readable in /proc): ANTHROPIC_API_KEY
 * (a token of the hub's key proxy, never the real key, which both sides refuse; ANTHROPIC_BASE_URL, exactly
 * http://127.0.0.1:<port>, goes as --env) travels on stdin as NUL-terminated NAME=VALUE records closed by an empty
 * record. The wrapper reads exactly those bytes, then execs the target, which gets the rest of stdin (Claude's
 * stream-json input).
 *
 * sudo runs as root, so the hub cannot signal it: kill() goes through the wrapper's `signal` mode, which signals the
 * children of that sudo process as the agent account; sudo then exits with the target's status.
 *
 * A Claude process's private temp directory (CLAUDE_CODE_TMPDIR, processTmp.ts) must be exactly
 * `/tmp/hs/<22 base64url characters>`; the wrapper creates it 0700 as the agent account before starting Claude, and
 * when the process exits removeTmp() has the wrapper's `rmtmp` mode delete it (the hub cannot: it is the agent's).
 * TMPDIR passes only as that same directory (chats: Claude Code's sandbox bridge sockets go there).
 *
 * `run_as` empty (dev machines, tests): nothing here is used and every caller spawns directly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { HubConfig } from "../config.js";
import { errorMessage } from "../util/errors.js";
import { redactSecrets } from "../util/redact.js";
import type { Logger } from "../util/log.js";
import { isProcessTmpDir } from "./processTmp.js";

export type AgentMode = "claude" | "tmux";

export interface AgentRunAs {
  /** The agent account (`[agents] run_as`). */
  user: string;
  /** The wrapper (`[agents] exec`). */
  exec: string;
  /** `[agents] sudo`. */
  sudo: string;
  /** `paths.users_root`: every cwd and directory argument must be inside it (the wrapper has the same root). */
  workRoot: string;
  /** `paths.agent_plugins_dir`: the only place `--plugin-dir` may point into, as `<dir>/<uuid>/(project|workstation)`. */
  pluginsDir?: string;
}

/** The `[agents]` section as AgentExec takes it. */
export function agentRunAsConfig(config: HubConfig): AgentRunAs {
  return { user: config.agents.runAs, exec: config.agents.exec, sudo: config.agents.sudo, workRoot: config.paths.usersRoot, pluginsDir: config.paths.agentPluginsDir };
}

export interface AgentCommandSpec {
  cwd: string;
  args: readonly string[];
  /** Candidate environment (e.g. the SDK's full env): only allowlisted names survive; ANTHROPIC_API_KEY moves to stdin. */
  env?: Record<string, string | undefined>;
}

export interface AgentInvocation {
  /** The sudo binary. */
  command: string;
  args: string[];
  /** Bytes to write to stdin before anything else (null = none). */
  preamble: string | null;
}

export class AgentExecError extends Error {
  constructor(message: string) {
    super(`agent exec: ${message}`);
    this.name = "AgentExecError";
  }
}

const fail = (msg: string): never => {
  throw new AgentExecError(msg);
};

/**
 * `<users_root>/~hub`: the hub's scratch folders that agent processes must enter (skill overlays);
 * with run_as they cannot live in the hub's private data dir. ("~" sorts after every username and is not one.)
 */
export const AGENT_SCRATCH_DIRNAME = "~hub";

/** Shells a terminal may run inside tmux (the wrapper has the same list). */
export const AGENT_SHELLS: readonly string[] = ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/usr/bin/fish", "/bin/sh"];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** The server browser's MCP server as the hub passes it in --mcp-config (mirrors BROWSER_MCP_RE in workstation-agent-exec). */
const BROWSER_MCP_RE = /"browser":\{"type":"http","url":"http:\/\/127\.0\.0\.1:[0-9]{1,5}\/mcp\/[a-z0-9_-]{1,32}","headers":\{"Authorization":"Bearer [A-Za-z0-9_-]{43}"(,"X-Workstation-Session":"[0-9a-f-]{36}")?\}\}/;
const NO_CTRL_RE = /^[^\x00-\x1f\x7f]*$/;
const ENV_VALUE_RE = /^[A-Za-z0-9._:/,+=@-]{0,256}$/;
/** The only ANTHROPIC_API_KEY an agent process may get: a token of the hub's key proxy (keyProxy.ts), never a key. */
const API_KEY_RE = /^hsk-[A-Za-z0-9_-]{43}$/;
/** The only ANTHROPIC_BASE_URL: the hub's loopback key proxy. */
const BASE_URL_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const TMUX_NAME_RE = /^term-[A-Za-z0-9_-]{1,100}$/;

/** True when `p` is an absolute, normalized path equal to or inside `root` (the wrapper re-checks with realpath). */
export function isUnderRoot(root: string, p: string): boolean {
  if (!isAbsolute(p) || normalize(p) !== p || p.endsWith("/")) return false;
  return p === root || p.startsWith(`${root}/`);
}

// ---------------------------------------------------------------- argument rules (mirror deploy/workstation-agent-exec)

const CLAUDE_BOOL_FLAGS = new Set([
  "--verbose",
  "--include-partial-messages",
  "--strict-mcp-config",
  "--allow-dangerously-skip-permissions",
  "--no-session-persistence",
  "--include-hook-events",
  "--continue",
  "--fork-session",
  "--thinking=adaptive",
  "--thinking=disabled",
  "--permission-prompt-tool=stdio",
  "--version",
]);

type ValueCheck = (v: string, root: string, pluginsDir?: string) => boolean;
const re =
  (r: RegExp): ValueCheck =>
  (v) =>
    r.test(v);
const MODEL: ValueCheck = re(/^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,99}$/);
const TOOL_LIST: ValueCheck = (v) => v.length <= 16_000 && NO_CTRL_RE.test(v);
const UNDER_ROOT: ValueCheck = (v, root) => isUnderRoot(root, v);

/** Claude Code flags that take a value (`--flag=value` or `--flag value`), as the Agent SDK builds them. */
const CLAUDE_VALUE_FLAGS: Record<string, ValueCheck> = {
  "--output-format": re(/^stream-json$/),
  "--input-format": re(/^stream-json$/),
  "--model": MODEL,
  "--fallback-model": MODEL,
  "--effort": re(/^(low|medium|high|xhigh|max)$/),
  "--max-turns": re(/^[0-9]{1,7}$/),
  "--max-thinking-tokens": re(/^[0-9]{1,7}$/),
  "--max-budget-usd": re(/^[0-9]{1,7}(\.[0-9]{1,6})?$/),
  "--thinking-display": re(/^[a-z_]{1,20}$/),
  "--resume": re(UUID_RE),
  "--session-id": re(UUID_RE),
  "--resume-session-at": re(UUID_RE),
  "--permission-mode": re(/^(default|acceptEdits|bypassPermissions|plan|dontAsk|auto)$/),
  "--setting-sources": re(/^((user|project|local)(,(user|project|local))*)?$/),
  "--allowedTools": TOOL_LIST,
  "--disallowedTools": TOOL_LIST,
  "--tools": TOOL_LIST,
  // Only the hub's in-process (type "sdk") servers, plus the server browser's MCP endpoint in exactly the shape the hub
  // builds (same rule as workstation-agent-exec): nothing that starts a command or names any other URL.
  "--mcp-config": (v) => {
    const rest = v.replace(BROWSER_MCP_RE, "");
    return v.length <= 64_000 && NO_CTRL_RE.test(v) && v.startsWith('{"mcpServers":') && !rest.replaceAll('"type":"sdk"', "").includes('"type"') && !rest.includes('"command"') && !rest.includes('"url"');
  },
  // Inline JSON only, never a settings file path.
  "--settings": (v) => v.length <= 64_000 && NO_CTRL_RE.test(v) && v.startsWith("{"),
  "--add-dir": UNDER_ROOT,
  // A plugin the hub generated (skills, commands, agents only): `<plugins dir>/<uuid>/(project|workstation)` and nothing else.
  "--plugin-dir": (v, _root, pluginsDir) => isPluginDir(v, pluginsDir),
  "--plugin-dir-no-mcp": (v, _root, pluginsDir) => isPluginDir(v, pluginsDir),
};

/** `<pluginsDir>/<uuid>/(project|workstation)` exactly (normalized, absolute). */
export function isPluginDir(v: string, pluginsDir: string | undefined): boolean {
  if (!pluginsDir || !isAbsolute(v) || normalize(v) !== v || !v.startsWith(`${pluginsDir}/`)) return false;
  return new RegExp(`^${UUID_RE.source.slice(1, -1)}/(project|workstation)$`).test(v.slice(pluginsDir.length + 1));
}

function checkFlags(mode: string, args: readonly string[], root: string, bools: ReadonlySet<string>, values: Record<string, ValueCheck>, pluginsDir?: string): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (bools.has(a)) continue;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const check = Object.hasOwn(values, name) ? values[name] : undefined;
    if (!check) fail(`${mode}: argument not allowed: ${JSON.stringify(a.slice(0, 80))}`);
    let value: string;
    if (eq > 0) value = a.slice(eq + 1);
    else {
      if (i + 1 >= args.length) fail(`${mode}: ${name} needs a value`);
      value = args[++i]!;
    }
    if (!check!(value, root, pluginsDir)) fail(`${mode}: bad value for ${name}: ${JSON.stringify(value.slice(0, 80))}`);
  }
}

/** Throws AgentExecError unless `args` are what the hub passes to Claude Code (Agent SDK flags). */
export function validateClaudeArgs(args: readonly string[], root: string, pluginsDir?: string): void {
  checkFlags("claude", args, root, CLAUDE_BOOL_FLAGS, CLAUDE_VALUE_FLAGS, pluginsDir);
}

/** Throws unless `args` are one of the five tmux calls of the terminal service. */
export function validateTmuxArgs(args: readonly string[], root: string): void {
  const [sub, ...rest] = args;
  const ok = (() => {
    switch (sub) {
      case "list-sessions":
        return rest.length === 2 && rest[0] === "-F" && rest[1] === "#{session_name}";
      case "has-session":
      case "kill-session":
      case "attach-session":
        return rest.length === 2 && rest[0] === "-t" && rest[1]!.startsWith("=") && TMUX_NAME_RE.test(rest[1]!.slice(1));
      case "new-session": {
        const [d, s, name, c, dir, x, cols, y, rows, shell, ...more] = rest;
        return (
          more.length === 0 &&
          d === "-d" &&
          s === "-s" &&
          TMUX_NAME_RE.test(name ?? "") &&
          c === "-c" &&
          isUnderRoot(root, dir ?? "") &&
          x === "-x" &&
          /^[0-9]{1,4}$/.test(cols ?? "") &&
          y === "-y" &&
          /^[0-9]{1,4}$/.test(rows ?? "") &&
          AGENT_SHELLS.includes(shell ?? "")
        );
      }
      default:
        return false;
    }
  })();
  if (!ok) fail(`tmux: call not allowed: ${JSON.stringify(args.join(" ").slice(0, 120))}`);
}

const VALIDATORS: Record<AgentMode, (args: readonly string[], root: string, pluginsDir?: string) => void> = { claude: validateClaudeArgs, tmux: validateTmuxArgs };

/** Environment names the wrapper accepts per mode (others are dropped here, refused there). */
export function envAllowed(mode: AgentMode, name: string): boolean {
  if (name === "LANG" || name === "LC_ALL" || name === "TZ") return true;
  if (mode === "claude") return name === "ANTHROPIC_BASE_URL" || name === "TMPDIR" || (/^CLAUDE_(CODE|AGENT_SDK)_[A-Z0-9_]{1,64}$/.test(name) && !/^CLAUDE_CODE_(SHELL|SHELL_PREFIX|GIT_BASH_PATH)$/.test(name));
  if (mode === "tmux") return name === "TERM" || name === "COLORTERM" || name === "WORKSTATION_USER";
  return false;
}

/** Builds the exact sudo argv (and stdin preamble) of one agent process. Throws AgentExecError on anything unexpected. */
export function agentInvocation(cfg: AgentRunAs, mode: AgentMode, spec: AgentCommandSpec): AgentInvocation {
  if (!isUnderRoot(cfg.workRoot, spec.cwd)) fail(`${mode}: cwd outside the workspace root: ${spec.cwd}`);
  const secrets: [string, string][] = [];
  const args = [...spec.args];
  VALIDATORS[mode](args, cfg.workRoot, cfg.pluginsDir);
  const envArgs: string[] = [];
  let baseUrl = false;
  const tmpDir = mode === "claude" ? spec.env?.CLAUDE_CODE_TMPDIR : undefined;
  if (tmpDir !== undefined && !isProcessTmpDir(tmpDir)) fail(`claude: CLAUDE_CODE_TMPDIR must be a process temp directory (/tmp/hs/<22 characters>): ${tmpDir.slice(0, 80)}`);
  for (const [name, value] of Object.entries(spec.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined) continue;
    // TMPDIR only as the process's own temp directory (never the hub's own TMPDIR).
    if (name === "TMPDIR" && (mode !== "claude" || tmpDir === undefined || value !== tmpDir)) continue;
    if (name === "ANTHROPIC_API_KEY") {
      if (mode !== "claude") fail(`${mode}: ANTHROPIC_API_KEY is only for Claude`);
      if (/^sk-ant-/i.test(value)) fail("claude: refusing a real Anthropic API key (agent processes only get key proxy tokens)");
      if (!API_KEY_RE.test(value)) fail("claude: malformed ANTHROPIC_API_KEY (not a key proxy token)");
      secrets.push([name, value]);
      continue;
    }
    if (name === "ANTHROPIC_BASE_URL" && mode === "claude") {
      const port = BASE_URL_RE.exec(value)?.[1];
      if (!port || Number(port) > 65535) fail("claude: ANTHROPIC_BASE_URL must be http://127.0.0.1:<port>");
      baseUrl = true;
    }
    if (envAllowed(mode, name) && ENV_VALUE_RE.test(value)) envArgs.push("--env", `${name}=${value}`);
  }
  if (secrets.some(([k]) => k === "ANTHROPIC_API_KEY") && !baseUrl) fail("claude: a key proxy token needs ANTHROPIC_BASE_URL");
  if (mode === "tmux" && secrets.length) fail("tmux: no stdin secrets");
  const preamble = secrets.length ? `${secrets.map(([k, v]) => `${k}=${v}\0`).join("")}\0` : null;
  return {
    command: cfg.sudo,
    args: ["-n", "-u", cfg.user, "--", cfg.exec, mode, spec.cwd, ...envArgs, ...(preamble ? ["--stdin-secrets"] : []), "--", ...args],
    preamble,
  };
}

const SIGNALS: Record<string, "TERM" | "INT" | "HUP" | "KILL"> = { SIGTERM: "TERM", SIGINT: "INT", SIGHUP: "HUP", SIGKILL: "KILL", "15": "TERM", "2": "INT", "1": "HUP", "9": "KILL" };

/** The sudo argv that signals the target started by sudo process `pid`. */
export function signalInvocation(cfg: AgentRunAs, pid: number, signal: NodeJS.Signals | number = "SIGTERM"): { command: string; args: string[] } {
  if (!Number.isInteger(pid) || pid <= 1) fail(`signal: bad pid ${pid}`);
  return { command: cfg.sudo, args: ["-n", "-u", cfg.user, "--", cfg.exec, "signal", SIGNALS[String(signal)] ?? "TERM", String(pid)] };
}

/** The sudo argv that removes a Claude process's temp directory (processTmp.ts) as the agent account. */
export function rmtmpInvocation(cfg: AgentRunAs, dir: string): { command: string; args: string[] } {
  if (!isProcessTmpDir(dir)) fail(`rmtmp: not a process temp directory: ${dir.slice(0, 80)}`);
  return { command: cfg.sudo, args: ["-n", "-u", cfg.user, "--", cfg.exec, "rmtmp", dir] };
}

// ---------------------------------------------------------------- isolated downloads (chats' download_file)

/** Parent of the download temp directories (the wrapper's FETCH_ROOT is the same). */
export const FETCH_TMP_ROOT = "/tmp/hf";
const FETCH_NAME_RE = /^[A-Za-z0-9_-]{22}$/;
/** What the wrapper accepts as a download URL (the hub has already normalised it with URL; mirrors FETCH_URL_RE). */
export const FETCH_URL_RE = /^https:\/\/([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(:443)?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*$/;
const FETCH_IPV4_RE = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
const FETCH_IPV6_RE = /^[0-9a-f:]{2,39}$/;
/** The file name a finished download gets in `<chat folder>/downloads` (mirrors FETCH_FILE_RE). */
export const FETCH_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,149}$/;
/** `<users root>/<user>/.chat/<session id>/downloads` (mirrors the wrapper's check). */
const FETCH_DEST_RE = /\/\.chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/downloads$/;
export const FETCH_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const FETCH_MAX_TIMEOUT_S = 7200;

export const isFetchTmpDir = (dir: unknown, root = FETCH_TMP_ROOT): boolean => typeof dir === "string" && dir.startsWith(`${root}/`) && FETCH_NAME_RE.test(dir.slice(root.length + 1));

/** The sudo argv of one isolated fetch: `fetch <out-dir> <url> <pinned ip> <max bytes> <timeout s>`. */
export function fetchInvocation(cfg: AgentRunAs, p: { dir: string; url: string; ip: string; maxBytes: number; timeoutS: number }): { command: string; args: string[] } {
  if (!isFetchTmpDir(p.dir)) fail(`fetch: not a download temp directory: ${p.dir.slice(0, 80)}`);
  if (p.url.length > 2048 || !FETCH_URL_RE.test(p.url)) fail(`fetch: URL not allowed: ${p.url.slice(0, 80)}`);
  if (!FETCH_IPV4_RE.test(p.ip) && !(FETCH_IPV6_RE.test(p.ip) && p.ip.includes(":"))) fail(`fetch: bad address ${p.ip.slice(0, 45)}`);
  if (!Number.isInteger(p.maxBytes) || p.maxBytes < 1 || p.maxBytes > FETCH_MAX_BYTES) fail(`fetch: bad size limit ${p.maxBytes}`);
  if (!Number.isInteger(p.timeoutS) || p.timeoutS < 1 || p.timeoutS > FETCH_MAX_TIMEOUT_S) fail(`fetch: bad time limit ${p.timeoutS}`);
  return { command: cfg.sudo, args: ["-n", "-u", cfg.user, "--", cfg.exec, "fetch", p.dir, p.url, p.ip, String(p.maxBytes), String(p.timeoutS)] };
}

/** The sudo argv that moves a finished download into `<chat folder>/downloads` (prints the final path). */
export function fetchMoveInvocation(cfg: AgentRunAs, dir: string, destDir: string, name: string): { command: string; args: string[] } {
  if (!isFetchTmpDir(dir)) fail(`fetchmv: not a download temp directory: ${dir.slice(0, 80)}`);
  if (!isUnderRoot(cfg.workRoot, destDir) || !FETCH_DEST_RE.test(destDir)) fail(`fetchmv: not a chat's downloads folder: ${destDir.slice(0, 120)}`);
  if (!FETCH_FILE_RE.test(name)) fail(`fetchmv: bad file name ${JSON.stringify(name.slice(0, 80))}`);
  return { command: cfg.sudo, args: ["-n", "-u", cfg.user, "--", cfg.exec, "fetchmv", dir, destDir, name] };
}

/** The sudo argv that removes a download temp directory (a redirect, an error). */
export function fetchRemoveInvocation(cfg: AgentRunAs, dir: string): { command: string; args: string[] } {
  if (!isFetchTmpDir(dir)) fail(`fetchrm: not a download temp directory: ${dir.slice(0, 80)}`);
  return { command: cfg.sudo, args: ["-n", "-u", cfg.user, "--", cfg.exec, "fetchrm", dir] };
}

// ---------------------------------------------------------------- processes

/**
 * A child started through sudo. Satisfies the SDK's SpawnedProcess; kill() goes through the
 * wrapper's `signal` mode (the hub may not signal the root-owned sudo itself).
 */
export interface AgentProcess extends SpawnedProcess {
  readonly pid: number | undefined;
  readonly stderr: ChildProcess["stderr"];
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export type SpawnFn = (command: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;

/** sudo itself gets a minimal environment (it resets it anyway; the wrapper builds the target's own). */
const SUDO_ENV: NodeJS.ProcessEnv = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };

export class AgentExec {
  constructor(
    readonly cfg: AgentRunAs,
    private readonly log?: Logger,
    private readonly spawnFn: SpawnFn = (c, a, o) => spawn(c, a, o),
  ) {}

  /** Starts one agent process; the preamble (if any) is already written to its stdin. */
  spawn(mode: AgentMode, spec: AgentCommandSpec): AgentProcess {
    const inv = agentInvocation(this.cfg, mode, spec);
    // sudo starts in the target cwd only after the wrapper's checks; its own cwd just has to exist.
    const child = this.spawnFn(inv.command, inv.args, { cwd: spec.cwd, env: SUDO_ENV, stdio: ["pipe", "pipe", "pipe"] });
    // A refused call exits before reading stdin: never let the EPIPE become an unhandled 'error'.
    child.stdin?.on("error", () => undefined);
    if (inv.preamble) child.stdin?.write(inv.preamble);
    return this.wrap(child, mode);
  }

  /** Signals the target of sudo process `pid` (fire and forget). */
  signal(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): void {
    this.fireAndForget(() => signalInvocation(this.cfg, pid, signal), { pid }, "could not signal an agent process");
  }

  /** Removes a Claude process's temp directory through the wrapper's `rmtmp` mode (fire and forget). */
  removeTmp(dir: string): void {
    this.fireAndForget(() => rmtmpInvocation(this.cfg, dir), { dir }, "could not remove a Claude process's temp directory");
  }

  private fireAndForget(build: () => { command: string; args: string[] }, ctx: Record<string, unknown>, failed: string): void {
    try {
      const inv = build();
      const child = this.spawnFn(inv.command, inv.args, { cwd: "/", env: SUDO_ENV, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin?.end();
      let stderr = "";
      child.on("error", (err) => this.log?.warn({ ...ctx, err: errorMessage(err) }, failed));
      child.on("exit", (code) => {
        if (code) this.log?.warn({ ...ctx, code, stderr: redactSecrets(stderr.trim()).slice(0, 500) }, failed);
      });
      child.stdout?.resume();
      child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-2000)));
    } catch (err) {
      this.log?.warn({ ...ctx, err: errorMessage(err) }, failed);
    }
  }

  private wrap(child: ChildProcess, mode: AgentMode): AgentProcess {
    let killed = false;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const proc = {
      get pid() {
        return child.pid;
      },
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr,
      get killed() {
        return killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: (signal: NodeJS.Signals | number = "SIGTERM"): boolean => {
        if (exited() || child.pid === undefined) return false;
        killed = true;
        this.signal(child.pid, signal);
        return true;
      },
      on(event: string, listener: (...a: never[]) => void) {
        child.on(event, listener as (...a: unknown[]) => void);
        return proc;
      },
      once(event: string, listener: (...a: never[]) => void) {
        child.once(event, listener as (...a: unknown[]) => void);
        return proc;
      },
      off(event: string, listener: (...a: never[]) => void) {
        child.off(event, listener as (...a: unknown[]) => void);
        return proc;
      },
    };
    child.on("error", (err) => this.log?.warn({ mode, err: errorMessage(err) }, "agent process error"));
    return proc as unknown as AgentProcess;
  }

  /** Runs a short agent command to completion (stdout, stderr, exit code); never throws. */
  run(mode: AgentMode, spec: AgentCommandSpec, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
    return new Promise((resolve) => {
      let p: AgentProcess;
      try {
        p = this.spawn(mode, spec);
      } catch (err) {
        resolve({ code: null, stdout: "", stderr: "", error: errorMessage(err) });
        return;
      }
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (code: number | null, error: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, error });
      };
      const timer = setTimeout(() => {
        p.kill("SIGTERM");
        finish(null, `${mode} timed out after ${Math.round(timeoutMs / 1000)} s`);
      }, timeoutMs);
      timer.unref?.();
      p.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString("utf8")).slice(-1024 * 1024)));
      p.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-8000)));
      p.on("error", (err) => finish(null, errorMessage(err)));
      p.on("exit", (code) => finish(code, null));
      p.stdin.end();
    });
  }

  /**
   * Runs one prepared wrapper invocation (fetchInvocation & co.) to completion; never throws. `signal` / the timeout end
   * it through the wrapper's `signal` mode.
   */
  runInvocation(inv: { command: string; args: string[] }, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(inv.command, inv.args, { cwd: "/", env: SUDO_ENV, stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        resolve({ code: null, stdout: "", stderr: "", error: errorMessage(err) });
        return;
      }
      child.stdin?.on("error", () => undefined);
      child.stdin?.end();
      let stdout = "";
      let stderr = "";
      let done = false;
      const stop = () => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) this.signal(child.pid, "SIGTERM");
      };
      const finish = (code: number | null, error: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ code, stdout, stderr, error });
      };
      const onAbort = () => {
        stop();
        finish(null, "cancelled");
      };
      const timer = setTimeout(() => {
        stop();
        finish(null, `timed out after ${Math.round(timeoutMs / 1000)} s`);
      }, timeoutMs);
      timer.unref?.();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (d: Buffer) => (stdout = (stdout + d.toString("utf8")).slice(-64 * 1024)));
      child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-8000)));
      child.on("error", (err) => finish(null, errorMessage(err)));
      child.on("exit", (code) => finish(code, null));
    });
  }

  /** file + argv for node-pty (tmux attach): no stdin preamble on a terminal. */
  ptyCommand(mode: "tmux", spec: AgentCommandSpec): { file: string; args: string[] } {
    const inv = agentInvocation(this.cfg, mode, spec);
    return { file: inv.command, args: inv.args };
  }

  /**
   * Agent SDK options that start Claude Code through the wrapper. `pathToClaudeCodeExecutable` only has to look like a
   * native binary (the SDK then passes the CLI flags alone); the wrapper picks the real one. `onChild`: pid / stderr.
   */
  claudeOptions(onChild?: (p: AgentProcess) => void): { pathToClaudeCodeExecutable: string; spawnClaudeCodeProcess: (o: SpawnOptions) => SpawnedProcess } {
    return {
      pathToClaudeCodeExecutable: this.cfg.exec,
      spawnClaudeCodeProcess: (o: SpawnOptions): SpawnedProcess => {
        const p = this.spawn("claude", { cwd: o.cwd ?? fail("claude: no cwd"), args: o.args, env: o.env });
        // The SDK aborts only after its stdin-EOF grace; never hand the signal to spawn() (it would kill sudo).
        o.signal?.addEventListener("abort", () => p.kill("SIGTERM"), { once: true });
        // The wrapper created the process's temp directory; it goes when the process does.
        const tmp = o.env?.CLAUDE_CODE_TMPDIR;
        if (typeof tmp === "string" && isProcessTmpDir(tmp)) p.on("exit", () => this.removeTmp(tmp));
        onChild?.(p);
        return p;
      },
    };
  }
}
