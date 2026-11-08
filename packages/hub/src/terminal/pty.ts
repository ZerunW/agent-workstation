/**
 * Terminal bridge (web SSH). Each terminal is a tmux session named
 * `term-<user>-<id>` (rows persisted in SQLite); every WebSocket attaches its
 * own node-pty running `tmux attach-session -t =<name>`, so closing the page
 * only detaches and the shell keeps running. Hub restarts do not kill tmux
 * (systemd KillMode=process); startup reconciles rows with `tmux ls`.
 * Only DELETE kills the tmux session.
 *
 * Without tmux (dev Macs) the shell runs directly in a hub-owned pty with a
 * 256 KB scrollback replayed on attach; it does not survive a hub restart.
 *
 * Security note (also in README): this is a real shell as the hub's OS user, or with `[agents] run_as` as the
 * agent account: then every tmux call goes through the agent wrapper (sessions/agentExec.ts), the tmux server and
 * its shells run as that account, and there is no direct mode. Workspace isolation is directory-level only.
 */
import { execFile } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IPty } from "node-pty";
import type { TerminalInfo } from "@agent-workstation/protocol";
import { TerminalClientFrame } from "@agent-workstation/protocol";
import type { Store, TerminalRow } from "../db/store.js";
import { resolveInRoot } from "../files/paths.js";
import type { AgentExec } from "../sessions/agentExec.js";
import { badRequest, errorMessage, forbidden, HttpError, notFound } from "../util/errors.js";
import { shortId } from "../util/ids.js";
import type { Logger } from "../util/log.js";
import { iso } from "../util/time.js";

type PtyModule = typeof import("node-pty");

/** The subset of a `ws` WebSocket used here. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
}

const OPEN = 1;
const SCROLLBACK = 256 * 1024;

interface DirectTerm {
  pty: IPty;
  buffer: string;
  clients: Set<SocketLike>;
}

export interface TerminalDeps {
  store: Store;
  log: Logger;
  enabled: () => boolean;
  shell: string;
  userRoot: (user: string) => string;
  /** Override detection (tests). */
  tmuxBin?: string | null;
  loadPty?: () => Promise<PtyModule>;
  /** `[agents] run_as`: tmux (and so every shell) runs as the agent account through the wrapper. */
  agentExec?: AgentExec | undefined;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * node-pty 1.1.0's macOS prebuild ships `spawn-helper` without the executable
 * bit (npm drops it), which makes every spawn fail with "posix_spawnp failed".
 * Linux builds from source and does not use the helper.
 */
function fixSpawnHelperMode(log: Logger): void {
  try {
    const pkgDir = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    for (const p of [join(pkgDir, "prebuilds", `darwin-${process.arch}`, "spawn-helper"), join(pkgDir, "build", "Release", "spawn-helper")]) {
      if (!existsSync(p)) continue;
      try {
        accessSync(p, constants.X_OK);
      } catch {
        chmodSync(p, 0o755);
        log.info({ path: p }, "made node-pty spawn-helper executable");
      }
    }
  } catch (err) {
    log.debug({ err: errorMessage(err) }, "could not check node-pty spawn-helper");
  }
}

function send(ws: SocketLike, frame: { t: "out"; data: string } | { t: "exit"; code: number | null }): void {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(frame));
}

export class TerminalService {
  private ptyMod: PtyModule | null = null;
  private tmux: string | null = null;
  private initialized = false;
  private initError: string | null = null;
  private readonly direct = new Map<string, DirectTerm>();
  private readonly attached = new Map<string, Set<IPty>>();

