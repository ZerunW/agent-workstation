import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackgroundTask, PermissionRequest, PermissionResponse, Session } from "@agent-workstation/protocol";
import type { Store } from "../src/db/store.js";
import { Pricing } from "../src/pricing.js";
import { historyTools } from "../src/search/history.js";
import { CODE_FOLDER_DENIED, CODE_NETWORK_DENIED, CODE_UNSANDBOXED_DENIED, codeCommandEnv, codeSandbox } from "../src/sessions/codeSandbox.js";
import { SUBAGENT_ROLE_NOTE } from "../src/sessions/guide.js";
import { TIMEOUT_DENY_MESSAGE } from "../src/sessions/permissions.js";
import type { SessionServiceDeps } from "../src/sessions/runtime.js";
import type { HubToolResult, HubToolSpec } from "../src/sessions/sdk.js";
import {
  finalAnswer,
  inArea,
  MAX_SUBAGENT_ANSWER_BYTES,
  normalizeAreaPaths,
  outsideAreaMessage,
  ownedByMessage,
  parseSubagentsInput,
  SUBAGENT_TASK_HEADING,
  SUBAGENTS_DECLINED,
  subagentPrompt,
  subagentResultText,
} from "../src/sessions/subagents.js";
import type { RecordingBus } from "../src/ws/protocol.js";
import type { FakeQuery } from "./fakeSdk.js";
import { hubFixture, msgBody, runtimeFixture, tempDir, until, type HubFixture, type RuntimeFixture } from "./helpers.js";

const RUN = "mcp__workstation_subagent__run_subagents";
const SEP = "\n\n--- subagent ---\n\n";

type Fixture = RuntimeFixture;

let fx: Fixture | null = null;
let h: HubFixture | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  fx?.cleanup();
  fx = null;
  await h?.close();
  h = null;
  for (const c of cleanups.splice(0)) c();
});

function fixture(extra: (b: { store: Store; bus: RecordingBus }) => Partial<SessionServiceDeps> = () => ({}), limits: Partial<RuntimeFixture["limits"]> = {}): Fixture {
  const base = runtimeFixture((b) => extra(b), limits);
  base.store.setPricing(new Pricing());
  return base;
}

type Kind = "chat" | "code";
type Mode = "default" | "acceptEdits" | "bypassPermissions";
function parent(f: Fixture, o: { kind?: Kind; cwd?: string; permissionMode?: Mode; incognito?: boolean; model?: string } = {}): string {
  f.store.ensureUser("alice");
  const kind = o.kind ?? "code";
  const cwd = kind === "chat" ? ".chat" : (o.cwd ?? "");
  mkdirSync(join(f.root, "alice", cwd), { recursive: true });
  return f.sessions.create({
    user: "alice",
    kind,
    cwd,
    model: o.model ?? "opus",
    permissionMode: o.permissionMode ?? "default",
    effort: null,
    ...(o.incognito ? { incognito: true } : {}),
  }).id;
}

const isParentQuery = (q: FakeQuery) => !!q.options.allowedTools?.includes(RUN);
const runTool = (f: Fixture): HubToolSpec => f.sdk.mcpServers.get("workstation_subagent")!.find((t) => t.name === "run_subagents")!;
const textOf = (r: HubToolResult) => (typeof r === "string" ? r : r.text);
const isError = (r: HubToolResult) => typeof r !== "string" && !!r.isError;
const sections = (r: HubToolResult) => textOf(r).split(SEP);
const sessionLine = (text: string) => /^session: ([0-9a-f-]{36})\n\n/.exec(text)?.[1] ?? null;
const turnEnd = (f: Fixture, id: string, n = 1) => until(() => f.store.getSession(id)!.turnCount >= n && f.sessions.statusOf(id).status === "idle", 6000, `turn ${n} of ${id}`);
const tasksOf = (f: Fixture, id: string): BackgroundTask[] => f.bus.ofType("background_tasks").filter((e) => e.sessionId === id).at(-1)?.tasks ?? [];
const cards = (f: Fixture, id: string): PermissionRequest[] => f.bus.ofType("permission_request").map((e) => e.request).filter((r) => r.toolName === RUN && r.sessionId === id);
/** The n-th (1-based) batch card shown in session `id`. */
const card = (f: Fixture, id: string, n = 1) => until(() => cards(f, id)[n - 1], 4000, `batch card ${n}`);
/** Answers the n-th batch card of `id`. */
async function answer(f: Fixture, id: string, behavior: "allow" | "deny" = "allow", extra: Partial<PermissionResponse> = {}, n = 1): Promise<PermissionRequest> {
  const req = await card(f, id, n);
  expect(f.sessions.respondPermission("alice", id, { requestId: req.requestId, behavior, ...extra })).toEqual({ ok: true });
  return req;
}
/** Sends a message to the parent, approves its batch card and waits for the turn to end. */
async function approvedTurn(f: Fixture, id: string, text = "go"): Promise<PermissionRequest> {
  await f.sessions.send(id, msgBody(text));
  const req = await answer(f, id);
  await turnEnd(f, id);
  return req;
}
/** A batch; every agent gets the whole working directory as its area unless it names `paths` (chats ignore them). */
const agents = (...a: Record<string, unknown>[]) => ({ agents: a.map((x) => ({ paths: ["**"], ...x })) });
/** A batch exactly as given (no default `paths`). */
const rawAgents = (...a: Record<string, unknown>[]) => ({ agents: a });
/** The task of a child's first message (a code child's starts with the hub's preamble). */
const taskOf = (text: string): string => {
  const mark = `\n${SUBAGENT_TASK_HEADING}\n\n`;
  const at = text.indexOf(mark);
  return at < 0 ? text : text.slice(at + mark.length);
};

/**
 * Claude parents make the run_subagents `calls` (in parallel, or one after the other) and then answer; Claude
 * children run `child`.
 */
