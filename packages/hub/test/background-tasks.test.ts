import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { HubHealth, SessionSnapshot } from "@agent-workstation/protocol";
import { AgentExec, type SpawnFn } from "../src/sessions/agentExec.js";
import { MAX_ENDED_TASKS } from "../src/sessions/runtime.js";
import type { FakeQuery } from "./fakeSdk.js";
import { hubFixture, msgBody, runtimeFixture, until, type HubFixture, type RuntimeFixture } from "./helpers.js";

let fx: RuntimeFixture | undefined;
let h: HubFixture | undefined;
afterEach(async () => {
  fx?.cleanup();
  fx = undefined;
  await h?.close();
  h = undefined;
});

const sdkTask = (id: string, extra: Record<string, unknown> = {}) => ({ task_id: id, task_type: "local_bash", description: `task ${id}`, ...extra });
const changed = (q: FakeQuery, tasks: unknown[]) => q.emit({ type: "system", subtype: "background_tasks_changed", tasks, uuid: crypto.randomUUID(), session_id: q.sessionId });
const notify = (q: FakeQuery, taskId: string, status: string) =>
  q.emit({ type: "system", subtype: "task_notification", task_id: taskId, status, output_file: "/dev/null", summary: "", uuid: crypto.randomUUID(), session_id: q.sessionId });

