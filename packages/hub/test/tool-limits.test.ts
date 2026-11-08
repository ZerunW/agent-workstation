/**
 * Loose per-command limits: `[sessions] tool_memory_limit_mb` (default 0 = off) becomes Claude Code's
 * CLAUDE_CODE_TOOL_MEMORY_LIMIT in the inline settings' `env` of Claude code sessions and chats with their own folder;
 * the hub's unit does not delegate its cgroup (limits off). Also: api_requests rows of databases from before the docs assistant survive the
 * table rebuild that makes session_id nullable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { Store } from "../src/db/store.js";
import { toolLimitEnv } from "../src/sessions/codeSandbox.js";
import { msgBody, runtimeFixture, tempDir, until, type RuntimeFixture } from "./helpers.js";

let fx: RuntimeFixture | null = null;
const cleanups: (() => void)[] = [];
afterEach(() => {
  fx?.cleanup();
  fx = null;
  for (const c of cleanups.splice(0)) c();
});

const settingsOf = async (f: RuntimeFixture, kind: "chat" | "code") => {
  const id = f.newSession(kind);
  const before = f.sdk.queries.length;
  await f.sessions.send(id, msgBody("build it"));
  await until(() => f.sdk.queries.length > before);
  return f.sdk.last.options.settings as unknown as { env: Record<string, string>; sandbox: Record<string, unknown> };
};

describe("tool memory limit", () => {
  it("toolLimitEnv: MiB with the CLI's m suffix; 0 or nonsense sets nothing", () => {
    expect(toolLimitEnv(3072)).toEqual({ CLAUDE_CODE_TOOL_MEMORY_LIMIT: "3072m" });
    expect(toolLimitEnv(0)).toEqual({});
    expect(toolLimitEnv(-1)).toEqual({});
    expect(toolLimitEnv(1.5)).toEqual({});
  });

  it("config: [sessions] tool_memory_limit_mb, off by default", () => {
    expect(parseConfig({}, null, {}).sessions.toolMemoryLimitMb).toBe(0);
    expect(parseConfig({ sessions: { tool_memory_limit_mb: 3072 } }, null, {}).sessions.toolMemoryLimitMb).toBe(3072);
    expect(() => parseConfig({ sessions: { tool_memory_limit_mb: -5 } }, null, {})).toThrow();
  });

  it("set in the settings env of Claude code sessions and chats with their own folder, next to the sandbox", async () => {
    fx = runtimeFixture({ toolMemoryLimitMb: () => 3072 });
    for (const kind of ["code", "chat"] as const) {
      const s = await settingsOf(fx, kind);
      expect(s.env.CLAUDE_CODE_TOOL_MEMORY_LIMIT).toBe("3072m");
      expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
      // The package caches / folder env stay.
      expect(Object.keys(s.env).length).toBeGreaterThan(1);
    }
  });

  it("absent while off (the default)", async () => {
    fx = runtimeFixture({ toolMemoryLimitMb: () => 0 });
    for (const kind of ["code", "chat"] as const) expect((await settingsOf(fx, kind)).env).not.toHaveProperty("CLAUDE_CODE_TOOL_MEMORY_LIMIT");
    fx.cleanup();
    fx = runtimeFixture();
    expect((await settingsOf(fx, "code")).env).not.toHaveProperty("CLAUDE_CODE_TOOL_MEMORY_LIMIT");
  });

  it("the hub's unit does not delegate its cgroup while the limits are off (see deploy/README.md)", () => {
    const unit = readFileSync(join(import.meta.dirname, "..", "..", "..", "deploy", "systemd", "workstation-hub.service"), "utf8");
    expect(unit).not.toMatch(/^Delegate=/m);
    // Still only the hub process is signalled on stop (tmux servers and Claude processes survive a restart).
    expect(unit).toMatch(/^KillMode=process$/m);
  });
});

describe("api_requests migration", () => {
  it("rebuilds an old table (session_id NOT NULL, no purpose) keeping rows and ids; hub rows without a session fit", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "hub.sqlite");
    const old = new Database(file);
    old.exec(`CREATE TABLE api_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session_id TEXT NOT NULL, user TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, cache_read INTEGER NOT NULL,
      output INTEGER NOT NULL, web_search_requests INTEGER NOT NULL, speed TEXT, cost_usd REAL NOT NULL, complete INTEGER NOT NULL)`);
    old.prepare("INSERT INTO api_requests VALUES (7, '2026-10-01T00:00:00.000Z', 'sess-1', 'alice', 'claude-opus-5-5', 10, 0, 0, 0, 5, 0, NULL, 0.25, 1)").run();
    old.close();

    const store = new Store(file);
    try {
      const cols = store.db.prepare("PRAGMA table_info(api_requests)").all() as { name: string; notnull: number }[];
      expect(cols.find((c) => c.name === "session_id")!.notnull).toBe(0);
      expect(cols.some((c) => c.name === "purpose")).toBe(true);
      const range = ["2000-01-01", "2100-01-01"] as const;
      expect(store.listApiRequests(...range)).toEqual([expect.objectContaining({ id: 7, sessionId: "sess-1", user: "alice", purpose: null, costUsd: 0.25, complete: true })]);
      store.insertApiRequest({ at: "2026-10-02T00:00:00.000Z", sessionId: null, user: "_readme", purpose: "readme", model: "claude-sonnet-5-5", input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, webSearchRequests: 0, speed: null, costUsd: 0.5, complete: true });
      expect(store.apiSpend(...range)).toBeCloseTo(0.75, 10);
      expect(store.apiSpendByUser(...range).get("_readme")).toBeCloseTo(0.5, 10);
    } finally {
      store.close();
    }
    // Opening it again changes nothing.
    const again = new Store(file);
    expect(again.listApiRequests("2000-01-01", "2100-01-01")).toHaveLength(2);
    again.close();
  });
});
