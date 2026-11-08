/**
 * Large-file uploads of synced projects (> MAX_SYNC_FILE_BYTES; protocol LargeFileUploadResponse).
 *
 * Large files sync like any other file (review, accept/reject, snapshots, History, restore): sync-core keeps a pointer
 * in the review git and the content in the project's content-addressed large-file store (`<user root>/.sync/<name>.large/
 * objects/…`, see @agent-workstation/sync-core large.ts). This module is only the upload half: the Mac sends each version whole,
 * in ordered resumable chunks (PUT /api/projects/:id/large), streamed to a partial file in `<name>.large/uploads/`
 * (never inside the work tree, never buffered in memory). When the last byte arrives, sync-core checks the sha256
 * (mismatch → 422, the partial is dropped), moves the bytes into the store and applies a normal sync write of the
 * pointer (`local` + the work tree, same baseHash / merge / conflict / force rules as small writes). A version the
 * store already holds completes at the first request without any bytes. The pointer in `local` is the only record.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { LARGE_FILE_CHUNK_BYTES, MAX_SYNC_FILE_BYTES, type LargeFileUploadResponse } from "@agent-workstation/protocol";
import { assertRelPath, isSyncCoreError, lstatOrNull, resolveInside, withLock, type ProjectRepo } from "@agent-workstation/sync-core";
import type { ProjectRow } from "../db/store.js";
import { badRequest, errorMessage, HttpError } from "../util/errors.js";
import type { Logger } from "../util/log.js";

export interface LargeFilesDeps {
  log: Logger;
  paths: (row: ProjectRow) => { workTree: string; largeDir: string };
  repo: (row: ProjectRow) => Promise<ProjectRepo>;
  /** Files larger than this are large files (default MAX_SYNC_FILE_BYTES; tests lower it — sync-core gets the same). */
  minBytes?: number;
  /** Largest chunk accepted (default LARGE_FILE_CHUNK_BYTES). */
  chunkBytes?: number;
}

export interface LargeUploadQuery {
  path: string;
  sha256: string;
  size: number;
  mode: number;
  offset: number;
  /** Real sha256 of the version the Mac last saw (null for a new file). */
  baseHash: string | null;
  force: boolean;
}

/** A chunk whose offset does not match what the hub holds (409 with the progress as the body). */
export class LargeOffsetMismatch extends Error {
  constructor(readonly progress: LargeFileUploadResponse) {
    super(`the hub holds ${progress.received} bytes of ${progress.path}; resume from there`);
  }
}

interface PartialMeta {
  path: string;
  sha256: string;
  size: number;
}

const isSymlinkMode = (mode: number): boolean => (mode & 0o170000) === 0o120000;

export class LargeFiles {
  readonly minBytes: number;
  readonly chunkBytes: number;

  constructor(private readonly deps: LargeFilesDeps) {
    this.minBytes = deps.minBytes ?? MAX_SYNC_FILE_BYTES;
    this.chunkBytes = deps.chunkBytes ?? LARGE_FILE_CHUNK_BYTES;
  }

  isLarge(size: number): boolean {
    return size > this.minBytes;
  }

  /** Partial uploads live next to the store (same file system: completing one is a rename, never a copy). */
  private partFiles(row: ProjectRow, path: string): { dir: string; part: string; meta: string } {
    const dir = join(this.deps.paths(row).largeDir, "uploads");
    const key = createHash("sha256").update(path).digest("hex");
    return { dir, part: join(dir, `${key}.part`), meta: join(dir, `${key}.json`) };
  }

