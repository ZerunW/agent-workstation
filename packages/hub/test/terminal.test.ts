import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { TerminalService } from "../src/terminal/pty.js";
import { silentLogger } from "../src/util/log.js";
import { tempDir } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/** A fake `tmux` that keeps its session list in a text file. */
function fakeTmux(dir: string): { bin: string; state: string; sessions: () => string[] } {
  const state = join(dir, "tmux-state");
  writeFileSync(state, "");
  const bin = join(dir, "tmux");
  writeFileSync(
    bin,
    `#!/bin/sh
STATE="${state}"
case "$1" in
  list-sessions) cat "$STATE"; exit 0 ;;
  has-session) grep -qx "\${3#=}" "$STATE" ;;
  kill-session) grep -vx "\${3#=}" "$STATE" > "$STATE.tmp"; mv "$STATE.tmp" "$STATE" ;;
  new-session) echo "$4" >> "$STATE" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, state, sessions: () => readFileSync(state, "utf8").split("\n").filter(Boolean) };
}

describe("tmux terminals survive hub restarts", () => {
  it("reconciles rows with tmux ls at startup and never kills tmux on shutdown", async () => {
    const t = tempDir();
    const store = new Store(":memory:");
    cleanups.push(() => store.close(), t.cleanup);
    const root = join(t.dir, "alice");
    mkdirSync(root, { recursive: true });
    const tmux = fakeTmux(t.dir);
    writeFileSync(tmux.state, "term-alice-alive001\n");
    store.insertTerminal({ id: "alive001", user: "alice", cwd: "", createdAt: new Date().toISOString(), tmuxSession: "term-alice-alive001" });
    store.insertTerminal({ id: "gone0001", user: "alice", cwd: "", createdAt: new Date().toISOString(), tmuxSession: "term-alice-gone0001" });

    const svc = new TerminalService({ store, log: silentLogger, enabled: () => true, shell: "/bin/sh", userRoot: () => root, tmuxBin: tmux.bin, loadPty: async () => (await import("node-pty")) });
    await svc.init();
    expect(svc.mode).toBe("tmux");
    expect(store.getTerminal("gone0001")).toBeNull(); // marked exited
    expect((await svc.list("alice")).map((x) => x.id)).toEqual(["alive001"]);

    const created = await svc.create("alice", true, "");
    expect(created.tmuxSession).toBe(`term-alice-${created.id}`);
    expect(tmux.sessions()).toContain(created.tmuxSession);

    svc.shutdown();
    expect(tmux.sessions()).toEqual(["term-alice-alive001", created.tmuxSession]);

    // A new hub process: rows are still valid.
    const svc2 = new TerminalService({ store, log: silentLogger, enabled: () => true, shell: "/bin/sh", userRoot: () => root, tmuxBin: tmux.bin, loadPty: async () => (await import("node-pty")) });
    await svc2.init();
    expect((await svc2.list("alice")).map((x) => x.id).sort()).toEqual(["alive001", created.id].sort());

    // Only an explicit DELETE kills the tmux session.
    await svc2.remove("alice", created.id);
    expect(tmux.sessions()).toEqual(["term-alice-alive001"]);
    await expect(svc2.remove("bob", "alive001")).rejects.toMatchObject({ status: 404 });
  });
});
