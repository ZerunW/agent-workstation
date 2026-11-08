import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  AdminOverview,
  AdminUsageResponse,
  CommandsResponse,
  DiskStatus,
  ErrorBody,
  HubHealth,
  Me,
  MessagesResponse,
  ModelsResponse,
  MyUsageResponse,
  ServerEvent,
  Session,
  SessionsResponse,
  TreeResponse,
  UPLOAD_HEADERS,
  UploadChunkResponse,
  UsageLimits,
  UsersResponse,
  TerminalInfo,
} from "@agent-workstation/protocol";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { createHub, startHub, stopHub, type Hub } from "../src/hub.js";
import { silentLogger } from "../src/util/log.js";
import { FakeSdk } from "./fakeSdk.js";
import { WS_UPGRADE, tempDir, until } from "./helpers.js";

let app: FastifyInstance;
let hub: Hub;
let sdk: FakeSdk;
let cleanup: () => void;
let root: string;
let keyFile: string;
const disk = { used: 40 };

const as = (user: string) => ({ "x-workstation-user": user });

beforeAll(async () => {
  const t = tempDir();
  keyFile = join(t.dir, "anthropic.env");
  writeFileSync(keyFile, "ANTHROPIC_API_KEY=sk-ant-api03-routes-not-a-real-key\n");
  root = join(t.dir, "users");
  sdk = new FakeSdk();
  const config = parseConfig(
    {
      paths: { users_root: root, data_dir: join(t.dir, "data"), claude_bin: "", claude_home: join(t.dir, "claude-home") },
      // Never the machine's own key file (/etc/agent-workstation/anthropic.env).
      auth: { admin_usernames: ["admin"], tailscale_identity: false, lan_access: "legacy", anthropic_api_key_file: keyFile },
    },
    null,
    {},
  );
  hub = createHub(config, {
    log: silentLogger,
    sdk,
    dbFile: ":memory:",
    captureProcess: false,
    tmuxBin: null,
    statfs: async () => ({ totalBytes: 100 * 2 ** 30, freeBytes: (100 - disk.used) * 2 ** 30, usedPercent: disk.used }),
    du: async (paths) => new Map(paths.map((p) => [p, 1024])),
  });
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

async function waitIdle(sessionId: string, turns: number) {
  await until(() => hub.store.getSession(sessionId)!.turnCount >= turns && hub.sessions.statusOf(sessionId).status === "idle", 3000, "turn");
}

describe("anonymous endpoints and identity", () => {
  it("serves health and healthz without a username; usage limits need one", async () => {
    expect((await app.inject("/healthz")).body).toBe("ok");
    const h = await app.inject("/api/health");
    expect(HubHealth.parse(h.json())).toMatchObject({ ok: true, protocolVersion: 1 });
    expect((await app.inject("/api/usage/limits")).statusCode).toBe(401);
    const l = await app.inject({ url: "/api/usage/limits", headers: as("alice") });
    expect(l.statusCode).toBe(200);
    UsageLimits.parse(l.json());
  });

  it("requires a username elsewhere, rejects reserved names, auto-creates users", async () => {
    const r = await app.inject("/api/me");
    expect(r.statusCode).toBe(401);
    expect(ErrorBody.parse(r.json()).code).toBe("user_required");
    expect((await app.inject({ url: "/api/me", headers: as("_system") })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/me", headers: as("Bad Name!") })).statusCode).toBe(400);
    const me = Me.parse((await app.inject({ url: "/api/me", headers: as("alice") })).json());
    expect(me.user).toMatchObject({ name: "alice", isAdmin: false, enabled: true });
    // ?user= fallback (browser downloads / WebSocket upgrades)
    expect((await app.inject("/api/me?user=alice")).statusCode).toBe(200);
    // the user list is admin-only: nobody can enumerate usernames from the login screen
    expect((await app.inject("/api/users")).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/users", headers: as("alice") })).statusCode).toBe(403);
    const users = UsersResponse.parse((await app.inject({ url: "/api/users", headers: as("admin") })).json());
    expect(users.map((u) => u.name)).toContain("alice");
    expect(users.map((u) => u.name)).not.toContain("_system");
    const created = await app.inject({ method: "POST", url: "/api/users", payload: { name: "bob" } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/users", payload: { name: "bob" } })).statusCode).toBe(200);
  });

  it("reads the user from X-Workstation-User only", async () => {
    expect((await app.inject({ url: "/api/me", headers: { "x-user": "carol" } })).statusCode).toBe(401);
    const dave = await app.inject({ url: "/api/me", headers: { "x-workstation-user": "dave" } });
    expect(Me.parse(dave.json()).user.name).toBe("dave");
  });
});

describe("sessions and pre-send checks", () => {
  let sessionId: string;

  it("creates, lists, isolates and runs a chat session", async () => {
    const r = await app.inject({ method: "POST", url: "/api/sessions", headers: as("alice"), payload: { kind: "chat" } });
    expect(r.statusCode).toBe(201);
    const s = Session.parse(r.json());
    expect(s).toMatchObject({ kind: "chat", cwd: `.chat/${s.id}`, permissionMode: "dontAsk", status: "idle", lastSeq: 0 });
    sessionId = s.id;
    expect(SessionsResponse.parse((await app.inject({ url: "/api/sessions?kind=chat", headers: as("alice") })).json()).map((x) => x.id)).toContain(s.id);
    expect((await app.inject({ url: "/api/sessions?kind=code", headers: as("alice") })).json()).toEqual([]);
    expect((await app.inject({ url: `/api/sessions/${s.id}`, headers: as("bob") })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/sessions", headers: as("bob") })).json()).toEqual([]);

    const send = await app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: as("alice"), payload: { uuid: randomUUID(), text: "hi there" } });
    expect(send.statusCode).toBe(200);
    expect(send.json()).toMatchObject({ state: "accepted", seq: 1 });
    await waitIdle(s.id, 1);
    const msgs = MessagesResponse.parse((await app.inject({ url: `/api/sessions/${s.id}/messages?after=0`, headers: as("alice") })).json());
    expect(msgs.map((m) => m.kind)).toEqual(["user", "system", "assistant", "result"]);
    expect((await app.inject({ url: `/api/sessions/${s.id}/messages?after=2&limit=1`, headers: as("alice") })).json()).toHaveLength(1);

    const renamed = await app.inject({ method: "PATCH", url: `/api/sessions/${s.id}`, headers: as("alice"), payload: { title: "Renamed" } });
    expect(Session.parse(renamed.json()).title).toBe("Renamed");
    const set = await app.inject({ method: "PATCH", url: `/api/sessions/${s.id}/settings`, headers: as("alice"), payload: { model: "haiku", effort: "low" } });
    expect(Session.parse(set.json())).toMatchObject({ model: "haiku", effort: "low" });
  });

  it("validates bodies", async () => {
    const r = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, headers: as("alice"), payload: { uuid: "nope", text: 1 } });
    expect(r.statusCode).toBe(400);
    const body = ErrorBody.parse(r.json());
    expect(body.code).toBe("invalid_request");
    expect(Array.isArray(body.details)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/sessions", headers: as("alice"), payload: { kind: "code", cwd: "nope/missing" } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/sessions/not-a-uuid", headers: as("alice") })).statusCode).toBe(404);
  });

  it("enforces remote switch, user disable, weekly limit, disk block and the API key", async () => {
    const post = () => app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, headers: as("alice"), payload: { uuid: randomUUID(), text: "again" } });
    const code = async () => {
      const r = await post();
      return [r.statusCode, r.json<{ code?: string }>().code];
    };

    expect((await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: as("alice"), payload: { remoteClaudeEnabled: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: as("admin"), payload: { remoteClaudeEnabled: false } })).json()).toMatchObject({ remoteClaudeEnabled: false });
    expect(await code()).toEqual([403, "remote_disabled"]);
    await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: as("admin"), payload: { remoteClaudeEnabled: true } });

    await app.inject({ method: "PATCH", url: "/api/users/alice", headers: as("admin"), payload: { enabled: false } });
    expect(await code()).toEqual([403, "user_disabled"]);
    await app.inject({ method: "PATCH", url: "/api/users/alice", headers: as("admin"), payload: { enabled: true } });

    const patched = await app.inject({ method: "PATCH", url: "/api/users/alice", headers: as("admin"), payload: { weeklyTokenLimit: 5 } });
    expect(patched.json()).toMatchObject({ weeklyTokenLimit: 5 });
    expect(await code()).toEqual([429, "weekly_limit"]);
    await app.inject({ method: "PATCH", url: "/api/users/alice", headers: as("admin"), payload: { weeklyTokenLimit: null } });

    disk.used = 99;
    await hub.disk.check();
    expect(await code()).toEqual([507, "disk_block"]);
    disk.used = 40;
    await hub.disk.check();

    const key = readFileSync(keyFile, "utf8");
    rmSync(keyFile);
    hub.apiKeys.reload();
    expect(await code()).toEqual([503, "api_unavailable"]);
    expect((await app.inject({ method: "POST", url: "/api/sessions", headers: as("alice"), payload: { kind: "chat" } })).json()).toMatchObject({ code: "api_unavailable" });
    expect(Me.parse((await app.inject({ url: "/api/me", headers: as("alice") })).json()).apiAvailable).toBe(false);
    writeFileSync(keyFile, key);
    hub.apiKeys.reload();

    const ok = await post();
    expect(ok.statusCode).toBe(200);
    await waitIdle(sessionId, 2);
  });

  it("reports usage to the user and to the admin", async () => {
    const me = MyUsageResponse.parse((await app.inject({ url: "/api/usage/me?range=7d", headers: as("alice") })).json());
    expect(me.weeklyTokens).toBe(30);
    expect(me.buckets.reduce((s, b) => s + b.turns, 0)).toBe(2);
    expect((await app.inject({ url: "/api/usage/me?range=nope", headers: as("alice") })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/admin/usage", headers: as("alice") })).statusCode).toBe(403);
    const admin = AdminUsageResponse.parse((await app.inject({ url: "/api/admin/usage?range=30d", headers: as("admin") })).json());
    expect(admin.users.find((u) => u.user === "alice")).toMatchObject({ weeklyTokens: 30, sessions: 1 });
    const overview = AdminOverview.parse((await app.inject({ url: "/api/admin/overview", headers: as("admin") })).json());
    expect(overview.pool.max).toBe(6);
    expect((await app.inject({ url: "/api/usage/limits/history?range=today", headers: as("alice") })).statusCode).toBe(404);
    DiskStatus.parse((await app.inject({ url: "/api/disk", headers: as("alice") })).json());
  });

  it("fills models/commands via a short-lived process when the cache is empty", async () => {
    const models = ModelsResponse.parse((await app.inject({ url: "/api/models", headers: as("alice") })).json());
    expect(models.map((m) => m.value)).toEqual(["default", "haiku"]);
    const cmds = CommandsResponse.parse((await app.inject({ url: `/api/commands`, headers: as("alice") })).json());
    expect(cmds.map((c) => c.name)).toEqual(["compact", "my-skill"]);
    expect(cmds[1]!.isSkill).toBe(true);
  });

  it("deletes a session", async () => {
    const r = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}`, headers: as("alice") });
    expect(r.statusCode).toBe(204);
    expect((await app.inject({ url: `/api/sessions/${sessionId}`, headers: as("alice") })).statusCode).toBe(404);
  });
});

describe("files", () => {
  it("mkdir, upload, tree, content, download, zip, delete — all confined", async () => {
    expect((await app.inject({ method: "POST", url: "/api/files/mkdir", headers: as("alice"), payload: { path: "inbox/docs" } })).statusCode).toBe(201);
    const up = await app.inject({
      method: "PUT",
      url: "/api/files/upload",
      headers: {
        ...as("alice"),
        "content-type": "application/octet-stream",
        [UPLOAD_HEADERS.uploadId]: "route-upload-1",
        [UPLOAD_HEADERS.path]: encodeURIComponent("inbox/docs/hello.txt"),
        [UPLOAD_HEADERS.chunkIndex]: "0",
        [UPLOAD_HEADERS.chunkTotal]: "1",
        [UPLOAD_HEADERS.totalBytes]: "11",
      },
      payload: Buffer.from("hello world"),
    });
    expect(up.statusCode).toBe(200);
    expect(UploadChunkResponse.parse(up.json())).toMatchObject({ complete: true, path: "inbox/docs/hello.txt" });
    expect((await app.inject({ url: "/api/files/upload?uploadId=route-upload-1", headers: as("alice") })).json()).toMatchObject({ complete: true });

    const tree = TreeResponse.parse((await app.inject({ url: "/api/files/tree?path=inbox&depth=3", headers: as("alice") })).json());
    expect(tree.map((e) => e.path)).toEqual(["inbox/docs", "inbox/docs/hello.txt"]);
    const content = await app.inject({ url: "/api/files/content?path=inbox/docs/hello.txt", headers: as("alice") });
    expect(content.json()).toMatchObject({ text: "hello world", truncated: false, mediaType: "text/plain", size: 11 });

    const dl = await app.inject({ url: "/api/files/download?path=inbox/docs/hello.txt&user=alice" });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe("hello world");
    expect(dl.headers["content-disposition"]).toContain("attachment");

    writeFileSync(join(root, "alice", "inbox", "second.txt"), "2");
    const zip = await app.inject({ url: "/api/files/download?path=inbox/docs&path=inbox/second.txt", headers: as("alice") });
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe("PK");

    mkdirSync(join(root, "outside-target"), { recursive: true });
    symlinkSync(join(root, "outside-target"), join(root, "alice", "inbox", "escape"));
    expect((await app.inject({ url: "/api/files/tree?path=inbox/escape", headers: as("alice") })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/files/content?path=../bob/x", headers: as("alice") })).statusCode).toBe(400);
    // other users cannot see alice's files
    expect((await app.inject({ url: "/api/files/content?path=inbox/docs/hello.txt", headers: as("bob") })).statusCode).toBe(404);

    expect((await app.inject({ method: "DELETE", url: "/api/files?path=inbox", headers: as("alice") })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/api/files?path=inbox/docs", headers: as("alice") })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/api/files?path=inbox/escape", headers: as("alice") })).statusCode).toBe(204);
  });

  it("pauses uploads at the disk block level", async () => {
    disk.used = 99;
    await hub.disk.check();
    const r = await app.inject({ method: "PUT", url: "/api/files/upload", headers: { ...as("alice"), "content-type": "application/octet-stream" }, payload: Buffer.from("x") });
    expect(r.statusCode).toBe(507);
    disk.used = 40;
    await hub.disk.check();
  });
});

// ------------------------------------------------------------------ WebSocket

function collector(ws: WebSocket) {
  const events: ServerEvent[] = [];
  ws.on("message", (d) => events.push(ServerEvent.parse(JSON.parse(String(d)))));
  return {
    events,
    async waitFor<T extends ServerEvent["type"]>(type: T, pred: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true, ms = 3000) {
      return until(() => events.find((e): e is Extract<ServerEvent, { type: T }> => e.type === type && pred(e as Extract<ServerEvent, { type: T }>)), ms, `ws ${type}`);
    },
  };
}

describe("WebSocket handshake", () => {
  it("hello → welcome; subscribe → replay → snapshot → live", async () => {
    const created = Session.parse((await app.inject({ method: "POST", url: "/api/sessions", headers: as("alice"), payload: { kind: "chat" } })).json());
    await app.inject({ method: "POST", url: `/api/sessions/${created.id}/messages`, headers: as("alice"), payload: { uuid: randomUUID(), text: "first" } });
    await waitIdle(created.id, 1);

    const ws = await app.injectWS("/ws", WS_UPGRADE);
    const c = collector(ws);
    ws.send(JSON.stringify({ type: "subscribe", sessionId: created.id, lastSeq: 0 }));
    await c.waitFor("error", (e) => e.code === "hello_required");
    ws.send(JSON.stringify({ type: "hello", user: "alice", protocolVersion: 1 }));
    await c.waitFor("welcome");
    await c.waitFor("usage_limits");
    await c.waitFor("disk_status");

    ws.send(JSON.stringify({ type: "subscribe", sessionId: created.id, lastSeq: 1 }));
    const snap = await c.waitFor("snapshot");
    const types = c.events.map((e) => e.type);
    const replayIdx = types.indexOf("replay");
    expect(replayIdx).toBeGreaterThan(-1);
    expect(replayIdx).toBeLessThan(types.indexOf("snapshot"));
    const replay = c.events[replayIdx] as Extract<ServerEvent, { type: "replay" }>;
    expect(replay.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
    expect(snap.snapshot.session.status).toBe("idle");

    // bob subscribing to alice's session is refused
    const wsBob = await app.injectWS("/ws", WS_UPGRADE);
    const b = collector(wsBob);
    wsBob.send(JSON.stringify({ type: "hello", user: "bob", protocolVersion: 1 }));
    await b.waitFor("welcome");
    wsBob.send(JSON.stringify({ type: "subscribe", sessionId: created.id, lastSeq: 0 }));
    await b.waitFor("error", (e) => e.code === "not_found");

    // live events after the snapshot
    await app.inject({ method: "POST", url: `/api/sessions/${created.id}/messages`, headers: as("alice"), payload: { uuid: randomUUID(), text: "second" } });
    await c.waitFor("message", (e) => e.message.kind === "result" && e.message.seq > 4);
    expect(c.events.some((e) => e.type === "delta")).toBe(true);
    expect(c.events.some((e) => e.type === "session_state" && e.status === "running")).toBe(true);
    expect(b.events.some((e) => e.type === "message" || e.type === "delta")).toBe(false);

    ws.send(JSON.stringify({ type: "ping" }));
    await c.waitFor("pong");
    ws.terminate();
    wsBob.terminate();
  });

  it("re-sends pending permissions after a reconnect; first answer wins", async () => {
    const created = Session.parse((await app.inject({ method: "POST", url: "/api/sessions", headers: as("alice"), payload: { kind: "code" } })).json());
    let result: unknown = null;
    const prev = sdk.behavior;
    sdk.behavior = async (q) => {
      q.init();
      result = await q.askPermission("Bash", { command: "ls" });
      q.reply("listed");
    };
    const ws1 = await app.injectWS("/ws", WS_UPGRADE);
    const c1 = collector(ws1);
    ws1.send(JSON.stringify({ type: "hello", user: "alice", protocolVersion: 1 }));
    await c1.waitFor("welcome");
    await app.inject({ method: "POST", url: `/api/sessions/${created.id}/messages`, headers: as("alice"), payload: { uuid: randomUUID(), text: "ls" } });
    const req = await c1.waitFor("permission_request");
    ws1.terminate(); // tab closed

    const ws2 = await app.injectWS("/ws", WS_UPGRADE);
    const c2 = collector(ws2);
    ws2.send(JSON.stringify({ type: "hello", user: "alice", protocolVersion: 1 }));
    await c2.waitFor("welcome");
    ws2.send(JSON.stringify({ type: "subscribe", sessionId: created.id, lastSeq: 0 }));
    const snap = await c2.waitFor("snapshot");
    expect(snap.snapshot.pendingPermission?.requestId).toBe(req.request.requestId);
    expect(snap.snapshot.session.status).toBe("requires_action");

    ws2.send(JSON.stringify({ type: "permission_response", sessionId: created.id, response: { requestId: req.request.requestId, behavior: "allow" } }));
    await c2.waitFor("permission_resolved");
    ws2.send(JSON.stringify({ type: "permission_response", sessionId: created.id, response: { requestId: req.request.requestId, behavior: "deny" } }));
    await c2.waitFor("error", (e) => e.code === "permission_not_found");
    await until(() => result);
    expect(result).toMatchObject({ behavior: "allow" });
    ws2.terminate();
    sdk.behavior = prev;
  });
});

describe("terminals (direct pty mode, no tmux on this machine)", () => {
  it("new users start without a terminal unless they are admins; an admin turns it on", async () => {
    expect((await app.inject({ method: "POST", url: "/api/terminals", headers: as("terminal-newbie"), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/me", headers: as("terminal-newbie") })).json().user.terminalEnabled).toBe(false);
    expect((await app.inject({ url: "/api/me", headers: as("admin") })).json().user.terminalEnabled).toBe(true);
    const on = await app.inject({ method: "PATCH", url: "/api/users/terminal-newbie", headers: as("admin"), payload: { terminalEnabled: true } });
    expect(on.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/me", headers: as("terminal-newbie") })).json().user.terminalEnabled).toBe(true);
  });

  it("creates, attaches over WS, echoes input, deletes", async () => {
    await app.inject({ url: "/api/me", headers: as("alice") });
    await app.inject({ method: "PATCH", url: "/api/users/alice", headers: as("admin"), payload: { terminalEnabled: true } });
    const r = await app.inject({ method: "POST", url: "/api/terminals", headers: as("alice"), payload: { cwd: "inbox" } });
    expect(r.statusCode).toBe(201);
    const info = TerminalInfo.parse(r.json());
    expect(info.tmuxSession).toBe(`term-alice-${info.id}`);
    expect((await app.inject({ url: "/api/terminals", headers: as("alice") })).json()).toHaveLength(1);
    expect((await app.inject({ url: "/api/terminals", headers: as("bob") })).json()).toHaveLength(0);

    const ws = await app.injectWS(`/ws/terminal/${info.id}?user=alice`, WS_UPGRADE);
    let out = "";
    ws.on("message", (d) => {
      const f = JSON.parse(String(d)) as { t: string; data?: string };
      if (f.t === "out") out += f.data;
    });
    ws.send(JSON.stringify({ t: "resize", cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ t: "in", data: "echo workstation-$((40+2))\r" }));
    await until(() => out.includes("workstation-42"), 5000, "terminal echo").catch((e) => { throw new Error(`${e.message}; got: ${JSON.stringify(out.slice(-500))}`); });
    ws.terminate();

    await app.inject({ method: "PATCH", url: "/api/users/alice", headers: as("admin"), payload: { terminalEnabled: false } });
    expect((await app.inject({ method: "POST", url: "/api/terminals", headers: as("alice"), payload: {} })).statusCode).toBe(403);
    await app.inject({ method: "PATCH", url: "/api/users/alice", headers: as("admin"), payload: { terminalEnabled: true } });

    expect((await app.inject({ method: "DELETE", url: `/api/terminals/${info.id}`, headers: as("alice") })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/terminals", headers: as("alice") })).json()).toHaveLength(0);
  });
});

describe("projects (smoke; full flow in projects.test.ts)", () => {
  it("lists nothing at first and validates the create body", async () => {
    expect((await app.inject({ url: "/api/projects", headers: as("alice") })).json()).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/projects", headers: as("alice"), payload: {} })).statusCode).toBe(400);
  });
});
