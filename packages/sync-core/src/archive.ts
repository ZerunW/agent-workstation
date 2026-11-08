/**
 * Extracting an uploaded baseline archive (tar or tar.zst) into a scratch directory with the system `tar` (and `zstd`),
 * under hard limits: compressed input bytes, total extracted bytes, entry count and wall time. The tar headers are
 * read on their way to `tar` (a pass-through scanner), so a limit is hit from the declared sizes, before the data is
 * written; any limit kills the child processes. The caller removes the scratch directory.
 *
 * The scanner must read the archive the way GNU tar does, or an archive could declare small sizes to the scanner and
 * write large files through tar. It therefore accepts only the entry types `0`, NUL, `1`-`7`, `x`, `g`, `L`, `K` (and
 * `X`, read like `x`), refuses sparse, multi-volume, dump-directory, volume and unknown types and any header whose
 * checksum is wrong (`baseline_unsupported_entry`) instead of guessing where the next header is. As a second line of
 * defence the scratch directory's real (allocated) size is measured every second while tar writes, and the children
 * are killed when it passes the extracted-size limit (plus room for directory blocks).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { opendir, lstat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { SyncCoreError } from "./errors.js";
import type { BaselineSource } from "./repo.js";

export interface BaselineLimits {
  /** Bytes of the uploaded (possibly compressed) archive. */
  maxCompressedBytes: number;
  /** Sum of the sizes of all files in the archive. */
  maxExtractedBytes: number;
  /** Entries (files, folders, links) in the archive. */
  maxFiles: number;
  /** Wall time for receiving and extracting. */
  maxMs: number;
}

const GIB = 1024 ** 3;
export const DEFAULT_BASELINE_LIMITS: BaselineLimits = {
  maxCompressedBytes: 4 * GIB,
  maxExtractedBytes: 8 * GIB,
  maxFiles: 200_000,
  maxMs: 30 * 60_000,
};

export type BaselineFormat = "tar" | "tar.zst";

const BLOCK = 512;
const MAX_PAX_BYTES = 1024 * 1024;

const tooLarge = (what: string, limit: number, unit: string) =>
  new SyncCoreError("baseline_too_large", `the baseline has more than ${limit.toLocaleString("en-US")} ${unit} (${what} limit)`, { limit: what });

const unsupported = (message: string) => new SyncCoreError("baseline_unsupported_entry", message);

/** Entry types of a tar header the baseline accepts (the rest of GNU tar's types are refused). */
const DATA_TYPES = new Set(["0", "\0", "7"]);
const LINK_OR_DIR_TYPES = new Set(["1", "2", "3", "4", "5", "6"]);
const META_TYPES = new Set(["x", "X", "g", "L", "K"]);

/** The header's checksum: unsigned sum of its bytes with the checksum field read as spaces (signed sum accepted as well, like GNU tar). */
function checksumMatches(h: Buffer): boolean {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i]!;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  const field = h.toString("latin1", 148, 156).replace(/\0.*$/s, "").trim();
  if (!/^[0-7]{1,11}$/.test(field)) return false;
  const stored = parseInt(field, 8);
  return stored === unsigned || stored === signed;
}

function parseNumeric(field: Buffer): number {
  if ((field[0]! & 0x80) !== 0) {
    // base-256 (GNU/star) for sizes that do not fit the octal field
    let n = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return n;
  }
  const s = field.toString("latin1").replace(/\0.*$/s, "").trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new SyncCoreError("invalid_argument", "not a tar archive");
  return parseInt(s, 8);
}

/** Pass-through transform that reads tar headers and enforces the extracted-size and entry limits (exported for tests). */
export class TarScanner extends Transform {
  private readonly hdr = Buffer.alloc(BLOCK);
  private hdrLen = 0;
  /** Data and padding bytes of the current entry still to pass. */
  private skip = 0;
  private collectLeft = 0;
  private collected: Buffer[] = [];
  private collecting = false;
  private nextSize: number | null = null;
  private files = 0;
  private bytes = 0;
  /** Bytes that passed through (the decompressed archive size). */
  total = 0;

