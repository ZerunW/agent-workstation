import { UPLOAD_CHUNK_BYTES } from "@agent-workstation/protocol";
import { api, ApiError, type UploadChunkResult } from "./api";
import { uuid } from "./format";

export interface ChunkPlan {
  index: number;
  start: number;
  end: number; // exclusive
}

/** Split `size` bytes into <= chunkBytes ranges. An empty file still produces one (empty) chunk. */
export function planChunks(size: number, chunkBytes: number = UPLOAD_CHUNK_BYTES): ChunkPlan[] {
  if (size <= 0) return [{ index: 0, start: 0, end: 0 }];
  const out: ChunkPlan[] = [];
  for (let start = 0, i = 0; start < size; start += chunkBytes, i++) out.push({ index: i, start, end: Math.min(size, start + chunkBytes) });
  return out;
}

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
  chunksDone: number;
  chunksTotal: number;
}

export interface UploadOptions {
  /** Destination path relative to the workspace root, e.g. "inbox/report.pdf". */
  path: string;
  onProgress?: (p: UploadProgress) => void;
  chunkBytes?: number;
  /** Retries per chunk (default 3, exponential backoff 400ms * 2^n). */
  retries?: number;
  signal?: AbortSignal;
  /** Reuse an uploadId to resume a failed upload. */
  uploadId?: string;
  sendChunk?: typeof api.uploadChunk;
  /** Ask the hub which chunks it already has (used when resuming a known uploadId). */
  getStatus?: typeof api.uploadStatus;
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadResult {
  path: string;
  uploadId: string;
}

const resumable = new Map<string, string>(); // `${path}|${size}|${lastModified}` -> uploadId

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retriable(e: unknown): boolean {
  // 507 (disk full) and 4xx are final; only transient transport/gateway failures are worth another try.
  if (e instanceof ApiError) return e.status === 0 || e.status === 408 || e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504;
  return (e as Error)?.name !== "AbortError";
}

/**
 * Chunked upload (PUT /api/files/upload, headers per UPLOAD_HEADERS). Failed chunks are retried with
 * backoff; chunks the server already reports as received (resume) are skipped.
 */
export async function uploadFile(file: Blob & { name?: string; lastModified?: number }, opts: UploadOptions): Promise<UploadResult> {
  const chunkBytes = opts.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  const plan = planChunks(file.size, chunkBytes);
  const resumeKey = `${opts.path}|${file.size}|${file.lastModified ?? 0}`;
  const known = opts.uploadId ?? resumable.get(resumeKey);
  const uploadId = known ?? uuid();
  resumable.set(resumeKey, uploadId);
  const send = opts.sendChunk ?? api.uploadChunk;
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 3;
  const received = new Set<number>();
  let sentBytes = 0;
  let finalPath = opts.path;
  let complete = false;

  const report = () => opts.onProgress?.({ sentBytes, totalBytes: file.size, chunksDone: received.size, chunksTotal: plan.length });
  // Resuming a previous attempt: skip chunks the hub already stored.
  if (known) {
    try {
      const status = await (opts.getStatus ?? api.uploadStatus)(uploadId);
      for (const i of status.received ?? []) if (i < plan.length) received.add(i);
    } catch {
      /* unknown upload id or old hub: just send everything */
    }
  }
  sentBytes = plan.reduce((n, p) => (received.has(p.index) ? n + (p.end - p.start) : n), 0);
  report();

  for (const chunk of plan) {
    if (received.has(chunk.index)) continue;
    let attempt = 0;
    for (;;) {
      if (opts.signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
      try {
        const res: UploadChunkResult = await send({
          uploadId,
          path: opts.path,
          index: chunk.index,
          total: plan.length,
          totalBytes: file.size,
          body: file.slice(chunk.start, chunk.end),
          signal: opts.signal,
        });
        for (const i of res.received ?? []) received.add(i);
        received.add(chunk.index);
        if (res.path) finalPath = res.path;
        if (res.complete) complete = true;
        break;
      } catch (e) {
        if (attempt >= retries || !retriable(e)) throw e;
        await sleep(400 * 2 ** attempt);
        attempt++;
      }
    }
    sentBytes = 0;
    for (const p of plan) if (received.has(p.index)) sentBytes += p.end - p.start;
    report();
    if (complete && received.size >= plan.length) break;
  }
  resumable.delete(resumeKey);
  return { path: finalPath, uploadId };
}
