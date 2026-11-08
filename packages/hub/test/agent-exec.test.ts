import { execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { Store } from "../src/db/store.js";
import { createHub, stopHub } from "../src/hub.js";
import { AgentExec, agentInvocation, AgentExecError, rmtmpInvocation, signalInvocation, validateClaudeArgs, type AgentRunAs, type SpawnFn } from "../src/sessions/agentExec.js";
import { createProcessTmpDir, isProcessTmpDir, newProcessTmpDir, removeProcessTmpDir } from "../src/sessions/processTmp.js";
import { TerminalService, type SocketLike } from "../src/terminal/pty.js";
import { silentLogger } from "../src/util/log.js";
import { FakeSdk } from "./fakeSdk.js";
import { msgBody, runtimeFixture, tempDir, until, type RuntimeFixture } from "./helpers.js";

const REPO = resolve(fileURLToPath(import.meta.url), "../../../..");
const UUID = "0f4c1e2a-3b5d-4c6e-8f70-1a2b3c4d5e6f";
const cfg: AgentRunAs = { user: "workstation-agent", exec: "/opt/agent-workstation/bin/workstation-agent-exec", sudo: "/usr/bin/sudo", workRoot: "/srv/agent-workstation/users" };
const SUDO = ["-n", "-u", "workstation-agent", "--", "/opt/agent-workstation/bin/workstation-agent-exec"];
/** A key proxy token (hsk- + 32 bytes base64url): what an API-billed Claude process gets instead of the key. */
const TOKEN = "hsk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A spawn() stand-in: records every call; each child exits with `code` once its stdin ends. */
function fakeSpawn(reply: (args: readonly string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: () => string; child: ChildProcess }[] = [];
  const fn: SpawnFn = (command, args, opts) => {
    const child = new EventEmitter() as ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null; pid: number };
    const stdin = new PassThrough();
    let written = "";
    stdin.on("data", (d: Buffer) => (written += d.toString("utf8")));
    Object.assign(child, { pid: 4242 + calls.length, stdin, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    stdin.on("finish", () => {
      const r = reply(args);
      if (r.stdout) child.stdout!.push(r.stdout);
      child.stdout!.push(null);
      child.stderr!.push(null);
      setImmediate(() => {
        child.exitCode = r.code ?? 0;
        child.emit("exit", child.exitCode, null);
      });
    });
    calls.push({ command, args: [...args], cwd: opts.cwd, env: opts.env, stdin: () => written, child });
    return child;
  };
  return { fn, calls };
}


const BRW = '"browser":{"type":"http","url":"http://127.0.0.1:45173/mcp/alice","headers":{"Authorization":"Bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456","X-Workstation-Session":"0f4c1e2a-3b5d-4c6e-8f70-1a2b3c4d5e6f"}}';
describe("agent spawn helper: the exact sudo/wrapper argv", () => {
  const claudeArgs = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--model=opus", "--permission-prompt-tool=stdio", `--resume=${UUID}`, "--setting-sources=project", "--allow-dangerously-skip-permissions", "--permission-mode=bypassPermissions", "--add-dir=/srv/agent-workstation/users/alice"];

  it("Claude: allowlisted environment only, the key proxy token on stdin (never in argv)", () => {
    const inv = agentInvocation(cfg, "claude", {
      cwd: "/srv/agent-workstation/users/alice/proj",
      args: claudeArgs,
      env: { PATH: "/usr/bin", HOME: "/home/workstation", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.316", CLAUDE_CONFIG_DIR: "/home/workstation-agent/.claude", ANTHROPIC_API_KEY: TOKEN, ANTHROPIC_BASE_URL: "http://127.0.0.1:41234", ANTHROPIC_AUTH_TOKEN: "tok", CLAUDE_CODE_SHELL_PREFIX: "evil", LD_PRELOAD: "/x.so", NOPE: undefined },
    });
    expect(inv.command).toBe("/usr/bin/sudo");
    expect(inv.args).toEqual([...SUDO, "claude", "/srv/agent-workstation/users/alice/proj", "--env", "ANTHROPIC_BASE_URL=http://127.0.0.1:41234", "--env", "CLAUDE_AGENT_SDK_VERSION=0.3.316", "--env", "CLAUDE_CODE_ENTRYPOINT=sdk-ts", "--stdin-secrets", "--", ...claudeArgs]);
    expect(inv.preamble).toBe(`ANTHROPIC_API_KEY=${TOKEN}\0\0`);
    expect(inv.args.join(" ")).not.toMatch(/hsk-|tok|evil|LD_PRELOAD/);
  });

  it("Claude: refuses a real API key, a malformed token, a token without the proxy and any other base URL", () => {
    const at = (env: Record<string, string>) => () => agentInvocation(cfg, "claude", { cwd: "/srv/agent-workstation/users", args: ["--verbose"], env });
    const base = "http://127.0.0.1:41234";
    expect(at({ ANTHROPIC_API_KEY: "sk-ant-api03-abc_DEF", ANTHROPIC_BASE_URL: base })).toThrow(/real Anthropic API key/);
    expect(at({ ANTHROPIC_API_KEY: `sk-ant-${TOKEN.slice(4)}`, ANTHROPIC_BASE_URL: base })).toThrow(/real Anthropic API key/);
    for (const bad of [`${TOKEN}x`, TOKEN.slice(0, -1), "hsk-short", `xsk-${TOKEN.slice(4)}`, `${TOKEN.slice(0, -2)}/x`]) expect(at({ ANTHROPIC_API_KEY: bad, ANTHROPIC_BASE_URL: base }), bad).toThrow(/malformed/);
    expect(at({ ANTHROPIC_API_KEY: TOKEN })).toThrow(/needs ANTHROPIC_BASE_URL/);
    for (const url of ["http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:08080", "http://127.0.0.1", "http://127.0.0.1:8080/", "http://127.0.0.1:8080/v1", "https://127.0.0.1:8080", "http://localhost:8080", "http://127.0.0.2:8080", "http://[::1]:8080", "http://127.0.0.1:8080@evil.example", "http://evil.example:80"]) {
      expect(at({ ANTHROPIC_BASE_URL: url }), url).toThrow(/ANTHROPIC_BASE_URL must be/);
    }
    expect(agentInvocation(cfg, "claude", { cwd: "/srv/agent-workstation/users", args: ["--verbose"], env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:65535" } }).args).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:65535");
    // Other modes never get it.
    expect(agentInvocation(cfg, "tmux", { cwd: "/srv/agent-workstation/users", args: ["list-sessions", "-F", "#{session_name}"], env: { ANTHROPIC_BASE_URL: base } }).args.join(" ")).not.toContain("ANTHROPIC_BASE_URL");
  });

  it("claude --version: no stdin secrets", () => {
    expect(agentInvocation(cfg, "claude", { cwd: "/srv/agent-workstation/users", args: ["--version"] })).toEqual({ command: "/usr/bin/sudo", args: [...SUDO, "claude", "/srv/agent-workstation/users", "--", "--version"], preamble: null });
  });

  it("tmux: the terminal calls, with the terminal's environment", () => {
    const args = ["new-session", "-d", "-s", "term-alice-Ab3x9QzP", "-c", "/srv/agent-workstation/users/alice", "-x", "120", "-y", "32", "/bin/bash"];
    expect(agentInvocation(cfg, "tmux", { cwd: "/srv/agent-workstation/users/alice", args, env: { LANG: "C.UTF-8", TERM: "xterm-256color", WORKSTATION_USER: "alice", HOME: "/x" } }).args).toEqual([
      ...SUDO,
      "tmux",
      "/srv/agent-workstation/users/alice",
      "--env",
      "LANG=C.UTF-8",
      "--env",
      "TERM=xterm-256color",
      "--env",
      "WORKSTATION_USER=alice",
      "--",
      ...args,
    ]);
    expect(signalInvocation(cfg, 1234, "SIGKILL")).toEqual({ command: "/usr/bin/sudo", args: [...SUDO, "signal", "KILL", "1234"] });
    expect(signalInvocation(cfg, 1234).args.at(-2)).toBe("TERM");
  });

  it("claude: the server browser's MCP endpoint (exact hub shape) passes next to sdk servers", () => {
    expect(() => validateClaudeArgs(["--mcp-config", `{"mcpServers":{"workstation-visual":{"type":"sdk","name":"workstation-visual"},${BRW}}}`], "/srv/agent-workstation/users")).not.toThrow();
    expect(() => validateClaudeArgs(["--mcp-config", JSON.stringify({ mcpServers: { browser: { type: "http", url: "http://127.0.0.1:1/mcp/bob", headers: { Authorization: `Bearer ${"x".repeat(43)}` } } } })], "/srv/agent-workstation/users")).not.toThrow();
  });

  it("claude: only <plugins dir>/<uuid>/(project|workstation) passes as --plugin-dir or --plugin-dir-no-mcp", () => {
    const root = "/srv/agent-workstation/users";
    const dir = "/var/lib/agent-workstation-plugins";
    const id = "0123abcd-4567-89ab-cdef-0123456789ab";
    for (const flag of ["--plugin-dir", "--plugin-dir-no-mcp"]) {
      expect(() => validateClaudeArgs([`${flag}=${dir}/${id}/workstation`, flag, `${dir}/${id}/project`], root, dir), flag).not.toThrow();
      for (const bad of [`${dir}/${id}`, `${dir}/${id}/other`, `${dir}/${id}/project/skills`, `${dir}/not-a-uuid/project`, `${dir}/${id}/../${id}/project`, `${dir}-x/${id}/project`, `${root}/alice/proj`, `${root}/~hub/${id}/project`, `${dir}//${id}/project`, `${dir}/${id}/project/`, "/etc"]) {
        expect(() => validateClaudeArgs([`${flag}=${bad}`], root, dir), `${flag} ${bad}`).toThrow();
      }
      // no plugins dir configured: never
      expect(() => validateClaudeArgs([`${flag}=${dir}/${id}/project`], root)).toThrow();
    }
  });

  it.each([
    ["claude --plugin-dir inside a project", "claude", "/srv/agent-workstation/users/alice", ["--plugin-dir", "/srv/agent-workstation/users/alice"]],
    ["claude --debug-file", "claude", "/srv/agent-workstation/users/alice", ["--debug-file=/srv/agent-workstation/users/x"]],
    ["claude a stdio MCP server", "claude", "/srv/agent-workstation/users/alice", ["--mcp-config", '{"mcpServers":{"x":{"type":"stdio","command":"sh"}}}']],
    ["claude the browser MCP on another host", "claude", "/srv/agent-workstation/users/alice", ["--mcp-config", `{"mcpServers":{${BRW.replace("127.0.0.1", "10.0.0.1")}}}`]],
    ["claude the browser MCP on another path", "claude", "/srv/agent-workstation/users/alice", ["--mcp-config", `{"mcpServers":{${BRW.replace("/mcp/alice", "/x")}}}`]],
    ["claude a second http MCP server", "claude", "/srv/agent-workstation/users/alice", ["--mcp-config", `{"mcpServers":{${BRW},${BRW.replace('"browser"', '"other"')}}}`]],
    ["claude an MCP url without a type", "claude", "/srv/agent-workstation/users/alice", ["--mcp-config", '{"mcpServers":{"x":{"url":"http://evil.example/"}}}']],
    ["claude a settings file", "claude", "/srv/agent-workstation/users/alice", ["--settings", "/etc/passwd"]],
    ["claude --add-dir outside the root", "claude", "/srv/agent-workstation/users/alice", ["--add-dir=/etc"]],
    ["claude --add-dir with ..", "claude", "/srv/agent-workstation/users/alice", ["--add-dir=/srv/agent-workstation/users/../../etc"]],
    ["claude a bad --resume", "claude", "/srv/agent-workstation/users/alice", ["--resume=../x"]],
    ["claude a flag without value", "claude", "/srv/agent-workstation/users/alice", ["--model"]],
    ["claude a positional prompt", "claude", "/srv/agent-workstation/users/alice", ["-p", "hi"]],
    ["claude auth login", "claude", "/srv/agent-workstation/users", ["auth", "login"]],
    ["claude auth status", "claude", "/srv/agent-workstation/users", ["auth", "status", "--json"]],
    ["claude cwd outside the root", "claude", "/home/workstation", ["--verbose"]],
    ["claude a relative cwd", "claude", "alice", ["--verbose"]],
    ["claude a cwd beside the root", "claude", "/srv/agent-workstation/users-other", ["--verbose"]],
    ["tmux kill-server", "tmux", "/srv/agent-workstation/users", ["kill-server"]],
    ["tmux send-keys", "tmux", "/srv/agent-workstation/users", ["send-keys", "-t", "=term-a-b", "rm -rf ~", "Enter"]],
    ["tmux another shell", "tmux", "/srv/agent-workstation/users/alice", ["new-session", "-d", "-s", "term-alice-x", "-c", "/srv/agent-workstation/users/alice", "-x", "120", "-y", "32", "/usr/bin/python3"]],
    ["tmux a session dir outside the root", "tmux", "/srv/agent-workstation/users/alice", ["new-session", "-d", "-s", "term-alice-x", "-c", "/tmp", "-x", "120", "-y", "32", "/bin/bash"]],
    ["tmux a bad session name", "tmux", "/srv/agent-workstation/users", ["has-session", "-t", "=x;rm"]],
  ] as const)("refuses %s", (_name, mode, cwd, args) => {
    expect(() => agentInvocation(cfg, mode, { cwd, args })).toThrow(AgentExecError);
  });

  it("refuses an API key outside Claude or malformed", () => {
    expect(() => agentInvocation(cfg, "tmux", { cwd: "/srv/agent-workstation/users", args: ["list-sessions", "-F", "#{session_name}"], env: { ANTHROPIC_API_KEY: "sk" } })).toThrow(/only for Claude/);
    expect(() => agentInvocation(cfg, "claude", { cwd: "/srv/agent-workstation/users", args: ["--verbose"], env: { ANTHROPIC_API_KEY: "sk bad\nkey" } })).toThrow(/malformed/);
  });
});

describe("agent processes", () => {
  it("writes the stdin secrets before the target's input, and kill() goes through the wrapper's signal mode", async () => {
    const sp = fakeSpawn();
    const exec = new AgentExec(cfg, silentLogger, sp.fn);
    const ac = new AbortController();
    const opts = exec.claudeOptions();
    expect(opts.pathToClaudeCodeExecutable).toBe(cfg.exec);
    const p = opts.spawnClaudeCodeProcess({ command: "/ignored/claude", args: ["--verbose", "--input-format", "stream-json"], cwd: "/srv/agent-workstation/users/alice", env: { ANTHROPIC_API_KEY: TOKEN, ANTHROPIC_BASE_URL: "http://127.0.0.1:41234", PATH: "/x" }, signal: ac.signal });
    expect(sp.calls[0]!.command).toBe("/usr/bin/sudo");
    expect(sp.calls[0]!.args).toEqual([...SUDO, "claude", "/srv/agent-workstation/users/alice", "--env", "ANTHROPIC_BASE_URL=http://127.0.0.1:41234", "--stdin-secrets", "--", "--verbose", "--input-format", "stream-json"]);
    expect(sp.calls[0]!.env).toEqual({ PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" });
    p.stdin.write('{"type":"user"}\n');
    expect(sp.calls[0]!.stdin()).toBe(`ANTHROPIC_API_KEY=${TOKEN}\0\0{"type":"user"}\n`);

    expect(p.kill("SIGTERM")).toBe(true);
    expect(p.killed).toBe(true);
    expect(sp.calls[1]!.args).toEqual([...SUDO, "signal", "TERM", "4242"]);
    ac.abort();
    expect(sp.calls[2]!.args).toEqual([...SUDO, "signal", "TERM", "4242"]);
    const exited = new Promise((r) => p.on("exit", r));
    p.stdin.end();
    await exited;
    expect(p.exitCode).toBe(0);
    expect(p.kill("SIGTERM")).toBe(false); // already gone: nothing to signal
    expect(sp.calls).toHaveLength(3);
  });

  it("a Claude process's private temp directory: validated, TMPDIR only as that directory, removed through the wrapper on exit", async () => {
    const tmp = newProcessTmpDir();
    expect(tmp).toMatch(/^\/tmp\/hs\/[A-Za-z0-9_-]{22}$/);
    const base = { cwd: "/srv/agent-workstation/users/alice", args: ["--verbose"] };
    expect(agentInvocation(cfg, "claude", { ...base, env: { CLAUDE_CODE_TMPDIR: tmp, TMPDIR: tmp } }).args).toEqual([...SUDO, "claude", base.cwd, "--env", `CLAUDE_CODE_TMPDIR=${tmp}`, "--env", `TMPDIR=${tmp}`, "--", "--verbose"]);
    // The hub's own TMPDIR (or one without a process temp directory) never passes.
    expect(agentInvocation(cfg, "claude", { ...base, env: { CLAUDE_CODE_TMPDIR: tmp, TMPDIR: "/tmp" } }).args).toEqual([...SUDO, "claude", base.cwd, "--env", `CLAUDE_CODE_TMPDIR=${tmp}`, "--", "--verbose"]);
    expect(agentInvocation(cfg, "claude", { ...base, env: { TMPDIR: tmp } }).args.join(" ")).not.toContain("TMPDIR");
    for (const bad of ["/tmp/workstation-chats/0f4c1e2a-3b5d-4c6e-8f70-1a2b3c4d5e6f", "/tmp", "/tmp/hs/short", `${tmp}/x`, "/tmp/hs/../../etc/aaaaaaaaaaaaaaaa"]) {
      expect(() => agentInvocation(cfg, "claude", { ...base, env: { CLAUDE_CODE_TMPDIR: bad } }), bad).toThrow(/CLAUDE_CODE_TMPDIR/);
    }
    expect(() => rmtmpInvocation(cfg, "/tmp/hs/../x")).toThrow(AgentExecError);
    expect(rmtmpInvocation(cfg, tmp).args).toEqual([...SUDO, "rmtmp", tmp]);

    const sp = fakeSpawn();
    const exec = new AgentExec(cfg, silentLogger, sp.fn);
    const p = exec.claudeOptions().spawnClaudeCodeProcess({ command: "/ignored/claude", args: ["--verbose"], cwd: base.cwd, env: { CLAUDE_CODE_TMPDIR: tmp }, signal: new AbortController().signal });
    expect(sp.calls).toHaveLength(1);
    const exited = new Promise((r) => p.on("exit", r));
    p.stdin.end();
    await exited;
    await until(() => sp.calls.length === 2);
    expect(sp.calls[1]!.args).toEqual([...SUDO, "rmtmp", tmp]);
    expect(sp.calls[1]!.cwd).toBe("/");
  });

  it("without run_as: the hub creates the temp directory 0700 and removes it with everything in it", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const root = join(t.dir, "hs");
    const dir = newProcessTmpDir(root);
    expect(isProcessTmpDir(dir, root)).toBe(true);
    createProcessTmpDir(dir, root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => createProcessTmpDir(dir, root)).toThrow(); // never reused
    mkdirSync(join(dir, "claude-1000", "proj"), { recursive: true });
    writeFileSync(join(dir, "claude-1000", "proj", "out.txt"), "x");
    removeProcessTmpDir(dir, root);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(root)).toBe(true);
    removeProcessTmpDir(root, root); // not a process temp directory: left alone
    removeProcessTmpDir(undefined, root);
    expect(existsSync(root)).toBe(true);
    expect(() => createProcessTmpDir(join(t.dir, "elsewhere"), root)).toThrow(/not a process temp directory/);
  });

  it("refuses before spawning anything", () => {
    const sp = fakeSpawn();
    const exec = new AgentExec(cfg, silentLogger, sp.fn);
    expect(() => exec.spawn("claude", { cwd: "/srv/agent-workstation/users/alice", args: ["--plugin-dir", "/tmp"] })).toThrow(AgentExecError);
    expect(() => exec.claudeOptions().spawnClaudeCodeProcess({ command: "/usr/bin/node", args: ["/x/cli.js", "--verbose"], cwd: "/srv/agent-workstation/users/alice", env: {}, signal: new AbortController().signal })).toThrow(AgentExecError);
    expect(sp.calls).toHaveLength(0);
  });
});

describe("terminals as the agent account", () => {
  it.skipIf(process.platform !== "linux")("runs every tmux call and the attach pty through sudo + the wrapper", async () => {
    const t = tempDir();
    const store = new Store(":memory:");
    cleanups.push(t.cleanup, () => store.close());
    const root = join(t.dir, "users");
    const home = join(root, "alice");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(home, { recursive: true });
    const alive = new Set<string>();
    const sp = fakeSpawn((args) => {
      const sub = args[args.lastIndexOf("--") + 1];
      const name = args.at(-1)!.replace(/^=/, "");
      if (sub === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
      if (sub === "list-sessions") return { stdout: [...alive].join("\n") };
      if (sub === "has-session") return { code: alive.has(name) ? 0 : 1 };
      if (sub === "kill-session") alive.delete(name);
      return {};
    });
    const ptys: { file: string; args: string[]; env: Record<string, string>; destroyed: boolean; killed: boolean }[] = [];
    const loadPty = async () =>
      ({
        spawn: (file: string, args: string[], o: { env: Record<string, string> }) => {
          const rec = { file, args, env: o.env, destroyed: false, killed: false };
          ptys.push(rec);
          return { onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, kill: () => (rec.killed = true), destroy: () => (rec.destroyed = true) };
        },
      }) as never;
    const svc = new TerminalService({ store, log: silentLogger, enabled: () => true, shell: "/bin/bash", userRoot: () => home, loadPty, agentExec: new AgentExec({ ...cfg, workRoot: root }, silentLogger, sp.fn) });
    await svc.init();
    expect(svc.mode).toBe("tmux");
    expect(sp.calls[0]!.args).toEqual([...SUDO, "tmux", root, "--env", `LANG=${process.env.LANG || "C.UTF-8"}`, "--", "list-sessions", "-F", "#{session_name}"]);

    const created = await svc.create("alice", true, "");
    const name = `term-alice-${created.id}`;
    expect(sp.calls[1]!.args.slice(5, 7)).toEqual(["tmux", home]);
    expect(sp.calls[1]!.args.slice(sp.calls[1]!.args.lastIndexOf("--"))).toEqual(["--", "new-session", "-d", "-s", name, "-c", home, "-x", "120", "-y", "32", "/bin/bash"]);

    const ws = Object.assign(new EventEmitter(), { readyState: 1, send: () => undefined, close: () => undefined }) as unknown as SocketLike & EventEmitter;
    await svc.attach("alice", true, created.id, ws);
    expect(ptys[0]!.file).toBe("/usr/bin/sudo");
    expect(ptys[0]!.args.slice(ptys[0]!.args.lastIndexOf("--"))).toEqual(["--", "attach-session", "-t", `=${name}`]);
    expect(ptys[0]!.args).toContain("WORKSTATION_USER=alice");
    expect(Object.keys(ptys[0]!.env).sort()).toEqual(["COLORTERM", "LANG", "TERM", "WORKSTATION_USER"]);
    ws.emit("close");
    // The hub may not signal the root-owned sudo: the pty is closed (hang-up) instead.
    expect(ptys[0]!.destroyed).toBe(true);
    expect(ptys[0]!.killed).toBe(false);

    await svc.remove("alice", created.id);
    expect(sp.calls.at(-1)!.args.slice(-3)).toEqual(["kill-session", "-t", `=${name}`]);
    expect(alive.size).toBe(0);
    svc.shutdown();
  });
});

describe("[agents] run_as", () => {
  it("empty (default) keeps the old path: hub-owned homes, the configured claude binary, no wrapper", async () => {
    const c = parseConfig({}, null, { CLAUDE_CONFIG_DIR: "/cfg/claude" });
    expect(c.agents).toEqual({ runAs: "", exec: "/opt/agent-workstation/bin/workstation-agent-exec", sudo: "/usr/bin/sudo", home: "" });
    expect(c.paths.claudeHome).toBe("/cfg/claude");

    let fx: RuntimeFixture | null = runtimeFixture({ claudeExecutable: "/usr/local/bin/claude" });
    cleanups.push(() => fx?.cleanup());
    const id = fx.newSession("code");
    await fx.sessions.send(id, msgBody("hi"));
    await until(() => fx!.sdk.queries.length > 0);
    expect(fx.sdk.last.options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    // Spawned by the hub itself, which creates and removes the process's private temp directory (processTmp.ts).
    expect(typeof fx.sdk.last.options.spawnClaudeCodeProcess).toBe("function");
    const env = fx.sdk.last.options.env as Record<string, string | undefined>;
    expect(isProcessTmpDir(env.CLAUDE_CODE_TMPDIR)).toBe(true);
    expect(env.TMPDIR).toBe(env.CLAUDE_CODE_TMPDIR); // code sessions run sandboxed too (codeSandbox.ts)
    fx = null;
  });

  it("set: the agent's homes, and Claude sessions start through the wrapper", async () => {
    const c = parseConfig({ agents: { run_as: "workstation-agent" } }, null, { CLAUDE_CONFIG_DIR: "/cfg/claude" });
    expect(c.agents).toEqual({ runAs: "workstation-agent", exec: "/opt/agent-workstation/bin/workstation-agent-exec", sudo: "/usr/bin/sudo", home: "/home/workstation-agent" });
    expect(c.paths.claudeHome).toBe("/home/workstation-agent/.claude");
    expect(() => parseConfig({ agents: { run_as: "root; rm -rf /" } }, null, {})).toThrow();
    expect(() => parseConfig({ agents: { run_as: "x", exec: "relative/exec" } }, null, {})).toThrow();

    const fx = runtimeFixture({ claudeExecutable: "/usr/local/bin/claude", agentExec: new AgentExec(cfg, silentLogger, fakeSpawn().fn) });
    cleanups.push(() => fx.cleanup());
    const id = fx.newSession("code");
    await fx.sessions.send(id, msgBody("hi"));
    await until(() => fx.sdk.queries.length > 0);
    expect(fx.sdk.last.options.pathToClaudeCodeExecutable).toBe(cfg.exec);
    expect(typeof fx.sdk.last.options.spawnClaudeCodeProcess).toBe("function");
  });

  it("createHub: scratch folders the agent can enter, no hub-side claude binary", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const root = join(t.dir, "users");
    const config = parseConfig({ paths: { users_root: root, data_dir: join(t.dir, "data"), claude_bin: "" }, agents: { run_as: "workstation-agent", home: join(t.dir, "agent") } }, null, {});
    const hub = createHub(config, { log: silentLogger, sdk: new FakeSdk(), dbFile: ":memory:", captureProcess: false });
    cleanups.push(() => stopHub(hub));
    expect(hub.claudeExecutable).toBeUndefined();
    expect(existsSync(join(root, "~hub"))).toBe(true);
    expect(config.paths.claudeHome).toBe(join(t.dir, "agent", ".claude"));
  });
});

const run = (cmd: string, args: string[]) =>
  new Promise<{ code: number; out: string }>((done) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }));
  });
const haveBash = existsSync("/bin/bash") || existsSync("/usr/bin/bash");

describe.skipIf(!haveBash || process.platform !== "linux")("deploy scripts", () => {
  it("every deploy shell script parses (bash -n)", async () => {
    const scripts = [...readdirSync(join(REPO, "deploy")).filter((f) => f.endsWith(".sh")).map((f) => join(REPO, "deploy", f)), join(REPO, "deploy", "workstation-agent-exec"), join(REPO, "deploy", "test", "workstation-agent-exec.test.sh")];
    for (const s of scripts) expect(await run("bash", ["-n", s]), s).toEqual({ code: 0, out: "" });
  });

  it("the wrapper passes its shell test (fake target dir, no sudo)", async () => {
    const r = await run("bash", [join(REPO, "deploy", "test", "workstation-agent-exec.test.sh")]);
    expect(r.out).not.toContain("not ok");
    expect(r.code, r.out).toBe(0);
    if (process.getuid?.() !== 0) expect(r.out).toMatch(/^all \d+ passed$/m);
  }, 60_000);
});
