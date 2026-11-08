import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKUserMessage } from "../src/sessions/sdk.js";
import { totalmem } from "node:os";
import { join } from "node:path";
import { TIMEOUT_DENY_MESSAGE } from "../src/sessions/permissions.js";
import { workstationGuide } from "../src/sessions/guide.js";
import { VISUAL_GUIDANCE } from "../src/sessions/visual.js";
import type { FakeQuery } from "./fakeSdk.js";
import { msgBody, runtimeFixture, tick, until, type RuntimeFixture } from "./helpers.js";

let fx: RuntimeFixture;
afterEach(() => fx?.cleanup());

const kinds = (f: RuntimeFixture, id: string) => f.store.listMessages(id, 0, 1000).map((m) => (m.kind === "system" ? `system:${JSON.parse(m.payload).subtype}` : m.kind));
const status = (f: RuntimeFixture, id: string) => f.sessions.statusOf(id).status;

describe("spawn and message flow", () => {
  it("spawns lazily on the first message, feeds our uuid, and persists in order", async () => {
    fx = runtimeFixture();
    const id = fx.newSession();
    expect(fx.sdk.queries).toHaveLength(0);

    const body = msgBody("hello");
    const r = await fx.sessions.send(id, body);
    expect(r).toMatchObject({ state: "accepted", position: null, seq: 1 });
    await until(() => status(fx, id) === "idle" && fx.store.getSession(id)!.lastSeq >= 4, 3000, "turn end");

    expect(fx.sdk.queries).toHaveLength(1);
    const q = fx.sdk.last;
    expect(q.options.resume).toBeUndefined();
    // A chat: the web tools, plus sandboxed commands and file tools in its own folder.
    expect(q.options.tools).toEqual(["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    // Chat runs the CLI in default mode so canUseTool sees every call; the session itself never asks (dontAsk).
    expect(q.options.permissionMode).toBe("default");
    expect(fx.store.getSession(id)!.permissionMode).toBe("dontAsk");
    expect(q.options.includePartialMessages).toBe(true);
    expect(q.options.settings).toMatchObject({ cleanupPeriodDays: 36500 });
    expect((q.options.env as Record<string, string>).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
    expect(q.received[0]!.uuid).toBe(body.uuid);

    expect(kinds(fx, id)).toEqual(["user", "system:init", "assistant", "result"]);
    const rows = fx.store.listMessages(id, 0, 100);
    expect(rows.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(rows[0]!.uuid).toBe(body.uuid);
    expect(rows[0]!.delivery).toBe("sent");
    expect(fx.store.getSession(id)!.claudeSessionId).toBe(q.sessionId);

    // Deltas were broadcast and folded; the partial is clear after the turn.
    const deltas = fx.bus.ofType("delta").filter((d) => d.delta.part === "text");
    expect(deltas.map((d) => (d.delta.part === "text" ? d.delta.text : "")).join("")).toBe("echo: hello");
    expect(fx.sessions.snapshot(id).partial.text).toBe("");
    // Auto-title from the first message.
    expect(fx.store.getSession(id)!.title).toBe("hello");
  });

  it("reuses the live process for later turns and runs one turn at a time", async () => {
    fx = runtimeFixture();
    const id = fx.newSession();
    let release: (() => void) | null = null;
    fx.sdk.behavior = (q, m) => {
      const text = String(m.message.content);
      if (text === "slow") {
        release = () => q.reply("slow done");
        return;
      }
      q.reply(`echo: ${text}`);
    };
    await fx.sessions.send(id, msgBody("slow"));
    await until(() => release, 2000, "slow turn started");
    await fx.sessions.send(id, msgBody("second"));
    await tick(30);
    // second is held hub-side until the first turn's result
    expect(fx.sdk.last.received).toHaveLength(1);
    expect(status(fx, id)).toBe("running");
    release!();
    await until(() => fx.sdk.last.received.length === 2 && status(fx, id) === "idle", 3000, "second turn");
    expect(fx.sdk.queries).toHaveLength(1);
    const users = fx.store.listMessages(id, 0, 100).filter((m) => m.kind === "user");
    expect(users.map((m) => m.delivery)).toEqual(["sent", "sent"]);
  });

  it("dedupes a re-POSTed uuid and an echoed user message", async () => {
    fx = runtimeFixture();
    const id = fx.newSession();
    fx.sdk.behavior = (q, m) => {
      // Echo the user message back (some SDK modes replay user input).
      q.emit({ ...m, session_id: q.sessionId, isReplay: true });
      q.reply("hi");
    };
    const body = msgBody("once");
    const a = await fx.sessions.send(id, body);
    await until(() => status(fx, id) === "idle" && fx.store.getSession(id)!.lastSeq >= 4);
    const b = await fx.sessions.send(id, body);
    expect(b.seq).toBe(a.seq);
    await tick(30);
    const users = fx.store.listMessages(id, 0, 100).filter((m) => m.kind === "user");
    expect(users).toHaveLength(1);
    expect(fx.sdk.last.received).toHaveLength(1);
  });

  it("reads a project's settings files, hooks and MCP servers only with project_settings on", async () => {
    fx = runtimeFixture({ projectSettings: () => true });
    const id = fx.newSession("code");
    fx.sdk.behavior = (q) => {
      q.init();
      q.reply("done");
    };
    await fx.sessions.send(id, msgBody("run it"));
    await until(() => status(fx, id) === "idle");
    expect(fx.sdk.last.options.settingSources).toEqual(["project"]);
    expect(fx.sdk.last.options.strictMcpConfig).toBeUndefined();
    expect((fx.sdk.last.options.settings as { disableAllHooks?: boolean }).disableAllHooks).toBeUndefined();
  });

  it("persists tool-result user messages and code-session options", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    fx.sdk.behavior = (q) => {
      q.init();
      q.emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, parent_tool_use_id: null, uuid: randomUUID(), session_id: q.sessionId });
      q.reply("done");
    };
    await fx.sessions.send(id, msgBody("run it"));
    await until(() => status(fx, id) === "idle" && fx.store.getSession(id)!.lastSeq >= 5);
    const q = fx.sdk.last;
    // No settings file is read (unless [sessions] project_settings is on); hooks and project MCP servers stay off as well.
    expect(q.options.settingSources).toEqual([]);
    expect(q.options.strictMcpConfig).toBe(true);
    expect((q.options.settings as { disableAllHooks?: boolean }).disableAllHooks).toBe(true);
    // The Claude Code preset plus the Agent Workstation guide for exactly this session: no browser, history or memories.
    const guide = workstationGuide({
      kind: "code",
      memory: false,
      history: false,
      incognito: false,
      browser: false,
      readAttachments: false,
      agentAccount: false,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      cwdAbs: join(fx.root, "alice"),
      cwdRel: "",
      projectName: null,
      subagents: true,
      subagent: false,
      now: new Date(),
    });
    expect(q.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: guide });
    expect(guide).toContain(VISUAL_GUIDANCE);
    expect(q.options.tools).toBeUndefined();
    expect(q.options.allowDangerouslySkipPermissions).toBe(true);
    expect(kinds(fx, id).filter((k) => k === "user")).toHaveLength(2);
  });
});

