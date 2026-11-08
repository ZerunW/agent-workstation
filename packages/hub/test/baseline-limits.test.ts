/** POST /api/projects/:id/baseline limits ([baseline] config): 413 baseline_too_large, 408 baseline_timeout, no leftovers. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Project } from "@agent-workstation/protocol";
import { hubFixture, tempDir, type HubFixture } from "./helpers.js";

function tarball(files: Record<string, string>, zstd: boolean): Buffer {
  const t = tempDir("workstation-tar-");
  try {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(t.dir, "src", p, ".."), { recursive: true });
      writeFileSync(join(t.dir, "src", p), c);
    }
    const out = join(t.dir, "b.tar");
    execFileSync("tar", ["-c", "-b", "1", ...(zstd ? ["--zstd"] : []), "-f", out, "-C", join(t.dir, "src"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return readFileSync(out);
  } finally {
    t.cleanup();
  }
}

let f: HubFixture;
beforeAll(async () => {
  f = await hubFixture({}, () => ({ baseline: { max_compressed_bytes: 5000, max_extracted_bytes: 3000, max_files: 6, max_minutes: 0.01 } }));
});
afterAll(() => f.close());

const A = () => f.as("alice", { "content-type": "application/octet-stream" });
async function newProject(name: string): Promise<Project> {
  const r = await f.app.inject({ method: "POST", url: "/api/projects", headers: f.as("alice"), payload: { name } });
  return Project.parse(r.json());
}
const scratchLeft = (p: Project) => {
  const dir = join(f.root, "alice", ".sync", `${p.name}.git`, "workstation", "tmp");
  try {
    return readdirSync(dir).filter((n) => n.startsWith("baseline-"));
  } catch {
    return [];
  }
};

describe("baseline limits", () => {
  it("accepts a baseline within the limits (tar and tar.zst)", async () => {
    const p = await newProject("ok");
    const r = await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/baseline`, headers: A(), payload: tarball({ "a.txt": "a\n", "d/b.txt": "b\n" }, true) });
    expect(r.statusCode).toBe(200);
    const q = await newProject("ok2");
    const r2 = await f.app.inject({ method: "POST", url: `/api/projects/${q.id}/baseline`, headers: { ...A(), "x-baseline-encoding": "tar" }, payload: tarball({ "a.txt": "a\n" }, false) });
    expect(r2.statusCode).toBe(200);
  });

  it("too many files: 413 baseline_too_large", async () => {
    const p = await newProject("many");
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, "x\n"]));
    for (const zstd of [true, false]) {
      const r = await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/baseline`, headers: { ...A(), ...(zstd ? {} : { "x-baseline-encoding": "tar" }) }, payload: tarball(files, zstd) });
      expect(r.statusCode).toBe(413);
      expect(r.json().code).toBe("baseline_too_large");
    }
    expect(scratchLeft(p)).toEqual([]);
  });

  it("too many extracted bytes: 413 even when the upload is small (compressible)", async () => {
    const p = await newProject("bomb");
    const body = tarball({ "zeros.bin": "0".repeat(200_000) }, true);
    expect(body.length).toBeLessThan(5000);
    const r = await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/baseline`, headers: A(), payload: body });
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("baseline_too_large");
    expect(scratchLeft(p)).toEqual([]);
  });

  it("upload over the compressed-size limit: 413", async () => {
    const p = await newProject("bigupload");
    const r = await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/baseline`, headers: { ...A(), "x-baseline-encoding": "tar" }, payload: tarball({ "a.txt": "q".repeat(8000) }, false).subarray(0, 6000) });
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("baseline_too_large");
  });

  it("an entry type tar readers disagree about, or a damaged header: 400 baseline_unsupported_entry, nothing left behind", async () => {
    const block = (name: string, type: string, size: number, badSum = false): Buffer => {
      const h = Buffer.alloc(512);
      h.write(name, 0, "latin1");
      h.write("0000644\0", 100, "latin1");
      h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
      h.write("        ", 148, "latin1");
      h.write(type, 156, "latin1");
      h.write("ustar\0", 257, "latin1");
      let sum = badSum ? 1 : 0;
      for (const b of h) sum += b;
      h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
      return h;
    };
    const end = Buffer.alloc(1024);
    const sparse = Buffer.concat([block("s.bin", "S", 0), end]);
    const damaged = Buffer.concat([block("a.txt", "0", 0, true), end]);
    for (const [name, body] of [["sparse", sparse], ["damaged", damaged]] as const) {
      const p = await newProject(`odd-${name}`);
      const r = await f.app.inject({ method: "POST", url: `/api/projects/${p.id}/baseline`, headers: { ...A(), "x-baseline-encoding": "tar" }, payload: body });
      expect(r.statusCode, name).toBe(400);
      expect(r.json().code, name).toBe("baseline_unsupported_entry");
      expect(scratchLeft(p)).toEqual([]);
    }
  });

  it("a stalled upload: 408 baseline_timeout", async () => {
    const p = await newProject("slow");
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => void f.app.routing(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const { request } = await import("node:http");
      const status = await new Promise<{ code: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: `/api/projects/${p.id}/baseline`, headers: { ...A(), "x-baseline-encoding": "tar", "transfer-encoding": "chunked" } }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ code: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.write(Buffer.alloc(100)); // never finished
      });
      expect(status.code).toBe(408);
      expect(JSON.parse(status.body).code).toBe("baseline_timeout");
    } finally {
      server.closeAllConnections();
      server.close();
    }
    expect(scratchLeft(p)).toEqual([]);
  });
});