describe("background tasks of a live session", () => {
  const clock = { now: new Date("2026-10-31T10:00:00.000Z") };

  async function started(): Promise<{ id: string; q: FakeQuery }> {
    fx = runtimeFixture({ clock: () => clock.now });
    const id = fx.newSession("code");
    await fx.sessions.send(id, msgBody("hi"));
    await until(() => fx!.sessions.statusOf(id).status === "idle" && fx!.store.getSession(id)!.turnCount === 1, 3000, "turn");
    return { id, q: fx.sdk.last };
  }
  const events = (f: RuntimeFixture) => f.bus.ofType("background_tasks");

  it("maps the SDK list, keeps startedAt across updates, broadcasts every change and puts it in the snapshot", async () => {
    const { id, q } = await started();
    expect(fx!.sessions.snapshot(id).backgroundTasks).toEqual([]);

    changed(q, [sdkTask("t1"), sdkTask("t2", { task_type: "local_agent", subagent_type: "Explore" })]);
    await until(() => events(fx!).length === 1, 2000, "first event");
    const first = events(fx!)[0]!;
    expect(first).toMatchObject({ type: "background_tasks", sessionId: id });
    expect(first.tasks).toEqual([
      { taskId: "t1", type: "local_bash", description: "task t1", startedAt: "2026-10-31T10:00:00.000Z", status: "running", endedAt: null },
      { taskId: "t2", type: "local_agent", description: "task t2", subagentType: "Explore", startedAt: "2026-10-31T10:00:00.000Z", status: "running", endedAt: null },
    ]);
    expect(fx!.bus.events.find((e) => e.event.type === "background_tasks")!.scope).toBe("session");

    // t1 stays, t2 leaves the list (completed), t3 appears later: t1 keeps its first-seen time.
    clock.now = new Date("2026-10-31T10:05:00.000Z");
    changed(q, [sdkTask("t1", { description: "renamed" }), sdkTask("t3")]);
    await until(() => events(fx!).length === 2, 2000, "second event");
    expect(events(fx!)[1]!.tasks.map((t) => [t.taskId, t.startedAt, t.status, t.endedAt])).toEqual([
      ["t1", "2026-10-31T10:00:00.000Z", "running", null],
      ["t2", "2026-10-31T10:00:00.000Z", "completed", "2026-10-31T10:05:00.000Z"],
      ["t3", "2026-10-31T10:05:00.000Z", "running", null],
    ]);
    expect(events(fx!)[1]!.tasks[0]!.description).toBe("renamed");

    const snap = fx!.sessions.snapshot(id);
    expect(SessionSnapshot.parse(snap).backgroundTasks).toEqual(events(fx!)[1]!.tasks);

    // An identical list is not broadcast again; an empty one completes the rest.
    changed(q, [sdkTask("t1", { description: "renamed" }), sdkTask("t3")]);
    clock.now = new Date("2026-10-31T10:06:00.000Z");
    changed(q, []);
    await until(() => events(fx!).length === 3, 2000, "empty event");
    expect(events(fx!)[2]!.tasks.map((t) => [t.taskId, t.status, t.endedAt])).toEqual([
      ["t1", "completed", "2026-10-31T10:06:00.000Z"],
      ["t2", "completed", "2026-10-31T10:05:00.000Z"],
      ["t3", "completed", "2026-10-31T10:06:00.000Z"],
    ]);
    expect(fx!.sessions.snapshot(id).backgroundTasks).toEqual(events(fx!)[2]!.tasks);
  });

  it("task_notification decides how a task ended (failed / stopped), also when it arrives after the task left the list", async () => {
    const { id, q } = await started();
    changed(q, [sdkTask("a"), sdkTask("b"), sdkTask("c"), sdkTask("d")]);
    notify(q, "a", "failed");
    notify(q, "b", "stopped");
    notify(q, "x", "bogus"); // unknown status: ignored
    changed(q, [sdkTask("d")]);
    await until(() => events(fx!).length === 2, 2000, "ended");
    const statuses = () => Object.fromEntries(fx!.sessions.snapshot(id).backgroundTasks!.map((t) => [t.taskId, t.status]));
    expect(statuses()).toEqual({ a: "failed", b: "stopped", c: "completed", d: "running" });
    // A late notification corrects an ended task.
    notify(q, "c", "failed");
    await until(() => events(fx!).length === 3, 2000, "late notification");
    expect(statuses()).toEqual({ a: "failed", b: "stopped", c: "failed", d: "running" });
    // The same status again: no broadcast.
    notify(q, "c", "failed");
    changed(q, [sdkTask("d")]);
    q.end();
    await until(() => events(fx!).length === 4, 2000, "process end");
    expect(statuses()).toEqual({ a: "failed", b: "stopped", c: "failed", d: "stopped" });
  });

  it("a task stopped through the stop route ends as stopped", async () => {
    const { id, q } = await started();
    changed(q, [sdkTask("t1"), sdkTask("t2")]);
    await until(() => events(fx!).length === 1, 2000, "event");
    expect(await fx!.sessions.stopTask(id, "t1")).toBe(true);
    changed(q, [sdkTask("t2")]);
    await until(() => events(fx!).length === 2, 2000, "stopped");
    expect(fx!.sessions.snapshot(id).backgroundTasks!.map((t) => [t.taskId, t.status])).toEqual([
      ["t1", "stopped"],
      ["t2", "running"],
    ]);
    // An ended task cannot be stopped again.
    expect(await fx!.sessions.stopTask(id, "t1")).toBe(false);
  });

  it(`keeps at most ${MAX_ENDED_TASKS} ended tasks (the oldest go), running ones always`, async () => {
    const { id, q } = await started();
    const many = Array.from({ length: MAX_ENDED_TASKS + 5 }, (_, i) => sdkTask(`t${i}`));
    changed(q, [...many, sdkTask("live")]);
    changed(q, [sdkTask("live")]);
    await until(() => events(fx!).length === 2, 2000, "ended");
    const tasks = fx!.sessions.snapshot(id).backgroundTasks!;
    expect(tasks).toHaveLength(MAX_ENDED_TASKS + 1);
    expect(tasks[0]!.taskId).toBe("t5");
    expect(tasks.filter((t) => t.status === "running").map((t) => t.taskId)).toEqual(["live"]);
    expect(events(fx!)[1]!.tasks).toEqual(tasks);
  });

  it("does not store the message in the transcript", async () => {
    const { id, q } = await started();
    const before = fx!.store.listMessages(id, 0, 1000).length;
    changed(q, [sdkTask("t1")]);
    await until(() => events(fx!).length === 1, 2000, "event");
    expect(fx!.store.listMessages(id, 0, 1000)).toHaveLength(before);
  });

  it("still-running tasks become stopped (and are broadcast) when the process ends", async () => {
    const { id, q } = await started();
    changed(q, [sdkTask("t1")]);
    await until(() => events(fx!).length === 1, 2000, "event");
    clock.now = new Date("2026-10-31T10:09:00.000Z");
    q.end();
    await until(() => events(fx!).length === 2, 2000, "end event");
    expect(events(fx!)[1]!.tasks).toMatchObject([{ taskId: "t1", status: "stopped", endedAt: "2026-10-31T10:09:00.000Z" }]);
    expect(fx!.sessions.snapshot(id).backgroundTasks).toEqual(events(fx!)[1]!.tasks);
  });

  it("keeps the ended tasks across a process recycle of the same session; the new process's tasks come after them", async () => {
    const { id, q } = await started();
    changed(q, [sdkTask("t1")]);
    await until(() => events(fx!).length === 1, 2000, "event");
    await fx!.sessions.close(id);
    await until(() => events(fx!).length === 2, 2000, "stop event");
    expect(fx!.sessions.snapshot(id).backgroundTasks).toMatchObject([{ taskId: "t1", status: "stopped" }]);

    await fx!.sessions.send(id, msgBody("again"));
    await until(() => fx!.sessions.statusOf(id).status === "idle" && fx!.store.getSession(id)!.turnCount === 2, 3000, "second turn");
    const q2 = fx!.sdk.last;
    expect(q2).not.toBe(q);
    expect(fx!.sessions.snapshot(id).backgroundTasks).toMatchObject([{ taskId: "t1", status: "stopped" }]);
    changed(q2, [sdkTask("t2")]);
    await until(() => events(fx!).length === 3, 2000, "new task");
    expect(fx!.sessions.snapshot(id).backgroundTasks!.map((t) => [t.taskId, t.status])).toEqual([
      ["t1", "stopped"],
      ["t2", "running"],
    ]);
  });

  it("stopTask calls the live query for a known task only", async () => {
    const { id, q } = await started();
    expect(await fx!.sessions.stopTask(id, "t1")).toBe(false);
    changed(q, [sdkTask("t1")]);
    await until(() => events(fx!).length === 1, 2000, "event");
    expect(await fx!.sessions.stopTask(id, "nope")).toBe(false);
    expect(await fx!.sessions.stopTask(id, "t1")).toBe(true);
    expect(q.stoppedTasks).toEqual(["t1"]);
    q.end();
    await until(() => events(fx!).length === 2, 2000, "clear event");
    expect(await fx!.sessions.stopTask(id, "t1")).toBe(false);
  });
});

