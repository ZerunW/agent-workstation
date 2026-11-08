/**
 * Large files (> the project's large-file threshold, MAX_SYNC_FILE_BYTES by default).
 *
 * git never sees their content. Wherever sync-core builds a tree from files, a large file becomes a small pointer blob
 * (LARGE_FILE_POINTER_HEADER, then `sha256 <hex>` and `size <n>` lines) and its bytes go into a per-project,
 * content-addressed store outside the work tree: `<store>/objects/<sha256[0:2]>/<sha256>`, written tmp + rename and
 * read-only afterwards (one copy per distinct version, never deleted automatically). Wherever sync-core writes a ref's
 * content into the work tree, a pointer is resolved from the store (streamed). Nothing here ever holds a large file in
 * memory: hashing and copying are streamed.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream, type Stats } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { LARGE_FILE_POINTER_HEADER } from "@agent-workstation/protocol";
import { SyncCoreError } from "./errors.js";

export interface LargePointer {
  /** Lowercase hex sha256 of the real content. */
  sha256: string;
  /** Real size in bytes. */
  size: number;
}

/** Pointer blobs are tiny; anything bigger is never parsed as one. */
export const POINTER_MAX_BYTES = 256;

const SHA_RE = /^[0-9a-f]{64}$/;
const POINTER_RE = new RegExp(`^${LARGE_FILE_POINTER_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nsha256 ([0-9a-f]{64})\\nsize (0|[1-9][0-9]{0,15})\\n$`);

/** The exact pointer bytes git stores for a large file. */
export function pointerText(p: LargePointer): Buffer {
  return Buffer.from(`${LARGE_FILE_POINTER_HEADER}\nsha256 ${p.sha256}\nsize ${p.size}\n`, "utf8");
}

/** A pointer blob's fields, or null when `buf` is not exactly a pointer. */
export function parsePointer(buf: Uint8Array): LargePointer | null {
  if (buf.byteLength > POINTER_MAX_BYTES) return null;
  const m = POINTER_RE.exec(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("latin1"));
  return m ? { sha256: m[1]!, size: Number(m[2]) } : null;
}

/** Streaming sha256 + byte count of a file. */
export async function hashFileStream(abs: string): Promise<LargePointer> {
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(abs)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: h.digest("hex"), size };
}

export class LargeStore {
  readonly objectsDir: string;
  readonly tmpDir: string;

  constructor(readonly dir: string) {
    this.objectsDir = path.join(dir, "objects");
    this.tmpDir = path.join(dir, "tmp");
  }

  /** Leftovers of interrupted copies (call with the project lock held). */
  async init(): Promise<void> {
    await rm(this.tmpDir, { recursive: true, force: true });
  }

  objectPath(sha256: string): string {
    if (!SHA_RE.test(sha256)) throw new SyncCoreError("invalid_argument", `invalid sha256: ${sha256}`);
    return path.join(this.objectsDir, sha256.slice(0, 2), sha256);
  }

  /** Size of the stored object, null when absent. */
  async storedSize(sha256: string): Promise<number | null> {
    try {
      const st = await stat(this.objectPath(sha256));
      return st.isFile() ? st.size : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
      throw e;
    }
  }

  async has(p: LargePointer): Promise<boolean> {
    return (await this.storedSize(p.sha256)) === p.size;
  }

  /** Throws `large_missing` unless the store holds this version. */
  async require(p: LargePointer, what: string): Promise<string> {
    if (!(await this.has(p))) {
      throw new SyncCoreError("large_missing", `the large-file store has no copy of ${what} (sha256 ${p.sha256}, ${p.size} bytes)`, { sha256: p.sha256, size: p.size });
    }
    return this.objectPath(p.sha256);
  }

  private async tmpFile(): Promise<string> {
    await mkdir(this.tmpDir, { recursive: true });
    return path.join(this.tmpDir, `${Date.now()}-${randomBytes(6).toString("hex")}`);
  }

  /** Move a finished temp file into place (read-only); an existing copy wins and the temp file is dropped. */
  private async install(tmp: string, p: LargePointer): Promise<void> {
    const dest = this.objectPath(p.sha256);
    if (await this.has(p)) {
      await rm(tmp, { force: true });
      return;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await chmod(tmp, 0o444);
    await rename(tmp, dest);
  }

  /** Copy a file into the store (streamed, hashed while copying). Returns what was actually stored. */
  async addFile(abs: string): Promise<LargePointer> {
    const tmp = await this.tmpFile();
    try {
      const h = createHash("sha256");
      let size = 0;
      await pipeline(
        createReadStream(abs),
        async function* (src: AsyncIterable<Buffer>) {
          for await (const c of src) {
            h.update(c);
            size += c.length;
            yield c;
          }
        },
        createWriteStream(tmp, { mode: 0o600 }),
      );
      const p = { sha256: h.digest("hex"), size };
      await this.install(tmp, p);
      return p;
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /**
   * Take ownership of a finished upload (same file system: renamed, never copied). Its sha256 is checked (streamed);
   * a mismatch throws `invalid_argument` and leaves the file where it is.
   */
  async adopt(file: string, expected: LargePointer): Promise<void> {
    const got = await hashFileStream(file);
    if (got.sha256 !== expected.sha256 || got.size !== expected.size) {
      throw new SyncCoreError("invalid_argument", `content does not match sha256 ${expected.sha256} / ${expected.size} bytes`, { hashMismatch: true, sha256: got.sha256, size: got.size });
    }
    const tmp = await this.tmpFile();
    await rename(file, tmp);
    try {
      await this.install(tmp, got);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /** Write a stored version to `dest` (streamed; temp file in the target directory + rename, then `mode`). */
  async copyOut(p: LargePointer, dest: string, mode: number, what: string): Promise<void> {
    const src = await this.require(p, what);
    const dir = path.dirname(dest);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(dest)}.workstation-${randomBytes(4).toString("hex")}.tmp`);
    try {
      await pipeline(createReadStream(src), createWriteStream(tmp, { mode }));
      await chmod(tmp, mode);
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /** A read stream of a stored version (optionally a byte range, inclusive `end`). */
  async open(p: LargePointer, what: string, range?: { start: number; end: number }): Promise<ReadStream> {
    const src = await this.require(p, what);
    return createReadStream(src, range ? { start: range.start, end: range.end } : {});
  }
}

// ---------------------------------------------------------------------------
// Hash cache for large work-tree files (stat → sha256), so an unchanged large file is hashed once.
// ---------------------------------------------------------------------------

type CacheRow = [size: number, mtimeMs: number, ctimeMs: number, ino: number, sha256: string];

export class LargeHashCache {
  private rows = new Map<string, CacheRow>();
  private loaded = false;
  private dirty = false;

  constructor(private readonly file: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as Record<string, CacheRow>;
      for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && v.length === 5 && typeof v[4] === "string") this.rows.set(k, v);
    } catch {
      /* missing or unreadable: start empty */
    }
  }

  async get(rel: string, st: Stats): Promise<LargePointer | null> {
    await this.load();
    const r = this.rows.get(rel);
    if (!r || r[0] !== st.size || r[1] !== st.mtimeMs || r[2] !== st.ctimeMs || r[3] !== st.ino) return null;
    return { sha256: r[4], size: r[0] };
  }

  async set(rel: string, st: Stats, sha256: string): Promise<void> {
    await this.load();
    this.rows.set(rel, [st.size, st.mtimeMs, st.ctimeMs, st.ino, sha256]);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.rows)));
    await rename(tmp, this.file);
  }
}