describe("resume, usage accounting and reconciliation", () => {
  it("turns cumulative modelUsage into per-turn deltas across a resume", async () => {
    fx = runtimeFixture();
    const id = fx.newSession();
    fx.sdk.behavior = (q) => q.reply("a", { input: 10, output: 5, cost: 0.1 });
    await fx.sessions.send(id, msgBody("one"));
    await until(() => status(fx, id) === "idle" && fx.store.getSession(id)!.turnCount === 1);
    const claudeId = fx.store.getSession(id)!.claudeSessionId!;

    await fx.sessions.close(id);
    expect(fx.sdk.queries[0]!.closed).toBe(true);

    fx.sdk.behavior = (q) => q.reply("b", { input: 5, output: 4, cost: 0.05 });
    await fx.sessions.send(id, msgBody("two"));
    await until(() => fx.store.getSession(id)!.turnCount === 2);
    expect(fx.sdk.queries).toHaveLength(2);
    expect(fx.sdk.last.options.resume).toBe(claudeId);

    const turns = fx.store.db.prepare("SELECT input_tokens, output_tokens, cost_usd FROM turns WHERE session_id = ? ORDER BY id").all(id) as { input_tokens: number; output_tokens: number; cost_usd: number }[];
    expect(turns.map((t) => [t.input_tokens, t.output_tokens])).toEqual([
      [10, 5],
      [5, 4],
    ]);
    expect(turns[1]!.cost_usd).toBeCloseTo(0.05);
    expect(fx.store.getSession(id)!.costUsd).toBeCloseTo(0.15);

    // Totals going down (e.g. after /clear) count as a fresh start.
    fx.sdk.behavior = (q) => {
      q.init();
      q.emitResultWithTotals({ input: 3, output: 1, cost: 0.01 });
    };
    await fx.sessions.send(id, msgBody("three"));
    await until(() => fx.store.getSession(id)!.turnCount === 3);
    const last = fx.store.db.prepare("SELECT input_tokens, output_tokens FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(id) as { input_tokens: number; output_tokens: number };
    expect([last.input_tokens, last.output_tokens]).toEqual([3, 1]);
  });

  it("imports transcript messages the hub missed when it resumes", async () => {
    fx = runtimeFixture();
    const id = fx.newSession();
    await fx.sessions.send(id, msgBody("one"));
    await until(() => status(fx, id) === "idle" && fx.store.getSession(id)!.turnCount === 1);
    await fx.sessions.close(id);
    const s = fx.store.getSession(id)!;
    const known = fx.store.listMessages(id, 0, 100).filter((m) => m.kind === "user" || m.kind === "assistant");
    const missedUuid = randomUUID();
    fx.sdk.transcripts.set(s.claudeSessionId!, [
      ...known.map((m) => ({ type: m.kind as "user" | "assistant", uuid: m.uuid, session_id: s.claudeSessionId!, message: {}, parent_tool_use_id: null, parent_agent_id: null })),
      { type: "assistant", uuid: missedUuid, session_id: s.claudeSessionId!, message: { role: "assistant", content: [{ type: "text", text: "missed" }] }, parent_tool_use_id: null, parent_agent_id: null },
      { type: "user", uuid: randomUUID(), session_id: s.claudeSessionId!, message: { role: "user", content: "<local-command-stdout>x</local-command-stdout>" }, parent_tool_use_id: null, parent_agent_id: null },
    ]);
    await fx.sessions.send(id, msgBody("two"));
    await until(() => fx.store.getSession(id)!.turnCount === 2);
    const rows = fx.store.listMessages(id, 0, 100);
    const missed = rows.find((m) => m.uuid === missedUuid);
    expect(missed).toBeTruthy();
    // inserted before the new user message was fed? It is inserted at spawn time, after the new user row.
    expect(rows.filter((m) => m.payload.includes("local-command-stdout"))).toHaveLength(0);
  });
});

describe("permissions", () => {
  function permissionBehavior(f: RuntimeFixture, results: unknown[]) {
    f.sdk.behavior = async (q) => {
      q.init();
      const r = await q.askPermission("Bash", { command: "npm test" });
      results.push(r);
      q.reply("after permission");
    };
  }

  it("holds requests across reconnects, resends them in snapshots, first answer wins", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    const results: unknown[] = [];
    permissionBehavior(fx, results);
    await fx.sessions.send(id, msgBody("test please"));
    const req = await until(() => fx.bus.ofType("permission_request")[0], 2000, "permission_request");
    expect(status(fx, id)).toBe("requires_action");
    // "Tab closed and reopened": nothing is tied to a connection; the snapshot re-sends it.
    expect(fx.sessions.snapshot(id).pendingPermission?.requestId).toBe(req.request.requestId);
    await tick(20);
    expect(fx.sessions.snapshot(id).pendingPermission?.requestId).toBe(req.request.requestId);

    const first = fx.sessions.respondPermission("alice", id, { requestId: req.request.requestId, behavior: "allow" });
    const second = fx.sessions.respondPermission("alice", id, { requestId: req.request.requestId, behavior: "deny" });
    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({ ok: false, code: "permission_not_found" });
    await until(() => results.length === 1);
    expect(results[0]).toMatchObject({ behavior: "allow", updatedInput: { command: "npm test" } });
    expect(fx.bus.ofType("permission_resolved")).toHaveLength(1);
    await until(() => status(fx, id) === "idle");
  });

  it("rejects answers from another user", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    const results: unknown[] = [];
    permissionBehavior(fx, results);
    await fx.sessions.send(id, msgBody("x"));
    const req = await until(() => fx.bus.ofType("permission_request")[0]);
    expect(fx.sessions.respondPermission("mallory", id, { requestId: req.request.requestId, behavior: "allow" })).toMatchObject({ ok: false });
    fx.sessions.respondPermission("alice", id, { requestId: req.request.requestId, behavior: "deny", message: "no" });
    await until(() => results.length === 1);
    expect(results[0]).toMatchObject({ behavior: "deny", message: "no" });
  });

  it("times out to deny with interrupt", async () => {
    fx = runtimeFixture({}, { permissionTimeoutMs: 60 });
    const id = fx.newSession("code");
    const results: unknown[] = [];
    permissionBehavior(fx, results);
    await fx.sessions.send(id, msgBody("x"));
    await until(() => results.length === 1, 2000, "timeout");
    expect(results[0]).toEqual({ behavior: "deny", message: TIMEOUT_DENY_MESSAGE, interrupt: true });
    expect(fx.bus.ofType("permission_resolved")[0]).toMatchObject({ behavior: "deny" });
    expect(fx.sessions.snapshot(id).pendingPermission).toBeNull();
  });

  it("cancels on the SDK's abort signal", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    const ac = new AbortController();
    let result: unknown = null;
    fx.sdk.behavior = async (q) => {
      q.init();
      result = await q.askPermission("Edit", { file_path: "x.txt" }, ac.signal);
      q.reply("aborted");
    };
    await fx.sessions.send(id, msgBody("x"));
    await until(() => fx.bus.ofType("permission_request").length === 1);
    ac.abort();
    await until(() => result);
    expect(fx.bus.ofType("permission_cancelled")).toHaveLength(1);
    expect(result).toMatchObject({ behavior: "deny" });
  });

  it("remembers 'always allow' rules hub-side (session scope)", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    const results: unknown[] = [];
    permissionBehavior(fx, results);
    await fx.sessions.send(id, msgBody("x"));
    const req = await until(() => fx.bus.ofType("permission_request")[0]);
    fx.sessions.respondPermission("alice", id, { requestId: req.request.requestId, behavior: "allow", remember: "session" });
    await until(() => results.length === 1 && status(fx, id) === "idle");
    // Respawn (rules must survive the process) and ask again: no prompt this time.
    await fx.sessions.close(id);
    await fx.sessions.send(id, msgBody("y"));
    await until(() => results.length === 2);
    expect(fx.bus.ofType("permission_request")).toHaveLength(1);
    expect(results[1]).toMatchObject({ behavior: "allow" });
    // Another session of the same user still asks.
    const other = fx.newSession("code");
    await fx.sessions.send(other, msgBody("z"));
    await until(() => fx.bus.ofType("permission_request").length === 2);
  });
});