  constructor(private readonly limits: BaselineLimits) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.total += chunk.length;
    try {
      let off = 0;
      while (off < chunk.length) {
        if (this.skip > 0) {
          const n = Math.min(this.skip, chunk.length - off);
          if (this.collecting && this.collectLeft > 0) {
            const c = Math.min(n, this.collectLeft);
            this.collected.push(Buffer.from(chunk.subarray(off, off + c)));
            this.collectLeft -= c;
          }
          this.skip -= n;
          off += n;
          if (this.skip === 0 && this.collecting) this.finishPax();
          continue;
        }
        const n = Math.min(BLOCK - this.hdrLen, chunk.length - off);
        chunk.copy(this.hdr, this.hdrLen, off, off + n);
        this.hdrLen += n;
        off += n;
        if (this.hdrLen === BLOCK) {
          this.hdrLen = 0;
          this.header();
        }
      }
    } catch (err) {
      return cb(err as Error);
    }
    cb(null, chunk);
  }

  private header(): void {
    const h = this.hdr;
    if (h.every((b) => b === 0)) return;
    if (!checksumMatches(h)) throw unsupported("the baseline has a damaged tar header (wrong checksum)");
    const type = String.fromCharCode(h[156]!);
    const meta = META_TYPES.has(type);
    if (!meta && !DATA_TYPES.has(type) && !LINK_OR_DIR_TYPES.has(type)) {
      throw unsupported(`the baseline has a tar entry of a type that is not accepted (${type === "\0" ? "NUL" : JSON.stringify(type)}; sparse, multi-volume and unknown types are refused)`);
    }
    let size = parseNumeric(h.subarray(124, 136));
    if (meta) {
      if (size > MAX_PAX_BYTES) throw new SyncCoreError("invalid_argument", "tar metadata header too large");
      // `x` (and Solaris `X`) records apply to the next entry; `g` records and GNU long names carry no size.
      this.collecting = type === "x" || type === "X";
      this.collectLeft = this.collecting ? size : 0;
      this.collected = [];
      this.skip = Math.ceil(size / BLOCK) * BLOCK;
      if (this.skip === 0 && this.collecting) this.finishPax();
      return;
    }
    if (this.nextSize !== null) size = this.nextSize;
    this.nextSize = null;
    const regular = DATA_TYPES.has(type);
    this.files += 1;
    if (this.files > this.limits.maxFiles) throw tooLarge("file count", this.limits.maxFiles, "files");
    if (regular) {
      this.bytes += size;
      if (this.bytes > this.limits.maxExtractedBytes) throw tooLarge("extracted size", this.limits.maxExtractedBytes, "bytes when extracted");
    }
    // Links and folders carry no data blocks.
    this.skip = LINK_OR_DIR_TYPES.has(type) ? 0 : Math.ceil(size / BLOCK) * BLOCK;
  }

  /**
   * Pax records ("<len> key=value\n"): a `size` overrides the next header's, the last one wins (as in tar). Sparse
   * records are refused: tar would then read the entry as a sparse file whose data layout the scanner does not follow.
   */
  private finishPax(): void {
    this.collecting = false;
    const text = Buffer.concat(this.collected).toString("utf8");
    this.collected = [];
    if (/\d+ GNU\.sparse\./.test(text) || /\d+ SCHILY\.realsize=/.test(text)) throw unsupported("the baseline has a sparse file entry, which is not accepted");
    for (const m of text.matchAll(/\d+ size=(\d+)\n/g)) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) this.nextSize = v;
    }
  }
}

/**
 * Allocated bytes under `dir` (du-style: the blocks the files occupy, directories included; symlinks are not followed).
 * Stops counting as soon as the total passes `stopAbove`.
 */
export async function allocatedBytes(dir: string, stopAbove = Infinity): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= stopAbove) {
    const d = stack.pop()!;
    try {
      total += (await lstat(d)).blocks * 512;
      for await (const e of await opendir(d)) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else {
          try {
            total += (await lstat(p)).blocks * 512;
          } catch {
            /* removed while counting */
          }
          if (total > stopAbove) break;
        }
      }
    } catch {
      /* a directory that is not there (yet) or vanished */
    }
  }
  return total;
}

/** How often the scratch directory's real size is measured while tar writes. */
export const SCRATCH_POLL_MS = 1000;

/**
 * Extracts `source` into `dir` (must exist). Throws SyncCoreError `baseline_too_large` / `baseline_timeout` when a
 * limit is hit (the child processes are killed first), `baseline_unsupported_entry` for an entry type or header the
 * scanner does not accept, `invalid_argument` for an archive tar rejects, `tool` when tar or zstd cannot run. The source stream is stopped but not destroyed (the caller still has a response to send).
 */
