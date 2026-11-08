import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAX_SYNC_FILE_BYTES } from "../src/index.js";
import { commitCount, deleteOp, h, lines, localContent, localMode, makeProject, replaceLine, writeOp } from "./helpers.js";

const BASE = lines(20);

describe("applyOps", () => {
  it("writes directly when the work tree equals local and commits once per batch", async () => {
    const p = await makeProject({ "a.txt": "a\n", "b.txt": "b\n" });
    const n0 = commitCount(p);
    const r = await p.repo.applyOps([
      writeOp("a.txt", "a2\n", { baseHash: h("a\n") }),
      writeOp("new dir/新 文件.txt", "hello\n"),
      deleteOp("b.txt", h("b\n")),
    ]);
    expect(r.results.map((x) => x.status)).toEqual(["applied", "applied", "applied"]);
    expect(commitCount(p)).toBe(n0 + 1);
    expect(p.git("log", "-1", "--format=%s", "refs/heads/local").trim()).toBe("sync: 3 files");
    expect(r.localCommit).toBe(await p.repo.localCommit());
    expect(await p.read("a.txt")).toBe("a2\n");
    expect(await p.read("new dir/新 文件.txt")).toBe("hello\n");
    await expect(lstat(p.w("b.txt"))).rejects.toThrow();
    expect(localContent(p, "new dir/新 文件.txt")).toBe("hello\n");
    expect(localContent(p, "b.txt")).toBeNull();
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("echo suppression: an op whose hash equals local is a noop and creates no commit", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    const before = await p.repo.localCommit();
    const n0 = commitCount(p);
    // Even when Claude has changed the server copy, the Mac's unchanged file is a noop.
    await writeFile(p.w("a.txt"), "claude\n");
    const r = await p.repo.applyOps([writeOp("a.txt", "a\n", { baseHash: h("a\n") }), writeOp("a.txt", "a\n", { omitContent: true })]);
    expect(r.results.map((x) => x.status)).toEqual(["noop", "noop"]);
    expect(r.localCommit).toBe(before);
    expect(commitCount(p)).toBe(n0);
    expect(await p.read("a.txt")).toBe("claude\n");
    // Deleting a path local does not have is a noop as well.
    expect((await p.repo.applyOps([deleteOp("nope.txt", null)])).results[0]!.status).toBe("noop");
    expect(commitCount(p)).toBe(n0);
  });

  it("asks for content only when the hash is unknown (renames reuse known blobs)", async () => {
    const p = await makeProject({ "a.txt": "payload\n" });
    const r1 = await p.repo.applyOps([writeOp("x.txt", "unknown\n", { omitContent: true })]);
    expect(r1.results[0]).toEqual({ path: "x.txt", status: "need_content" });
    // Mac renamed a.txt → moved/b.txt: delete + write without content (hash known from local).
    const r2 = await p.repo.applyOps([deleteOp("a.txt", h("payload\n")), writeOp("moved/b.txt", "payload\n", { omitContent: true })]);
    expect(r2.results.map((x) => x.status)).toEqual(["applied", "applied"]);
    expect(await p.read("moved/b.txt")).toBe("payload\n");
    // Content that does not match its hash is refused.
    const bad = { ...writeOp("y.txt", "real\n"), hash: h("other\n") };
    expect((await p.repo.applyOps([bad])).results[0]).toEqual({ path: "y.txt", status: "need_content", reason: "hash_mismatch" });
  });

  it("three-way merges non-overlapping edits", async () => {
    const p = await makeProject({ "f.txt": BASE });
    const claude = replaceLine(BASE, 2, "claude line 2");
    await writeFile(p.w("f.txt"), claude);
    const mac = replaceLine(BASE, 18, "mac line 18");
    const r = await p.repo.applyOps([writeOp("f.txt", mac, { baseHash: h(BASE) })]);
    expect(r.results[0]!.status).toBe("merged");
    expect(await p.read("f.txt")).toBe(replaceLine(mac, 2, "claude line 2"));
    expect(localContent(p, "f.txt")).toBe(mac);
    const review = await p.repo.review();
    expect(review.files).toMatchObject([{ path: "f.txt", status: "modified", additions: 1, deletions: 1 }]);
  });

  it("reports overlapping edits as a conflict and changes nothing", async () => {
    const p = await makeProject({ "f.txt": BASE });
    await writeFile(p.w("f.txt"), replaceLine(BASE, 5, "claude"));
    const before = await p.repo.localCommit();
    const r = await p.repo.applyOps([writeOp("f.txt", replaceLine(BASE, 5, "mac"), { baseHash: h(BASE) })]);
    expect(r.results[0]!.status).toBe("conflict");
    expect(r.results[0]!.reason).toMatch(/conflict/);
    expect(r.localCommit).toBe(before);
    expect(r.trashRef).toBeNull();
    expect(await p.read("f.txt")).toBe(replaceLine(BASE, 5, "claude"));
  });

  it("force overwrites a conflict after writing a trash ref", async () => {
    const p = await makeProject({ "f.txt": BASE });
    const claude = replaceLine(BASE, 5, "claude");
    await writeFile(p.w("f.txt"), claude);
    const mac = replaceLine(BASE, 5, "mac");
    const r = await p.repo.applyOps([writeOp("f.txt", mac, { baseHash: h(BASE), force: true })]);
    expect(r.results[0]).toEqual({ path: "f.txt", status: "applied", reason: "forced" });
    expect(r.trashRef).toMatch(/^refs\/trash\/\d{8}T\d{9}Z-[0-9a-f]{6}$/);
    expect(p.git("show", `${r.trashRef}:f.txt`)).toBe(claude);
    expect(await p.read("f.txt")).toBe(mac);
    expect(localContent(p, "f.txt")).toBe(mac);
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("deletes only when the server copy is untouched; force deletes after trashing", async () => {
    const p = await makeProject({ "keep/a.txt": "a\n", "b.txt": "b\n" });
    const r1 = await p.repo.applyOps([deleteOp("keep/a.txt", h("a\n"))]);
    expect(r1.results[0]!.status).toBe("applied");
    await expect(lstat(p.w("keep"))).rejects.toThrow(); // emptied parent dir pruned

    await writeFile(p.w("b.txt"), "claude\n");
    const r2 = await p.repo.applyOps([deleteOp("b.txt", h("b\n"))]);
    expect(r2.results[0]).toEqual({ path: "b.txt", status: "conflict", reason: "modified on the server" });
    expect(localContent(p, "b.txt")).toBe("b\n");

    const r3 = await p.repo.applyOps([deleteOp("b.txt", h("b\n"), true)]);
    expect(r3.results[0]).toEqual({ path: "b.txt", status: "applied", reason: "forced" });
    expect(p.git("show", `${r3.trashRef}:b.txt`)).toBe("claude\n");
    await expect(lstat(p.w("b.txt"))).rejects.toThrow();
    expect(localContent(p, "b.txt")).toBeNull();
  });

  it("skips symlinks, oversized files and excluded paths", async () => {
    const p = await makeProject({ "real.txt": "r\n" });
    await symlink("real.txt", p.w("ln"));
    await mkdir(p.w("dirlink-target"));
    await symlink("dirlink-target", p.w("dirlink"));
    const n0 = commitCount(p);
    const r = await p.repo.applyOps([
      { ...writeOp("big.bin", "x", { omitContent: true }), size: MAX_SYNC_FILE_BYTES + 1 },
      writeOp("s", "target", { mode: 0o120777 }),
      writeOp("ln", "over the link\n"),
      writeOp("dirlink/inside.txt", "escape?\n"),
      writeOp("node_modules/pkg/index.js", "x\n"),
    ]);
    expect(r.results.map((x) => `${x.status}:${x.reason}`)).toEqual([
      "skipped:too_large",
      "skipped:symlink",
      "skipped:symlink",
      "skipped:symlink",
      "skipped:excluded",
    ]);
    expect(commitCount(p)).toBe(n0);
    await expect(lstat(p.w("dirlink-target/inside.txt"))).rejects.toThrow();
    expect(await readFile(p.w("real.txt"), "utf8")).toBe("r\n");
  });

  it("preserves the executable bit (new files and mode-only changes)", async () => {
    const p = await makeProject({ "tool.sh": "#!/bin/sh\n" });
    const r = await p.repo.applyOps([writeOp("bin/run.sh", "#!/bin/sh\necho\n", { mode: 0o100755 }), writeOp("tool.sh", "#!/bin/sh\n", { mode: 0o100755, omitContent: true, baseHash: h("#!/bin/sh\n") })]);
    expect(r.results.map((x) => x.status)).toEqual(["applied", "applied"]);
    expect((await stat(p.w("bin/run.sh"))).mode & 0o111).not.toBe(0);
    expect((await stat(p.w("tool.sh"))).mode & 0o111).not.toBe(0);
    expect(localMode(p, "bin/run.sh")).toBe("100755");
    expect(localMode(p, "tool.sh")).toBe("100755");
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("merges against the Mac's real base when local moved since (stale baseHash)", async () => {
    const p = await makeProject({ "f.txt": BASE });
    // Claude edits line 3; the user accepts it on the server (local moves to L1).
    await writeFile(p.w("f.txt"), replaceLine(BASE, 3, "claude 3"));
    await p.repo.accept({ path: "f.txt" });
    // Meanwhile the Mac edited line 15 starting from the original BASE.
    const mac = replaceLine(BASE, 15, "mac 15");
    const r = await p.repo.applyOps([writeOp("f.txt", mac, { baseHash: h(BASE) })]);
    expect(r.results[0]!.status).toBe("merged");
    expect(await p.read("f.txt")).toBe(replaceLine(mac, 3, "claude 3"));
    expect(localContent(p, "f.txt")).toBe(mac);
    // Claude's accepted change is pending again rather than lost.
    expect((await p.repo.review()).files.map((f) => f.path)).toEqual(["f.txt"]);
  });

  it("treats identical content on both sides as applied without touching the work tree", async () => {
    const p = await makeProject({ "f.txt": "v1\n" });
    await writeFile(p.w("f.txt"), "v2\n");
    const r = await p.repo.applyOps([writeOp("f.txt", "v2\n", { baseHash: h("v1\n") })]);
    expect(r.results[0]!.status).toBe("applied");
    expect(localContent(p, "f.txt")).toBe("v2\n");
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("replaces a directory with a file in one batch", async () => {
    const p = await makeProject({ "d/x.txt": "x\n" });
    const r = await p.repo.applyOps([writeOp("d", "now a file\n"), deleteOp("d/x.txt", h("x\n"))]);
    expect(r.results.map((x) => x.status)).toEqual(["applied", "applied"]);
    expect(await p.read("d")).toBe("now a file\n");
    expect(localContent(p, "d")).toBe("now a file\n");
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("serializes concurrent batches through the project mutex", async () => {
    const p = await makeProject({ "seed.txt": "s\n" });
    const n0 = commitCount(p);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => p.repo.applyOps([writeOp(`f${i}.txt`, `content ${i}\n`)])),
    );
    expect(results.every((r) => r.results[0]!.status === "applied")).toBe(true);
    expect(commitCount(p)).toBe(n0 + 4);
    // Linear history: every batch saw the previous batch's commit as its parent.
    const commits = new Set(results.map((r) => r.localCommit));
    expect(commits.size).toBe(4);
    const parents = p.git("log", "--format=%P", "-4", "refs/heads/local").trim().split("\n");
    expect(parents.every((l) => l.split(" ").length === 1)).toBe(true);
    for (let i = 0; i < 4; i++) expect(localContent(p, `f${i}.txt`)).toBe(`content ${i}\n`);
  });

  it("reports duplicate ops on one path with the last op's result", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    const r = await p.repo.applyOps([writeOp("a.txt", "first\n", { baseHash: h("a\n") }), writeOp("a.txt", "second\n", { baseHash: h("a\n") })]);
    expect(r.results.map((x) => x.status)).toEqual(["applied", "applied"]);
    expect(await p.read("a.txt")).toBe("second\n");
  });
});