function claudeParent(
  f: Fixture,
  calls: Record<string, unknown>[],
  child: (q: FakeQuery, task: string, message: string) => Promise<void> | void = (q, t) => q.reply(`child answer to: ${t}`),
  o: { sequential?: boolean } = {},
): HubToolResult[] {
  const results: HubToolResult[] = [];
  f.sdk.behavior = async (q, m) => {
    const text = typeof m.message.content === "string" ? m.message.content : "";
    if (!isParentQuery(q)) return child(q, taskOf(text), text);
    q.init();
    const tool = runTool(f);
    if (o.sequential) for (const a of calls) results.push(await tool.handler(a));
    else results.push(...(await Promise.all(calls.map((a) => tool.handler(a)))));
    if (!q.closed) q.reply("parent done");
  };
  return results;
}

describe("run_subagents: the call", () => {
  it("asks once with the filled-in specs, then runs a code child in the parent's cwd with its permission mode, returns the answer and shows it as a background task", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f, { cwd: "work", permissionMode: "acceptEdits" });
    const cwdAbs = join(f.root, "alice", "work");
    let child: FakeQuery | null = null;
    const results = claudeParent(f, [agents({ task: "Write out.txt", description: "Write the file" })], (q) => {
      child = q;
      q.reply("The child did the work.");
    });
    await f.sessions.send(id, msgBody("delegate"));
    const req = await card(f, id);
    // Nothing starts before the answer; the card names the batch with the default model filled in.
    expect(f.store.childSessionIds(id)).toEqual([]);
    expect(req).toMatchObject({ sessionId: id, toolName: RUN, input: { agents: [{ model: "opus", description: "Write the file", task: "Write out.txt" }] } });
    expect(req.suggestions).toBeUndefined();
    expect(f.sessions.statusOf(id).status).toBe("requires_action");
    expect(f.sessions.snapshot(id).pendingPermission).toMatchObject({ requestId: req.requestId, toolName: RUN });
    expect(f.sessions.respondPermission("alice", id, { requestId: req.requestId, behavior: "allow" })).toEqual({ ok: true });
    await turnEnd(f, id);

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(isError(r)).toBe(false);
    const childId = sessionLine(textOf(r))!;
    expect(textOf(r)).toBe(`session: ${childId}\n\nThe child did the work.`);
    expect(cards(f, id)).toHaveLength(1);
    const row = f.store.getSession(childId)!;
    expect(row).toMatchObject({ parentSessionId: id, user: "alice", kind: "code", cwd: "work", model: "opus", permissionMode: "acceptEdits", title: "Write the file", incognito: false });
    expect(f.sessions.toProtocol(row).parentSessionId).toBe(id);
    expect(f.sessions.toProtocol(f.store.getSession(id)!).parentSessionId).toBeNull();
    // The child runs in the parent's directory with the subagent role, without run_subagents or wrap_up.
    const o = child!.options;
    expect(o.cwd).toBe(cwdAbs);
    expect(JSON.stringify(o.systemPrompt)).toContain(SUBAGENT_ROLE_NOTE);
    expect(Object.keys(o.mcpServers ?? {})).not.toContain("workstation_subagent");
    expect(Object.keys(o.mcpServers ?? {})).not.toContain("workstation_turn");

    // Background task of the parent while it ran, completed afterwards.
    const running = f.bus.ofType("background_tasks").find((e) => e.sessionId === id && e.tasks.some((t) => t.status === "running"))!;
    expect(running.tasks[0]).toMatchObject({ taskId: childId, type: "workstation_subagent", description: "Write the file", subagentType: "opus", status: "running" });
    expect(tasksOf(f, id)).toEqual([expect.objectContaining({ taskId: childId, status: "completed", endedAt: expect.any(String) })]);
    expect(f.sessions.snapshot(id).backgroundTasks?.[0]).toMatchObject({ taskId: childId, status: "completed" });
  });

  it("refuses invalid input and models the user may not use (allowlist), without a card or a child", async () => {
    fx = fixture(() => ({ subagentModelAllowed: (_u, model) => model === "sonnet" }));
    const f = fx;
    const id = parent(f);
    const results = claudeParent(
      f,
      [
        agents({ task: "t", model: "haiku", description: "not allowed" }, { task: "t", model: "opus", description: "also not allowed" }, { task: "t", model: "sonnet", description: "allowed" }),
        agents({ task: "t", description: "ok" }, { task: "t", description: "x".repeat(81) }),
        agents(),
        agents(...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ task: "t", description: `d${n}` }))),
        { task: "t", description: "the old single form" },
        agents({ task: "t", model: "sonnet", description: "allowed" }),
      ],
      undefined,
      { sequential: true },
    );
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id);
    await turnEnd(f, id);
    expect(results.map(isError)).toEqual([true, true, true, true, true, false]);
    expect(textOf(results[0]!)).toBe("Not started: agent 1 (not allowed): model haiku is not one the user may use.");
    expect(textOf(results[1]!)).toMatch(/^Not started: agent 2: description is longer than 80/);
    expect(textOf(results[2]!)).toMatch(/^Not started: agents is empty/);
    expect(textOf(results[3]!)).toMatch(/^Not started: at most 6 agents per call/);
    expect(textOf(results[4]!)).toMatch(/^Not started: agents must be a list/);
    // Only the valid call asked, and only it started a child.
    expect(cards(f, id)).toHaveLength(1);
    const children = f.store.childSessionIds(id);
    expect(children).toHaveLength(1);
    expect(f.store.getSession(children[0]!)!.model).toBe("sonnet");
  });

  it("a chat child is a research-only chat in the parent's chat folder; the card names the batch", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f, { kind: "chat" });
    let childOptions: FakeQuery["options"] | null = null;
    let readVerdict: unknown = null;
    let fetchVerdict: unknown = null;
    const results = claudeParent(f, [agents({ task: "What is new in Node 24?", description: "Node 24 news" })], async (q, task) => {
      childOptions = q.options;
      readVerdict = await q.askPermission("Read", { file_path: join(f.root, "alice", ".chat", "x.txt") });
      fetchVerdict = await q.askPermission("WebFetch", { url: "https://example.com" });
      q.reply(`Researched: ${task}`);
    });
    const req = await approvedTurn(f, id, "research this");
    expect(req).toMatchObject({ toolName: RUN, input: { agents: [{ model: "opus", description: "Node 24 news", task: "What is new in Node 24?" }] } });
    expect(isError(results[0]!)).toBe(false);
    const text = textOf(results[0]!);
    const childId = sessionLine(text)!;
    expect(text).toBe(`session: ${childId}\n\nResearched: What is new in Node 24?`); // no Files line in chats
    expect(f.store.getSession(childId)).toMatchObject({ parentSessionId: id, kind: "chat", cwd: `.chat/${id}`, model: "opus", permissionMode: "dontAsk" });

    // Research only: WebSearch + WebFetch, no hub servers (no visuals, memory, history, browser, run_subagents).
    const o = childOptions!;
    expect(o.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(o.mcpServers ?? {}).toEqual({});
    expect(o.allowedTools ?? []).toEqual([]);
    expect(String(o.systemPrompt)).toContain(SUBAGENT_ROLE_NOTE);
    expect(String(o.systemPrompt)).not.toContain("show_visual");
    expect(readVerdict).toMatchObject({ behavior: "deny" });
    expect(fetchVerdict).toMatchObject({ behavior: "allow" });
  });
});

