/** Baseline archive limits: compressed bytes, extracted bytes, entry count, wall time; scratch dir cleaned; tar/zstd killed. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { isSyncCoreError, openProject } from "../src/index.js";
import { tmpRoot, writeFiles } from "./helpers.js";

const hasZstd = spawnSync("zstd", ["--version"]).status === 0;

async function archive(files: Record<string, string>, zst: boolean): Promise<Buffer> {
  const root = await tmpRoot();
  await writeFiles(path.join(root, "src"), files);
  const args = zst ? ["-c", "--zstd", "-f", "-", "-C", path.join(root, "src"), "."] : ["-c", "-f", "-", "-C", path.join(root, "src"), "."];
  return execFileSync("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 1 << 28 });
}

async function repo() {
  const root = await tmpRoot();
  const r = await openProject({ gitDir: path.join(root, "sync", "p.git"), workTree: path.join(root, "work") });
  const scratch = path.join(r.gitDir, "workstation", "tmp");
  const leftovers = async () => (await readdir(scratch).catch(() => [])).filter((n) => n.startsWith("baseline-"));
  return { r, leftovers, root };
}

const files = { "a.txt": "aaaa\n", "b/c.txt": "cccc\n", "d.txt": "dddd\n" };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isSyncCoreError(e) ? e.code : `other:${String(e)}`;
  }
  return "ok";
}

describe.each([
  ["tar", false],
  ["tar.zst", true],
] as const)("baseline limits (%s)", (format, zst) => {
  const run = hasZstd || !zst ? it : it.skip;

  run("imports within the limits and leaves no scratch dir", async () => {
    const { r, leftovers } = await repo();
    const res = await r.importBaseline(await archive(files, zst), { format, limits: { maxFiles: 100, maxExtractedBytes: 1000, maxCompressedBytes: 100_000, maxMs: 20_000 } });
    expect(res.files).toBe(3);
    expect(await leftovers()).toEqual([]);
  });

  run("entry count over the limit: baseline_too_large", async () => {
    const { r, leftovers } = await repo();
    const code = await codeOf(r.importBaseline(await archive(files, zst), { format, limits: { maxFiles: 3 } })); // ./ + a + b/ + b/c + d = 5 entries
    expect(code).toBe("baseline_too_large");
    expect(await leftovers()).toEqual([]);
  });

  run("extracted bytes over the limit: baseline_too_large", async () => {
    const { r, leftovers } = await repo();
    const code = await codeOf(r.importBaseline(await archive({ "big.txt": "x".repeat(20_000) }, zst), { format, limits: { maxExtractedBytes: 10_000 } }));
    expect(code).toBe("baseline_too_large");
    expect(await leftovers()).toEqual([]);
    expect((await r.review()).files).toEqual([]);
  });

  run("compressed bytes over the limit: baseline_too_large", async () => {
    const { r, leftovers } = await repo();
    const code = await codeOf(r.importBaseline(await archive({ "a.txt": randomBytes(5000).toString("base64") }, zst), { format, limits: { maxCompressedBytes: 200 } }));
    expect(code).toBe("baseline_too_large");
    expect(await leftovers()).toEqual([]);
  });

  run("a stalled upload hits the time limit: baseline_timeout, children gone, scratch removed", async () => {
    const { r, leftovers } = await repo();
    const body = new PassThrough();
    // The start of a real archive (a valid stream as far as it goes), then nothing more: only the time limit can end it.
    body.write((await archive({ "a.txt": randomBytes(4000).toString("base64") }, zst)).subarray(0, 100));
    const t0 = Date.now();
    const code = await codeOf(r.importBaseline(body, { format, limits: { maxMs: 300 } }));
    expect(code).toBe("baseline_timeout");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await leftovers()).toEqual([]);
    body.destroy();
  });

  run("garbage is refused: invalid_argument for a bad zstd stream, baseline_unsupported_entry for a bad tar header", async () => {
    const { r } = await repo();
    expect(await codeOf(r.importBaseline(Readable.from([Buffer.from("not an archive at all".repeat(100))]), { format }))).toBe(zst ? "invalid_argument" : "baseline_unsupported_entry");
  });
});

describe("decompression bomb", () => {
  it.skipIf(!hasZstd)("a tiny tar.zst declaring a huge file is refused before anything is extracted", async () => {
    const { r, leftovers } = await repo();
    const a = await archive({ "zeros.bin": "0".repeat(3_000_000) }, true);
    expect(a.length).toBeLessThan(50_000);
    expect(await codeOf(r.importBaseline(a, { format: "tar.zst", limits: { maxExtractedBytes: 1_000_000 } }))).toBe("baseline_too_large");
    expect(await leftovers()).toEqual([]);
  });
});
