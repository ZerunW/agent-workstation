/**
 * Large files (pointer design) against real git, with the threshold lowered to 1 KiB so nothing big is written:
 * pointers in status / snapshot / trash / baseline / Mac pushes, materialization on accept / reject / restore, review
 * fields, whole-file accept/reject, conflicts, manifest by real hash, small ↔ large, a missing store object, and a guard
 * that no large file is ever read into memory (fs.readFile spy) or stored in git (every blob ≤ the threshold).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LARGE_FILE_POINTER_HEADER } from "@agent-workstation/protocol";
import { hashBytes, isSyncCoreError } from "../src/index.js";
import { deleteOp, h, localContent, makeProject, writeOp, type TestProject } from "./helpers.js";

const LIM = 1024;

// Every fs.readFile of a work-tree / Mac-side file is measured: none may exceed the threshold.
const reads = vi.hoisted(() => ({ max: 0, over: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    readFile: (async (...args: Parameters<typeof orig.readFile>) => {
      const out = await orig.readFile(...args);
      const f = String(args[0]);
      if (/[/\\](work|mac)[/\\]/.test(f)) {
        reads.max = Math.max(reads.max, out.length);
        if (out.length > LIM) reads.over.push(f);
      }
      return out;
    }) as typeof orig.readFile,
  };
});

const projects: TestProject[] = [];
async function project(files: Parameters<typeof makeProject>[0] = {}): Promise<TestProject> {
  const p = await makeProject(files, { largeFileBytes: LIM });
  projects.push(p);
  return p;
}

const big = (n = 3000): Buffer => randomBytes(n);
const pointer = (b: Buffer): string => `${LARGE_FILE_POINTER_HEADER}\nsha256 ${hashBytes(b)}\nsize ${b.length}\n`;
const storeFile = (p: TestProject, b: Buffer): string => path.join(p.repo.largeStore.dir, "objects", hashBytes(b).slice(0, 2), hashBytes(b));
const atRef = (p: TestProject, ref: string, rel: string): string => p.git("show", `${ref}:${rel}`);
const wt = (p: TestProject, rel: string): Buffer => readFileSync(p.w(rel));

/** No blob in the review repo is larger than the threshold (large content never entered git). */
function assertNoLargeBlobs(p: TestProject): void {
  const out = p.git("cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectsize)");
  for (const line of out.split("\n")) {
    const [type, size] = line.split(" ");
    if (type === "blob") expect(Number(size)).toBeLessThanOrEqual(LIM);
  }
}

afterAll(() => {
  for (const p of projects) assertNoLargeBlobs(p);
  expect(reads.over).toEqual([]);
  expect(reads.max).toBeGreaterThan(0); // the spy saw sync-core's own (small) reads
  expect(reads.max).toBeLessThanOrEqual(LIM);
});