describe("run_subagents: approval", () => {
  it("denied: no child starts and the tool says the user declined", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f);
    const results = claudeParent(f, [agents({ task: "a", description: "A" }, { task: "b", description: "B" })]);
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id, "deny", { message: "not now" });
    await turnEnd(f, id);
    expect(results).toEqual([{ text: SUBAGENTS_DECLINED, isError: true }]);
    expect(f.store.childSessionIds(id)).toEqual([]);
    expect(tasksOf(f, id)).toEqual([]);
    expect(f.bus.ofType("permission_resolved").at(-1)).toMatchObject({ sessionId: id, behavior: "deny" });
  });

  it("timed out: no child starts, the tool returns the timeout text and the parent's turn is stopped", async () => {
    fx = fixture(undefined, { permissionTimeoutMs: 200 });
    const f = fx;
    const id = parent(f);
    let parentQ: FakeQuery | null = null;
    const results: HubToolResult[] = [];
    f.sdk.behavior = async (q) => {
      parentQ = q;
      q.init();
      results.push(await runTool(f).handler(agents({ task: "a", description: "A" })));
      q.reply("parent done");
    };
    await f.sessions.send(id, msgBody("go"));
    await card(f, id);
    await turnEnd(f, id);
    expect(results).toEqual([{ text: TIMEOUT_DENY_MESSAGE, isError: true }]);
    expect(parentQ!.interrupted).toBeGreaterThan(0);
    expect(f.store.childSessionIds(id)).toEqual([]);
    expect(f.bus.ofType("notice").some((n) => n.code === "permission_timeout")).toBe(true);
  });

  it("stopping the turn while the card waits starts nothing and withdraws the card", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f);
    const results = claudeParent(f, [agents({ task: "a", description: "A" })]);
    await f.sessions.send(id, msgBody("go"));
    const req = await card(f, id);
    await f.sessions.stop(id);
    await until(() => results.length === 1, 4000, "call returned");
    expect(results).toEqual([{ text: "Not started: the turn was stopped.", isError: true }]);
    expect(f.bus.ofType("permission_cancelled").some((e) => e.requestId === req.requestId && e.sessionId === id)).toBe(true);
    expect(f.store.childSessionIds(id)).toEqual([]);
    expect(f.sessions.respondPermission("alice", id, { requestId: req.requestId, behavior: "allow" })).toMatchObject({ ok: false, code: "permission_not_found" });
  });

  it("bypassPermissions and remembered rules never skip the card", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f, { permissionMode: "bypassPermissions" });
    f.store.insertRule({ user: "alice", sessionId: null, toolName: RUN, ruleContent: null });
    f.store.insertRule({ user: "alice", sessionId: id, toolName: RUN, ruleContent: null });
    const results = claudeParent(f, [agents({ task: "a", description: "A" })]);
    await f.sessions.send(id, msgBody("go"));
    await card(f, id);
    await new Promise((r) => setTimeout(r, 50));
    expect(f.store.childSessionIds(id)).toEqual([]);
    await answer(f, id);
    await turnEnd(f, id);
    expect(isError(results[0]!)).toBe(false);
    expect(f.store.childSessionIds(id)).toHaveLength(1);
  });

  it("acceptEdits and a stored rule never skip the card either", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f, { permissionMode: "acceptEdits" });
    f.store.insertRule({ user: "alice", sessionId: id, toolName: RUN, ruleContent: null });
    const results = claudeParent(f, [agents({ task: "x", description: "X" })], (q, t) => q.reply(`child: ${t}`));
    const req = await approvedTurn(f, id);
    expect(req).toMatchObject({ sessionId: id, toolName: RUN, input: { agents: [{ model: "opus", description: "X", task: "x" }] } });
    expect(textOf(results[0]!)).toMatch(/\n\nchild: x$/);
  });

  it('"remember" answers allow once: no rule is stored and the next batch asks again', async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f);
    const results = claudeParent(f, [agents({ task: "a", description: "A" }), agents({ task: "b", description: "B" }), agents({ task: "c", description: "C" })], undefined, { sequential: true });
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id, "allow", { remember: "user" }, 1);
    await answer(f, id, "allow", { remember: "session", updatedInput: agents({ task: "evil", description: "E" }) }, 2);
    await answer(f, id, "deny", {}, 3);
    await turnEnd(f, id);
    expect(results.map(isError)).toEqual([false, false, true]);
    // The input is never replaced by the answer.
    expect(textOf(results[1]!)).toMatch(/child answer to: b$/);
    expect(textOf(results[2]!)).toBe(SUBAGENTS_DECLINED);
    expect(f.store.rulesFor("alice", RUN, id)).toEqual([]);
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM permissions_rules").get()).toEqual({ n: 0 });
    expect(f.store.childSessionIds(id)).toHaveLength(2);
  });
});