export async function extractArchive(
  source: Exclude<BaselineSource, string>,
  dir: string,
  format: BaselineFormat,
  limits: BaselineLimits,
  opts: { pollMs?: number; /** Replaces the real disk measurement (tests). */ measure?: typeof allocatedBytes } = {},
): Promise<void> {
  const input: NodeJS.ReadableStream =
    source instanceof Uint8Array ? Readable.from([Buffer.from(source.buffer, source.byteOffset, source.byteLength)]) : (source as NodeJS.ReadableStream);
  const children: ChildProcess[] = [];
  let failure: Error | null = null;
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > limits.maxCompressedBytes) return cb(tooLarge("upload size", limits.maxCompressedBytes, "bytes"));
      cb(null, chunk);
    },
  });
  const scanner = new TarScanner(limits);
  const timer = setTimeout(() => fail(new SyncCoreError("baseline_timeout", `the baseline took longer than ${Math.round(limits.maxMs / 1000)} s to receive and extract`)), limits.maxMs);
  // The scratch directory's real size, measured while tar writes: the scanner's sizes are what the headers declare, this is
  // what is on disk. Room for the directories and the blocks small files round up to.
  const diskLimit = limits.maxExtractedBytes + 4096 * (limits.maxFiles + 1);
  let measuring = false;
  const watch = setInterval(() => {
    if (measuring || failure) return;
    measuring = true;
    (opts.measure ?? allocatedBytes)(dir, diskLimit)
      .then((n) => {
        if (n > diskLimit) fail(tooLarge("extracted size", limits.maxExtractedBytes, "bytes when extracted"));
      })
      .finally(() => (measuring = false));
  }, opts.pollMs ?? SCRATCH_POLL_MS);
  const fail = (err: Error): void => {
    if (failure) return;
    failure = err;
    clearTimeout(timer);
    clearInterval(watch);
    input.unpipe(counter);
    input.pause();
    counter.destroy();
    scanner.destroy();
    for (const c of children) c.kill("SIGKILL");
  };
  counter.on("error", fail);
  scanner.on("error", fail);
  input.on("error", (e: Error) => fail(new SyncCoreError("tool", `reading baseline stream failed: ${e.message}`)));

  const run = (cmd: string, args: string[], stdout: "pipe" | "ignore") => {
    const child = spawn(cmd, args, { stdio: ["pipe", stdout, "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-2000)));
    child.stdin!.on("error", () => {
      /* the process exited early; its exit code reports why */
    });
    const done = new Promise<number>((resolve) => {
      child.on("error", (e) => {
        fail(new SyncCoreError("tool", `could not run ${cmd}: ${e.message}`));
        resolve(-1);
      });
      child.on("close", (code) => resolve(code ?? -1));
    });
    return { child, done, stderr: () => stderr.trim() };
  };

  const tar = run("tar", ["-x", "--no-same-owner", "-f", "-", "-C", dir], "ignore");
  const zstd = format === "tar.zst" ? run("zstd", ["-d", "-c", "-q"], "pipe") : null;
  input.pipe(counter);
  if (zstd) {
    counter.pipe(zstd.child.stdin!);
    zstd.child.stdout!.pipe(scanner);
  } else {
    counter.pipe(scanner);
  }
  scanner.pipe(tar.child.stdin!);

  try {
    const [tarCode, zstdCode] = await Promise.all([tar.done, zstd ? zstd.done : Promise.resolve(0)]);
    if (failure) throw failure;
    // The last measurement: what is on disk now, even if extraction was quicker than the polling interval.
    if (((await (opts.measure ?? allocatedBytes)(dir, diskLimit))) > diskLimit) throw tooLarge("extracted size", limits.maxExtractedBytes, "bytes when extracted");
    // `tar -c --zstd -f -` pads its output with zero bytes after the zstd frame, which zstd reports after it has decoded
    // everything: fine when tar read a complete archive from the decoded data.
    const paddedFrame = tarCode === 0 && scanner.total > 0 && /unsupported format/.test(zstd?.stderr() ?? "");
    if (zstdCode !== 0 && !paddedFrame) throw new SyncCoreError("invalid_argument", `not a valid zstd stream: ${zstd!.stderr().slice(0, 300)}`);
    if (tarCode !== 0) throw new SyncCoreError("invalid_argument", `tar could not read the archive (exit ${tarCode}): ${tar.stderr().slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
    for (const c of children) c.kill("SIGKILL");
  }
}
