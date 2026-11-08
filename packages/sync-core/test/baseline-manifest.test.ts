import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SYNC_FILE_BYTES, openProject, type ManifestEntry } from "../src/index.js";
import { h, localContent, localMode, makeProject, tmpRoot, writeFiles } from "./helpers.js";

const tarHasZstd = (() => {
  const r = spawnSync("tar", ["--help"], { encoding: "utf8" });
  const z = spawnSync("zstd", ["--version"], { encoding: "utf8" });
  return r.status === 0 && z.status === 0 && /zstd/.test(r.stdout + r.stderr + (process.platform === "darwin" ? "zstd" : ""));
})();

describe("openProject", () => {
  it("creates a bare repo outside the work tree with an empty `local` branch", async () => {
    const root = await tmpRoot();
    const repo = await openProject({ gitDir: path.join(root, "s", "x.git"), workTree: path.join(root, "w"), excludes: ["*.log"] });
    const local = await repo.localCommit();
    expect(local).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(path.join(repo.gitDir, "info", "exclude"), "utf8")).toContain("*.log");
    expect(await readFile(path.join(repo.gitDir, "HEAD"), "utf8")).toBe("ref: refs/heads/local\n");
    // No .git inside the work tree.
    await expect(lstat(path.join(repo.workTree, ".git"))).rejects.toThrow();
    // Re-opening is idempotent and keeps the branch.
    const again = await openProject({ gitDir: path.join(root, "s", "x.git"), workTree: path.join(root, "w") });
    expect(await again.localCommit()).toBe(local);
    expect((await again.review()).files).toEqual([]);
  });

  it("refuses a git dir inside the work tree", async () => {
    const root = await tmpRoot();
    await expect(openProject({ gitDir: path.join(root, "w", ".sync.git"), workTree: path.join(root, "w") })).rejects.toThrow(/must not contain/);
  });
});