describe("run_subagents: children", () => {
  it("a child runs through the key proxy like its parent and has no run_subagents or wrap_up (depth 1)", async () => {
    const issued: string[] = [];
    const apiProxy = { issue: (owner: string) => (issued.push(owner), { token: `hsk-${"a".repeat(43)}`, baseUrl: "http://127.0.0.1:9" }), revoke: () => {}, revokeOwner: () => {} };
    fx = fixture(() => ({ apiProxy }));
    const f = fx;
    const id = parent(f);
    let child: FakeQuery | null = null;
    const results = claudeParent(f, [agents({ task: "Do it", description: "Child" })], (q) => {
      child = q;
      q.reply("done by child");
    });
    await approvedTurn(f, id);
    const childId = sessionLine(textOf(results[0]!))!;
    expect(f.store.getSession(childId)).toMatchObject({ model: "opus", cwd: "" });
    expect(issued).toEqual([id, childId]); // the child's process gets its own proxy token too
    const o = child!.options;
    expect(Object.keys(o.mcpServers ?? {})).not.toContain("workstation_subagent");
    expect(Object.keys(o.mcpServers ?? {})).not.toContain("workstation_turn");
    expect(o.allowedTools ?? []).not.toContain(RUN);
    expect(JSON.stringify(o.systemPrompt)).toContain(SUBAGENT_ROLE_NOTE);
    // A child cannot run subagents even when asked directly, and no card is shown for it.
    const before = f.bus.ofType("permission_request").length;
    expect(await f.sessions.subagents.run(childId, [{ task: "x", description: "x" }])).toEqual({ text: "A subagent cannot start subagents of its own.", isError: true });
    expect(f.bus.ofType("permission_request")).toHaveLength(before);
  });

  it("is hidden from the session list and search but readable by the user who started it", async () => {
    h = await hubFixture();
    const hub = h.hub;
    const p = (await h.app.inject({ method: "POST", url: "/api/sessions", headers: h.as("alice"), payload: { kind: "code", model: "opus" } })).json() as Session;
    const child = hub.sessions.create({ user: "alice", kind: "code", cwd: "", model: "opus", permissionMode: "default", effort: null, title: "zebra research", parentSessionId: p.id });
    const say = (sessionId: string, text: string) => hub.store.appendMessage(sessionId, { uuid: crypto.randomUUID(), kind: "user", payload: { type: "user", message: { role: "user", content: text } } });
    say(p.id, "zebras in the parent");
    say(child.id, "zebras in the child");

    const list = (await h.app.inject({ method: "GET", url: "/api/sessions", headers: h.as("alice") })).json() as Session[];
    expect(list.map((s) => s.id)).toEqual([p.id]);
    expect(hub.store.listAllSessions().map((s) => s.id)).not.toContain(child.id);
    const got = await h.app.inject({ method: "GET", url: `/api/sessions/${child.id}`, headers: h.as("alice") });
    expect(got.json()).toMatchObject({ id: child.id, parentSessionId: p.id });
    expect((await h.app.inject({ method: "GET", url: `/api/sessions/${child.id}/messages`, headers: h.as("alice") })).json()).toHaveLength(1);
    expect((await h.app.inject({ method: "GET", url: `/api/sessions/${child.id}`, headers: h.as("bob") })).statusCode).toBe(404);
    const search = JSON.stringify((await h.app.inject({ method: "GET", url: "/api/search?q=zebras", headers: h.as("alice") })).json());
    expect(search).toContain(p.id);
    expect(search).not.toContain(child.id);
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM search_docs WHERE session_id = ?").get(child.id)).toEqual({ n: 0 });
    const read = historyTools({ store: hub.store, search: hub.search, relevantAvailable: () => false }, "alice", p.id).find((t) => t.name === "read_conversation")!;
    expect(await read.handler({ sessionId: child.id })).toEqual({ text: "No conversation with that id.", isError: true });
    // Deleting the parent deletes its subagents' sessions.
    expect((await h.app.inject({ method: "DELETE", url: `/api/sessions/${p.id}`, headers: h.as("alice") })).statusCode).toBe(204);
    expect(hub.store.getSession(child.id)).toBeNull();
  });

  it("a child's permission card is shown in the parent (subagent field) and the answer resolves the child", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f);
    let verdict: unknown = null;
    const results = claudeParent(f, [agents({ task: "List files", description: "List them" })], async (q) => {
      q.init();
      verdict = await q.askPermission("Bash", { command: "ls -la" });
      q.reply("listed");
    });
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id);
    const req = await until(() => f.bus.ofType("permission_request").map((e) => e.request).find((r: PermissionRequest) => r.subagent), 4000, "forwarded card");
    const childId = f.store.childSessionIds(id)[0]!;
    expect(req).toMatchObject({ sessionId: id, toolName: "Bash", input: { command: "ls -la" }, subagent: { sessionId: childId, description: "List them" } });
    expect(f.sessions.snapshot(id).pendingPermission).toMatchObject({ requestId: req.requestId, subagent: { sessionId: childId } });
    expect(f.sessions.statusOf(id).status).toBe("requires_action");
    expect(f.sessions.statusOf(childId).status).toBe("requires_action");
    expect(f.sessions.respondPermission("alice", id, { requestId: req.requestId, behavior: "allow" })).toEqual({ ok: true });
    expect(f.bus.ofType("permission_resolved").at(-1)).toMatchObject({ sessionId: id, requestId: req.requestId, behavior: "allow" });
    await turnEnd(f, id);
    expect(verdict).toMatchObject({ behavior: "allow" });
    expect(textOf(results[0]!)).toBe(`session: ${childId}\n\nlisted`);
  });

  it("an incognito chat's children are incognito too", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f, { kind: "chat", incognito: true });
    const results = claudeParent(f, [agents({ task: "q", description: "d" })]);
    await approvedTurn(f, id);
    const childId = sessionLine(textOf(results[0]!))!;
    expect(f.store.getSession(childId)).toMatchObject({ incognito: true, kind: "chat", parentSessionId: id });
    await f.sessions.delete(id);
    expect(f.store.getSession(childId)).toBeNull();
  });
});

