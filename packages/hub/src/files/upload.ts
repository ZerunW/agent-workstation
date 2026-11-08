/**
 * Resumable chunked uploads (PUT /api/files/upload, headers in UPLOAD_HEADERS).
 *
 * Chunks land in <data_dir>/uploads/<user>/<uploadId>/<index>.part (each
 * written to a temp name and renamed). The `uploads` row tracks which chunks
 * arrived, so a client can resume by re-sending what is missing. When the
 * last chunk arrives the parts are concatenated into a temp file next to the
 * target and hard-linked into place (no-clobber: an existing file is never
 * overwritten — the upload gets "name (1).ext" instead), then the temp parts
 * (hub-owned scratch data) are removed.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { UPLOAD_CHUNK_BYTES, UPLOAD_HEADERS } from "@agent-workstation/protocol";
import type { Store, UploadRow } from "../db/store.js";
import { badRequest, HttpError } from "../util/errors.js";
import type { Logger } from "../util/log.js";
import { normalizeRelPath, numberedName, resolveInRoot } from "./paths.js";

export interface UploadChunkResult {
  uploadId: string;
  received: number[];
  complete: boolean;
  path?: string;
}

export interface UploadHeaders {
  uploadId: string;
  path: string;
  chunkIndex: number;
  chunkTotal: number;
  totalBytes: number;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Free space kept in reserve beyond the upload itself. */
const RESERVE_BYTES = 256 * 1024 * 1024;