  constructor(private readonly deps: TerminalDeps) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      this.ptyMod = await (this.deps.loadPty ?? (() => import("node-pty")))();
      if (process.platform === "darwin") fixSpawnHelperMode(this.deps.log);
    } catch (err) {
      this.initError = `node-pty unavailable: ${errorMessage(err)}`;
      this.deps.log.warn({ err: this.initError }, "terminal disabled");
    }
    // As the agent account the wrapper runs its own tmux (a missing one shows up as failing tmux calls).
    if (this.deps.agentExec) this.tmux = "tmux";
    else if (this.deps.tmuxBin !== undefined) this.tmux = this.deps.tmuxBin;
    else {
      const r = await run("sh", ["-c", "command -v tmux"]);
      this.tmux = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    }
    if (!this.tmux) this.deps.log.warn("tmux not found: terminals run without persistence");
    await this.reconcile();
  }

  /**
   * Startup reconciliation. The hub runs with systemd `KillMode=process`, so
   * tmux servers outlive hub restarts: rows whose tmux session still exists
   * stay valid (clients re-attach), rows whose session is gone are marked exited.
   * Without tmux, nothing survives a restart, so every row is marked exited.
   */
  async reconcile(): Promise<{ kept: number; exited: number }> {
    const rows = this.deps.store.listLiveTerminals();
    let names = new Set<string>();
    if (this.tmux) {
      const r = await this.tmuxRun(["list-sessions", "-F", "#{session_name}"]);
      // Exit code 1 with "no server running" simply means no sessions.
      names = new Set(r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []);
    }
    let kept = 0;
    let exited = 0;
    for (const row of rows) {
      if (this.tmux ? names.has(row.tmuxSession) : this.direct.has(row.id)) kept++;
      else {
        this.deps.store.markTerminalExited(row.id);
        exited++;
      }
    }
    if (rows.length) this.deps.log.info({ kept, exited }, "terminals reconciled with tmux");
    return { kept, exited };
  }

  /** One tmux call: directly, or as the agent account (cwd: the workspace root unless given). */
  private async tmuxRun(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const exec = this.deps.agentExec;
    if (!exec) return run(this.tmux!, args);
    const r = await exec.run("tmux", { cwd: cwd ?? exec.cfg.workRoot, args, env: { LANG: process.env.LANG || "C.UTF-8" } }, 10_000);
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.error ?? r.stderr };
  }

  /** Detaches one tmux client pty. As the agent account the hub may not signal sudo: closing the pty hangs it up. */
  private closePty(p: IPty): void {
    try {
      const destroy = this.deps.agentExec ? (p as IPty & { destroy?: () => void }).destroy : undefined;
      if (destroy) destroy.call(p);
      else p.kill();
    } catch {
      /* ignore */
    }
  }

  get mode(): "tmux" | "direct" | "unavailable" {
    if (!this.ptyMod) return "unavailable";
    return this.tmux ? "tmux" : "direct";
  }

  private check(terminalEnabledForUser: boolean): PtyModule {
    if (!this.deps.enabled()) throw forbidden("terminal_disabled", "the terminal is disabled on this hub");
    if (!terminalEnabledForUser) throw forbidden("terminal_disabled", "the terminal is disabled for this user");
    if (!this.ptyMod) throw new HttpError(503, "terminal_unavailable", this.initError ?? "terminal unavailable");
    return this.ptyMod;
  }

  private env(user: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.LANG = env.LANG || "C.UTF-8";
    env.WORKSTATION_USER = user;
    delete env.TMUX;
    return env;
  }

  private info(r: TerminalRow): TerminalInfo {
    return { id: r.id, cwd: r.cwd, createdAt: r.createdAt, tmuxSession: r.tmuxSession };
  }

  async create(user: string, terminalEnabled: boolean, cwdRel: string | undefined): Promise<TerminalInfo> {
    const pty = this.check(terminalEnabled);
    const root = this.deps.userRoot(user);
    const cwd = await resolveInRoot(root, cwdRel ?? "", { allowRoot: true, mustExist: true });
    if (!(await stat(cwd.abs)).isDirectory()) throw badRequest("invalid_request", "cwd is not a directory");
    const id = shortId(8);
    const name = `term-${user}-${id}`;
    if (this.tmux) {
      const r = await this.tmuxRun(["new-session", "-d", "-s", name, "-c", cwd.abs, "-x", "120", "-y", "32", this.deps.shell], cwd.abs);
      if (r.code !== 0) throw new HttpError(500, "terminal_failed", `tmux: ${r.stderr.trim() || "failed"}`);
    } else {
      const p = pty.spawn(this.deps.shell, ["-l"], { name: "xterm-256color", cols: 120, rows: 32, cwd: cwd.abs, env: this.env(user) });
      const term: DirectTerm = { pty: p, buffer: "", clients: new Set() };
      p.onData((d) => {
        term.buffer = (term.buffer + d).slice(-SCROLLBACK);
        for (const c of term.clients) send(c, { t: "out", data: d });
      });
      p.onExit(({ exitCode }) => {
        for (const c of term.clients) {
          send(c, { t: "exit", code: exitCode });
          c.close(1000, "exited");
        }
        this.direct.delete(id);
        try {
          this.deps.store.markTerminalExited(id);
        } catch {
          /* store already closed during shutdown */
        }
      });
      this.direct.set(id, term);
    }
    const row: TerminalRow = { id, user, cwd: cwd.rel, createdAt: iso(), tmuxSession: name };
    this.deps.store.insertTerminal(row);
    return this.info(row);
  }

  private async alive(r: TerminalRow): Promise<boolean> {
    if (this.tmux) return (await this.tmuxRun(["has-session", "-t", `=${r.tmuxSession}`])).code === 0;
    return this.direct.has(r.id);
  }

  async list(user: string): Promise<TerminalInfo[]> {
    const out: TerminalInfo[] = [];
    for (const r of this.deps.store.listTerminals(user)) {
      if (await this.alive(r)) out.push(this.info(r));
      else this.deps.store.markTerminalExited(r.id); // the shell exited on its own
    }
    return out;
  }

  async remove(user: string, id: string): Promise<void> {
    const r = this.deps.store.getTerminal(id);
    if (!r || r.user !== user) throw notFound("no such terminal");
    for (const p of this.attached.get(id) ?? []) this.closePty(p);
    this.attached.delete(id);
    if (this.tmux) await this.tmuxRun(["kill-session", "-t", `=${r.tmuxSession}`]);
    const d = this.direct.get(id);
    if (d) {
      this.direct.delete(id);
      try {
        d.pty.kill();
      } catch {
        /* ignore */
      }
    }
    this.deps.store.deleteTerminal(id);
  }

  /** Wires a WebSocket to the terminal. Throws HttpError before any frame is sent. */
  async attach(user: string, terminalEnabled: boolean, id: string, ws: SocketLike): Promise<void> {
    const pty = this.check(terminalEnabled);
    const r = this.deps.store.getTerminal(id);
    if (!r || r.user !== user) throw notFound("no such terminal");
    if (!(await this.alive(r))) {
      this.deps.store.markTerminalExited(id);
      throw notFound("terminal has exited");
    }

    if (!this.tmux) {
      const term = this.direct.get(id)!;
      term.clients.add(ws);
      if (term.buffer) send(ws, { t: "out", data: term.buffer });
      ws.on("message", (raw) => this.onFrame(raw, term.pty));
      ws.on("close", () => term.clients.delete(ws));
      return;
    }

    const cwdAbs = (await resolveInRoot(this.deps.userRoot(user), r.cwd, { allowRoot: true })).abs;
    // attach (never create): a session that died must not be resurrected silently.
    const attachArgs = ["attach-session", "-t", `=${r.tmuxSession}`];
    let file = this.tmux;
    let args = attachArgs;
    let env = this.env(user);
    if (this.deps.agentExec) {
      // sudo resets the environment; the wrapper passes on only these.
      env = { TERM: env.TERM!, COLORTERM: env.COLORTERM!, LANG: env.LANG!, WORKSTATION_USER: user };
      try {
        ({ file, args } = this.deps.agentExec.ptyCommand("tmux", { cwd: cwdAbs, args: attachArgs, env }));
      } catch (err) {
        throw new HttpError(500, "terminal_failed", errorMessage(err));
      }
    }
    const p = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: cwdAbs,
      env,
    });
    const set = this.attached.get(id) ?? new Set<IPty>();
    set.add(p);
    this.attached.set(id, set);
    p.onData((d) => send(ws, { t: "out", data: d }));
    p.onExit(({ exitCode }) => {
      set.delete(p);
      send(ws, { t: "exit", code: exitCode });
      ws.close(1000, "detached");
    });
    ws.on("message", (raw) => this.onFrame(raw, p));
    ws.on("close", () => {
      set.delete(p);
      this.closePty(p); // detaches this tmux client only
    });
  }

  private onFrame(raw: unknown, p: IPty): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    } catch {
      return;
    }
    const f = TerminalClientFrame.safeParse(parsed);
    if (!f.success) return;
    try {
      if (f.data.t === "in") p.write(f.data.data);
      else p.resize(Math.min(f.data.cols, 1000), Math.min(f.data.rows, 500));
    } catch (err) {
      this.deps.log.debug({ err: errorMessage(err) }, "pty write/resize failed");
    }
  }

  /**
   * Hub shutdown: detaches every client pty. tmux sessions are NOT killed
   * (only an explicit DELETE does that) so shells survive hub restarts.
   * Direct-mode (no tmux) shells cannot survive and end here.
   */
  shutdown(): void {
    for (const set of this.attached.values()) {
      for (const p of set) this.closePty(p);
    }
    this.attached.clear();
    for (const d of this.direct.values()) {
      try {
        d.pty.kill();
      } catch {
        /* ignore */
      }
    }
    this.direct.clear();
  }
}