describe("run_subagents: running a batch", () => {
  it("with free subagent slots every approved child starts at once; sections come back in input order", async () => {
    // pool of 5: subagents may use 5 − SUBAGENT_RESERVED_SLOTS = 3
    fx = fixture(() => ({}), { max: 5 });
    const f = fx;
    const id = parent(f);
    const gates = new Map<string, () => void>();
    const results = claudeParent(f, [agents(...[1, 2, 3].map((n) => ({ task: `task ${n}`, description: `job ${n}` })))], async (q, text) => {
      q.init();
      await new Promise<void>((res) => gates.set(text, res));
      q.reply(`done ${text}`);
    });
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id);
    await until(() => gates.size === 3, 4000, "all three children running");
    expect(f.store.childSessionIds(id)).toHaveLength(3);
    expect(tasksOf(f, id).filter((t) => t.status === "running")).toHaveLength(3);
    // They finish out of order; the sections still follow the input order.
    gates.get("task 2")!();
    gates.get("task 3")!();
    gates.get("task 1")!();
    await turnEnd(f, id);
    expect(results).toHaveLength(1);
    expect(isError(results[0]!)).toBe(false);
    const parts = sections(results[0]!);
    expect(parts.map((s) => s.split("\n\n")[1])).toEqual(["done task 1", "done task 2", "done task 3"]);
    const ids = parts.map(sessionLine);
    expect(new Set(ids).size).toBe(3);
    expect(ids.map((c) => f.store.getSession(c!)!.title)).toEqual(["job 1", "job 2", "job 3"]);
    expect(tasksOf(f, id).map((t) => t.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("subagents never take the reserved slots: with a pool of 4 only 2 run, the third waits for one to finish", async () => {
    fx = fixture(() => ({}), { max: 4 });
    const f = fx;
    const id = parent(f);
    const gates = new Map<string, () => void>();
    const results = claudeParent(f, [agents(...[1, 2, 3].map((n) => ({ task: `task ${n}`, description: `job ${n}` })))], async (q, text) => {
      q.init();
      await new Promise<void>((res) => gates.set(text, res));
      q.reply(`done ${text}`);
    });
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id);
    await until(() => gates.size === 2, 4000, "two children running");
    await new Promise((r) => setTimeout(r, 100));
    expect(gates.size).toBe(2);
    expect(f.store.childSessionIds(id)).toHaveLength(2);
    gates.get("task 2")!();
    await until(() => gates.size === 3, 4000, "third child started");
    gates.get("task 3")!();
    gates.get("task 1")!();
    await turnEnd(f, id);
    expect(sections(results[0]!).map((x) => x.split("\n\n")[1])).toEqual(["done task 1", "done task 2", "done task 3"]);
  });

  it("a failed child gets its error in its own section; the others still answer", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f);
    const results = claudeParent(
      f,
      [agents({ task: "first", description: "One" }, { task: "broken", description: "Two" }, { task: "third", description: "Three" })],
      (q, text) => {
        if (text !== "broken") return q.reply(`ok ${text}`);
        q.init();
        q.result(undefined, { subtype: "error_during_execution", is_error: true, result: "", errors: ["boom"] });
      },
    );
    await approvedTurn(f, id);
    const r = results[0]!;
    expect(isError(r)).toBe(false);
    const parts = sections(r);
    expect(parts).toHaveLength(3);
    const ids = parts.map(sessionLine);
    expect(parts[0]).toBe(`session: ${ids[0]}\n\nok first`);
    expect(parts[1]).toBe(`session: ${ids[1]}\n\nThe subagent failed: boom`);
    expect(parts[2]).toBe(`session: ${ids[2]}\n\nok third`);
    expect(tasksOf(f, id).map((t) => [t.description, t.status, t.subagentType])).toEqual([
      ["One", "completed", "opus"],
      ["Two", "failed", "opus"],
      ["Three", "completed", "opus"],
    ]);
  });

  it("stops a child after the timeout and returns an error that still names the child", async () => {
    fx = fixture(() => ({ subagentTimeoutMs: () => 300 }));
    const f = fx;
    const id = parent(f);
    let child: FakeQuery | null = null;
    const results = claudeParent(f, [agents({ task: "never ends", description: "slow" })], (q) => {
      child = q;
      q.init();
    });
    await approvedTurn(f, id);
    const r = results[0]!;
    expect(isError(r)).toBe(true);
    const childId = sessionLine(textOf(r))!;
    expect(childId).toBeTruthy();
    expect(textOf(r)).toMatch(/did not finish within .* and was stopped\.$/);
    expect(child!.interrupted).toBeGreaterThan(0);
    await until(() => child!.closed, 2000, "child closed");
    expect(tasksOf(f, id)).toEqual([expect.objectContaining({ taskId: childId, status: "failed" })]);
  });

  it("stopping the parent's turn stops all its running children", async () => {
    fx = fixture(() => ({}), { max: 5 });
    const f = fx;
    const id = parent(f);
    const children: FakeQuery[] = [];
    const results = claudeParent(f, [agents(...[1, 2, 3].map((n) => ({ task: `task ${n}`, description: `job ${n}` })))], (q) => {
      children.push(q);
      q.init();
    });
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id);
    await until(() => children.length === 3, 4000, "three children");
    await f.sessions.stop(id);
    await until(() => results.length === 1, 4000, "the call returned");
    expect(isError(results[0]!)).toBe(true);
    const parts = sections(results[0]!);
    expect(parts).toHaveLength(3);
    expect(parts.every((t) => /^session: \S+\n\nThe subagent was stopped before it finished\.$/.test(t))).toBe(true);
    expect(children.every((q) => q.interrupted > 0)).toBe(true);
    expect(f.store.childSessionIds(id)).toHaveLength(3);
    expect(tasksOf(f, id).map((t) => t.status)).toEqual(["stopped", "stopped", "stopped"]);
  });

  it("the parent's task stop route stops one child", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f);
    const results = claudeParent(f, [agents({ task: "long", description: "long job" })], (q) => q.init());
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id);
    const childId = await until(() => f.store.childSessionIds(id)[0], 4000, "child");
    await until(() => f.sessions.statusOf(childId).status === "running", 4000, "child running");
    expect(await f.sessions.stopTask(id, childId)).toBe(true);
    await turnEnd(f, id);
    expect(textOf(results[0]!)).toBe(`session: ${childId}\n\nThe subagent was stopped before it finished.`);
    expect(tasksOf(f, id)).toEqual([expect.objectContaining({ taskId: childId, status: "stopped" })]);
    expect(await f.sessions.stopTask(id, childId)).toBe(false);
  });
});

