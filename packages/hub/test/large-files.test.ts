/**
 * Large files (pointer design) through the hub routes against the real sync-core: chunked upload → store + `local`
 * pointer + work tree (review clean), resume after 409, sha256 mismatch, chunk limits, disk block, traversal and
 * symlinks, upload dedup, conflicts and force, the manifest by real hash, review / accept / reject of a large file,
 * raw downloads with HTTP Range (work tree and refs), small ↔ large transitions, a missing store object, sizes, and
 * project deletion. The large-file threshold and chunk size are lowered (1 KiB / 1000 bytes) so nothing big is written.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LARGE_FILE_POINTER_HEADER, LargeFileUploadResponse, ManifestResponse, Project, ReviewResponse, SyncResult } from "@agent-workstation/protocol";
import type { ProjectRow } from "../src/db/store.js";
import { hubFixture, tempDir, type HubFixture } from "./helpers.js";

const MIN = 1024;
const CHUNK = 1000;
let f: HubFixture;
const A = () => f.as("alice");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const pointer = (b: Buffer) => `${LARGE_FILE_POINTER_HEADER}\nsha256 ${sha(b)}\nsize ${b.length}\n`;

beforeAll(async () => {
  f = await hubFixture({ largeFileMinBytes: MIN, largeFileChunkBytes: CHUNK });
});
afterAll(async () => {
  await f.close();
});

async function newProject(name: string): Promise<{ id: string; row: ProjectRow; work: string; large: string; gitDir: string }> {
  const r = await f.app.inject({ method: "POST", url: "/api/projects", headers: A(), payload: { name } });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as string;
  const row = f.hub.store.getProject(id)!;
  const p = f.hub.projects.paths(row);
  return { id, row, work: p.workTree, large: p.largeDir, gitDir: p.gitDir };
}

const largeUrl = (id: string, q: Record<string, string | number | null | undefined>) =>
  `/api/projects/${id}/large?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string | number] => e[1] !== null && e[1] !== undefined).map(([k, v]): [string, string] => [k, String(v)])).toString()}`;

type UploadOpts = { sha256?: string; mode?: number; baseHash?: string | null; force?: boolean };
function putChunk(id: string, path: string, data: Buffer, offset: number, chunk: Buffer, o: UploadOpts = {}) {
  return f.app.inject({
    method: "PUT",
    url: largeUrl(id, { path, sha256: o.sha256 ?? sha(data), size: data.length, mode: o.mode ?? 0o100644, offset, baseHash: o.baseHash ?? null, force: o.force ? "true" : null }),
    headers: { ...A(), "content-type": "application/octet-stream" },
    payload: chunk,
  });
}

async function upload(id: string, path: string, data: Buffer, o: UploadOpts = {}) {
  let last;
  for (let off = 0; off < data.length; off += CHUNK) {
    last = await putChunk(id, path, data, off, data.subarray(off, off + CHUNK), o);
    if (last.statusCode !== 200 || last.json().complete) return last;
  }
  return last!;
}

const progress = (id: string, path: string, data: Buffer) => f.app.inject({ method: "GET", url: largeUrl(id, { path, sha256: sha(data), size: data.length }), headers: A() });

const writeOp = (path: string, content: string, baseHash: string | null = null) => ({ op: "write", path, hash: sha(content), size: Buffer.byteLength(content), mode: 0o100644, baseHash, contentBase64: Buffer.from(content).toString("base64") });
const pushOps = (id: string, ops: unknown[]) => f.app.inject({ method: "PUT", url: `/api/projects/${id}/files`, headers: A(), payload: { ops } });
const review = async (id: string) => ReviewResponse.parse((await f.app.inject({ method: "GET", url: `/api/projects/${id}/review`, headers: A() })).json());
const manifest = async (id: string, entries: unknown[]) => ManifestResponse.parse((await f.app.inject({ method: "POST", url: `/api/projects/${id}/manifest`, headers: A(), payload: { entries } })).json());
const raw = (id: string, path: string, o: { ref?: string; range?: string } = {}) =>
  f.app.inject({ method: "GET", url: `/api/projects/${id}/raw?path=${encodeURIComponent(path)}${o.ref ? `&ref=${encodeURIComponent(o.ref)}` : ""}`, headers: { ...A(), ...(o.range ? { range: o.range } : {}) } });
const git = (gitDir: string, ...args: string[]) => execFileSync("git", [`--git-dir=${gitDir}`, ...args], { encoding: "utf8" });
const localHas = (gitDir: string, path: string) => git(gitDir, "ls-tree", "-r", "--name-only", "refs/heads/local").split("\n").includes(path);
const storeObject = (large: string, data: Buffer) => join(large, "objects", sha(data).slice(0, 2), sha(data));

describe("large-file upload", () => {
  it("uploads in ordered chunks, then syncs: store + `local` pointer + work tree, review clean", async () => {
    const p = await newProject("big-one");
    const data = randomBytes(2500);
    const r1 = await putChunk(p.id, "media/clip.mov", data, 0, data.subarray(0, CHUNK), { mode: 0o100755 });
    expect(r1.statusCode).toBe(200);
    expect(LargeFileUploadResponse.parse(r1.json())).toEqual({ path: "media/clip.mov", received: 1000, complete: false });
    // Nothing in the work tree yet; the partial lives next to the store, outside the work tree.
    expect(existsSync(join(p.work, "media", "clip.mov"))).toBe(false);
    expect(readdirSync(join(p.large, "uploads")).some((n) => n.endsWith(".part"))).toBe(true);
    expect((await progress(p.id, "media/clip.mov", data)).json()).toEqual({ path: "media/clip.mov", received: 1000, complete: false });

    await putChunk(p.id, "media/clip.mov", data, 1000, data.subarray(1000, 2000), { mode: 0o100755 });
    const last = await putChunk(p.id, "media/clip.mov", data, 2000, data.subarray(2000), { mode: 0o100755 });
    const done = LargeFileUploadResponse.parse(last.json());
    expect(done).toMatchObject({ path: "media/clip.mov", received: 2500, complete: true, result: { status: "applied" } });
    expect(done.localCommit).toBe(git(p.gitDir, "rev-parse", "refs/heads/local").trim());
    const abs = join(p.work, "media", "clip.mov");
    expect(readFileSync(abs).equals(data)).toBe(true);
    expect(statSync(abs).mode & 0o777).toBe(0o755);
    expect(git(p.gitDir, "show", "refs/heads/local:media/clip.mov")).toBe(pointer(data));
    expect(readFileSync(storeObject(p.large, data)).equals(data)).toBe(true);
    expect(readdirSync(join(p.large, "uploads")).filter((n) => n.endsWith(".part"))).toEqual([]);
    expect((await review(p.id)).files).toEqual([]);
    expect((await progress(p.id, "media/clip.mov", data)).json()).toMatchObject({ path: "media/clip.mov", received: 2500, complete: true });
    const history = (await f.app.inject({ method: "GET", url: `/api/projects/${p.id}/history`, headers: A() })).json() as { message: string; kind: string }[];
    expect(history[0]).toMatchObject({ message: "sync: 1 file", kind: "sync" });
    // The project's size counts the store.
    const proj = Project.parse((await f.app.inject({ method: "GET", url: `/api/projects/${p.id}`, headers: A() })).json());
    expect(proj.sizeBytes).toBeGreaterThanOrEqual(2 * data.length);
  });

  it("resumes after a 409 offset mismatch; a new version of the file starts over", async () => {
    const p = await newProject("resume");
    const data = randomBytes(2200);
    await putChunk(p.id, "d.bin", data, 0, data.subarray(0, 1000));
    const skip = await putChunk(p.id, "d.bin", data, 2000, data.subarray(2000));
    expect(skip.statusCode).toBe(409);
    expect(skip.json()).toMatchObject({ path: "d.bin", received: 1000, complete: false, code: "stale" });
    expect((await putChunk(p.id, "d.bin", data, 0, data.subarray(0, 1000))).statusCode).toBe(409);
    const resumeFrom = (await progress(p.id, "d.bin", data)).json().received as number;
    expect(resumeFrom).toBe(1000);
    for (let off = resumeFrom; off < data.length; off += CHUNK) expect((await putChunk(p.id, "d.bin", data, off, data.subarray(off, off + CHUNK))).statusCode).toBe(200);
    expect(readFileSync(join(p.work, "d.bin")).equals(data)).toBe(true);

    // The Mac changed the file mid-upload: other sha → the old partial is dropped, offset 0 starts the new one.
    const v2 = randomBytes(2100);
    const other = randomBytes(2100);
    await putChunk(p.id, "e.bin", other, 0, other.subarray(0, 1000));
    expect((await putChunk(p.id, "e.bin", v2, 1000, v2.subarray(1000, 2000))).json()).toMatchObject({ received: 0 });
    expect((await upload(p.id, "e.bin", v2)).json()).toMatchObject({ complete: true, result: { status: "applied" } });
    expect(readFileSync(join(p.work, "e.bin")).equals(v2)).toBe(true);
  });

  it("drops the upload on a sha256 mismatch (422); refuses oversize chunks, small files and a blocked disk", async () => {
    const p = await newProject("checks");
    const data = randomBytes(1500);
    const bad = await upload(p.id, "x.bin", data, { sha256: sha("something else") });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe("hash_mismatch");
    expect(existsSync(join(p.work, "x.bin"))).toBe(false);
    expect(localHas(p.gitDir, "x.bin")).toBe(false);
    expect((await progress(p.id, "x.bin", data)).json()).toMatchObject({ received: 0, complete: false });
    expect(readdirSync(join(p.large, "uploads"))).toEqual([]);

    const tooBig = await putChunk(p.id, "y.bin", data, 0, data.subarray(0, CHUNK + 1));
    expect(tooBig.statusCode).toBe(413);
    expect((await progress(p.id, "y.bin", data)).json()).toMatchObject({ received: 0 });
    const zeros = Buffer.alloc(1100);
    expect((await putChunk(p.id, "y.bin", zeros, 0, Buffer.alloc(1000))).statusCode).toBe(200);
    expect((await putChunk(p.id, "y.bin", zeros, 1000, Buffer.alloc(200))).statusCode).toBe(413);

    const small = Buffer.from("small");
    expect((await putChunk(p.id, "s.txt", small, 0, small)).json()).toMatchObject({ code: "invalid_request" });
    expect((await f.app.inject({ method: "PUT", url: largeUrl(p.id, { path: "z.bin", sha256: "nothex", size: 2000, offset: 0 }), headers: A(), payload: Buffer.alloc(1) })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "PUT", url: largeUrl(p.id, { path: "z.bin", sha256: sha(data), size: 2000, offset: 0, baseHash: "zz" }), headers: A(), payload: Buffer.alloc(1) })).statusCode).toBe(400);

    f.disk.used = 97;
    await f.hub.disk.check();
    const blocked = await putChunk(p.id, "z.bin", data, 0, data.subarray(0, 1000));
    f.disk.used = 40;
    await f.hub.disk.check();
    expect(blocked.statusCode).toBe(507);
    expect(blocked.json().code).toBe("disk_block");
  });

  it("refuses paths that escape the project or go through symlinks", async () => {
    const p = await newProject("paths");
    const data = randomBytes(1100);
    const outside = tempDir("workstation-outside-");
    try {
      for (const bad of ["../escape.bin", "/abs.bin", "a/../../x.bin", ".git/objects/x", "a//b"]) {
        const r = await putChunk(p.id, bad, data, 0, data.subarray(0, 1000));
        expect(r.statusCode, bad).toBe(400);
      }
      symlinkSync(outside.dir, join(p.work, "link"));
      const viaLink = await putChunk(p.id, "link/x.bin", data, 0, data.subarray(0, 1000));
      expect(viaLink.statusCode).toBe(422);
      expect(viaLink.json().code).toBe("symlink");
      symlinkSync(join(outside.dir, "target.bin"), join(p.work, "file-link.bin"));
      expect((await putChunk(p.id, "file-link.bin", data, 0, data.subarray(0, 1000))).json().code).toBe("symlink");
      mkdirSync(join(p.work, "dir.bin"));
      expect((await putChunk(p.id, "dir.bin", data, 0, data.subarray(0, 1000))).statusCode).toBe(409);
      expect(readdirSync(outside.dir)).toEqual([]);
    } finally {
      outside.cleanup();
    }
  });

  it("dedup: a version the store already holds completes at the first request", async () => {
    const p = await newProject("dedup");
    const data = randomBytes(3000);
    expect((await upload(p.id, "a/one.bin", data)).json()).toMatchObject({ complete: true });
    const first = await putChunk(p.id, "b/two.bin", data, 0, data.subarray(0, CHUNK));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ path: "b/two.bin", received: 3000, complete: true, result: { status: "applied" } });
    expect(readFileSync(join(p.work, "b", "two.bin")).equals(data)).toBe(true);
    expect(readdirSync(join(p.large, "objects"), { recursive: true }).filter((n) => /[0-9a-f]{64}$/.test(String(n)))).toHaveLength(1);
  });
});

describe("large files and the rest of sync", () => {
  it("conflicts when the server changed the file too; force (no re-upload) keeps the Mac's", async () => {
    const p = await newProject("conflict");
    const v1 = randomBytes(2000);
    await upload(p.id, "m.bin", v1);
    // Server unchanged: a new Mac version applies on top of v1.
    const v2 = randomBytes(2000);
    expect((await upload(p.id, "m.bin", v2, { baseHash: sha(v1) })).json()).toMatchObject({ complete: true, result: { status: "applied" } });
    // Claude rewrote it on the server; the Mac sends v3: conflict (HTTP 200), nothing moves.
    const server = randomBytes(1900);
    writeFileSync(join(p.work, "m.bin"), server);
    const before = git(p.gitDir, "rev-parse", "refs/heads/local").trim();
    const v3 = randomBytes(2000);
    const c = await upload(p.id, "m.bin", v3, { baseHash: sha(v2) });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ complete: true, result: { status: "conflict", reason: "large file changed on both sides" } });
    expect(git(p.gitDir, "rev-parse", "refs/heads/local").trim()).toBe(before);
    expect(readFileSync(join(p.work, "m.bin")).equals(server)).toBe(true);
    // Review shows the server's change as a large file.
    expect((await review(p.id)).files).toMatchObject([{ path: "m.bin", status: "modified", binary: true, large: true, sizeBytes: 1900, oldSizeBytes: 2000, additions: 0, deletions: 0 }]);
    // "Keep mine": the store already holds v3, so the first request completes.
    const forced = await putChunk(p.id, "m.bin", v3, 0, v3.subarray(0, CHUNK), { baseHash: sha(v2), force: true });
    expect(forced.json()).toMatchObject({ complete: true, result: { status: "applied", reason: "forced" } });
    expect(readFileSync(join(p.work, "m.bin")).equals(v3)).toBe(true);
    expect((await review(p.id)).files).toEqual([]);
  });

  it("manifest: large files compare by their real sha256 and size", async () => {
    const p = await newProject("manifest");
    const data = randomBytes(3000);
    const entry = { path: "data/set.bin", hash: sha(data), size: data.length, mode: 0o100644 };
    expect((await manifest(p.id, [entry])).need).toEqual(["data/set.bin"]);
    await upload(p.id, "data/set.bin", data);
    const m = await manifest(p.id, [entry, { path: "readme.md", hash: sha("hi"), size: 2, mode: 0o100644 }]);
    expect(m.need).toEqual(["readme.md"]);
    expect(m.delete).toEqual([]);
    expect((await manifest(p.id, [{ ...entry, hash: sha("v2") }])).need).toEqual(["data/set.bin"]);
    expect((await manifest(p.id, [])).delete).toEqual(["data/set.bin"]);
  });

  it("review, accept and reject of a large file changed on the server", async () => {
    const p = await newProject("review");
    const v1 = randomBytes(2048);
    await upload(p.id, "rec/run1.dat", v1);
    const v2 = randomBytes(3072);
    writeFileSync(join(p.work, "rec", "run1.dat"), v2);
    writeFileSync(join(p.work, "rec", "run2.dat"), randomBytes(1500));
    const files = (await review(p.id)).files;
    expect(files).toEqual([
      { path: "rec/run1.dat", status: "modified", binary: true, additions: 0, deletions: 0, sizeBytes: 3072, large: true, oldSizeBytes: 2048, lastTouchedBy: null },
      { path: "rec/run2.dat", status: "added", binary: true, additions: 0, deletions: 0, sizeBytes: 1500, large: true, lastTouchedBy: null },
    ]);
    const diff = await f.app.inject({ method: "GET", url: `/api/projects/${p.id}/review/diff?path=rec/run1.dat`, headers: A() });
    expect(diff.json()).toMatchObject({ binary: true, oldText: null, newText: null, hunks: [] });
    const patch = await f.app.inject({ method: "GET", url: `/api/projects/${p.id}/review/patch`, headers: A() });
    expect(patch.statusCode).toBe(200);
    expect(patch.body).not.toContain("workstation-large");

    const acc = await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/review/accept`, headers: A(), payload: { path: "rec/run1.dat" } });
    expect(acc.json().files).toEqual([{ path: "rec/run1.dat", contentBase64: null, deleted: false, large: true, sha256: sha(v2), size: 3072 }]);
    // The Mac downloads the accepted version by Range at `local`.
    const part = await raw(p.id, "rec/run1.dat", { ref: acc.json().localCommit, range: "bytes=0-99" });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.equals(v2.subarray(0, 100))).toBe(true);

    const rej = await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/review/reject`, headers: A(), payload: { path: "rec/run2.dat" } });
    expect(rej.statusCode).toBe(200);
    expect(existsSync(join(p.work, "rec", "run2.dat"))).toBe(false);
    writeFileSync(join(p.work, "rec", "run1.dat"), randomBytes(1800));
    await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/review/reject`, headers: A(), payload: { all: true } });
    expect(readFileSync(join(p.work, "rec", "run1.dat")).equals(v2)).toBe(true);
    expect((await review(p.id)).files).toEqual([]);

    // A delete op removes it from the work tree and `local`.
    const del = await pushOps(p.id, [{ op: "delete", path: "rec/run1.dat", baseHash: sha(v2) }]);
    expect(SyncResult.parse(del.json()).results).toEqual([{ path: "rec/run1.dat", status: "applied" }]);
    expect(existsSync(join(p.work, "rec"))).toBe(false);
    expect(localHas(p.gitDir, "rec/run1.dat")).toBe(false);
  });

  it("raw: Range on the work tree and on refs (large from the store, small from git); full downloads count", async () => {
    const p = await newProject("raw");
    const data = randomBytes(5000);
    await upload(p.id, "big.bin", data);
    expect((await pushOps(p.id, [writeOp("small.txt", "0123456789\n")])).statusCode).toBe(200);
    writeFileSync(join(p.work, "new.bin"), randomBytes(1300));

    const full = await raw(p.id, "big.bin");
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["content-length"]).toBe("5000");
    expect(full.rawPayload.equals(data)).toBe(true);

    const mid = await raw(p.id, "big.bin", { range: "bytes=1000-1999" });
    expect(mid.statusCode).toBe(206);
    expect(mid.headers["content-range"]).toBe("bytes 1000-1999/5000");
    expect(mid.headers["content-length"]).toBe("1000");
    expect(mid.rawPayload.equals(data.subarray(1000, 2000))).toBe(true);
    expect((await raw(p.id, "big.bin", { range: "bytes=4900-" })).rawPayload.equals(data.subarray(4900))).toBe(true);
    expect((await raw(p.id, "big.bin", { range: "bytes=-10" })).rawPayload.equals(data.subarray(4990))).toBe(true);
    const bad = await raw(p.id, "big.bin", { range: "bytes=6000-7000" });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers["content-range"]).toBe("bytes */5000");

    // At a ref: the pointer is resolved from the store; small files come from git (sliced for a range).
    const local = await raw(p.id, "big.bin", { ref: "local", range: "bytes=10-19" });
    expect(local.statusCode).toBe(206);
    expect(local.headers["content-range"]).toBe("bytes 10-19/5000");
    expect(local.rawPayload.equals(data.subarray(10, 20))).toBe(true);
    expect((await raw(p.id, "big.bin", { ref: "local" })).rawPayload.equals(data)).toBe(true);
    const s = await raw(p.id, "small.txt", { ref: "local", range: "bytes=2-5" });
    expect(s.statusCode).toBe(206);
    expect(s.body).toBe("2345");

    // A new large server file: a partial range does not count as downloaded, the tail does.
    const repo = await f.hub.projects.repo(p.row);
    expect((await repo.canDelete()).undownloadedFiles).toBe(1);
    await raw(p.id, "new.bin", { range: "bytes=0-9" });
    expect((await repo.canDelete()).undownloadedFiles).toBe(1);
    await raw(p.id, "new.bin", { range: "bytes=10-" });
    await new Promise((r) => setTimeout(r, 100));
    expect((await repo.canDelete()).undownloadedFiles).toBe(0);
  });

  it("a missing store object is a clear error (large_missing), never pointer bytes", async () => {
    const p = await newProject("missing");
    const data = randomBytes(2000);
    await upload(p.id, "gone.bin", data);
    rmSync(storeObject(p.large, data), { force: true });
    const r = await raw(p.id, "gone.bin", { ref: "local" });
    expect(r.statusCode).toBe(500);
    expect(r.json().code).toBe("large_missing");
    writeFileSync(join(p.work, "gone.bin"), randomBytes(1500));
    const rej = await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/review/reject`, headers: A(), payload: { path: "gone.bin" } });
    expect(rej.json().code).toBe("large_missing");
    expect(readFileSync(join(p.work, "gone.bin")).toString("latin1")).not.toContain(LARGE_FILE_POINTER_HEADER);
    // The Mac is asked for it again.
    expect((await manifest(p.id, [{ path: "gone.bin", hash: sha(data), size: data.length, mode: 0o100644 }])).need).toEqual(["gone.bin"]);
  });

  it("small ↔ large: only the representation changes; a large write through PUT files is skipped", async () => {
    const p = await newProject("transitions");
    const small = "a small version\n";
    expect(SyncResult.parse((await pushOps(p.id, [writeOp("model.ckpt", small), writeOp("keep.txt", "k\n")])).json()).results.map((r) => r.status)).toEqual(["applied", "applied"]);

    const big = randomBytes(4000);
    expect((await manifest(p.id, [{ path: "model.ckpt", hash: sha(big), size: big.length, mode: 0o100644 }, { path: "keep.txt", hash: sha("k\n"), size: 2, mode: 0o100644 }])).need).toEqual(["model.ckpt"]);
    expect((await upload(p.id, "model.ckpt", big, { baseHash: sha(small) })).json()).toMatchObject({ complete: true, result: { status: "applied" } });
    expect(git(p.gitDir, "show", "refs/heads/local:model.ckpt")).toBe(pointer(big));
    expect(readFileSync(join(p.work, "model.ckpt")).equals(big)).toBe(true);
    expect((await review(p.id)).files).toEqual([]);

    const viaGit = await pushOps(p.id, [{ op: "write", path: "model.ckpt", hash: sha(big), size: big.length, mode: 0o100644, baseHash: null, contentBase64: big.toString("base64") }]);
    expect(SyncResult.parse(viaGit.json()).results).toEqual([{ path: "model.ckpt", status: "skipped", reason: "too_large" }]);

    // Shrunk on the Mac: an ordinary write.
    const r = await pushOps(p.id, [writeOp("model.ckpt", "tiny again\n", sha(big))]);
    expect(SyncResult.parse(r.json()).results).toEqual([{ path: "model.ckpt", status: "applied" }]);
    expect(readFileSync(join(p.work, "model.ckpt"), "utf8")).toBe("tiny again\n");
    expect(git(p.gitDir, "show", "refs/heads/local:model.ckpt")).toBe("tiny again\n");
    expect((await review(p.id)).files).toEqual([]);
    // Every blob in the review repo is small: no large content ever went through git.
    for (const line of git(p.gitDir, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectsize)").split("\n")) {
      const [type, size] = line.split(" ");
      if (type === "blob") expect(Number(size)).toBeLessThanOrEqual(MIN);
    }
  });

  it("deleting the project removes the store and any partial uploads", async () => {
    const p = await newProject("gone");
    const data = randomBytes(2000);
    await upload(p.id, "a.bin", data);
    await putChunk(p.id, "b.bin", randomBytes(2000), 0, data.subarray(0, 1000));
    expect(existsSync(storeObject(p.large, data))).toBe(true);
    const r = await f.app.inject({ method: "DELETE", url: `/api/projects/${p.id}`, headers: A() });
    expect(r.statusCode).toBe(204);
    expect(existsSync(p.work)).toBe(false);
    expect(existsSync(p.large)).toBe(false);
  });
});
