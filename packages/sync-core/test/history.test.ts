import { randomUUID } from "node:crypto";
import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { acquireLock, isSyncCoreError } from "../src/index.js";
import { makeProject } from "./helpers.js";

describe("snapshot / history / restore", () => {
  it("snapshots each turn, lists history newest first and restores a single path", async () => {
    const p = await makeProject({ "a.txt": "v1\n", "b.txt": "b1\n" });
    const sid = randomUUID();
    const localBefore = await p.repo.localCommit();

    await writeFile(p.w("a.txt"), "v2\n");
    const s1 = await p.repo.snapshot({ sessionId: sid, turn: 1, message: "turn one\nwith newline" });
    expect(s1).toMatchObject({ ref: `refs/snapshots/${sid}/1`, sessionId: sid, turn: 1, kind: "snapshot", message: "turn one with newline", changed: true });
    expect(p.git("rev-parse", `${s1.ref}^`).trim()).toBe(localBefore);

    await writeFile(p.w("a.txt"), "v3\n");
    await writeFile(p.w("b.txt"), "b3\n");
    const s2 = await p.repo.snapshot({ sessionId: sid, turn: 2, message: "turn two" });
    expect(p.git("rev-parse", `${s2.ref}^`).trim()).toBe(s1.commit);
    // "What changed in turn 2" is a diff of two snapshots.
    expect(p.git("diff", "--name-only", s1.ref, s2.ref).trim().split("\n")).toEqual(["a.txt", "b.txt"]);

    const s3 = await p.repo.snapshot({ sessionId: sid, turn: 3, message: "no-op turn" });
    expect(s3.changed).toBe(false);

    const restored = await p.repo.restore({ ref: s1.ref, path: "a.txt" });
    expect(restored.commit).toBe(s1.commit);
    expect(await p.read("a.txt")).toBe("v2\n");
    expect(await p.read("b.txt")).toBe("b3\n");
    expect(p.git("show", `${restored.trashRef}:a.txt`)).toBe("v3\n");
    expect(await p.repo.localCommit()).toBe(localBefore);

    const hist = await p.repo.history();
    expect(hist.map((s) => s.kind)).toEqual(["trash", "snapshot", "snapshot", "snapshot", "sync"]);
    expect(hist[1]).toMatchObject({ ref: s3.ref, turn: 3, sessionId: sid });
    expect(hist[4]).toMatchObject({ ref: localBefore, message: "baseline: 2 files", sessionId: null, turn: null });
    for (let i = 1; i < hist.length; i++) expect(Date.parse(hist[i - 1]!.at)).toBeGreaterThanOrEqual(Date.parse(hist[i]!.at));
    expect((await p.repo.history({ includeUnchanged: false })).some((s) => s.ref === s3.ref)).toBe(false);
    expect(await p.repo.history({ limit: 2 })).toHaveLength(2);
  });

  it("records accept and sync commits in history", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    await writeFile(p.w("a.txt"), "a2\n");
    await p.repo.accept({ path: "a.txt" });
    const hist = await p.repo.history();
    expect(hist[0]).toMatchObject({ kind: "accept", message: "accept: a.txt" });
  });

  it("restores the whole tree from a snapshot (removing files created later)", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    const sid = "session-1";
    await writeFile(p.w("a.txt"), "a2\n");
    await writeFile(p.w("x.txt"), "x\n");
    const s1 = await p.repo.snapshot({ sessionId: sid, turn: 1, message: "t1" });
    await writeFile(p.w("a.txt"), "a3\n");
    await mkdir(p.w("later"));
    await writeFile(p.w("later/y.txt"), "y\n");
    await p.repo.restore({ ref: s1.ref });
    expect(await p.read("a.txt")).toBe("a2\n");
    expect(await p.read("x.txt")).toBe("x\n");
    await expect(lstat(p.w("later/y.txt"))).rejects.toThrow();
    // Restoring from `local` itself throws away all of Claude's edits (after a trash ref).
    const r = await p.repo.restore({ ref: "local" });
    expect((await p.repo.review()).files).toEqual([]);
    expect(p.git("show", `${r.trashRef}:x.txt`)).toBe("x\n");
  });

  it("validates refs and session ids", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    await expect(p.repo.restore({ ref: "--output=/tmp/x" })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "invalid_argument"));
    await expect(p.repo.restore({ ref: "refs/heads/main" })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "invalid_argument"));
    await expect(p.repo.restore({ ref: "refs/trash/../heads/local" })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "invalid_argument"));
    await expect(p.repo.restore({ ref: "deadbeefdeadbeef" })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "not_found"));
    await expect(p.repo.restore({ ref: "local", path: "nope.txt" })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "not_found"));
    await expect(p.repo.snapshot({ sessionId: "../x", turn: 1, message: "" })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "invalid_argument"));
    await expect(p.repo.snapshot({ sessionId: "s", turn: -1, message: "" })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "invalid_argument"));
  });

  it("writes explicit trash refs", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    await writeFile(p.w("a.txt"), "dirty\n");
    const t = await p.repo.trash("before something risky");
    expect(t).toMatchObject({ kind: "trash", message: "trash: before something risky", sessionId: null, turn: null });
    expect(p.git("show", `${t.ref}:a.txt`)).toBe("dirty\n");
    expect((await p.repo.history())[0]!.ref).toBe(t.ref);
  });
});