/** The reason of the first "deny" among PreToolUse hook outputs (null: none denied). */
function hookDenial(outs: unknown[]): string | null {
  for (const o of outs) {
    const h = (o as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)?.hookSpecificOutput;
    if (h?.permissionDecision === "deny") return h.permissionDecisionReason ?? "";
  }
  return null;
}
const subagentCards = (f: Fixture) => f.bus.ofType("permission_request").map((e) => e.request).filter((r) => !!r.subagent);

describe("run_subagents: areas and file ownership", () => {
  it("code: every agent needs valid paths; one error names each bad agent, before any card; the card carries the normalised paths", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f);
    const results = claudeParent(
      f,
      [
        rawAgents({ task: "t", description: "A" }, { task: "t", description: "B", paths: ["/etc/passwd", "src/../../up", "  ", "~/x"] }, { task: "t", description: "C", paths: ["src/**"] }),
        rawAgents({ task: "t", description: "D", paths: [] }),
        rawAgents({ task: "t", description: "E", paths: "src/**" }),
        rawAgents({ task: "t", description: "F", paths: Array.from({ length: 21 }, (_, i) => `f${i}`) }),
        rawAgents({ task: "t", description: "ok", paths: ["./src/", "src", "docs//*.md", " README.md "] }),
      ],
      undefined,
      { sequential: true },
    );
    await f.sessions.send(id, msgBody("go"));
    const req = await answer(f, id);
    await turnEnd(f, id);
    expect(results.map(isError)).toEqual([true, true, true, true, false]);
    expect(textOf(results[0]!)).toBe(
      'Not started: agent 1 (A): paths is missing (the files it may change, as globs relative to the working directory); agent 2 (B): path "/etc/passwd" is absolute (give it relative to the working directory); path "src/../../up" leaves the working directory; paths has an empty pattern; path "~/x" is absolute (give it relative to the working directory).',
    );
    expect(textOf(results[1]!)).toBe("Not started: paths is empty.");
    expect(textOf(results[2]!)).toBe("Not started: paths must be a list of globs.");
    expect(textOf(results[3]!)).toBe("Not started: paths has more than 20 patterns.");
    expect(cards(f, id)).toHaveLength(1);
    expect(req.input).toEqual({ agents: [{ model: "opus", description: "ok", task: "t", paths: ["src", "docs/*.md", "README.md"] }] });
    expect(f.store.childSessionIds(id)).toHaveLength(1);
  });

  it("chats ignore paths: missing or invalid ones start, the card has none and the child gets the bare task", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f, { kind: "chat" });
    const messages: string[] = [];
    const results = claudeParent(f, [rawAgents({ task: "q1", description: "none" }, { task: "q2", description: "bad", paths: ["/etc"] })], (q, _task, message) => {
      messages.push(message);
      q.reply("answer");
    });
    const req = await approvedTurn(f, id);
    expect(isError(results[0]!)).toBe(false);
    expect(req.input).toEqual({ agents: [expect.not.objectContaining({ paths: expect.anything() }), expect.not.objectContaining({ paths: expect.anything() })] });
    expect(messages.sort()).toEqual(["q1", "q2"]);
  });

  it("a Claude child writes only inside its area (symlinks resolved), denied before any card in PreToolUse and canUseTool; Bash is unchanged; its task starts with the preamble", async () => {
    fx = fixture();
    const f = fx;
    const id = parent(f, { cwd: "work" });
    const cwdAbs = join(f.root, "alice", "work");
    mkdirSync(join(cwdAbs, "src"), { recursive: true });
    mkdirSync(join(cwdAbs, "other"), { recursive: true });
    symlinkSync(join(cwdAbs, "other"), join(cwdAbs, "src", "link"));
    // The parent's rules allow the tools, so only the guard can refuse (and no card is needed for the rest).
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) f.store.insertRule({ user: "alice", sessionId: id, toolName: tool, ruleContent: null });
    const hooks: Record<string, string | null> = {};
    const asks: Record<string, unknown> = {};
    let message = "";
    const results = claudeParent(f, [agents({ task: "Fix src", description: "Fixer", paths: ["./src/**", "README.md"] })], async (q, _task, m) => {
      message = m;
      q.init();
      const cases: [string, string, Record<string, unknown>][] = [
        ["write in", "Write", { file_path: "src/a.ts", content: "x" }],
        ["edit in (absolute, new folder)", "Edit", { file_path: join(cwdAbs, "src", "deep", "b.ts"), old_string: "a", new_string: "b" }],
        ["readme", "Edit", { file_path: "README.md", old_string: "a", new_string: "b" }],
        ["write out", "Write", { file_path: "notes.txt", content: "x" }],
        ["edit out (..)", "Edit", { file_path: "src/../package.json", old_string: "a", new_string: "b" }],
        ["multiedit out", "MultiEdit", { file_path: join(cwdAbs, "other", "c.ts"), edits: [] }],
        ["notebook out", "NotebookEdit", { notebook_path: "nb.ipynb", new_source: "" }],
        ["symlink escape", "Write", { file_path: "src/link/evil.ts", content: "x" }],
        ["outside cwd", "Write", { file_path: join(f.root, "alice", "elsewhere.txt"), content: "x" }],
        ["bash", "Bash", { command: "echo x > /tmp/y" }],
      ];
      for (const [label, tool, input] of cases) {
        hooks[label] = hookDenial(await q.runHooks("PreToolUse", tool, input, `toolu_${label.replace(/\W/g, "")}`));
        asks[label] = await q.askPermission(tool, input);
      }
      q.reply("fixed");
    });
    const req = await approvedTurn(f, id);
    expect(isError(results[0]!)).toBe(false);
    expect(req.input).toMatchObject({ agents: [{ description: "Fixer", paths: ["src/**", "README.md"] }] });
    const area = outsideAreaMessage(["src/**", "README.md"]);
    expect(area).toBe("Outside your area (src/**, README.md): leave this file and mention it in your answer.");
    for (const label of ["write in", "edit in (absolute, new folder)", "readme", "bash"]) {
      expect(hooks[label], label).toBeNull();
      expect(asks[label], label).toMatchObject({ behavior: "allow" });
    }
    for (const label of ["write out", "multiedit out", "notebook out", "symlink escape"]) {
      expect(hooks[label], label).toBe(area);
      expect(asks[label], label).toEqual({ behavior: "deny", message: area });
    }
    // The session's own folder rule comes first (codeSandbox.ts): outside the cwd, or any `..`, is refused as such.
    for (const label of ["edit out (..)", "outside cwd"]) {
      expect(hooks[label], label).toBe(CODE_FOLDER_DENIED);
      expect(asks[label], label).toEqual({ behavior: "deny", message: CODE_FOLDER_DENIED });
    }
    expect(subagentCards(f)).toEqual([]);
    expect(message).toBe(subagentPrompt("Fix src", ["src/**", "README.md"]));
    expect(message).toContain("Your area: `src/**`, `README.md` (globs relative to the working directory)");
    expect(message).toContain("Keep files your shell commands write inside it too.");
    expect(message).toContain("A file another subagent is already editing is refused to you");
    expect(message).toContain("leave that file and mention it in your answer");
    expect(message.endsWith(`\n${SUBAGENT_TASK_HEADING}\n\nFix src`)).toBe(true);
  });

  it("a Claude child inherits the code sandbox: the same settings for its cwd, file tools outside it refused, network public only", async () => {
    fx = fixture(() => ({ resolveHost: async (host: string) => (host === "registry.npmjs.org" ? ["104.16.1.34"] : ["10.0.0.7"]) }));
    const f = fx;
    const id = parent(f, { cwd: "work", permissionMode: "bypassPermissions" });
    const cwdAbs = join(f.root, "alice", "work");
    let childOpts: FakeQuery["options"] | null = null;
    const got: Record<string, unknown> = {};
    claudeParent(f, [agents({ task: "Look around", description: "Looker" })], async (q) => {
      q.init();
      childOpts = q.options;
      got.hook = hookDenial(await q.runHooks("PreToolUse", "Read", { file_path: "/etc/passwd" }, "toolu_r1"));
      got.ask = await q.askPermission("Read", { file_path: join(f.root, "alice", "notes.txt") });
      got.netPrivate = await q.askPermission("SandboxNetworkAccess", { host: "internal.example" });
      got.netPublic = await q.askPermission("SandboxNetworkAccess", { host: "registry.npmjs.org" });
      got.unsandboxed = await q.askPermission("Bash", { command: "ls ~", dangerouslyDisableSandbox: true });
      q.reply("looked");
    });
    await approvedTurn(f, id);
    expect(childOpts).not.toBeNull();
    const opts = childOpts! as FakeQuery["options"];
    const env = opts.env as Record<string, string>;
    const tmp = env.CLAUDE_CODE_TMPDIR!;
    expect(opts.cwd).toBe(cwdAbs);
    expect(env.TMPDIR).toBe(tmp);
    const settings = opts.settings as unknown as { sandbox: unknown; env: unknown };
    // bypassPermissions (inherited): the strict allowlist of the known hosts.
    expect(settings.sandbox).toEqual(codeSandbox({ cwd: cwdAbs, usersRoot: f.root, tmpDir: tmp, strictNetwork: true }));
    expect(settings.env).toEqual(codeCommandEnv(tmp));
    // Its own temp directory, not the parent's.
    const parentQuery = f.sdk.queries.find((q) => isParentQuery(q))!;
    expect((parentQuery.options.env as Record<string, string>).CLAUDE_CODE_TMPDIR).not.toBe(tmp);
    expect(got.hook).toBe(CODE_FOLDER_DENIED);
    expect(got.ask).toEqual({ behavior: "deny", message: CODE_FOLDER_DENIED });
    expect(got.netPrivate).toEqual({ behavior: "deny", message: CODE_NETWORK_DENIED });
    expect(got.netPublic).toMatchObject({ behavior: "allow" });
    expect(got.unsandboxed).toEqual({ behavior: "deny", message: CODE_UNSANDBOXED_DENIED });
    expect(subagentCards(f)).toEqual([]);
  });

  it("the first child to write a file owns it until it ends: a sibling is denied before any card, then allowed; a refused write drops the claim", async () => {
    fx = fixture(() => ({}), { max: 5 });
    const f = fx;
    const id = parent(f, { cwd: "work" });
    const cwdAbs = join(f.root, "alice", "work");
    const log: Record<string, string | null> = {};
    let aClaimed = false;
    let bVerdict: unknown = null;
    let open1!: () => void;
    let open2!: () => void;
    const gate1 = new Promise<void>((r) => (open1 = r));
    const gate2 = new Promise<void>((r) => (open2 = r));
    claudeParent(f, [agents({ task: "A", description: "Writer A" }, { task: "B", description: "Writer B" })], async (q, task) => {
      q.init();
      let n = 0;
      const pre = async (file: string, tool = "Write") => hookDenial(await q.runHooks("PreToolUse", tool, { file_path: file, content: "x" }, `toolu_${task}${++n}`));
      if (task === "A") {
        log.aShared = await pre(join(cwdAbs, "shared.txt"));
        aClaimed = true;
        await gate1;
        // B's refused writes left no claim behind.
        log.aC = await pre("c.txt");
        log.aD = await pre("d.txt");
        q.reply("A done");
        return;
      }
      await until(() => aClaimed, 4000, "A claimed");
      log.bShared = await pre("shared.txt", "Edit");
      log.bOwn = await pre("b.txt");
      // A card the person refuses (canUseTool), and a call the mode refuses (PermissionDenied hook).
      bVerdict = await q.askPermission("Write", { file_path: "c.txt", content: "x" });
      log.bD = await pre("d.txt");
      await q.runHooks("PermissionDenied", "Write", { file_path: "d.txt" }, `toolu_B${n}`);
      await gate2;
      log.bAfter = await pre("shared.txt");
      q.reply("B done");
    });
    await f.sessions.send(id, msgBody("go"));
    await answer(f, id);
    const bCard = await until(() => subagentCards(f).find((r) => r.toolName === "Write"), 4000, "B's card");
    expect(bCard).toMatchObject({ input: { file_path: "c.txt" }, subagent: { description: "Writer B" } });
    expect(f.sessions.respondPermission("alice", id, { requestId: bCard.requestId, behavior: "deny" })).toEqual({ ok: true });
    await until(() => bVerdict !== null && "bD" in log, 4000, "B refused");
    open1();
    await until(() => tasksOf(f, id).some((t) => t.description === "Writer A" && t.status === "completed"), 4000, "A ended");
    open2();
    await turnEnd(f, id);
    expect(bVerdict).toMatchObject({ behavior: "deny" });
    expect(log).toEqual({ aShared: null, bShared: ownedByMessage("Writer A"), bOwn: null, bD: null, aC: null, aD: null, bAfter: null });
    expect(ownedByMessage("Writer A")).toBe("Writer A is editing this file: leave it and mention it in your answer.");
    // The only card was the one for the free file; the sibling's write on A's file never reached one.
    expect(subagentCards(f)).toHaveLength(1);
  });
});