describe("task stop route and health", () => {
  it("POST /api/sessions/:id/tasks/:taskId/stop: 204, 404 without process / task / for another user", async () => {
    h = await hubFixture();
    const { hub, app, as, sdk } = h;
    hub.users.ensure("alice");
    hub.users.ensure("bob");
    const s = hub.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null });
    const url = (task: string) => `/api/sessions/${s.id}/tasks/${task}/stop`;
    const post = (task: string, user = "alice") => app.inject({ method: "POST", url: url(task), headers: as(user) });

    // No live process yet.
    expect((await post("t1")).statusCode).toBe(404);

    await hub.sessions.send(s.id, msgBody("hi"));
    await until(() => hub.sessions.statusOf(s.id).status === "idle" && hub.store.getSession(s.id)!.turnCount === 1, 3000, "turn");
    const q = sdk.last;
    expect((await post("t1")).statusCode).toBe(404); // no such task
    changed(q, [sdkTask("t1")]);
    await until(() => hub.sessions.snapshot(s.id).backgroundTasks?.length === 1, 2000, "task");

    expect((await post("t1", "bob")).statusCode).toBe(404);
    expect(q.stoppedTasks).toEqual([]);
    const ok = await post("t1");
    expect(ok.statusCode).toBe(204);
    expect(ok.body).toBe("");
    expect(q.stoppedTasks).toEqual(["t1"]);
    expect((await post("other")).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/sessions/not-a-uuid/tasks/t1/stop", headers: as("alice") })).statusCode).toBe(404);
  });

  it("a session without background tasks has an empty list and nothing to stop", async () => {
    h = await hubFixture();
    h.hub.users.ensure("alice");
    const s = h.hub.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "opus", permissionMode: "dontAsk", effort: "high" });
    expect(h.hub.sessions.snapshot(s.id).backgroundTasks).toEqual([]);
    expect(await h.hub.sessions.stopTask(s.id, "t1")).toBe(false);
  });

  it("GET /api/health reports the host name", async () => {
    h = await hubFixture();
    const r = await h.app.inject("/api/health");
    expect(HubHealth.parse(r.json()).hostname).toBe(hostname());
  });

  it("GET /api/health reports the agent versions (run through a fake AgentExec) and the live process counts", async () => {
    const spawned: string[][] = [];
    const spawn: SpawnFn = (command, args) => {
      spawned.push([command, ...args]);
      const child = new EventEmitter() as ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null };
      const stdin = new PassThrough();
      Object.assign(child, { pid: 5000 + spawned.length, stdin, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
      stdin.resume();
      stdin.on("finish", () => {
        const claude = args.includes("claude");
        if (claude) child.stdout!.push("2.1.314 (Claude Code)\n");
        child.stdout!.push(null);
        child.stderr!.push(null);
        setImmediate(() => {
          child.exitCode = claude ? 0 : 127;
          child.emit("exit", child.exitCode, null);
        });
      });
      return child;
    };
    h = await hubFixture((dir) => ({ agentExec: new AgentExec({ user: "workstation-agent", exec: "/opt/agent-workstation/bin/workstation-agent-exec", sudo: "/usr/bin/sudo", workRoot: join(dir, "users") }, undefined, spawn) }));
    const health = async () => HubHealth.parse((await h!.app.inject("/api/health")).json());

    expect(await health()).toMatchObject({ agents: { claude: null }, processes: { claude: 0 } }); // not read yet
    await h.hub.agentVersions.refresh();
    expect((await health()).agents).toEqual({ claude: "2.1.314 (Claude Code)" });
    const versionRuns = spawned.filter((c) => c.at(-1) === "--version");
    expect(versionRuns.map((c) => c.at(c.indexOf("--") + 2))).toEqual(["claude"]);
    expect(versionRuns).toHaveLength(1);

    h.hub.users.ensure("alice");
    const s = h.hub.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "dontAsk", effort: null });
    await h.hub.sessions.send(s.id, msgBody("hi"));
    await until(() => h!.hub.sessions.statusOf(s.id).status === "idle" && h!.hub.store.getSession(s.id)!.turnCount === 1, 3000, "turn");
    expect((await health()).processes).toEqual({ claude: 1 });
  });
});