function header(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function intHeader(h: Record<string, string | string[] | undefined>, name: string, min: number): number {
  const raw = header(h, name);
  if (raw === undefined || !/^\d+$/.test(raw.trim())) throw badRequest("invalid_request", `missing or invalid ${name}`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min) throw badRequest("invalid_request", `invalid ${name}`);
  return n;
}

export function parseUploadHeaders(h: Record<string, string | string[] | undefined>): UploadHeaders {
  const uploadId = header(h, UPLOAD_HEADERS.uploadId)?.trim() ?? "";
  if (!ID_RE.test(uploadId)) throw badRequest("invalid_request", `${UPLOAD_HEADERS.uploadId} must match [A-Za-z0-9_-]{8,64}`);
  const rawPath = header(h, UPLOAD_HEADERS.path);
  if (!rawPath) throw badRequest("invalid_request", `missing ${UPLOAD_HEADERS.path}`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw badRequest("invalid_request", `${UPLOAD_HEADERS.path} is not valid percent-encoding`);
  }
  const path = normalizeRelPath(decoded);
  const chunkIndex = intHeader(h, UPLOAD_HEADERS.chunkIndex, 0);
  const chunkTotal = intHeader(h, UPLOAD_HEADERS.chunkTotal, 1);
  const totalBytes = intHeader(h, UPLOAD_HEADERS.totalBytes, 0);
  if (chunkIndex >= chunkTotal) throw badRequest("invalid_request", "chunk index out of range");
  const expectedChunks = Math.max(1, Math.ceil(totalBytes / UPLOAD_CHUNK_BYTES));
  if (chunkTotal !== expectedChunks) throw badRequest("invalid_request", `chunk total must be ${expectedChunks} for ${totalBytes} bytes`);
  return { uploadId, path, chunkIndex, chunkTotal, totalBytes };
}

export function expectedChunkSize(h: Pick<UploadHeaders, "chunkIndex" | "chunkTotal" | "totalBytes">): number {
  return h.chunkIndex < h.chunkTotal - 1 ? UPLOAD_CHUNK_BYTES : h.totalBytes - (h.chunkTotal - 1) * UPLOAD_CHUNK_BYTES;
}

export interface UploadServiceDeps {
  store: Store;
  dataDir: string;
  userRoot: (user: string) => string;
  log: Logger;
  /** Free bytes on the users_root filesystem (null = unknown). */
  freeBytes?: () => number | null;
}

export class UploadService {
  private readonly assembling = new Map<string, Promise<string>>();

  constructor(private readonly deps: UploadServiceDeps) {}

  private partsDir(user: string, id: string): string {
    return join(this.deps.dataDir, "uploads", user, id);
  }

  status(user: string, uploadId: string): UploadChunkResult {
    const row = this.deps.store.getUpload(user, uploadId);
    if (!row) return { uploadId, received: [], complete: false };
    return this.result(row);
  }

  private result(row: UploadRow): UploadChunkResult {
    return { uploadId: row.id, received: row.received, complete: !!row.finalPath, ...(row.finalPath ? { path: row.finalPath } : {}) };
  }

  async putChunk(user: string, h: UploadHeaders, body: Buffer): Promise<UploadChunkResult> {
    const want = expectedChunkSize(h);
    if (body.length !== want) throw badRequest("invalid_request", `chunk ${h.chunkIndex} must be ${want} bytes, got ${body.length}`);

    let row = this.deps.store.getUpload(user, h.uploadId);
    if (row) {
      if (row.path !== h.path || row.chunkTotal !== h.chunkTotal || row.totalBytes !== h.totalBytes) {
        throw new HttpError(409, "upload_mismatch", "uploadId was started with a different path or size");
      }
      if (row.finalPath) return this.result(row);
    } else {
      // Validate the destination before accepting any bytes.
      await resolveInRoot(this.deps.userRoot(user), h.path);
      const free = this.deps.freeBytes?.() ?? null;
      if (free !== null && h.totalBytes + RESERVE_BYTES > free) throw new HttpError(507, "disk_block", "not enough free disk space for this upload");
      row = this.deps.store.createUpload({ id: h.uploadId, user, path: h.path, chunkTotal: h.chunkTotal, totalBytes: h.totalBytes });
    }

    const dir = this.partsDir(user, h.uploadId);
    await mkdir(dir, { recursive: true });
    const part = join(dir, `${h.chunkIndex}.part`);
    const tmp = `${part}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, part);

    // Read-modify-write happens synchronously (better-sqlite3), so concurrent chunks cannot lose updates.
    row = this.deps.store.getUpload(user, h.uploadId)!;
    if (!row.received.includes(h.chunkIndex)) {
      const received = [...row.received, h.chunkIndex].sort((a, b) => a - b);
      this.deps.store.setUploadReceived(user, h.uploadId, received);
      row = { ...row, received };
    }
    if (row.received.length < row.chunkTotal || row.finalPath) return this.result(row);

    const key = `${user}/${h.uploadId}`;
    let job = this.assembling.get(key);
    if (!job) {
      job = this.assemble(user, row).finally(() => this.assembling.delete(key));
      this.assembling.set(key, job);
    }
    const finalPath = await job;
    return { uploadId: h.uploadId, received: row.received, complete: true, path: finalPath };
  }

  private async assemble(user: string, row: UploadRow): Promise<string> {
    const root = this.deps.userRoot(user);
    const target = await resolveInRoot(root, row.path);
    await mkdir(dirname(target.abs), { recursive: true });
    // Re-check after mkdir (a parent could have been swapped for a symlink).
    await resolveInRoot(root, row.path);
    const dir = this.partsDir(user, row.id);
    const tmp = join(dirname(target.abs), `.${basename(target.abs)}.workstation-upload-${row.id}`);
    const out = createWriteStream(tmp, { flags: "w" });
    try {
      for (let i = 0; i < row.chunkTotal; i++) {
        await pipeline(createReadStream(join(dir, `${i}.part`)), out, { end: false });
      }
      await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
      const fh = await open(tmp, "r+");
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      const size = (await stat(tmp)).size;
      if (size !== row.totalBytes) throw new HttpError(400, "upload_incomplete", `assembled ${size} bytes, expected ${row.totalBytes}`);

      let rel = target.rel;
      for (let n = 1; ; n++) {
        const dest = await resolveInRoot(root, rel);
        try {
          await link(tmp, dest.abs); // fails with EEXIST instead of overwriting
          rel = dest.rel;
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 999) throw err;
          rel = numberedName(target.rel, n);
        }
      }
      await unlink(tmp).catch(() => {});
      this.deps.store.completeUpload(user, row.id, rel);
      await rm(dir, { recursive: true, force: true });
      this.deps.log.info({ user, path: rel, bytes: row.totalBytes }, "upload complete");
      return rel;
    } catch (err) {
      out.destroy();
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}