describe("pointers", () => {
  it("baseline: large files go to the store, `local` holds pointers, the work tree the real bytes", async () => {
    const data = big();
    const p = await project({ "a.txt": "a\n", "media/clip.mov": data });
    expect(atRef(p, "refs/heads/local", "media/clip.mov")).toBe(pointer(data));
    expect(readFileSync(storeFile(p, data)).equals(data)).toBe(true);
    expect(statSync(storeFile(p, data)).mode & 0o222).toBe(0); // read-only
    expect(wt(p, "media/clip.mov").equals(data)).toBe(true);
    expect((await p.repo.review()).files).toEqual([]);
    expect(await p.repo.localLargeFile("media/clip.mov")).toEqual({ sha256: hashBytes(data), size: data.length });
    expect(await p.repo.localLargeFile("a.txt")).toBeNull();
    assertNoLargeBlobs(p);
  });

  it("status / snapshot / trash: a large work-tree file is staged as a pointer and stored once per version", async () => {
    const v1 = big();
    const p = await project({ "a.txt": "a\n", "data.bin": v1 });
    const v2 = big(5000);
    const added = big(2000);
    writeFileSync(p.w("data.bin"), v2);
    writeFileSync(p.w("new.bin"), added);
    const r = await p.repo.review();
    expect(r.files).toEqual([
      { path: "data.bin", status: "modified", binary: true, additions: 0, deletions: 0, sizeBytes: 5000, large: true, oldSizeBytes: 3000, lastTouchedBy: null },
      { path: "new.bin", status: "added", binary: true, additions: 0, deletions: 0, sizeBytes: 2000, large: true, lastTouchedBy: null },
    ]);
    expect(existsSync(storeFile(p, v2))).toBe(true);
    expect(existsSync(storeFile(p, added))).toBe(true);
    const d = await p.repo.diffFile("data.bin");
    expect(d).toMatchObject({ status: "modified", binary: true, tooLarge: true, oldText: null, newText: null, hunks: [] });

    const snap = await p.repo.snapshot({ sessionId: "s1", turn: 1, message: "t" });
    expect(atRef(p, snap.commit, "data.bin")).toBe(pointer(v2));
    expect(atRef(p, snap.commit, "new.bin")).toBe(pointer(added));
    const trash = await p.repo.trash("check");
    expect(atRef(p, trash.ref, "new.bin")).toBe(pointer(added));
    expect((await p.repo.history()).map((s) => s.kind)).toContain("snapshot");
    // The cached index never makes an edited large file look clean.
    const v3 = big(5000);
    writeFileSync(p.w("data.bin"), v3);
    expect((await p.repo.review()).files.find((f) => f.path === "data.bin")).toMatchObject({ large: true, sizeBytes: 5000 });
    const snap2 = await p.repo.snapshot({ sessionId: "s1", turn: 2, message: "t2" });
    expect(atRef(p, snap2.commit, "data.bin")).toBe(pointer(v3));
    expect(existsSync(storeFile(p, v3))).toBe(true);
    // Unchanged large file: its diff is still large/binary.
    expect(await p.repo.diffFile("data.bin")).toMatchObject({ binary: true, tooLarge: true, hunks: [] });
  });
});

