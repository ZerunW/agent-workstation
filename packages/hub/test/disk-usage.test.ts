import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { DiskMonitor, diskLevel } from "../src/disk/monitor.js";
import { ensureTranscriptRetention, deleteTranscripts } from "../src/sessions/claudeFiles.js";
import { computeUsageDelta, UsageLimitsService } from "../src/sessions/usage.js";
import { ruleMatches, rulesFromSuggestions } from "../src/sessions/rules.js";
import { toCommandInfos } from "../src/sessions/catalog.js";
import { usageBuckets } from "../src/sessions/usageReports.js";
import { parseConfig, candidateConfigPaths } from "../src/config.js";
import { silentLogger } from "../src/util/log.js";
import { RecordingBus } from "../src/ws/protocol.js";
import { tempDir } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("disk levels", () => {
  it("maps percentages to levels", () => {
    expect(diskLevel(10, 80, 95)).toBe("ok");
    expect(diskLevel(80, 80, 95)).toBe("warn");
    expect(diskLevel(94.9, 80, 95)).toBe("warn");
    expect(diskLevel(95, 80, 95)).toBe("block");
  });

  it("broadcasts disk_status only on level transitions", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const bus = new RecordingBus();
    bus.users = ["alice"];
    let used = 50;
    const thresholds = { warn: 80, block: 95 };
    const m = new DiskMonitor({
      usersRoot: t.dir,
      claudeHome: join(t.dir, "claude"),
      store,
      bus,
      log: silentLogger,
      thresholds: () => thresholds,
      listUsers: () => ["alice"],
      isAdmin: () => false,
      statfs: async () => ({ totalBytes: 1000, freeBytes: 1000 - used * 10, usedPercent: used }),
      du: async (paths) => new Map(paths.map((p) => [p, 4096])),
    });
    expect(await m.check()).toBe("ok");
    expect(bus.ofType("disk_status")).toHaveLength(0);
    used = 60;
    await m.check();
    expect(bus.ofType("disk_status")).toHaveLength(0);
    used = 85;
    expect(await m.check()).toBe("warn");
    used = 86;
    await m.check();
    expect(bus.ofType("disk_status").map((e) => e.status.level)).toEqual(["warn"]);
    used = 97;
    expect(await m.check()).toBe("block");
    used = 40;
    expect(await m.check()).toBe("ok");
    expect(bus.ofType("disk_status").map((e) => e.status.level)).toEqual(["warn", "block", "ok"]);
    // thresholds changed by admin re-evaluate immediately
    thresholds.warn = 30;
    await m.thresholdsChanged();
    expect(m.level).toBe("warn");
    const st = await m.statusForFresh("alice");
    expect(st.breakdown.map((b) => b.label)).toEqual(["Inbox", "Projects", "Project history", "Chat", "Claude transcripts"]);
    expect(st.breakdown[0]!.bytes).toBe(4096);
  });
});

describe("Claude files (iron rule)", () => {
  it("sets cleanupPeriodDays only when absent and merges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-home-"));
    expect(await ensureTranscriptRetention(dir, silentLogger)).toBe("set");
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ cleanupPeriodDays: 36500 });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", cleanupPeriodDays: 99 }));
    expect(await ensureTranscriptRetention(dir, silentLogger)).toBe("present");
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ theme: "dark", cleanupPeriodDays: 99 });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }));
    await ensureTranscriptRetention(dir, silentLogger);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ theme: "dark", cleanupPeriodDays: 36500 });
    writeFileSync(join(dir, "settings.json"), "{ not json");
    expect(await ensureTranscriptRetention(dir, silentLogger)).toBe("skipped");
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{ not json");
  });

  it("deletes only the transcripts of the given session ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-home-"));
    const id = "11111111-2222-3333-4444-555555555555";
    const other = "99999999-2222-3333-4444-555555555555";
    mkdirSync(join(dir, "projects", "-srv-a", id), { recursive: true });
    writeFileSync(join(dir, "projects", "-srv-a", `${id}.jsonl`), "x");
    writeFileSync(join(dir, "projects", "-srv-a", `${other}.jsonl`), "y");
    const removed = await deleteTranscripts(dir, [id, "../../etc"], silentLogger);
    expect(removed).toHaveLength(2);
    expect(readFileSync(join(dir, "projects", "-srv-a", `${other}.jsonl`), "utf8")).toBe("y");
  });
});