describe("pool: queueing and the memory gate", () => {
  it("queues when the pool is full and never evicts a running turn", async () => {
    fx = runtimeFixture({}, { max: 1 });
    const a = fx.newSession();
    const b = fx.newSession();
    const releases = new Map<FakeQuery, () => void>();
    fx.sdk.behavior = (q, m) => {
      if (String(m.message.content) === "hold") releases.set(q, () => q.reply("released"));
      else q.reply("quick");
    };
    await fx.sessions.send(a, msgBody("hold"));
    await until(() => releases.size === 1);
    const r = await fx.sessions.send(b, msgBody("quick please"));
    expect(r).toMatchObject({ state: "queued", position: 1 });
    expect(status(fx, b)).toBe("queued");
    expect(fx.store.getSession(b)!.status).toBe("queued");
    expect(fx.bus.ofType("session_state").some((e) => e.sessionId === b && e.status === "queued" && e.queuePosition === 1)).toBe(true);
    await tick(50);
    expect(fx.sdk.queries).toHaveLength(1); // a is running: not evicted

    [...releases.values()][0]!();
    // a's turn ends → b reclaims a's idle slot immediately
    await until(() => fx.sdk.queries.length === 2, 3000, "b spawned");
    expect(fx.sdk.queries[0]!.closed).toBe(true);
    await until(() => status(fx, b) === "idle" && fx.store.getSession(b)!.turnCount === 1);
    expect(fx.sessions.pool.activeCount).toBe(1);
  });

  it("does not start processes while MemAvailable is below the floor", async () => {
    fx = runtimeFixture({}, { max: 4, minFree: 1536 });
    fx.mem.available = 512;
    const id = fx.newSession();
    const r = await fx.sessions.send(id, msgBody("hi"));
    expect(r.state).toBe("queued");
    await tick(30);
    expect(fx.sdk.queries).toHaveLength(0);
    fx.mem.available = 4096;
    fx.sessions.pool.pump();
    await until(() => status(fx, id) === "idle" && fx.store.getSession(id)!.turnCount === 1, 3000, "spawn after memory freed");
    expect(fx.sdk.queries).toHaveLength(1);
  });

  it("swaps out an idle process when memory is low", async () => {
    fx = runtimeFixture({}, { max: 4, minFree: 1536 });
    const a = fx.newSession();
    await fx.sessions.send(a, msgBody("first"));
    await until(() => status(fx, a) === "idle" && fx.store.getSession(a)!.turnCount === 1);
    fx.mem.available = 100;
    const b = fx.newSession();
    const r = await fx.sessions.send(b, msgBody("second"));
    expect(r.state).toBe("accepted");
    await until(() => fx.store.getSession(b)!.turnCount === 1);
    expect(fx.sdk.queries[0]!.closed).toBe(true);
  });

  it("reaps idle processes after idle_minutes", async () => {
    fx = runtimeFixture({}, { idleMs: 40 });
    const id = fx.newSession();
    await fx.sessions.send(id, msgBody("hi"));
    await until(() => fx.sdk.last.closed, 2000, "idle reap");
    expect(fx.sessions.pool.activeCount).toBe(0);
  });
});