describe("accept / reject / restore", () => {
  it("accepts a large file whole (pointer to `local`, content by Range); hunks are refused", async () => {
    const v1 = big();
    const p = await project({ "data.bin": v1 });
    const v2 = big(4000);
    writeFileSync(p.w("data.bin"), v2);
    writeFileSync(p.w("other.bin"), big(1500));
    await expect(p.repo.accept({ path: "data.bin", hunks: [0] })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "binary"));
    const r = await p.repo.accept({ path: "data.bin" });
    expect(r.files).toEqual([{ path: "data.bin", contentBase64: null, deleted: false, large: true, sha256: hashBytes(v2), size: 4000 }]);
    expect(atRef(p, "refs/heads/local", "data.bin")).toBe(pointer(v2));
    expect((await p.repo.review()).files.map((f) => f.path)).toEqual(["other.bin"]);
    const all = await p.repo.accept({ all: true });
    expect(all.skipped).toEqual([]);
    expect(all.files).toMatchObject([{ path: "other.bin", contentBase64: null, large: true, size: 1500 }]);
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("rejects a large file whole: modified / deleted come back from the store, a new one goes", async () => {
    const v1 = big();
    const gone = big(2500);
    const p = await project({ "data.bin": v1, "gone.bin": gone, "a.txt": "a\n" });
    const v2 = big(3500);
    writeFileSync(p.w("data.bin"), v2);
    await unlink(p.w("gone.bin"));
    writeFileSync(p.w("new.bin"), big(1200));
    writeFileSync(p.w("a.txt"), "changed\n");
    const r = await p.repo.reject({ path: "data.bin" });
    expect(wt(p, "data.bin").equals(v1)).toBe(true);
    expect(atRef(p, r.trashRef!, "data.bin")).toBe(pointer(v2)); // the server's version is kept
    expect(existsSync(storeFile(p, v2))).toBe(true);
    await p.repo.reject({ all: true });
    expect(wt(p, "gone.bin").equals(gone)).toBe(true);
    expect(existsSync(p.w("new.bin"))).toBe(false);
    expect(readFileSync(p.w("a.txt"), "utf8")).toBe("a\n");
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("restores large files from snapshots (whole tree and one path), skipping ones already right", async () => {
    const v1 = big();
    const p = await project({ "data.bin": v1, "dir/b.bin": big(1100), "a.txt": "a\n" });
    const snap = await p.repo.snapshot({ sessionId: "s2", turn: 1, message: "t" });
    const keep = wt(p, "dir/b.bin");
    writeFileSync(p.w("data.bin"), big(2000));
    writeFileSync(p.w("a.txt"), "edited\n");
    writeFileSync(p.w("later.bin"), big(1300));
    const inoBefore = statSync(p.w("dir/b.bin")).ino;
    await p.repo.restore({ ref: snap.ref });
    expect(wt(p, "data.bin").equals(v1)).toBe(true);
    expect(readFileSync(p.w("a.txt"), "utf8")).toBe("a\n");
    expect(existsSync(p.w("later.bin"))).toBe(false);
    expect(wt(p, "dir/b.bin").equals(keep)).toBe(true);
    expect(statSync(p.w("dir/b.bin")).ino).toBe(inoBefore); // untouched: already that version

    writeFileSync(p.w("data.bin"), big(2100));
    await p.repo.restore({ ref: snap.ref, path: "data.bin" });
    expect(wt(p, "data.bin").equals(v1)).toBe(true);
    await rmAndRestoreDir(p, snap.ref, keep);
  });

  it("a missing store object is a `large_missing` error and nothing is written", async () => {
    const v1 = big();
    const p = await project({ "data.bin": v1 });
    const snap = await p.repo.snapshot({ sessionId: "s3", turn: 1, message: "t" });
    const v2 = big(2000);
    writeFileSync(p.w("data.bin"), v2);
    rmSync(storeFile(p, v1), { force: true });
    await expect(p.repo.restore({ ref: snap.ref })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "large_missing"));
    await expect(p.repo.reject({ path: "data.bin" })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "large_missing"));
    expect(wt(p, "data.bin").equals(v2)).toBe(true); // never a pointer file
    // The Mac is asked for it again.
    expect((await p.repo.manifest([{ path: "data.bin", hash: hashBytes(v1), size: v1.length, mode: 0o100644 }])).need).toEqual(["data.bin"]);
  });
});

async function rmAndRestoreDir(p: TestProject, ref: string, keep: Buffer): Promise<void> {
  rmSync(p.w("dir"), { recursive: true, force: true });
  await p.repo.restore({ ref, path: "dir" });
  expect(wt(p, "dir/b.bin").equals(keep)).toBe(true);
}

describe("Mac pushes of large files", () => {
  async function upload(p: TestProject, data: Buffer): Promise<string> {
    const f = path.join(p.root, `upload-${randomBytes(4).toString("hex")}`);
    await writeFile(f, data);
    return f;
  }

  it("applies like a small write: `local` gets the pointer, the work tree the bytes, review stays clean", async () => {
    const v1 = big();
    const p = await project({ "a.txt": "a\n" });
    const r = await p.repo.applyLargeWrite({ path: "m/model.ckpt", sha256: hashBytes(v1), size: v1.length, mode: 0o100755, baseHash: null, file: await upload(p, v1) });
    expect(r.result).toEqual({ status: "applied" });
    expect(r.localCommit).toBe(await p.repo.localCommit());
    expect(localContent(p, "m/model.ckpt")).toBe(pointer(v1));
    expect(wt(p, "m/model.ckpt").equals(v1)).toBe(true);
    expect(statSync(p.w("m/model.ckpt")).mode & 0o777).toBe(0o755);
    expect((await p.repo.review()).files).toEqual([]);
    expect((await p.repo.history())[0]!.message).toBe("sync: 1 file");
    // Same version again: noop, no commit.
    expect((await p.repo.applyLargeWrite({ path: "m/model.ckpt", sha256: hashBytes(v1), size: v1.length, mode: 0o100755, baseHash: hashBytes(v1) })).result).toEqual({ status: "noop" });
    // Dedup: the store already holds it, no content needed for another path.
    expect((await p.repo.applyLargeWrite({ path: "copy.ckpt", sha256: hashBytes(v1), size: v1.length, mode: 0o100644, baseHash: null })).result).toEqual({ status: "applied" });
    expect(wt(p, "copy.ckpt").equals(v1)).toBe(true);
    // Unknown content without a file: need_content.
    const v9 = big();
    expect((await p.repo.applyLargeWrite({ path: "x.bin", sha256: hashBytes(v9), size: v9.length, mode: 0o100644, baseHash: null })).result).toEqual({ status: "need_content" });
    // Content that does not match its sha256 is refused and left where it was.
    const bad = await upload(p, big());
    await expect(p.repo.applyLargeWrite({ path: "x.bin", sha256: hashBytes(v9), size: v9.length, mode: 0o100644, baseHash: null, file: bad })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "invalid_argument"));
    expect(existsSync(bad)).toBe(true);
    // A large write through applyOps is skipped (its own route).
    expect((await p.repo.applyOps([writeOp("y.bin", big())])).results[0]).toEqual({ path: "y.bin", status: "skipped", reason: "too_large" });
  });

  it("conflicts when the server changed it too (unless one side is unchanged); force keeps the Mac's", async () => {
    const v1 = big();
    const p = await project({ "data.bin": v1 });
    // Server unchanged: the Mac's new version applies.
    const v2 = big();
    expect((await p.repo.applyLargeWrite({ path: "data.bin", sha256: hashBytes(v2), size: v2.length, mode: 0o100644, baseHash: hashBytes(v1), file: await upload(p, v2) })).result).toEqual({ status: "applied" });
    expect(wt(p, "data.bin").equals(v2)).toBe(true);
    // Both changed: conflict, nothing moves.
    const server = big(2200);
    writeFileSync(p.w("data.bin"), server);
    const v3 = big();
    const local = await p.repo.localCommit();
    const c = await p.repo.applyLargeWrite({ path: "data.bin", sha256: hashBytes(v3), size: v3.length, mode: 0o100644, baseHash: hashBytes(v2), file: await upload(p, v3) });
    expect(c.result).toEqual({ status: "conflict", reason: "large file changed on both sides" });
    expect(await p.repo.localCommit()).toBe(local);
    expect(wt(p, "data.bin").equals(server)).toBe(true);
    // The Mac's version is stored, so "keep mine" needs no re-upload.
    const forced = await p.repo.applyLargeWrite({ path: "data.bin", sha256: hashBytes(v3), size: v3.length, mode: 0o100644, baseHash: hashBytes(v2), force: true });
    expect(forced.result).toEqual({ status: "applied", reason: "forced" });
    expect(atRef(p, forced.trashRef!, "data.bin")).toBe(pointer(server));
    expect(wt(p, "data.bin").equals(v3)).toBe(true);
    // A small Mac edit against a server-changed large file also conflicts (no content merge).
    writeFileSync(p.w("data.bin"), big(2300));
    expect((await p.repo.applyOps([writeOp("data.bin", "small now\n", { baseHash: hashBytes(v3) })])).results[0]).toMatchObject({ status: "conflict" });
    // A delete op against a server-unchanged large file removes it.
    writeFileSync(p.w("data.bin"), v3);
    expect((await p.repo.applyOps([deleteOp("data.bin", hashBytes(v3))])).results[0]).toEqual({ path: "data.bin", status: "applied" });
    expect(existsSync(p.w("data.bin"))).toBe(false);
    expect(localContent(p, "data.bin")).toBeNull();
  });

  it("manifest compares large files by their real sha256 and size", async () => {
    const v1 = big();
    const p = await project({ "data.bin": v1, "a.txt": "a\n" });
    const e = { path: "data.bin", hash: hashBytes(v1), size: v1.length, mode: 0o100644 };
    const a = { path: "a.txt", hash: h("a\n"), size: 2, mode: 0o100644 };
    expect(await p.repo.manifest([e, a])).toMatchObject({ need: [], delete: [] });
    expect((await p.repo.manifest([{ ...e, hash: hashBytes(big()) }, a])).need).toEqual(["data.bin"]);
    expect((await p.repo.manifest([{ ...e, hash: e.hash.toUpperCase() }, a])).need).toEqual([]);
    expect((await p.repo.manifest([a])).delete).toEqual(["data.bin"]);
  });
});

