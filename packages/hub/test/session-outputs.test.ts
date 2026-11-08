import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionOutputsResponse } from "@agent-workstation/protocol";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { createHub, startHub, stopHub, type Hub } from "../src/hub.js";
import { silentLogger } from "../src/util/log.js";
import { FakeSdk } from "./fakeSdk.js";
import { tempDir } from "./helpers.js";

let app: FastifyInstance;
let hub: Hub;
let cleanup: () => void;
let root: string;

const as = (user: string) => ({ "x-workstation-user": user });

beforeAll(async () => {
  const t = tempDir();
  root = join(t.dir, "users");
  const config = parseConfig(
    {
      paths: { users_root: root, data_dir: join(t.dir, "data"), claude_bin: "", claude_home: join(t.dir, "claude-home") },
      auth: { admin_usernames: ["admin"], anthropic_api_key_file: join(t.dir, "anthropic.env") },
    },
    null,
    {},
  );
  hub = createHub(config, { log: silentLogger, sdk: new FakeSdk(), dbFile: ":memory:", captureProcess: false, tmuxBin: null });
  await startHub(hub, { timers: false, retention: false });
  app = await buildApp(hub);
  await app.ready();
  cleanup = t.cleanup;
});

afterAll(async () => {
  await app.close();
  await stopHub(hub);
  cleanup();
});

function session(user = "alice", kind: "chat" | "code" = "code"): string {
  const id = randomUUID();
  hub.store.ensureUser(user);
  hub.store.insertSession({ id, user, kind, title: "t", cwd: ".", model: "default", permissionMode: "dontAsk", effort: null });
  return id;
}

function touch(sessionId: string, path: string, at: string, extra: { tool?: string; turn?: number; projectId?: string } = {}, user = "alice") {
  hub.store.insertFileTouch({ sessionId, user, path, tool: extra.tool ?? "Write", turn: extra.turn ?? 1, at, ...(extra.projectId ? { projectId: extra.projectId } : {}) });
}

function file(user: string, rel: string) {
  const abs = join(hub.users.root(user), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "x");
}

const get = async (id: string, user = "alice") => app.inject({ url: `/api/sessions/${id}/outputs`, headers: as(user) });

describe("GET /api/sessions/:id/outputs", () => {
  it("is empty without touches", async () => {
    const r = await get(session());
    expect(r.statusCode).toBe(200);
    expect(SessionOutputsResponse.parse(r.json())).toEqual({ outputs: [] });
  });

  it("returns one entry per path (the newest touch), newest first, and flags missing files", async () => {
    const id = session();
    const other = session();
    file("alice", "a.txt");
    file("alice", "dir/b.md");
    touch(id, "a.txt", "2026-01-01T10:00:00.000Z", { tool: "Write", turn: 1 });
    touch(id, "dir/b.md", "2026-01-01T11:00:00.000Z", { tool: "Write", turn: 1 });
    touch(id, "gone.txt", "2026-01-01T12:00:00.000Z", { tool: "Write", turn: 2 });
    touch(id, "a.txt", "2026-01-01T13:00:00.000Z", { tool: "Edit", turn: 3 });
    touch(other, "other.txt", "2026-01-01T14:00:00.000Z");
    const r = await get(id);
    const body = SessionOutputsResponse.parse(r.json());
    expect(body.outputs).toEqual([
      { path: "a.txt", tool: "Edit", turn: 3, at: "2026-01-01T13:00:00.000Z", missing: false },
      { path: "gone.txt", tool: "Write", turn: 2, at: "2026-01-01T12:00:00.000Z", missing: true },
      { path: "dir/b.md", tool: "Write", turn: 1, at: "2026-01-01T11:00:00.000Z", missing: false },
    ]);
  });

  it("returns workspace-relative paths for project touches", async () => {
    const id = session();
    const p = hub.store.insertProject({ id: randomUUID(), user: "alice", name: "sample-app", origin: null });
    file("alice", "projects/sample-app/src/x.ts");
    touch(id, "src/x.ts", "2026-02-01T10:00:00.000Z", { projectId: p.id });
    touch(id, "src/y.ts", "2026-02-01T09:00:00.000Z", { projectId: p.id });
    const body = SessionOutputsResponse.parse((await get(id)).json());
    expect(body.outputs.map((o) => [o.path, o.missing])).toEqual([
      ["projects/sample-app/src/x.ts", false],
      ["projects/sample-app/src/y.ts", true],
    ]);
  });

  it("lists what a chat's agent wrote in the chat's own folder; the files routes download it (paths relative to the user root)", async () => {
    hub.store.ensureUser("alice");
    const chat = hub.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null });
    expect(chat.cwd).toBe(`.chat/${chat.id}`);
    const rel = `.chat/${chat.id}/chart.png`;
    file("alice", rel);
    touch(chat.id, rel, "2026-03-01T10:00:00.000Z", { tool: "Write", turn: 1 });
    touch(chat.id, `.chat/${chat.id}/gone.csv`, "2026-03-01T09:00:00.000Z", { tool: "Edit", turn: 1 });
    const body = SessionOutputsResponse.parse((await get(chat.id)).json());
    expect(body.outputs.map((o) => [o.path, o.tool, o.missing])).toEqual([
      [rel, "Write", false],
      [`.chat/${chat.id}/gone.csv`, "Edit", true],
    ]);
    const dl = await app.inject({ url: `/api/files/download?path=${encodeURIComponent(rel)}`, headers: as("alice") });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe("x");
    expect((await get(chat.id, "bob")).statusCode).toBe(404);
  });

  it("caps at 200 entries", async () => {
    const id = session();
    for (let i = 0; i < 205; i++) touch(id, `f${i}.txt`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
    const body = SessionOutputsResponse.parse((await get(id)).json());
    expect(body.outputs).toHaveLength(200);
    expect(body.outputs[0]!.path).toBe("f204.txt");
    expect(body.outputs[199]!.path).toBe("f5.txt");
  });

  it("404s for another user's session and for unknown ids", async () => {
    const id = session();
    touch(id, "a.txt", "2026-01-01T10:00:00.000Z");
    expect((await get(id, "bob")).statusCode).toBe(404);
    expect((await get(randomUUID())).statusCode).toBe(404);
    expect((await get("not-a-uuid")).statusCode).toBe(404);
  });
});
