/**
 * The hub's mode: no built-in defaults, no in-tree .gitignore. Only `.git` and the caller's patterns (the person's
 * unchecked paths) are excluded; node_modules/, build/ and gitignored files sync like any other file.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { localContent, makeProject } from "./helpers.js";

describe("defaultExcludes: false + honorGitignore: false", () => {
  it("syncs what defaults or .gitignore would hide; excludes only .git and the given paths", async () => {
    const p = await makeProject(
      {
        ".gitignore": "docs/\n*.png\n/assets/\n",
        "node_modules/x/index.js": "x",
        "build/out.o": "o",
        "docs/a.md": "a",
        "img.png": "png",
        "src/assets/a.txt": "m",
        "keep/skip-me.txt": "s",
        "skipdir/inner.txt": "i",
      },
      { defaultExcludes: false, honorGitignore: false, excludes: ["/keep/skip-me.txt", "/skipdir/"] },
    );
    for (const f of ["node_modules/x/index.js", "build/out.o", "docs/a.md", "img.png", "src/assets/a.txt", ".gitignore"]) {
      expect(localContent(p, f), f).not.toBeNull();
    }
    expect(localContent(p, "keep/skip-me.txt")).toBeNull();
    expect(localContent(p, "skipdir/inner.txt")).toBeNull();
    // Files the agent creates in an excluded folder stay out of review; elsewhere they show.
    await mkdir(p.w("skipdir/gen"), { recursive: true });
    await writeFile(p.w("skipdir/gen/out.bin"), "gen");
    await mkdir(p.w("build"), { recursive: true });
    await writeFile(p.w("build/new.o"), "new");
    const paths = (await p.repo.review()).files.map((f) => f.path);
    expect(paths).toContain("build/new.o");
    expect(paths.some((x) => x.startsWith("skipdir/"))).toBe(false);
  });

  it("setExcludes replaces the list (a re-checked path is needed from the Mac again)", async () => {
    const p = await makeProject({ "a.txt": "a", "b.txt": "b" }, { defaultExcludes: false, honorGitignore: false, excludes: ["/b.txt"] });
    expect(localContent(p, "b.txt")).toBeNull();
    const entries = [{ path: "b.txt", hash: createHash("sha256").update("b").digest("hex"), size: 1, mode: 0o100644 }];
    expect((await p.repo.manifest(entries)).need).toEqual([]);
    await p.repo.setExcludes([]);
    expect((await p.repo.manifest(entries)).need).toEqual(["b.txt"]);
  });
});
