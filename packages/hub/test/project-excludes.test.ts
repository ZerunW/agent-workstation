/**
 * PUT /api/projects/:id/excludes: the Mac's unchecked paths are the server's only exclusions besides .git. No built-in
 * defaults (node_modules/, build/ …) and no in-tree .gitignore: what the person left checked is stored.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Project } from "@agent-workstation/protocol";
import { excludePattern } from "../src/projects/index.js";
import { hubFixture, tempDir, type HubFixture } from "./helpers.js";

let f: HubFixture;
beforeAll(async () => {
  f = await hubFixture();
});
afterAll(async () => {
  await f.close();
});

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

describe("excludePattern", () => {
  it("matches exactly the given path, anchored, globs and leading markers escaped", () => {
    expect(excludePattern({ path: "build", kind: "folder" })).toBe("/build/");
    expect(excludePattern({ path: "src/a.txt", kind: "file" })).toBe("/src/a.txt");
    expect(excludePattern({ path: "data/*.bin", kind: "file" })).toBe("/data/\\*.bin");
    expect(excludePattern({ path: "x[1]?", kind: "file" })).toBe("/x\\[1\\]\\?");
    expect(excludePattern({ path: "#notes", kind: "file" })).toBe("/\\#notes");
    expect(excludePattern({ path: "trail ", kind: "file" })).toBe("/trail\\ ");
  });
});

describe("PUT /api/projects/:id/excludes", () => {
  it("excludes only the unchecked paths; defaults and .gitignore no longer hide anything", async () => {
    const A = f.as("alice");
    const project = Project.parse((await f.app.inject({ method: "POST", url: "/api/projects", headers: A, payload: { name: "exc" } })).json());
    const base = `/api/projects/${project.id}`;
    const put = await f.app.inject({
      method: "PUT",
      url: `${base}/excludes`,
      headers: A,
      payload: { paths: [{ path: "build", kind: "folder" }, { path: "secret.txt", kind: "file" }] },
    });
    expect(put.statusCode).toBe(204);
    const tar = tarball({
      "node_modules/a.js": "a",
      "build/out.o": "o",
      "secret.txt": "s",
      "docs/a.md": "d",
      ".gitignore": "docs/\nnode_modules/\n",
      "src/main.c": "m",
    });
    const b = await f.app.inject({ method: "POST", url: `${base}/baseline`, headers: { ...A, "content-type": "application/x-tar" }, payload: tar });
    expect(b.statusCode).toBe(200);
    const raw = (p: string) => f.app.inject({ method: "GET", url: `${base}/raw?path=${encodeURIComponent(p)}&ref=local`, headers: A });
    for (const p of ["node_modules/a.js", "docs/a.md", ".gitignore", "src/main.c"]) expect((await raw(p)).statusCode, p).toBe(200);
    for (const p of ["build/out.o", "secret.txt"]) expect((await raw(p)).statusCode, p).toBe(404);
    // Re-checking a path (a new list) makes the server want it from the Mac again.
    await f.app.inject({ method: "PUT", url: `${base}/excludes`, headers: A, payload: { paths: [] } });
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const m = await f.app.inject({
      method: "POST",
      url: `${base}/manifest`,
      headers: A,
      payload: { entries: [{ path: "secret.txt", hash: sha("s"), size: 1, mode: 0o100644 }] },
    });
    expect(m.json().need).toEqual(["secret.txt"]);
  });

  it("validates the body and the user", async () => {
    const A = f.as("alice");
    const project = Project.parse((await f.app.inject({ method: "POST", url: "/api/projects", headers: A, payload: { name: "exc2" } })).json());
    expect((await f.app.inject({ method: "PUT", url: `/api/projects/${project.id}/excludes`, headers: A, payload: { paths: [{ path: "../x", kind: "file" }] } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "PUT", url: `/api/projects/${project.id}/excludes`, headers: f.as("bob"), payload: { paths: [] } })).statusCode).toBe(404);
  });
});