describe("run_subagents: helpers", () => {
  it("areas: normalised paths and glob matching", () => {
    expect(normalizeAreaPaths(["./src/", "src", "a//b/*.ts", "."])).toEqual({ ok: false, error: 'path "." is empty (use "**" for the whole working directory)' });
    expect(normalizeAreaPaths(["./src/", "src", "a//b/*.ts"])).toEqual({ ok: true, paths: ["src", "a/b/*.ts"] });
    expect(normalizeAreaPaths(["C:/x"])).toMatchObject({ ok: false, error: expect.stringMatching(/is absolute/) });
    expect(normalizeAreaPaths(undefined)).toMatchObject({ ok: false, error: expect.stringMatching(/^paths is missing/) });
    expect(inArea(["src/**"], "src/a/b.ts")).toBe(true);
    expect(inArea(["src/**"], "srcx/a.ts")).toBe(false);
    expect(inArea(["src"], "src/a/b.ts")).toBe(true);
    expect(inArea(["src"], "srcx")).toBe(false);
    expect(inArea(["*.md"], "a/b.md")).toBe(false);
    expect(inArea(["*.md"], "b.md")).toBe(true);
    expect(inArea(["**/*.md"], "b.md")).toBe(true);
    expect(inArea(["**/*.md"], "a/b/c.md")).toBe(true);
    expect(inArea(["a?c.ts", "(x)/*.ts"], "abc.ts")).toBe(true);
    expect(inArea(["(x)/*.ts"], "(x)/y.ts")).toBe(true);
    expect(inArea(["**"], "a/b")).toBe(true);
    expect(inArea(["**"], "../a")).toBe(false);
    expect(inArea(["**"], "")).toBe(false);
    expect(subagentPrompt("task", null)).toBe("task");
  });

  it("validates input, cuts long answers to 20 KB with a note, and reads the final answer", () => {
    expect(parseSubagentsInput(rawAgents({ task: " t ", description: "d" }, { task: "u", model: "sonnet", description: "e", paths: ["src/**"] }))).toEqual({
      ok: true,
      reqs: [
        { description: "d", task: "t" },
        { model: "sonnet", description: "e", task: "u", paths: ["src/**"] },
      ],
    });
    expect(parseSubagentsInput(rawAgents({ task: "x".repeat(8001), description: "" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/agent 1: description is empty.*agent 1: task is longer than 8000/),
    });
    const long = subagentResultText("11111111-1111-1111-1111-111111111111", "é".repeat(20_000), ["a.ts", "b.ts"]);
    const answer = long.split("\n\n").slice(1, -1).join("\n\n");
    expect(Buffer.byteLength(answer, "utf8")).toBeLessThanOrEqual(MAX_SUBAGENT_ANSWER_BYTES);
    expect(answer).toMatch(/\[Truncated: the answer was 40 KB;/);
    expect(long.endsWith("\n\nFiles: a.ts, b.ts")).toBe(true);
    const row = (kind: string, payload: unknown) => ({ sessionId: "s", seq: 1, uuid: crypto.randomUUID(), kind: kind as "assistant", payload: JSON.stringify(payload), at: "", delivery: null });
    expect(
      finalAnswer([
        row("assistant", { message: { id: "m1", content: [{ type: "text", text: "Looking." }, { type: "tool_use" }] }, parent_tool_use_id: null }),
        row("assistant", { message: { id: "m2", content: [{ type: "text", text: "Inner." }] }, parent_tool_use_id: "toolu_x" }),
        row("assistant", { message: { id: "m3", content: [{ type: "text", text: "Final " }] }, parent_tool_use_id: null }),
        row("assistant", { message: { id: "m3", content: [{ type: "text", text: "answer." }] }, parent_tool_use_id: null }),
        row("result", { is_error: false, result: "ok" }),
      ]),
    ).toEqual({ text: "Final answer.", isError: false });
    expect(finalAnswer([row("system", { subtype: "hub_process_died", error: "boom" })])).toEqual({ text: "The subagent failed: boom", isError: true });
  });
});