describe("stop, close, death", () => {
  it("stop interrupts the turn and cancels queued messages", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    fx.sdk.behavior = (q, m) => {
      q.init();
      q.onInterrupt = (qq) => qq.emit({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], errors: [], uuid: randomUUID(), session_id: qq.sessionId });
      void m;
    };
    await fx.sessions.send(id, msgBody("long task"));
    await until(() => fx.sdk.queries.length === 1 && fx.sdk.last.received.length === 1);
    await fx.sessions.send(id, msgBody("queued behind"));
    const s = await fx.sessions.stop(id);
    expect(fx.sdk.last.interrupted).toBe(1);
    expect(fx.sdk.last.closed).toBe(false);
    expect(s.status).toBe("idle");
    const cancelled = fx.store.listMessages(id, 0, 100).find((m) => m.payload.includes("hub_cancelled"));
    expect(cancelled).toBeTruthy();
    expect(fx.store.listMessages(id, 0, 100).filter((m) => m.kind === "user").map((m) => m.delivery)).toEqual(["sent", "cancelled"]);
  });

  it("closes the process when interrupt gets no result within the grace period", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    fx.sdk.behavior = (q) => q.init(); // never finishes, ignores interrupt
    await fx.sessions.send(id, msgBody("hang"));
    await until(() => fx.sdk.last.received.length === 1);
    await fx.sessions.stop(id);
    expect(fx.sdk.last.closed).toBe(true);
    expect(fx.store.listMessages(id, 0, 100).some((m) => m.payload.includes("hub_stop_timeout"))).toBe(true);
    expect(status(fx, id)).toBe("idle");
    // next message respawns with resume
    fx.sdk.behavior = (q) => q.reply("back");
    await fx.sessions.send(id, msgBody("again"));
    await until(() => fx.sdk.queries.length === 2 && status(fx, id) === "idle" && fx.store.getSession(id)!.turnCount === 1);
    expect(fx.sdk.last.options.resume).toBe(fx.sdk.queries[0]!.sessionId);
  });

  it("marks the session dead when the process dies mid-turn and respawns on the next message", async () => {
    fx = runtimeFixture();
    const id = fx.newSession();
    fx.sdk.behavior = (q) => {
      q.init();
      q.fail(new Error("Claude Code process exited with code 1"));
    };
    await fx.sessions.send(id, msgBody("boom"));
    await until(() => status(fx, id) === "dead", 2000, "dead");
    expect(fx.store.getSession(id)!.status).toBe("dead");
    expect(fx.store.listMessages(id, 0, 100).some((m) => m.payload.includes("hub_process_died"))).toBe(true);
    expect(fx.bus.ofType("error").some((e) => e.code === "process_died")).toBe(true);
    expect(fx.sessions.pool.activeCount).toBe(0);

    fx.sdk.behavior = (q) => q.reply("alive again");
    await fx.sessions.send(id, msgBody("retry"));
    await until(() => status(fx, id) === "idle" && fx.store.getSession(id)!.turnCount === 1, 3000, "recovered");
    expect(fx.sdk.queries).toHaveLength(2);
    expect(fx.sdk.last.options.resume).toBe(fx.sdk.queries[0]!.sessionId);
  });

  it("treats a stream that ends mid-turn as a death", async () => {
    fx = runtimeFixture();
    const id = fx.newSession();
    fx.sdk.behavior = (q) => {
      q.init();
      q.end();
    };
    await fx.sessions.send(id, msgBody("x"));
    await until(() => status(fx, id) === "dead");
  });
});