describe("files, deletion gate, sizes", () => {
  it("rawFile returns work-tree bytes and null for non-files", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    await mkdir(p.w("dir"));
    await symlink("a.txt", p.w("ln"));
    expect((await p.repo.rawFile("a.txt"))?.toString()).toBe("a\n");
    expect(await p.repo.rawFile("missing")).toBeNull();
    expect(await p.repo.rawFile("dir")).toBeNull();
    expect(await p.repo.rawFile("ln")).toBeNull();
    expect(await p.repo.rawFile("ln/x")).toBeNull();
    await expect(p.repo.rawFile("../etc/passwd")).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "invalid_path"));
  });

  it("canDelete requires no tracked changes and every new file downloaded", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    expect(await p.repo.canDelete()).toEqual({ ok: true, pendingFiles: 0, undownloadedFiles: 0 });
    await writeFile(p.w("a.txt"), "changed\n");
    await writeFile(p.w("report.md"), "# generated\n");
    expect(await p.repo.canDelete()).toEqual({ ok: false, pendingFiles: 2, undownloadedFiles: 1 });
    await p.repo.rawFile("report.md");
    expect(await p.repo.canDelete()).toEqual({ ok: false, pendingFiles: 2, undownloadedFiles: 0 });
    await p.repo.accept({ path: "a.txt" });
    expect(await p.repo.canDelete()).toEqual({ ok: true, pendingFiles: 1, undownloadedFiles: 0 });
    // Changing a downloaded file makes it undownloaded again.
    await writeFile(p.w("report.md"), "# regenerated\n");
    expect(await p.repo.canDelete()).toEqual({ ok: false, pendingFiles: 1, undownloadedFiles: 1 });
    await p.repo.markDownloaded(["report.md"]);
    expect((await p.repo.canDelete()).ok).toBe(true);
  });

  it("reports sizes and stats, and runs gc", async () => {
    const p = await makeProject({ "a.txt": "a".repeat(10000) });
    expect(await p.repo.size()).toBeGreaterThan(0);
    expect(await p.repo.gitDirSize()).toBeGreaterThan(0);
    const stats = await p.repo.projectStats();
    expect(stats).toMatchObject({ localCommit: await p.repo.localCommit(), pendingFiles: 0 });
    await p.repo.gc();
  });

  it("repo methods wait for a PreToolUse hold and run inside it via the handle", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    const hold = await acquireLock(p.repo.lockKey);
    let reviewed = false;
    const pending = p.repo.review().then(() => {
      reviewed = true;
    });
    await writeFile(p.w("a.txt"), "half-written by a tool\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(reviewed).toBe(false);
    // The holder itself can still use the repo.
    expect((await hold.run(() => p.repo.review())).files).toHaveLength(1);
    hold.release();
    await pending;
    expect(reviewed).toBe(true);
  });
});
