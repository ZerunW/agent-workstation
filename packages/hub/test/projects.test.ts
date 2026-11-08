/**
 * Projects end to end against the real sync-core (real git in a temp dir) and
 * the fake SDK: baseline → push → Claude edits through hooks → review → hunk
 * accept with diffId → stale diffId → reject → history/restore → raw download →
 * delete refusal and discard → disk breakdown.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  AcceptResponse,
  DiskStatus,
  ErrorBody,
  FileDiff,
  HistoryResponse,
  ManifestResponse,
  Project,
  RejectResponse,
  RestoreResponse,
  ReviewResponse,
  ServerEvent,
  SessionsResponse,
  SyncResult,
} from "@agent-workstation/protocol";
import { computeDiffId } from "../src/projects/diffId.js";
import { ToolHolds } from "../src/projects/holds.js";
import { validateProjectName } from "../src/projects/service.js";
import { silentLogger } from "../src/util/log.js";
import { WS_UPGRADE, hubFixture, tempDir, tick, until, type HubFixture } from "./helpers.js";

let f: HubFixture;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n") + "\n";

beforeAll(async () => {
  f = await hubFixture();
});
afterAll(async () => {
  await f.close();
});

function collector(ws: WebSocket) {
  const events: ServerEvent[] = [];
  ws.on("message", (d) => events.push(ServerEvent.parse(JSON.parse(String(d)))));
  return {
    events,
    waitFor<T extends ServerEvent["type"]>(type: T, pred: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true, ms = 4000) {
      return until(() => events.find((e): e is Extract<ServerEvent, { type: T }> => e.type === type && pred(e as Extract<ServerEvent, { type: T }>)), ms, `ws ${type}`);
    },
  };
}

function tarball(files: Record<string, string>, zstd: boolean): Buffer {
  const t = tempDir("workstation-tar-");
  try {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(t.dir, "src", p, ".."), { recursive: true });
      writeFileSync(join(t.dir, "src", p), c);
    }
    const out = join(t.dir, zstd ? "b.tar.zst" : "b.tar");
    execFileSync("tar", ["-c", ...(zstd ? ["--zstd"] : []), "-f", out, "-C", join(t.dir, "src"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return readFileSync(out);
  } finally {
    t.cleanup();
  }
}

describe("pure helpers", () => {
  it("validates project names", () => {
    expect(validateProjectName("app_v2.1-x")).toBe("app_v2.1-x");
    for (const bad of ["..", ".", ".hidden", "a/b", "", "x".repeat(65), "repo.git", "a b"]) expect(() => validateProjectName(bad)).toThrow();
  });

  it("diffId changes with the hunks and is stable otherwise", () => {
    const d = { path: "a.txt", binary: false, status: "modified", hunks: [{ header: "@@ -1,2 +1,2 @@", lines: ["-a", "+b", " c"] }] };
    expect(computeDiffId(d)).toBe(computeDiffId(structuredClone(d)));
    expect(computeDiffId(d)).not.toBe(computeDiffId({ ...d, hunks: [{ header: "@@ -1,2 +1,2 @@", lines: ["-a", "+B", " c"] }] }));
    expect(computeDiffId(d)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tool holds: release, suspend/resume and per-session release", async () => {
    const holds = new ToolHolds({ log: silentLogger, acquireTimeoutMs: 200 });
    const key = randomUUID();
    expect(await holds.acquire("t1", "s1", key)).toBe(true);
    // a second holder times out while t1 holds the lock
    expect(await holds.acquire("t2", "s2", key)).toBe(false);
    const resume = holds.suspend("t1");
    expect(resume).not.toBeNull();
    expect(holds.heldBy("t1")).toBe(false);
    expect(await holds.acquire("t3", "s2", key)).toBe(true);
    holds.release("t3");
    await resume!();
    expect(holds.heldBy("t1")).toBe(true);
    expect(holds.releaseSession("s1")).toBe(1);
    expect(holds.size).toBe(0);
    expect(holds.suspend("nope")).toBeNull();
  });
});

describe("projects API", () => {
  let project: Project;
  let plain: Project;
  let sessionId: string;
  const base = () => `/api/projects/${project.id}`;
  const A = (extra?: Record<string, string>) => f.as("alice", extra);
  const inject = (o: InjectOptions | string) => f.app.inject(o);
  const ws: { c: ReturnType<typeof collector> | null; sock: WebSocket | null } = { c: null, sock: null };

  afterAll(() => ws.sock?.terminate());

  it("creates projects, validates names, isolates users", async () => {
    const r = await inject({ method: "POST", url: "/api/projects", headers: A(), payload: { name: "sample-app", origin: "my-mac" } });
    expect(r.statusCode).toBe(201);
    project = Project.parse(r.json());
    expect(project).toMatchObject({ name: "sample-app", path: "projects/sample-app", user: "alice", origin: "my-mac", pendingFiles: 0 });
    expect(project.localCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(f.root, "alice", "projects", "sample-app"))).toBe(true);
    expect(existsSync(join(f.root, "alice", ".sync", "sample-app.git", "HEAD"))).toBe(true);

    const dup = await inject({ method: "POST", url: "/api/projects", headers: A(), payload: { name: "sample-app" } });
    expect(dup.statusCode).toBe(409);
    expect(ErrorBody.parse(dup.json()).code).toBe("project_exists");
    for (const name of ["..", ".x", "a/b"]) expect((await inject({ method: "POST", url: "/api/projects", headers: A(), payload: { name } })).statusCode).toBe(400);

    const list = (await inject({ url: "/api/projects", headers: A() })).json() as Project[];
    expect(list.map((p) => p.name)).toEqual(["sample-app"]);
    expect((await inject({ url: base(), headers: f.as("bob") })).statusCode).toBe(404);
    expect((await inject({ url: "/api/projects", headers: f.as("bob") })).json()).toEqual([]);
    expect(Project.parse((await inject({ url: base(), headers: A() })).json()).id).toBe(project.id);
  });

  it("imports a tar.zst baseline (excludes applied) and a plain tar", async () => {
    const files = {
      "a.txt": lines(12),
      "conflict.txt": lines(3),
      "src/main.ts": "export const x = 1;\n",
      "中文 名.md": "# hi\n",
      "node_modules/dep/index.js": "ignored\n",
    };
    // The server excludes only what the person unchecked on the Mac (no built-in defaults): the Mac sends it first.
    const ex = await inject({ method: "PUT", url: `${base()}/excludes`, headers: A(), payload: { paths: [{ path: "node_modules", kind: "folder" }] } });
    expect(ex.statusCode).toBe(204);
    const r = await inject({ method: "POST", url: `${base()}/baseline`, headers: A({ "content-type": "application/octet-stream" }), payload: tarball(files, true) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { localCommit: string; files: number; trashRef: string | null };
    expect(body.files).toBe(4);
    expect(readFileSync(join(f.root, "alice", "projects", "sample-app", "中文 名.md"), "utf8")).toBe("# hi\n");
    const p = Project.parse((await inject({ url: base(), headers: A() })).json());
    expect(p.localCommit).toBe(body.localCommit);
    expect(p.pendingFiles).toBe(0);

    plain = Project.parse((await inject({ method: "POST", url: "/api/projects", headers: A(), payload: { name: "plain" } })).json());
    const r2 = await inject({ method: "POST", url: `/api/projects/${plain.id}/baseline`, headers: A({ "content-type": "application/octet-stream", "x-baseline-encoding": "tar" }), payload: tarball({ "x.txt": "x\n", "d/y.txt": "y\n" }, false) });
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { files: number }).files).toBe(2);
    expect(readFileSync(join(f.root, "alice", "projects", "plain", "d", "y.txt"), "utf8")).toBe("y\n");
    // garbage is a clean 4xx/5xx, not a crash
    const bad = await inject({ method: "POST", url: `/api/projects/${plain.id}/baseline`, headers: A({ "content-type": "application/octet-stream", "x-baseline-encoding": "tar" }), payload: Buffer.from("not a tar") });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("reconciles a manifest and applies pushes", async () => {
    const m = await inject({
      method: "POST",
      url: `${base()}/manifest`,
      headers: A(),
      payload: { entries: [
        { path: "a.txt", hash: sha(lines(12)), size: 1, mode: 0o100644 },
        { path: "new-on-mac.txt", hash: sha("n\n"), size: 2, mode: 0o100644 },
        { path: "src/main.ts", hash: sha("changed"), size: 7, mode: 0o100644 },
      ] },
    });
    const man = ManifestResponse.parse(m.json());
    expect(man.need.sort()).toEqual(["new-on-mac.txt", "src/main.ts"]);
    expect(man.delete.sort()).toEqual(["conflict.txt", "中文 名.md"]);

    const content = "pushed\n";
    const r = await inject({ method: "PUT", url: `${base()}/files`, headers: A(), payload: { ops: [{ op: "write", path: "b.txt", hash: sha(content), size: content.length, mode: 0o100644, baseHash: null, contentBase64: Buffer.from(content).toString("base64") }] } });
    expect(r.statusCode).toBe(200);
    const res = SyncResult.parse(r.json());
    expect(res.results).toEqual([{ path: "b.txt", status: "applied" }]);
    expect(readFileSync(join(f.root, "alice", "projects", "sample-app", "b.txt"), "utf8")).toBe(content);
    // echo of the same content is a noop
    const again = SyncResult.parse((await inject({ method: "PUT", url: `${base()}/files`, headers: A(), payload: { ops: [{ op: "write", path: "b.txt", hash: sha(content), size: content.length, mode: 0o100644, baseHash: sha(content) }] } })).json());
    expect(again.results[0]!.status).toBe("noop");
  });

  it("a code session's Write/Edit holds the project lock and records touches; result snapshots", async () => {
    const sock = await f.app.injectWS("/ws", WS_UPGRADE);
    ws.sock = sock;
    ws.c = collector(sock);
    sock.send(JSON.stringify({ type: "hello", user: "alice", protocolVersion: 1 }));
    await ws.c.waitFor("welcome");

    const cr = await inject({ method: "POST", url: "/api/sessions", headers: A(), payload: { kind: "code", cwd: "projects/sample-app" } });
    expect(cr.statusCode).toBe(201);
    sessionId = (cr.json() as { id: string }).id;
    expect((cr.json() as { projectId: string }).projectId).toBe(project.id);

    const cwdAbs = join(f.root, "alice", "projects", "sample-app");
    const observed: { reviewSettledWhileHeld: boolean | null; lockFreeDuringPrompt: boolean | null } = { reviewSettledWhileHeld: null, lockFreeDuringPrompt: null };
    f.sdk.behavior = async (q) => {
      q.init();
      // Edit a.txt (two separate hunks) under the hold; a review read must wait for PostToolUse.
      await q.runHooks("PreToolUse", "Edit", { file_path: join(cwdAbs, "a.txt") }, "toolu_edit");
      let settled = false;
      const reviewP = inject({ url: `${base()}/review`, headers: A() }).then((r) => ((settled = true), r));
      await tick(150);
      observed.reviewSettledWhileHeld = settled;
      writeFileSync(join(cwdAbs, "a.txt"), lines(12).replace("line 2\n", "line 2 EDITED\n").replace("line 11\n", "line 11 EDITED\n"));
      await q.runHooks("PostToolUse", "Edit", { file_path: join(cwdAbs, "a.txt") }, "toolu_edit");
      const review = ReviewResponse.parse((await reviewP).json());
      expect(review.files.find((x) => x.path === "a.txt")?.status).toBe("modified");

      // Write a new file; the permission prompt suspends the hold.
      await q.runHooks("PreToolUse", "Write", { file_path: "src/new.txt", content: "new\n" }, "toolu_write");
      const decision = q.options.canUseTool!("Write", { file_path: "src/new.txt", content: "new\n" }, { signal: new AbortController().signal, toolUseID: "toolu_write", requestId: randomUUID() });
      const pending = await until(() => f.hub.sessions.permissions.pendingFor(sessionId)[0], 2000, "permission");
      expect(pending.toolUseId).toBe("toolu_write");
      let freeSettled = false;
      const free = inject({ url: base(), headers: A() }).then(() => (freeSettled = true));
      await until(() => freeSettled, 2000, "lock free during the prompt").catch(() => undefined);
      observed.lockFreeDuringPrompt = freeSettled;
      await free;
      f.hub.sessions.respondPermission("alice", sessionId, { requestId: pending.requestId, behavior: "allow" });
      expect((await decision)?.behavior).toBe("allow");
      mkdirSync(join(cwdAbs, "src"), { recursive: true });
      writeFileSync(join(cwdAbs, "src", "new.txt"), "new\n");
      await q.runHooks("PostToolUse", "Write", { file_path: "src/new.txt" }, "toolu_write");

      // A failed tool must release its hold too.
      await q.runHooks("PreToolUse", "Edit", { file_path: join(cwdAbs, "b.txt") }, "toolu_fail");
      await q.runHooks("PostToolUseFailure", "Edit", { file_path: join(cwdAbs, "b.txt") }, "toolu_fail");
      expect(f.hub.projects.holds.size).toBe(0);

      const mid = `msg_${randomUUID().slice(0, 6)}`;
      q.assistant(mid, "done");
      q.result();
    };
    const send = await inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, headers: A(), payload: { uuid: randomUUID(), text: "please edit a.txt\nand add a file" } });
    expect(send.statusCode).toBe(200);
    await until(() => f.hub.store.getSession(sessionId)!.turnCount >= 1 && f.hub.sessions.statusOf(sessionId).status === "idle", 5000, "turn");
    expect(observed.reviewSettledWhileHeld).toBe(false);
    expect(observed.lockFreeDuringPrompt).toBe(true);

    // file_touches carry the project and project-relative paths
    const touches = f.hub.store.db.prepare("SELECT path, tool, turn, project_id AS projectId, session_id AS sessionId FROM file_touches WHERE project_id = ? ORDER BY id").all(project.id) as { path: string; tool: string; turn: number }[];
    expect(touches.map((t) => [t.path, t.tool, t.turn])).toEqual([
      ["a.txt", "Edit", 1],
      ["src/new.txt", "Write", 1],
    ]);

    // review: lastTouchedBy filled
    const review = ReviewResponse.parse((await inject({ url: `${base()}/review`, headers: A() })).json());
    const byPath = new Map(review.files.map((x) => [x.path, x]));
    expect(byPath.get("a.txt")?.lastTouchedBy).toMatchObject({ sessionId, turn: 1, tool: "Edit" });
    expect(byPath.get("src/new.txt")).toMatchObject({ status: "added", lastTouchedBy: { sessionId, turn: 1, tool: "Write" } });
    expect(review.project.pendingFiles).toBe(review.files.length);

    // snapshot at turn end, then review_changed
    const history = await until(async () => {
      const h = HistoryResponse.parse((await inject({ url: `${base()}/history`, headers: A() })).json());
      return h.find((s) => s.kind === "snapshot") ? h : null;
    }, 4000, "snapshot");
    expect(history.find((s) => s.kind === "snapshot")).toMatchObject({ sessionId, turn: 1, message: "please edit a.txt" });
    await ws.c.waitFor("review_changed", (e) => e.projectId === project.id && e.pendingFiles >= 2);

    // Session.projectId on the list
    const sessions = SessionsResponse.parse((await inject({ url: "/api/sessions?kind=code", headers: A() })).json());
    expect(sessions.find((s) => s.id === sessionId)?.projectId).toBe(project.id);
  });

  it("accepts hunks with a diffId, refuses a stale one, rejects the rest", async () => {
    const d1 = FileDiff.parse((await inject({ url: `${base()}/review/diff?path=a.txt`, headers: A() })).json());
    expect(d1.hunks).toHaveLength(2);
    expect(d1.diffId).toMatch(/^[0-9a-f]{64}$/);

    const noId = await inject({ method: "POST", url: `${base()}/review/accept`, headers: A(), payload: { path: "a.txt", hunks: [0] } });
    expect(noId.statusCode).toBe(400);
    const wrong = await inject({ method: "POST", url: `${base()}/review/accept`, headers: A(), payload: { path: "a.txt", hunks: [0], diffId: "0".repeat(64) } });
    expect(wrong.statusCode).toBe(409);
    expect(ErrorBody.parse(wrong.json())).toMatchObject({ code: "stale_diff", details: { diffId: d1.diffId } });

    const ok = await inject({ method: "POST", url: `${base()}/review/accept`, headers: A(), payload: { path: "a.txt", hunks: [0], diffId: d1.diffId } });
    expect(ok.statusCode).toBe(200);
    const acc = AcceptResponse.parse(ok.json());
    const accepted = Buffer.from(acc.files[0]!.contentBase64!, "base64").toString("utf8");
    expect(accepted).toContain("line 2 EDITED");
    expect(accepted).not.toContain("line 11 EDITED");
    const p = Project.parse((await inject({ url: base(), headers: A() })).json());
    expect(p.localCommit).toBe(acc.localCommit);

    // the old diffId is stale now
    const stale = await inject({ method: "POST", url: `${base()}/review/reject`, headers: A(), payload: { path: "a.txt", hunks: [0], diffId: d1.diffId } });
    expect(stale.statusCode).toBe(409);
    expect(ErrorBody.parse(stale.json()).code).toBe("stale_diff");

    const d2 = FileDiff.parse((await inject({ url: `${base()}/review/diff?path=a.txt`, headers: A() })).json());
    expect(d2.hunks).toHaveLength(1);
    expect(d2.diffId).not.toBe(d1.diffId);
    const rej = await inject({ method: "POST", url: `${base()}/review/reject`, headers: A(), payload: { path: "a.txt", hunks: [0], diffId: d2.diffId } });
    expect(rej.statusCode).toBe(200);
    expect(RejectResponse.parse(rej.json()).paths).toEqual(["a.txt"]);
    const onDisk = readFileSync(join(f.root, "alice", "projects", "sample-app", "a.txt"), "utf8");
    expect(onDisk).toContain("line 2 EDITED");
    expect(onDisk).not.toContain("line 11 EDITED");

    // whole-file reject of the new file removes it (a trash ref keeps it)
    const rejNew = RejectResponse.parse((await inject({ method: "POST", url: `${base()}/review/reject`, headers: A(), payload: { path: "src/new.txt" } })).json());
    expect(rejNew.trashRef).toMatch(/^refs\/trash\//);
    expect(existsSync(join(f.root, "alice", "projects", "sample-app", "src", "new.txt"))).toBe(false);
    const unknown = await inject({ url: `${base()}/review/diff?path=nope.txt`, headers: A() });
    expect(unknown.statusCode).toBe(404);
    const invalid = await inject({ url: `${base()}/review/diff?path=..%2Fx`, headers: A() });
    expect(invalid.statusCode).toBe(400);
  });

  it("reports push conflicts with 409 + sync_conflict", async () => {
    const wt = join(f.root, "alice", "projects", "sample-app", "conflict.txt");
    writeFileSync(wt, "line 1 SERVER\nline 2\nline 3\n");
    const mac = "line 1 MAC\nline 2\nline 3\n";
    const r = await inject({ method: "PUT", url: `${base()}/files`, headers: A(), payload: { ops: [{ op: "write", path: "conflict.txt", hash: sha(mac), size: mac.length, mode: 0o100644, baseHash: sha(lines(3)), contentBase64: Buffer.from(mac).toString("base64") }] } });
    expect(r.statusCode).toBe(409);
    const body = r.json() as { code: string; results: { path: string; status: string }[] };
    expect(body.code).toBe("sync_conflict");
    expect(SyncResult.parse(body).results[0]).toMatchObject({ path: "conflict.txt", status: "conflict" });
    await ws.c!.waitFor("sync_conflict", (e) => e.projectId === project.id && e.path === "conflict.txt");
  });

  it("watcher events in the work tree trigger review_changed; the tree shows reviewStatus", async () => {
    await tick(100);
    ws.c!.events.length = 0;
    writeFileSync(join(f.root, "alice", "projects", "sample-app", "watched.txt"), "seen by chokidar\n");
    await ws.c!.waitFor("review_changed", (e) => e.projectId === project.id, 6000);
    const tree = (await inject({ url: "/api/files/tree?path=projects%2Fsample-app&depth=1", headers: A() })).json() as { path: string; reviewStatus?: string }[];
    expect(tree.find((e) => e.path === "projects/sample-app/watched.txt")?.reviewStatus).toBe("added");
    expect(tree.find((e) => e.path === "projects/sample-app/conflict.txt")?.reviewStatus).toBe("modified");
    expect(tree.find((e) => e.path === "projects/sample-app/b.txt")?.reviewStatus).toBeUndefined();
  });

  it("lists history and restores a file from the turn snapshot", async () => {
    const h = HistoryResponse.parse((await inject({ url: `${base()}/history`, headers: A() })).json());
    const kinds = new Set(h.map((s) => s.kind));
    for (const k of ["snapshot", "sync", "accept", "trash"]) expect(kinds.has(k as never)).toBe(true);
    expect(HistoryResponse.parse((await inject({ url: `${base()}/history?limit=1`, headers: A() })).json())).toHaveLength(1);
    const snap = h.find((s) => s.kind === "snapshot")!;
    const r = await inject({ method: "POST", url: `${base()}/restore`, headers: A(), payload: { ref: snap.ref, path: "src/new.txt" } });
    expect(r.statusCode).toBe(200);
    expect(RestoreResponse.parse(r.json()).trashRef).toMatch(/^refs\/trash\//);
    expect(readFileSync(join(f.root, "alice", "projects", "sample-app", "src", "new.txt"), "utf8")).toBe("new\n");
    expect((await inject({ method: "POST", url: `${base()}/restore`, headers: A(), payload: { ref: "refs/heads/../../x" } })).statusCode).toBe(400);
  });

  it("serves raw bytes and counts them as downloaded", async () => {
    const r = await inject({ url: `${base()}/raw?path=src%2Fnew.txt`, headers: A() });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("new\n");
    expect(r.headers["content-disposition"]).toContain("attachment");
    expect((await inject({ url: `${base()}/raw?path=missing.txt`, headers: A() })).statusCode).toBe(404);
  });

  it("accept all commits every pending file in one go", async () => {
    const wt = join(f.root, "alice", "projects", "plain");
    writeFileSync(join(wt, "x.txt"), "x changed\n");
    writeFileSync(join(wt, "fresh.txt"), "fresh\n");
    const before = Project.parse((await inject({ url: `/api/projects/${plain.id}`, headers: A() })).json());
    expect(before.pendingFiles).toBe(2);
    const r = await inject({ method: "POST", url: `/api/projects/${plain.id}/review/accept`, headers: A(), payload: { all: true } });
    expect(r.statusCode).toBe(200);
    const acc = AcceptResponse.parse(r.json());
    expect(acc.files.map((x) => x.path).sort()).toEqual(["fresh.txt", "x.txt"]);
    const after = Project.parse((await inject({ url: `/api/projects/${plain.id}`, headers: A() })).json());
    expect(after.pendingFiles).toBe(0);
    expect(after.localCommit).toBe(acc.localCommit);
    expect(after.localCommit).not.toBe(before.localCommit);
  });

  it("disk status lists the caller's projects (all for admin)", async () => {
    await inject({ method: "POST", url: "/api/projects", headers: f.as("bob"), payload: { name: "bobs" } });
    await f.hub.disk.refreshBreakdown();
    const mine = DiskStatus.parse((await inject({ url: "/api/disk", headers: A() })).json());
    expect(mine.projects.map((p) => p.name).sort()).toEqual(["plain", "sample-app"]);
    const sampleApp = mine.projects.find((p) => p.name === "sample-app")!;
    expect(sampleApp.id).toBe(project.id);
    expect(sampleApp.pendingFiles).toBeGreaterThan(0);
    expect(sampleApp.bytes).toBeGreaterThan(0);
    expect(mine.breakdown.some((b) => b.label === "Project history" && b.path === ".sync")).toBe(true);
    const admin = DiskStatus.parse((await inject({ url: "/api/disk", headers: f.as("admin") })).json());
    expect(admin.projects.map((p) => p.name).sort()).toEqual(["bobs", "plain", "sample-app"]);
    const bob = DiskStatus.parse((await inject({ url: "/api/disk", headers: f.as("bob") })).json());
    expect(bob.projects.map((p) => p.name)).toEqual(["bobs"]);
  });

  it("the files API cannot delete a project or touch .sync", async () => {
    const r = await inject({ method: "DELETE", url: "/api/files?path=projects%2Fsample-app", headers: A() });
    expect(r.statusCode).toBe(409);
    expect((await inject({ method: "DELETE", url: "/api/files?path=.sync%2Fsample-app.git", headers: A() })).statusCode).toBe(403);
    expect((await inject({ method: "POST", url: "/api/files/mkdir", headers: A(), payload: { path: ".sync/x" } })).statusCode).toBe(403);
    const tree = (await inject({ url: "/api/files/tree?depth=2", headers: A() })).json() as { path: string }[];
    expect(tree.some((e) => e.path.startsWith(".sync"))).toBe(false);
    expect(tree.some((e) => e.path === "projects/sample-app")).toBe(true);
  });

  it("refuses to delete a project with undownloaded files unless discardRemaining", async () => {
    writeFileSync(join(f.root, "alice", "projects", "sample-app", "generated.bin"), "data");
    const r = await inject({ method: "DELETE", url: base(), headers: A({ "content-type": "application/json" }), payload: { discardRemaining: false } });
    expect(r.statusCode).toBe(409);
    const err = ErrorBody.parse(r.json());
    expect(err.code).toBe("project_not_empty");
    expect(err.details).toMatchObject({ undownloadedFiles: 2 }); // generated.bin + watched.txt (src/new.txt was downloaded)
    expect(existsSync(join(f.root, "alice", "projects", "sample-app", "a.txt"))).toBe(true);

    const ok = await inject({ method: "DELETE", url: base(), headers: A({ "content-type": "application/json" }), payload: { discardRemaining: true } });
    expect(ok.statusCode).toBe(204);
    expect(existsSync(join(f.root, "alice", "projects", "sample-app"))).toBe(false);
    expect(existsSync(join(f.root, "alice", ".sync", "sample-app.git"))).toBe(false);
    expect((await inject({ url: base(), headers: A() })).statusCode).toBe(404);
    expect(f.hub.store.db.prepare("SELECT COUNT(*) AS n FROM file_touches WHERE project_id = ?").get(project.id)).toEqual({ n: 0 });
    // the session survives (history kept) and is no longer in a project
    const s = SessionsResponse.parse((await inject({ url: "/api/sessions?kind=code", headers: A() })).json()).find((x) => x.id === sessionId);
    expect(s?.projectId).toBeNull();

    // query-string form, on a project that is clean
    const q = await inject({ method: "DELETE", url: `/api/projects/${plain.id}?discardRemaining=1`, headers: A() });
    expect(q.statusCode).toBe(204);
  });
});

describe("review patch", () => {
  const A = (extra?: Record<string, string>) => f.as("carol", extra);

  it("returns every pending change as one git diff (renames, binaries, empty files)", async () => {
    const created = await f.app.inject({ method: "POST", url: "/api/projects", headers: A(), payload: { name: "patchy" } });
    const project = Project.parse(created.json());
    const url = `/api/projects/${project.id}/review/patch`;

    const clean = await f.app.inject({ url, headers: A() });
    expect(clean.statusCode).toBe(200);
    expect(clean.headers["content-type"]).toContain("text/x-diff");
    expect(clean.body).toBe("");

    const baseline = tarball({ "a.txt": lines(12), "old.txt": lines(30, " rename me"), "gone.txt": "bye\n", "bin.dat": "x" }, false);
    const b = await f.app.inject({ method: "POST", url: `/api/projects/${project.id}/baseline`, headers: A({ "content-type": "application/octet-stream", "x-baseline-encoding": "tar" }), payload: baseline });
    expect(b.statusCode).toBe(200);

    const wt = join(f.root, "carol", "projects", "patchy");
    writeFileSync(join(wt, "a.txt"), lines(12).replace("line 3\n", "line three\n"));
    rmSync(join(wt, "old.txt"));
    writeFileSync(join(wt, "moved.txt"), lines(30, " rename me"));
    rmSync(join(wt, "gone.txt"));
    writeFileSync(join(wt, "empty.txt"), "");
    mkdirSync(join(wt, "sub"), { recursive: true });
    writeFileSync(join(wt, "sub", "new.txt"), "brand new\n");
    writeFileSync(join(wt, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(wt, "fresh.bin"), Buffer.from([0, 9, 9, 0]));

    const r = await f.app.inject({ url, headers: A() });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/x-diff");
    const patch = r.body;
    expect(patch).toContain("diff --git a/a.txt b/a.txt");
    expect(patch).toContain("-line 3\n+line three\n");
    expect(patch).toMatch(/rename from old\.txt\nrename to moved\.txt/);
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toMatch(/diff --git a\/gone\.txt b\/gone\.txt\ndeleted file mode/);
    expect(patch).toMatch(/diff --git a\/empty\.txt b\/empty\.txt\nnew file mode 100644\nindex 0{7}\.\.e69de29\n/);
    expect(patch).toContain("+brand new");
    expect(patch).toContain("Binary files a/bin.dat and b/bin.dat differ");
    expect(patch).toContain("Binary files /dev/null and b/fresh.bin differ");

    // It is a real patch: applying its text parts (binaries are only marked) to a pristine copy of the baseline reproduces the work tree.
    const t = tempDir("workstation-patch-apply-");
    try {
      const tarFile = join(t.dir, "b.tar");
      writeFileSync(tarFile, baseline);
      const dir = join(t.dir, "copy");
      mkdirSync(dir);
      execFileSync("tar", ["-x", "-f", tarFile, "-C", dir]);
      writeFileSync(join(t.dir, "p.diff"), patch.split(/^(?=diff --git )/m).filter((c) => !c.includes("Binary files")).join(""));
      execFileSync("git", ["apply", "--no-index", "-p1", join(t.dir, "p.diff")], { cwd: dir, stdio: "pipe" });
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(readFileSync(join(wt, "a.txt"), "utf8"));
      expect(existsSync(join(dir, "old.txt"))).toBe(false);
      expect(readFileSync(join(dir, "moved.txt"), "utf8")).toBe(lines(30, " rename me"));
      expect(readFileSync(join(dir, "empty.txt"), "utf8")).toBe("");
      expect(readFileSync(join(dir, "sub", "new.txt"), "utf8")).toBe("brand new\n");
    } finally {
      t.cleanup();
    }

    // The review state is untouched, and other users cannot read it.
    const review = ReviewResponse.parse((await f.app.inject({ url: `/api/projects/${project.id}/review`, headers: A() })).json());
    expect(review.files.length).toBeGreaterThanOrEqual(7); // 7 when git pairs the rename, 8 when it does not
    expect((await f.app.inject({ url, headers: f.as("bob") })).statusCode).toBe(404);
  });
});