describe("usage parsing", () => {
  it("computes deltas from cumulative totals", () => {
    const mu = (i: number, o: number, c: number) => ({ m: { inputTokens: i, outputTokens: o, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: c } });
    const a = computeUsageDelta(null, mu(4, 9, 0.4));
    expect(a.deltas).toEqual([{ model: "m", input: 4, output: 9, cacheRead: 0, cacheCreate: 0, cost: 0.4 }]);
    const b = computeUsageDelta(a.next, mu(6, 16, 0.55));
    expect(b.deltas[0]).toMatchObject({ input: 2, output: 7 });
    expect(b.deltas[0]!.cost).toBeCloseTo(0.15);
    // unchanged totals (e.g. a /usage local command) → no rows
    expect(computeUsageDelta(b.next, mu(6, 16, 0.55)).deltas).toEqual([]);
    // models absent from a result keep their previous totals
    expect(computeUsageDelta(b.next, {}).next.models.m).toMatchObject({ input: 6 });
  });

  it("serves only the API credit row and broadcasts it", () => {
    const bus = new RecordingBus();
    const svc = new UsageLimitsService({ bus, log: silentLogger });
    expect(svc.current()).toEqual({ api: null });
    const row = { spentUsd: 1, limitUsd: 10, percent: 10, periodStart: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z", severity: "normal" as const };
    svc.setApiSource(() => row);
    expect(svc.current()).toEqual({ api: row });
    svc.broadcast();
    expect(bus.ofType("usage_limits")).toEqual([{ type: "usage_limits", limits: { api: row } }]);
    svc.setApiSource(() => {
      throw new Error("boom");
    });
    expect(svc.current()).toEqual({ api: null });
  });

  it("buckets usage by local day and hour", () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const now = new Date();
    const turn = (at: Date, input: number) => store.insertTurn({ sessionId: "s", user: "alice", kind: "chat", model: "m", inputTokens: input, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.01, durationMs: 1, at: at.toISOString() });
    turn(new Date(now.getTime() - 60_000), 10);
    turn(new Date(now.getTime() - 120_000), 5);
    turn(new Date(now.getTime() - 3 * 86400_000), 7);
    turn(new Date(now.getTime() - 40 * 86400_000), 99);
    const week = usageBuckets(store, "7d", "alice", now);
    expect(week.reduce((s, b) => s + b.inputTokens, 0)).toBe(22);
    expect(week.every((b) => new Date(b.bucket).getHours() === 0)).toBe(true);
    const today = usageBuckets(store, "today", "alice", now);
    expect(today.reduce((s, b) => s + b.inputTokens, 0)).toBeGreaterThanOrEqual(new Date(now.getTime() - 120_000).getDate() === now.getDate() ? 15 : 0);
  });
});

describe("permission rules", () => {
  it("matches Bash prefixes, exact commands, globs and domains", () => {
    const cwd = "/w";
    expect(ruleMatches({ toolName: "Bash", ruleContent: "npm test:*" }, "Bash", { command: "npm test -- --run" }, cwd)).toBe(true);
    expect(ruleMatches({ toolName: "Bash", ruleContent: "npm test:*" }, "Bash", { command: "npm testx" }, cwd)).toBe(false);
    expect(ruleMatches({ toolName: "Bash", ruleContent: "npm test:*" }, "Bash", { command: "npm test && rm -rf /" }, cwd)).toBe(false);
    expect(ruleMatches({ toolName: "Bash", ruleContent: "git status" }, "Bash", { command: "git status" }, cwd)).toBe(true);
    expect(ruleMatches({ toolName: "Bash", ruleContent: null }, "Bash", { command: "anything" }, cwd)).toBe(true);
    expect(ruleMatches({ toolName: "Bash", ruleContent: null }, "Edit", { command: "anything" }, cwd)).toBe(false);
    expect(ruleMatches({ toolName: "Edit", ruleContent: "src/**" }, "Edit", { file_path: "/w/src/a/b.ts" }, cwd)).toBe(true);
    expect(ruleMatches({ toolName: "Edit", ruleContent: "src/*.ts" }, "Edit", { file_path: "/w/src/a/b.ts" }, cwd)).toBe(false);
    expect(ruleMatches({ toolName: "WebFetch", ruleContent: "domain:example.com" }, "WebFetch", { url: "https://docs.example.com/x" }, cwd)).toBe(true);
    expect(ruleMatches({ toolName: "WebFetch", ruleContent: "domain:example.com" }, "WebFetch", { url: "https://evilexample.com" }, cwd)).toBe(false);
  });

  it("derives rules from SDK suggestions", () => {
    expect(rulesFromSuggestions("Bash", [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }] }])).toEqual([{ toolName: "Bash", ruleContent: "npm test:*" }]);
    expect(rulesFromSuggestions("Edit", undefined)).toEqual([{ toolName: "Edit", ruleContent: null }]);
  });
});

