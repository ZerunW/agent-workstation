/**
 * Server-side backups (refs/backups/…) and raw bytes at a ref, end to end against the real sync-core (real git in a
 * temp dir): round trip, nothing else in the repo or work tree changes, path/size validation, raw at commit / ref /
 * blob, never pruned.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HistoryResponse, Project, ProjectBackup, ProjectBackupsResponse, ReviewResponse } from "@agent-workstation/protocol";
import { gitBlobOid } from "@agent-workstation/sync-core";
import { clientSlug, validRawRef } from "../src/projects/backups.js";
import { hubFixture, tempDir, type HubFixture } from "./helpers.js";

let f: HubFixture;
let project: Project;
beforeAll(async () => {
  f = await hubFixture();
});
afterAll(async () => {
  await f.close();
});

const A = (extra: Record<string, string> = {}) => f.as("alice", extra);
const inject = (o: InjectOptions) => f.app.inject(o);
const base = () => `/api/projects/${project.id}`;
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const gitDir = () => join(f.root, "alice", ".sync", "demo.git");
const workTree = () => join(f.root, "alice", "projects", "demo");
const git = (...args: string[]) => execFileSync("git", [`--git-dir=${gitDir()}`, ...args], { encoding: "utf8" });

function tarball(files: Record<string, string>): Buffer {
  const t = tempDir("workstation-tar-");
  try {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(t.dir, "src", p, ".."), { recursive: true });
      writeFileSync(join(t.dir, "src", p), c);
    }
    const out = join(t.dir, "b.tar");
    execFileSync("tar", ["-c", "-f", out, "-C", join(t.dir, "src"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return readFileSync(out);
  } finally {
    t.cleanup();
  }
}

async function state() {
  const review = ReviewResponse.parse((await inject({ url: `${base()}/review`, headers: A() })).json());
  const history = HistoryResponse.parse((await inject({ url: `${base()}/history`, headers: A() })).json());
  const refs = git("for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter((l) => l && !l.startsWith("refs/backups/"));
  return { local: review.project.localCommit, files: review.files.map((x) => [x.path, x.status]), history, refs, work: readFileSync(join(workTree(), "a.txt"), "utf8") };
}

describe("project backups", () => {
  it("helpers: client slugs and accepted raw refs", () => {
    expect(clientSlug("mac:Alice's MacBook.local")).toBe("mac-alice-s-macbook-local");
    expect(clientSlug("::")).toBe("client");
    for (const ok of ["local", "refs/heads/local", "refs/backups/mac/20261031T1-abc", "refs/trash/x", "0123abc", "a".repeat(40)]) expect(validRawRef(ok)).toBe(true);
    for (const bad of ["HEAD", "HEAD~1", "main", "refs/backups/../heads/local", "refs/backups/.x", "refs/backups/x.lock", "refs/backups/", "refs/heads/other", "local:a.txt", "-x", "abc"]) expect(validRawRef(bad)).toBe(false);
  });

  it("stores a backup under refs/backups/<client>/<id> and changes nothing else", async () => {
    project = Project.parse((await inject({ method: "POST", url: "/api/projects", headers: A(), payload: { name: "demo" } })).json());
    const bl = await inject({ method: "POST", url: `${base()}/baseline`, headers: A({ "content-type": "application/octet-stream", "x-baseline-encoding": "tar" }), payload: tarball({ "a.txt": "one\n", "dir/b.txt": "bee\n" }) });
    expect(bl.statusCode).toBe(200);
    // A pending change in the work tree (Claude's edit) must survive untouched.
    writeFileSync(join(workTree(), "a.txt"), "one\nclaude edit\n");
    const before = await state();
    expect(before.files).toEqual([["a.txt", "modified"]]);

    const odd = 'odd "name"\\\twith\nnewline.txt';
    const bin = Buffer.from([0, 1, 2, 255, 0, 10]);
    const r = await inject({
      method: "POST",
      url: `${base()}/backups`,
      headers: A(),
      payload: {
        client: "mac:Alice's MacBook",
        reason: "overwrite",
        files: [
          { path: "a.txt", dataBase64: b64("mac version\n") },
          { path: "deep/new dir/ü file.bin", dataBase64: b64(bin), mode: 0o100755 },
          { path: odd, dataBase64: "" },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
    const backup = ProjectBackup.parse(r.json());
    expect(backup.ref).toMatch(/^refs\/backups\/mac-alice-s-macbook\/\d{8}T\d{9}Z-[0-9a-f]{6}$/);
    expect(backup.ref.endsWith(`/${backup.id}`)).toBe(true);
    expect(backup).toMatchObject({ client: "mac:Alice's MacBook", reason: "overwrite" });
    expect(backup.files).toEqual([
      { path: "a.txt", blob: gitBlobOid(Buffer.from("mac version\n")), size: 12 },
      { path: "deep/new dir/ü file.bin", blob: gitBlobOid(bin), size: 6 },
      { path: odd, blob: gitBlobOid(Buffer.alloc(0)), size: 0 },
    ]);
    // The commit's tree holds exactly the backed-up files (modes kept), and it has no parent.
    expect(git("rev-parse", backup.ref).trim()).toBe(backup.commit);
    const tree = git("ls-tree", "-r", "-z", backup.commit).split("\0").filter(Boolean);
    expect(tree.map((l) => l.slice(l.indexOf("\t") + 1)).sort()).toEqual(["a.txt", "deep/new dir/ü file.bin", odd].sort());
    expect(tree.find((l) => l.endsWith("ü file.bin"))).toMatch(/^100755 blob /);
    expect(git("rev-list", "--parents", "-n", "1", backup.commit).trim()).toBe(backup.commit);

    // local, review, history (snapshots / trash), other refs and the work tree are untouched.
    expect(await state()).toEqual(before);

    // Listing.
    const list = ProjectBackupsResponse.parse((await inject({ url: `${base()}/backups`, headers: A() })).json());
    expect(list.backups).toEqual([backup]);

    // A second backup is listed first.
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await inject({ method: "POST", url: `${base()}/backups`, headers: A(), payload: { client: "mac:Other", reason: "delete", files: [{ path: "dir/b.txt", dataBase64: b64("mac bee\n") }] } });
    expect(r2.statusCode).toBe(201);
    const second = ProjectBackup.parse(r2.json());
    const list2 = ProjectBackupsResponse.parse((await inject({ url: `${base()}/backups`, headers: A() })).json());
    expect(list2.backups.map((b) => b.id)).toEqual([second.id, backup.id]);
    expect(list2.backups[0]).toMatchObject({ client: "mac:Other", reason: "delete", ref: expect.stringMatching(/^refs\/backups\/mac-other\//) });
    expect(await state()).toEqual(before);

    // Raw bytes at the backup ref, its commit, the blob id; at local; and the work tree without ref.
    const raw = async (q: string) => inject({ url: `${base()}/raw?${q}`, headers: A() });
    expect((await raw(`path=a.txt&ref=${encodeURIComponent(backup.ref)}`)).body).toBe("mac version\n");
    expect((await raw(`path=a.txt&ref=${backup.commit}`)).body).toBe("mac version\n");
    expect((await raw(`path=a.txt&ref=${backup.commit.slice(0, 12)}`)).body).toBe("mac version\n");
    expect((await raw(`path=whatever.txt&ref=${backup.files[0]!.blob}`)).body).toBe("mac version\n");
    const binRes = await raw(`path=${encodeURIComponent("deep/new dir/ü file.bin")}&ref=${encodeURIComponent(backup.ref)}`);
    expect(binRes.rawPayload.equals(bin)).toBe(true);
    expect(binRes.headers["content-length"]).toBe("6");
    expect(binRes.headers["content-disposition"]).toContain("attachment");
    expect((await raw(`path=${encodeURIComponent(odd)}&ref=${encodeURIComponent(backup.ref)}`)).statusCode).toBe(200);
    expect((await raw("path=a.txt&ref=local")).body).toBe("one\n");
    expect((await raw("path=dir%2Fb.txt&ref=refs%2Fheads%2Flocal")).body).toBe("bee\n");
    expect((await raw("path=a.txt")).body).toBe("one\nclaude edit\n");
    const inline = await raw(`path=a.txt&ref=${encodeURIComponent(backup.ref)}&inline=1`);
    expect(inline.headers["content-security-policy"]).toBe("sandbox");
    expect(inline.headers["content-disposition"]).toContain("inline");
    // Missing ref / path / not a file → 404; bad ref or path → 400.
    expect((await raw("path=a.txt&ref=refs%2Fbackups%2Fnope%2Fx")).statusCode).toBe(404);
    expect((await raw(`path=dir%2Fb.txt&ref=${encodeURIComponent(backup.ref)}`)).statusCode).toBe(404);
    expect((await raw("path=dir&ref=local")).statusCode).toBe(404);
    expect((await raw(`path=a.txt&ref=${"0".repeat(40)}`)).statusCode).toBe(404);
    expect((await raw("path=a.txt&ref=HEAD~1")).statusCode).toBe(400);
    expect((await raw("path=a.txt&ref=refs%2Fheads%2F..%2Flocal")).statusCode).toBe(400);
    expect((await raw("path=..%2Fx&ref=local")).statusCode).toBe(400);
    expect((await raw("path=%2Fetc%2Fpasswd&ref=local")).statusCode).toBe(400);
    // Reading at a ref does not count as downloading the pending file.
    expect(await state()).toEqual(before);

    // Never pruned: an aggressive gc keeps every backup object.
    git("gc", "--prune=now", "--quiet");
    expect((await raw(`path=a.txt&ref=${encodeURIComponent(backup.ref)}`)).body).toBe("mac version\n");

    // Other users never see the project's backups.
    expect((await inject({ url: `${base()}/backups`, headers: f.as("bob") })).statusCode).toBe(404);
  });

  it("validates paths, base64, duplicates and sizes", async () => {
    const post = (files: unknown[], extra: Record<string, unknown> = {}) => inject({ method: "POST", url: `${base()}/backups`, headers: A(), payload: { client: "mac", reason: "manual", files, ...extra } });
    const one = (path: string, data = "x") => ({ path, dataBase64: b64(data) });
    const refsBefore = git("for-each-ref", "refs/backups");
    for (const path of ["/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/", ".git/config", "x/.GIT/y", "nul\0x"]) {
      const r = await post([one(path)]);
      expect(r.statusCode, path).toBe(400);
      expect(r.json().code).toBe("invalid_path");
    }
    expect((await post([one("a.txt"), one("a.txt")])).json()).toMatchObject({ code: "invalid_path" });
    expect((await post([one("a"), one("a/b")])).json()).toMatchObject({ code: "invalid_path" });
    expect((await post([{ path: "a.txt", dataBase64: "@@@" }])).json()).toMatchObject({ code: "invalid_request" });
    expect((await post([])).statusCode).toBe(400);
    expect((await post(Array.from({ length: 501 }, (_, i) => one(`f${i}.txt`)))).statusCode).toBe(400);
    expect((await post([one("a.txt")], { reason: "nope" })).statusCode).toBe(400);
    expect((await post([one("a.txt")], { client: "" })).statusCode).toBe(400);
    // 50 MB decoded is the limit (413 too_large), whatever the base64 says.
    const big = await post([{ path: "big.bin", dataBase64: Buffer.alloc(50 * 1024 * 1024 + 1).toString("base64") }]);
    expect(big.statusCode).toBe(413);
    expect(big.json().code).toBe("too_large");
    const split = await post([
      { path: "half1.bin", dataBase64: Buffer.alloc(25 * 1024 * 1024).toString("base64") },
      { path: "half2.bin", dataBase64: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") },
    ]);
    expect(split.statusCode).toBe(413);
    expect(git("for-each-ref", "refs/backups")).toBe(refsBefore);
    // 500 files are fine.
    const many = await post(Array.from({ length: 500 }, (_, i) => one(`many/f${i}.txt`, `file ${i}`)));
    expect(many.statusCode).toBe(201);
    expect(ProjectBackup.parse(many.json()).files).toHaveLength(500);
  }, 30_000);

  it("refuses backups while the disk is at block level", async () => {
    f.disk.used = 97;
    await f.hub.disk.check();
    const r = await inject({ method: "POST", url: `${base()}/backups`, headers: A(), payload: { client: "mac", reason: "manual", files: [{ path: "a.txt", dataBase64: b64("x") }] } });
    f.disk.used = 40;
    await f.hub.disk.check();
    expect(r.statusCode).toBe(507);
    expect(r.json().code).toBe("disk_block");
    // Listing and raw reads keep working at block level.
    f.disk.used = 97;
    await f.hub.disk.check();
    expect((await inject({ url: `${base()}/backups`, headers: A() })).statusCode).toBe(200);
    f.disk.used = 40;
    await f.hub.disk.check();
  });
});