describe("small ↔ large", () => {
  it("changes representation between versions; review shows a modified large file", async () => {
    const p = await project({ "model.ckpt": "small v1\n" });
    // Mac: small → large.
    const v2 = big();
    const f = path.join(p.root, "up-v2");
    await writeFile(f, v2);
    expect((await p.repo.applyLargeWrite({ path: "model.ckpt", sha256: hashBytes(v2), size: v2.length, mode: 0o100644, baseHash: h("small v1\n"), file: f })).result).toEqual({ status: "applied" });
    expect(localContent(p, "model.ckpt")).toBe(pointer(v2));
    expect((await p.repo.review()).files).toEqual([]);
    // Mac: large → small.
    expect((await p.repo.applyOps([writeOp("model.ckpt", "small v3\n", { baseHash: hashBytes(v2) })])).results[0]).toEqual({ path: "model.ckpt", status: "applied" });
    expect(localContent(p, "model.ckpt")).toBe("small v3\n");
    expect(readFileSync(p.w("model.ckpt"), "utf8")).toBe("small v3\n");
    expect((await p.repo.review()).files).toEqual([]);

    // Server: small → large.
    const v4 = big(2048);
    writeFileSync(p.w("model.ckpt"), v4);
    expect((await p.repo.review()).files).toEqual([
      { path: "model.ckpt", status: "modified", binary: true, additions: 0, deletions: 0, sizeBytes: 2048, large: true, oldSizeBytes: 9, lastTouchedBy: null },
    ]);
    await p.repo.accept({ path: "model.ckpt" });
    expect(localContent(p, "model.ckpt")).toBe(pointer(v4));
    // Server: large → small.
    await writeFile(p.w("model.ckpt"), "tiny\n");
    expect((await p.repo.review()).files).toEqual([
      { path: "model.ckpt", status: "modified", binary: true, additions: 0, deletions: 0, sizeBytes: 5, large: true, oldSizeBytes: 2048, lastTouchedBy: null },
    ]);
    await p.repo.accept({ path: "model.ckpt" });
    expect(localContent(p, "model.ckpt")).toBe("tiny\n");
    expect((await p.repo.review()).files).toEqual([]);
    // Grown again and rejected: back to the small `local` version.
    writeFileSync(p.w("model.ckpt"), big(1500));
    await p.repo.reject({ path: "model.ckpt" });
    expect(readFileSync(p.w("model.ckpt"), "utf8")).toBe("tiny\n");
  });

  it("downloads of a large new file count for canDelete", async () => {
    const p = await project({ "a.txt": "a\n" });
    await mkdir(p.w("out"));
    writeFileSync(p.w("out/result.bin"), big(4096));
    expect(await p.repo.canDelete()).toMatchObject({ ok: false, undownloadedFiles: 1 });
    await p.repo.markDownloaded(["out/result.bin"]);
    expect(await p.repo.canDelete()).toMatchObject({ undownloadedFiles: 0 });
    await expect(p.repo.rawFile("out/result.bin")).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "too_large"));
    expect(await p.repo.largeStoreSize()).toBeGreaterThanOrEqual(4096);
    expect((await p.repo.projectStats()).sizeBytes).toBeGreaterThanOrEqual((await p.repo.size()) + 4096);
  });
});