describe("catalog + config", () => {
  it("filters CLI-only commands and flags skills", () => {
    const cmds = toCommandInfos([
      { name: "compact", description: "c", argumentHint: "", builtin: true },
      { name: "/login", description: "l", argumentHint: "", builtin: true },
      { name: "doctor", description: "d", argumentHint: "", builtin: true },
      { name: "skill-x", description: "s", argumentHint: "<a>" },
      { name: "skill-y", description: "y", argumentHint: "", builtin: false },
    ]);
    expect(cmds).toEqual([
      { name: "compact", description: "c" },
      { name: "skill-x", description: "s", argumentHint: "<a>", isSkill: true },
      { name: "skill-y", description: "y", isSkill: true },
    ]);
  });

  it("parses TOML with defaults and env overrides; load order is env → ./config → /etc", () => {
    const c = parseConfig(`[server]\nport = 9100\n[sessions]\nmax_active_processes = 2\n[status]\nport = 1`, "/x.toml", {});
    expect(c.server.port).toBe(9100);
    expect(c.sessions).toMatchObject({ maxActiveProcesses: 2, minFreeMemMib: 1536, idleMinutes: 10, permissionTimeoutS: 600 });
    expect(c.paths.usersRoot).toBe("/srv/agent-workstation/users");
    expect(c.limits).toMatchObject({ diskWarnPercent: 80, diskBlockPercent: 95, remoteClaudeEnabled: true });
    const e = parseConfig({}, null, { WORKSTATION_HUB_PORT: "9999", WORKSTATION_USERS_ROOT: "/tmp/u" });
    expect(e.server.port).toBe(9999);
    expect(e.paths.usersRoot).toBe("/tmp/u");
    expect(() => parseConfig(`[limits]\ndisk_warn_percent = 96`, null, {})).toThrow(/lower/);
    expect(candidateConfigPaths({ WORKSTATION_CONFIG: "/a/b.toml" }, "/cwd")).toEqual(["/a/b.toml", "/cwd/config/workstation.toml", "/etc/agent-workstation/workstation.toml"]);
    expect(candidateConfigPaths({}, "/cwd")).toEqual(["/cwd/config/workstation.toml", "/etc/agent-workstation/workstation.toml"]);
  });

  it("reads only the WORKSTATION_* overrides and the key file setting", () => {
    expect(candidateConfigPaths({ HUB_CONFIG: "/other.toml" }, "/cwd")).toEqual(["/cwd/config/workstation.toml", "/etc/agent-workstation/workstation.toml"]);
    const ignored = parseConfig({}, null, { HUB_PORT: "9001", USERS_ROOT: "/srv/other/users" });
    expect(ignored.server.port).toBe(9000);
    expect(ignored.paths.usersRoot).toBe("/srv/agent-workstation/users");
    const set = parseConfig({}, null, { WORKSTATION_HUB_PORT: "9002", WORKSTATION_CLAUDE_BIN: "" });
    expect(set.server.port).toBe(9002);
    expect(set.paths.claudeBin).toBe(""); // empty = bundled binary
    expect(parseConfig({}, null, {}).auth.anthropicApiKeyFile).toBe("/etc/agent-workstation/anthropic.env");
    expect(parseConfig({ auth: { anthropic_api_key_file: "/k.env" } }, null, {}).auth.anthropicApiKeyFile).toBe("/k.env");
  });
});