describe("importBaseline", () => {
  it("imports a directory, preserving the executable bit, skipping excluded files and symlinks", async () => {
    const p = await makeProject({
      "README.md": "# hi\n",
      "src/main.ts": "console.log(1)\n",
      "中文 目录/文件 名.txt": "你好\n",
      "run.sh": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
      "node_modules/dep/index.js": "x\n",
      "build/out.o": "bin\n",
      ".DS_Store": "junk",
      "link": { symlink: "README.md" },
    });
    const files = p.git("ls-tree", "-r", "--name-only", "--full-tree", "refs/heads/local").trim().split("\n").sort();
    expect(files).toEqual(["README.md", "run.sh", "src/main.ts", "中文 目录/文件 名.txt"]);
    expect(localMode(p, "run.sh")).toBe("100755");
    expect(localMode(p, "README.md")).toBe("100644");
    expect(await p.read("中文 目录/文件 名.txt")).toBe("你好\n");
    expect((await stat(p.w("run.sh"))).mode & 0o111).not.toBe(0);
    await expect(lstat(p.w("node_modules"))).rejects.toThrow();
    await expect(lstat(p.w("link"))).rejects.toThrow();
    expect(p.git("log", "-1", "--format=%s", "refs/heads/local").trim()).toBe("baseline: 4 files");
    expect((await p.repo.review()).files).toEqual([]);
  });

  it.skipIf(!tarHasZstd)("imports a tar.zst stream and a tar.zst buffer", async () => {
    const root = await tmpRoot();
    const src = path.join(root, "src");
    await writeFiles(src, { "a.txt": "A\n", "dir/名 字.txt": "B\n", "x.sh": { content: "#!/bin/sh\n", mode: 0o755 } });
    const tarball = path.join(root, "base.tar.zst");
    execFileSync("tar", ["-c", "--zstd", "-f", tarball, "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });

    const repo = await openProject({ gitDir: path.join(root, "g.git"), workTree: path.join(root, "w") });
    const r = await repo.importBaseline(createReadStream(tarball));
    expect(r.files).toBe(3);
    expect(await readFile(path.join(repo.workTree, "dir/名 字.txt"), "utf8")).toBe("B\n");
    expect((await stat(path.join(repo.workTree, "x.sh"))).mode & 0o111).not.toBe(0);

    const repo2 = await openProject({ gitDir: path.join(root, "g2.git"), workTree: path.join(root, "w2") });
    const r2 = await repo2.importBaseline(await readFile(tarball));
    expect(r2.files).toBe(3);
    // Same content → same tree on both repos.
    const tree = (dir: string) => execFileSync("git", [`--git-dir=${dir}`, "rev-parse", "refs/heads/local^{tree}"], { encoding: "utf8" });
    expect(tree(repo2.gitDir)).toBe(tree(repo.gitDir));
  });

  it("rejects a corrupt tarball without touching local", async () => {
    const root = await tmpRoot();
    const repo = await openProject({ gitDir: path.join(root, "g.git"), workTree: path.join(root, "w") });
    const before = await repo.localCommit();
    await expect(repo.importBaseline(Buffer.from("definitely not zstd"))).rejects.toThrow();
    expect(await repo.localCommit()).toBe(before);
  });

  it("re-baseline trashes a divergent work tree and drops files the Mac deleted", async () => {
    const p = await makeProject({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    await writeFile(p.w("a.txt"), "claude edit\n");
    await writeFile(p.w("new.txt"), "claude new\n");
    // The Mac's folder now: b deleted, c changed.
    await unlink(path.join(p.mac, "b.txt"));
    await writeFile(path.join(p.mac, "c.txt"), "c2\n");
    const r = await p.repo.importBaseline(p.mac);
    expect(r.trashRef).toMatch(/^refs\/trash\//);
    expect(p.git("show", `${r.trashRef}:a.txt`)).toBe("claude edit\n");
    await expect(lstat(p.w("b.txt"))).rejects.toThrow();
    expect(await p.read("c.txt")).toBe("c2\n");
    expect(localContent(p, "b.txt")).toBeNull();
    const review = await p.repo.review();
    expect(review.files.map((f) => `${f.status}:${f.path}`)).toEqual(["added:new.txt"]);
  });

  it("re-baseline keeps a file that is still in the source but newly excluded", async () => {
    const p = await makeProject({ "keep.log": "log\n", "a.txt": "a\n" });
    const reopened = await openProject({ gitDir: p.repo.gitDir, workTree: p.repo.workTree, excludes: ["*.log"] });
    await reopened.importBaseline(p.mac);
    expect(await p.read("keep.log")).toBe("log\n");
    expect(localContent(p, "keep.log")).toBeNull();
    expect((await reopened.review()).files).toEqual([]);
  });
});

describe("manifest", () => {
  it("returns paths to push (content or exec-bit differs, or missing) and paths the Mac no longer has", async () => {
    const p = await makeProject({
      "same.txt": "same\n",
      "changed.txt": "old\n",
      "gone.txt": "gone\n",
      "tool.sh": { content: "#!/bin/sh\n", mode: 0o755 },
      "目录/文 件.txt": "x\n",
    });
    const entries: ManifestEntry[] = [
      { path: "same.txt", hash: h("same\n"), size: 5, mode: 0o100644 },
      { path: "changed.txt", hash: h("new\n"), size: 4, mode: 0o100644 },
      { path: "tool.sh", hash: h("#!/bin/sh\n"), size: 10, mode: 0o100644 }, // exec bit removed on the Mac
      { path: "目录/文 件.txt", hash: h("x\n"), size: 2, mode: 0o100644 },
      { path: "brand new.txt", hash: h("n\n"), size: 2, mode: 0o100644 },
      { path: "node_modules/a/b.js", hash: h("z"), size: 1, mode: 0o100644 }, // excluded
      { path: "huge.bin", hash: h("q"), size: MAX_SYNC_FILE_BYTES + 1, mode: 0o100644 }, // a large file `local` lacks
    ];
    const r = await p.repo.manifest(entries);
    expect(r.need).toEqual(["brand new.txt", "changed.txt", "huge.bin", "tool.sh"]);
    expect(r.delete).toEqual(["gone.txt"]);
    expect(r.localCommit).toBe(await p.repo.localCommit());
    // Second call uses the cached hashes and gives the same answer.
    expect(await p.repo.manifest(entries)).toEqual(r);
  });

  it("honours caller excludes and in-tree .gitignore", async () => {
    const p = await makeProject({ ".gitignore": "*.tmp\n", "keep.txt": "k\n" }, { excludes: ["secret/"] });
    const r = await p.repo.manifest([
      { path: ".gitignore", hash: h("*.tmp\n"), size: 6, mode: 0o100644 },
      { path: "keep.txt", hash: h("k\n"), size: 2, mode: 0o100644 },
      { path: "x.tmp", hash: h("t"), size: 1, mode: 0o100644 },
      { path: "secret/key", hash: h("s"), size: 1, mode: 0o100644 },
    ]);
    expect(r).toMatchObject({ need: [], delete: [] });
  });

  it("can ignore in-tree .gitignore (honorGitignore: false) while keeping info/exclude", async () => {
    const p = await makeProject({ ".gitignore": "*.tmp\n", "data.tmp": "d\n", "node_modules/x.js": "x" }, { honorGitignore: false });
    expect(localContent(p, "data.tmp")).toBe("d\n");
    expect(localContent(p, "node_modules/x.js")).toBeNull();
    await writeFile(p.w("claude.tmp"), "c\n");
    expect((await p.repo.review()).files.map((f) => f.path)).toEqual(["claude.tmp"]);
    const r = await p.repo.manifest([
      { path: ".gitignore", hash: h("*.tmp\n"), size: 6, mode: 0o100644 },
      { path: "data.tmp", hash: h("d2\n"), size: 3, mode: 0o100644 },
      { path: "node_modules/x.js", hash: h("x"), size: 1, mode: 0o100644 },
    ]);
    expect(r).toMatchObject({ need: ["data.tmp"], delete: [] });
  });

  it("rejects unsafe paths", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    await expect(p.repo.manifest([{ path: "../escape", hash: h("x"), size: 1, mode: 0o644 }])).rejects.toThrow(/invalid path/);
    await mkdir(p.w("sub"), { recursive: true });
    await expect(p.repo.manifest([{ path: "sub/.git/config", hash: h("x"), size: 1, mode: 0o644 }])).rejects.toThrow(/\.git/);
  });
});