  private async readMeta(file: string): Promise<PartialMeta | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as PartialMeta;
    } catch {
      return null;
    }
  }

  private sameUpload(meta: PartialMeta | null, q: { path: string; sha256: string; size: number }): boolean {
    return !!meta && meta.path === q.path && meta.sha256 === q.sha256 && meta.size === q.size;
  }

  /** Bytes held for this exact upload (path + sha256 + size), 0 when none. */
  private async held(row: ProjectRow, q: { path: string; sha256: string; size: number }): Promise<number> {
    const f = this.partFiles(row, q.path);
    if (!this.sameUpload(await this.readMeta(f.meta), q)) return 0;
    return (await lstatOrNull(f.part))?.size ?? 0;
  }

  /** The work-tree target: inside the project, no symlink on the way or at the end, not a directory. */
  private async target(row: ProjectRow, path: string): Promise<void> {
    const abs = await resolveInside(this.deps.paths(row).workTree, assertRelPath(path));
    const st = await lstatOrNull(abs);
    if (st?.isSymbolicLink()) throw new HttpError(422, "symlink", `${path} is a symlink on the server; symlinks are not synced`);
    if (st && !st.isFile()) throw new HttpError(409, "invalid_path", `a directory exists at ${path} on the server`);
  }

  private checkQuery(q: { path: string; sha256: string; size: number }): void {
    assertRelPath(q.path);
    if (!this.isLarge(q.size)) throw badRequest("invalid_request", `files up to ${this.minBytes} bytes sync through PUT /api/projects/:id/files`);
  }

  /** GET: how much of this upload the hub holds (complete when `local` already has this exact version). */
  async progress(row: ProjectRow, q: { path: string; sha256: string; size: number }): Promise<LargeFileUploadResponse> {
    this.checkQuery(q);
    const repo = await this.deps.repo(row);
    const local = await repo.localLargeFile(q.path);
    if (local && local.sha256 === q.sha256 && local.size === q.size && (await repo.largeStore.has(local))) {
      return { path: q.path, received: q.size, complete: true, localCommit: await repo.localCommit() };
    }
    return { path: q.path, received: await this.held(row, q), complete: false };
  }

  /**
   * PUT: appends one chunk (streamed to the partial file) at `offset`; on the last byte completes the sync write.
   * Throws LargeOffsetMismatch (409), HttpError 413 (chunk too big / past `size`), 422 hash_mismatch.
   */
  async putChunk(row: ProjectRow, q: LargeUploadQuery, body: Readable): Promise<LargeFileUploadResponse> {
    this.checkQuery(q);
    if (isSymlinkMode(q.mode)) throw new HttpError(422, "symlink", "symlinks are not synced");
    await this.target(row, q.path); // refuse early, before any bytes are kept
    return withLock(`large:${row.id}:${q.path}`, async () => {
      const f = this.partFiles(row, q.path);
      const repo = await this.deps.repo(row);
      const meta = await this.readMeta(f.meta);

      // The store already holds this version (another path, an earlier conflict, a re-upload): no bytes needed.
      if (await repo.largeStore.has({ sha256: q.sha256, size: q.size })) {
        body.resume();
        if (this.sameUpload(meta, q)) await this.dropPartial(f);
        return this.complete(row, repo, q, null);
      }

      await mkdir(f.dir, { recursive: true });
      let received = 0;
      if (this.sameUpload(meta, q)) {
        received = (await lstatOrNull(f.part))?.size ?? 0;
      } else {
        // Another version of this file (or none) was in progress: start over.
        await rm(f.part, { force: true });
        await writeFile(f.meta, JSON.stringify({ path: q.path, sha256: q.sha256, size: q.size } satisfies PartialMeta));
      }
      if (q.offset !== received) {
        body.resume();
        throw new LargeOffsetMismatch({ path: q.path, received, complete: false });
      }
      const max = Math.min(this.chunkBytes, q.size - q.offset);
      let n = 0;
      let refused: HttpError | null = null;
      const sink = createWriteStream(f.part, { flags: "a" });
      try {
        try {
          // Streamed straight to disk; the request is never destroyed, so a refusal still gets its answer.
          for await (const chunk of body.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
            n += chunk.length;
            if (n > max) {
              refused = new HttpError(413, "too_large", n > q.size - q.offset ? "the chunk runs past the file's size" : `a chunk holds at most ${max} bytes`);
              body.resume(); // the rest is discarded
              break;
            }
            if (!sink.write(chunk)) await once(sink, "drain");
          }
        } finally {
          sink.end();
          await finished(sink);
        }
      } catch (err) {
        refused = new HttpError(400, "upload_incomplete", `the chunk did not arrive completely: ${errorMessage(err)}`);
      }
      if (refused) {
        // Only whole chunks count: a broken or refused chunk is cut off again.
        await truncate(f.part, q.offset).catch(() => undefined);
        throw refused;
      }
      received = q.offset + n;
      if (received < q.size) return { path: q.path, received, complete: false };
      return this.complete(row, repo, q, f);
    });
  }

  /** The sync write of the pointer (sync-core moves the partial into the store after checking its sha256). */
  private async complete(row: ProjectRow, repo: ProjectRepo, q: LargeUploadQuery, f: { part: string; meta: string } | null): Promise<LargeFileUploadResponse> {
    let r;
    try {
      r = await repo.applyLargeWrite({
        path: q.path,
        sha256: q.sha256,
        size: q.size,
        mode: q.mode,
        baseHash: q.baseHash,
        ...(q.force ? { force: true } : {}),
        ...(f ? { file: f.part } : {}),
      });
    } catch (err) {
      if (f && isSyncCoreError(err, "invalid_argument") && (err.details as { hashMismatch?: boolean } | undefined)?.hashMismatch) {
        await this.dropPartial(f);
        throw new HttpError(422, "hash_mismatch", `${q.path}: the uploaded bytes do not match the sha256; upload the file again`, { path: q.path, received: 0, complete: false });
      }
      throw err;
    }
    if (f) await this.dropPartial(f);
    const { status, reason } = r.result;
    // need_content only if the store lost the version between the check and the write: upload it again.
    if (status === "need_content") return { path: q.path, received: 0, complete: false };
    this.deps.log.info({ projectId: row.id, size: q.size, status }, "large file synced");
    return { path: q.path, received: q.size, complete: true, result: reason !== undefined ? { status, reason } : { status }, localCommit: r.localCommit };
  }

  private async dropPartial(f: { part: string; meta: string }): Promise<void> {
    await rm(f.part, { force: true });
    await rm(f.meta, { force: true });
  }

  /** The store and partial uploads of a project (removed with the project only). */
  async dropProjectData(row: ProjectRow): Promise<void> {
    await rm(this.deps.paths(row).largeDir, { recursive: true, force: true });
  }
}