describe("live settings", () => {
  it("applies model / permission mode / effort to the live process and broadcasts", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    await fx.sessions.send(id, msgBody("hi"));
    await until(() => status(fx, id) === "idle" && fx.store.getSession(id)!.turnCount === 1);
    const s = await fx.sessions.updateSettings(id, { model: "haiku", permissionMode: "acceptEdits", effort: "high" });
    expect(s).toMatchObject({ model: "haiku", permissionMode: "acceptEdits", effort: "high" });
    const q = fx.sdk.last;
    expect(q.models).toEqual(["haiku"]);
    expect(q.modes).toEqual(["acceptEdits"]);
    expect(q.flags).toEqual([{ effortLevel: "high" }]);
    expect(fx.bus.ofType("session_settings").at(-1)).toMatchObject({ settings: { model: "haiku", permissionMode: "acceptEdits", effort: "high" } });

    // The SDK reporting a mode change (e.g. auto → default after a model switch) is written back.
    q.emit({ type: "system", subtype: "status", status: null, permissionMode: "default", uuid: randomUUID(), session_id: q.sessionId });
    await until(() => fx.store.getSession(id)!.permissionMode === "default");

    // Clearing effort sends null.
    await fx.sessions.updateSettings(id, { effort: null });
    expect(q.flags.at(-1)).toEqual({ effortLevel: null });
  });

  it("uses settings at spawn when no process is alive", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    await fx.sessions.updateSettings(id, { model: "sonnet", effort: "low", permissionMode: "plan" });
    await fx.sessions.send(id, msgBody("hi"));
    await until(() => fx.sdk.queries.length === 1);
    expect(fx.sdk.last.options).toMatchObject({ model: "sonnet", effort: "low", permissionMode: "plan" });
  });
});

describe("restart recovery", () => {
  it("marks sessions idle and undelivered messages cancelled", () => {
    fx = runtimeFixture();
    const id = fx.newSession();
    fx.store.updateSession(id, { status: "running" });
    const user: SDKUserMessage = { type: "user", message: { role: "user", content: "x" }, parent_tool_use_id: null };
    fx.store.appendMessage(id, { uuid: randomUUID(), kind: "user", payload: user, delivery: "pending" });
    fx.sessions.recoverAfterRestart();
    expect(fx.store.getSession(id)!.status).toBe("idle");
    const rows = fx.store.listMessages(id, 0, 10);
    expect(rows[0]!.delivery).toBe("cancelled");
    expect(rows[1]!.payload).toContain("hub_restart");
  });
});
