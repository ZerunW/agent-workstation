/**
 * The baseline's tar header scanner reads headers the way GNU tar does: only the accepted entry types, `X` read like
 * `x`, a wrong checksum refused (no resync), sparse entries refused; the scratch directory's real size is watched.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { allocatedBytes, DEFAULT_BASELINE_LIMITS, extractArchive, TarScanner } from "../src/archive.js";
import { isSyncCoreError, openProject } from "../src/index.js";
import { tmpRoot } from "./helpers.js";

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** One tar header block with a correct checksum (`badChecksum` writes a wrong one). */
function header(name: string, type: string, size: number, o: { badChecksum?: boolean; linkname?: string } = {}): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "latin1");
  h.write("0000644\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write(octal(size, 12), 124, "latin1");
  h.write(octal(0, 12), 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write(type, 156, "latin1");
  if (o.linkname) h.write(o.linkname, 157, 100, "latin1");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  if (o.badChecksum) sum += 1;
  h.write(octal(sum, 7), 148, "latin1");
  h[155] = 0x20;
  return h;
}

const pad = (b: Buffer): Buffer => (b.length % BLOCK === 0 ? b : Buffer.concat([b, Buffer.alloc(BLOCK - (b.length % BLOCK))]));
const END = Buffer.alloc(BLOCK * 2);
const entry = (name: string, type: string, data: Buffer | string = ""): Buffer => {
  const d = Buffer.from(data);
  return Buffer.concat([header(name, type, d.length), pad(d)]);
};
const pax = (records: Record<string, string>, type = "x"): Buffer => {
  const body = Object.entries(records)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`;
      let len = rest.length + 1;
      while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
      return `${len}${rest}`;
    })
    .join("");
  return entry("PaxHeader/x", type, body);
};

/** Pushes `archive` through a scanner; resolves with the error code (or "ok"). */
async function scan(archive: Buffer, limits: Partial<typeof DEFAULT_BASELINE_LIMITS> = {}): Promise<string> {
  const scanner = new TarScanner({ ...DEFAULT_BASELINE_LIMITS, ...limits });
  let out = 0;
  scanner.on("data", (c: Buffer) => (out += c.length));
  try {
    await new Promise<void>((resolve, reject) => {
      scanner.on("error", reject);
      scanner.on("end", resolve);
      // in small chunks so headers and data straddle chunk borders
      const chunks: Buffer[] = [];
      for (let i = 0; i < archive.length; i += 700) chunks.push(archive.subarray(i, i + 700));
      Readable.from(chunks).pipe(scanner);
    });
  } catch (e) {
    return isSyncCoreError(e) ? e.code : `other:${String(e)}`;
  }
  expect(out).toBe(archive.length); // a pass-through
  return "ok";
}

describe("entry types", () => {
  it("accepts 0, NUL, 1-7, x, g, L, K and X", async () => {
    const accepted = Buffer.concat([
      entry("a", "0", "aaa"),
      entry("b", "\0", "bbb"),
      entry("hard", "1"),
      entry("sym", "2"),
      entry("chr", "3"),
      entry("blk", "4"),
      entry("dir/", "5"),
      entry("fifo", "6"),
      entry("contig", "7", "ccc"),
      pax({ comment: "x" }, "g"),
      entry("././@LongLink", "L", "a-long-name\0"),
      entry("x", "0", "data"),
      entry("././@LongLink", "K", "a-long-target\0"),
      entry("sym2", "2"),
      pax({ path: "p" }, "X"),
      entry("y", "0", "data"),
      END,
    ]);
    expect(await scan(accepted)).toBe("ok");
  });

  it.each([
    ["S", "sparse"],
    ["D", "dump directory"],
    ["M", "multi-volume continuation"],
    ["N", "old GNU long name"],
    ["V", "volume header"],
    ["Z", "unknown"],
    ["A", "unknown"],
    ["8", "unknown"],
    ["W", "unknown"],
  ])("refuses type %s (%s) with baseline_unsupported_entry", async (type) => {
    expect(await scan(Buffer.concat([entry("a", "0", "x"), entry("odd", type, "data"), END]))).toBe("baseline_unsupported_entry");
  });

  it("refuses pax sparse records", async () => {
    expect(await scan(Buffer.concat([pax({ "GNU.sparse.realsize": "5000000", "GNU.sparse.major": "1" }), entry("s", "0", "x"), END]))).toBe("baseline_unsupported_entry");
  });
});

describe("header checksum", () => {
  it("a wrong checksum is refused instead of resyncing", async () => {
    const bad = Buffer.concat([entry("a", "0", "x"), header("b", "0", 0, { badChecksum: true }), entry("c", "0", "x"), END]);
    expect(await scan(bad)).toBe("baseline_unsupported_entry");
  });

  it("a checksum that is not an octal number is refused", async () => {
    const h = header("a", "0", 0);
    h.write("zzzzzzz\0", 148, "latin1");
    expect(await scan(Buffer.concat([h, END]))).toBe("baseline_unsupported_entry");
  });

  it("a file that starts with data where a header should be is refused (no hunting for the next header)", async () => {
    const junk = Buffer.alloc(BLOCK, 0x41);
    expect(await scan(Buffer.concat([entry("a", "0", "x"), junk, entry("b", "0", "x"), END]))).toBe("baseline_unsupported_entry");
  });
});

describe("sizes", () => {
  it("an X record's size= applies to the next entry like x's", async () => {
    const data = Buffer.alloc(20_000, 0x61);
    for (const type of ["x", "X"]) {
      // header size 0, record size 20000, then 20000 bytes of data: tar writes 20000 bytes
      const archive = Buffer.concat([pax({ size: "20000" }, type), header("big", "0", 0), pad(data), END]);
      expect(await scan(archive, { maxExtractedBytes: 10_000 }), type).toBe("baseline_too_large");
      expect(await scan(archive, { maxExtractedBytes: 30_000 }), type).toBe("ok");
    }
  });

  it("the last size= record wins, as in tar (a smaller later one cannot hide a larger earlier one from the byte count)", async () => {
    const data = Buffer.alloc(1_000, 0x61);
    const archive = Buffer.concat([pax({ size: "50000" }), pax({ size: "1000" }), header("f", "0", 0), pad(data), END]);
    // only the second x header applies to f, and f's data is 1000 bytes: the archive is consistent and counted as 1000
    expect(await scan(archive, { maxExtractedBytes: 2_000 })).toBe("ok");
    const twoInOne = Buffer.concat([entry("PaxHeader/x", "x", "14 size=50000\n14 size=01000\n"), header("f", "0", 0), pad(data), END]);
    expect(await scan(twoInOne, { maxExtractedBytes: 2_000 })).toBe("ok");
  });

  it("a g record's size does not apply to the next entry", async () => {
    const archive = Buffer.concat([pax({ size: "99999999" }, "g"), entry("a", "0", "tiny"), END]);
    expect(await scan(archive, { maxExtractedBytes: 1000 })).toBe("ok");
  });

  it("entry count and size limits still hold", async () => {
    expect(await scan(Buffer.concat([entry("a", "0"), entry("b", "0"), entry("c", "0"), END]), { maxFiles: 2 })).toBe("baseline_too_large");
    expect(await scan(Buffer.concat([entry("a", "0", "x".repeat(2000)), END]), { maxExtractedBytes: 1000 })).toBe("baseline_too_large");
  });
});

describe("through tar", () => {
  const hasTar = spawnSync("tar", ["--version"]).status === 0;
  const run = (archive: Buffer, limits: Partial<typeof DEFAULT_BASELINE_LIMITS> = {}) =>
    tmpRoot().then(async (root) => {
      const dir = path.join(root, "out");
      await mkdir(dir);
      try {
        await extractArchive(archive, dir, "tar", { ...DEFAULT_BASELINE_LIMITS, ...limits });
      } catch (e) {
        return isSyncCoreError(e) ? e.code : `other:${String(e)}`;
      }
      return "ok";
    });

  it.skipIf(!hasTar)("extracts a plain archive and refuses a sparse entry before tar writes anything", async () => {
    expect(await run(Buffer.concat([entry("a.txt", "0", "hello"), END]))).toBe("ok");
    expect(await run(Buffer.concat([entry("a.txt", "0", "hello"), entry("s", "S", "x"), END]))).toBe("baseline_unsupported_entry");
  });

  it.skipIf(!hasTar)("a bad checksum through importBaseline is baseline_unsupported_entry and leaves no scratch directory", async () => {
    const root = await tmpRoot();
    const r = await openProject({ gitDir: path.join(root, "sync", "p.git"), workTree: path.join(root, "work") });
    const bad = Buffer.concat([entry("a", "0", "x"), header("b", "0", 0, { badChecksum: true }), END]);
    await expect(r.importBaseline(bad, { format: "tar" })).rejects.toMatchObject({ code: "baseline_unsupported_entry" });
  });
});

describe("the scratch directory's real size", () => {
  it("allocatedBytes counts what is on disk and stops above a bound", async () => {
    const root = await tmpRoot();
    await mkdir(path.join(root, "d", "e"), { recursive: true });
    await writeFile(path.join(root, "d", "a.bin"), Buffer.alloc(100_000, 1));
    await writeFile(path.join(root, "d", "e", "b.bin"), Buffer.alloc(100_000, 1));
    const n = await allocatedBytes(root);
    expect(n).toBeGreaterThanOrEqual(200_000);
    expect(n).toBeLessThan(400_000);
    expect(await allocatedBytes(root, 50_000)).toBeGreaterThan(50_000);
    expect(await allocatedBytes(path.join(root, "missing"))).toBe(0);
  });

  it.skipIf(spawnSync("tar", ["--version"]).status !== 0)("tar is killed and the upload refused when the scratch directory is bigger than the limit allows, whatever the headers declared", async () => {
    const root = await tmpRoot();
    const dir = path.join(root, "out");
    await mkdir(dir);
    async function* body(): AsyncGenerator<Buffer> {
      yield header("grow.bin", "0", 400_000);
      for (let i = 0; i < 20; i++) {
        yield Buffer.alloc(10_000, 0x61);
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise(() => {}); // the rest of the body never arrives
    }
    const limit = { ...DEFAULT_BASELINE_LIMITS, maxExtractedBytes: 450_000, maxFiles: 10, maxMs: 20_000 };
    const seen: Array<[string, number]> = [];
    const t0 = Date.now();
    const err = await extractArchive(Readable.from(body()), dir, "tar", limit, {
      pollMs: 30,
      measure: async (d, stop) => {
        seen.push([d, stop ?? -1]);
        return seen.length < 3 ? 1000 : 10 * 1024 ** 3;
      },
    }).catch((e: unknown) => e);
    expect(isSyncCoreError(err, "baseline_too_large")).toBe(true);
    expect(seen[0]).toEqual([dir, 450_000 + 4096 * 11]);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
