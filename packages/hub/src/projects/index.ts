/**
 * /api/projects/* routes (ROUTES.project* in @agent-workstation/protocol), mounted on
 * ProjectService + @agent-workstation/sync-core. SyncCoreError codes are mapped to HTTP
 * statuses by the app's error handler (projects/errors.ts).
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AcceptBody,
  BASELINE_ENCODING_HEADER,
  CreateProjectBody,
  DeleteProjectBody,
  DeleteProjectQuery,
  HistoryQuery,
  ManifestBody,
  ProjectExcludesBody,
  PathQuery,
  ProjectBackupBody,
  RawQuery,
  RejectBody,
  RestoreBody,
  SyncBody,
  type FileDiff,
} from "@agent-workstation/protocol";
import { isSyncCoreError, withLock, type ProjectRepo, type SyncResult } from "@agent-workstation/sync-core";
import { parse, requireUser } from "../auth.js";
import type { ProjectRow } from "../db/store.js";
import { contentDisposition } from "../files/download.js";
import { mediaTypeFor } from "../files/mime.js";
import type { Hub } from "../hub.js";
import { badRequest, errorMessage, HttpError, notFound } from "../util/errors.js";
import { isUuid } from "../util/ids.js";
import { blobAt, blobStream, createBackup, listBackups, MAX_BACKUP_BYTES } from "./backups.js";
import { diffIdOf } from "./diffId.js";
import { LargeOffsetMismatch } from "./largeFiles.js";
import { reviewPatch } from "./patch.js";

const Sha256Hex = z.string().regex(/^[0-9a-fA-F]{64}$/, "sha256 must be 64 hex digits").transform((s) => s.toLowerCase());
/** `path` is checked by sync-core's assertRelPath (relative, no `..` / `.git`) in LargeFiles. */
const LargeProgressQuery = z.object({ path: z.string().min(1).max(4096), sha256: Sha256Hex, size: z.coerce.number().int().nonnegative() });
const LargeUploadQuery = LargeProgressQuery.extend({
  mode: z.coerce.number().int().nonnegative().default(0o100644),
  offset: z.coerce.number().int().nonnegative(),
  /** Real sha256 of the version the Mac last saw; empty / absent for a new file. */
  baseHash: z
    .string()
    .optional()
    .transform((s) => (s ? s.toLowerCase() : null))
    .refine((s) => s === null || /^[0-9a-f]{64}$/.test(s), "baseHash must be 64 hex digits"),
  force: z
    .string()
    .optional()
    .transform((s) => s === "true" || s === "1"),
});

/** One satisfiable `bytes=` range (inclusive end), null = serve the whole file, "unsatisfiable" → 416. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null; // multiple or malformed ranges: ignored (RFC 9110 allows it)
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** Bytes [start, end] of a stream (for git blobs, which cannot seek). */
function sliceStream(src: Readable, start: number, end: number): Readable {
  let pos = 0;
  const out = new PassThrough();
  src.on("error", (err) => out.destroy(err));
  src.on("data", (chunk: Buffer) => {
    const from = Math.max(0, start - pos);
    const to = Math.min(chunk.length, end + 1 - pos);
    pos += chunk.length;
    if (to > from && !out.write(chunk.subarray(from, to))) {
      src.pause();
      out.once("drain", () => src.resume());
    }
    if (pos > end) {
      src.removeAllListeners("data");
      src.destroy();
      out.end();
    }
  });
  src.on("end", () => out.end());
  return out;
}

type SyncResultBody = { localCommit: string | null; results: SyncResult["results"] };
type AcceptLike = { path: string; hunks?: number[]; diffId?: string } | { all: true };

const idOf = (params: unknown): string => {
  const id = (params as { id?: unknown }).id;
  if (typeof id !== "string" || !isUuid(id)) throw notFound("no such project");
  return id;
};

/**
 * One unchecked path as a gitignore rule matching exactly that path: anchored to the project root (leading "/"),
 * folders with a trailing "/", glob characters escaped, a leading "#" or "!" escaped, trailing spaces kept.
 */
export function excludePattern(p: { path: string; kind: "folder" | "file" }): string {
  let rel = p.path.replace(/^\/+|\/+$/g, "").replace(/[\\*?[\]]/g, (c) => `\\${c}`);
  if (/^[#!]/.test(rel)) rel = `\\${rel}`;
  rel = rel.replace(/ +$/, (sp) => sp.replace(/ /g, "\\ "));
  return `/${rel}${p.kind === "folder" ? "/" : ""}`;
}

function diskGuard(hub: Hub): void {
  if (hub.disk.level === "block") throw new HttpError(507, "disk_block", "the server's disk is almost full; sync pushes are paused (you can still review, accept, download and delete)");
}

export function registerProjectRoutes(app: FastifyInstance, hub: Hub): void {
  const svc = hub.projects;
  const owned = (req: FastifyRequest): { user: string; row: ProjectRow } => {
    const u = requireUser(hub, req);
    return { user: u.name, row: svc.owned(u.name, idOf(req.params)) };
  };

  /** Hunk-level accept/reject: verify the client's diffId under the project lock, then run `fn`. */
  async function checkedHunks<T>(row: ProjectRow, repo: ProjectRepo, body: AcceptLike, fn: () => Promise<T>): Promise<T> {
    if (!("path" in body) || body.hunks === undefined) return fn();
    if (!body.diffId) throw badRequest("invalid_request", "diffId (from GET …/review/diff) is required when hunks are given");
    const path = body.path;
    const sent = body.diffId;
    return withLock(row.id, async () => {
      let current: string | null = null;
      try {
        current = diffIdOf(await repo.diffFile(path));
      } catch (err) {
        if (!isSyncCoreError(err, "not_found")) throw err;
      }
      if (current !== sent) throw new HttpError(409, "stale_diff", `${path} changed since its diff was fetched; refetch the diff and select the hunks again`, { diffId: current });
      try {
        return await fn();
      } catch (err) {
        if (isSyncCoreError(err, "stale")) throw new HttpError(409, "stale_diff", err.message, { diffId: current });
        throw err;
      }
    });
  }

  app.get("/api/projects", async (req) => {
    const u = requireUser(hub, req);
    return Promise.all(svc.list(u.name).map((row) => svc.toProtocol(row)));
  });

  app.post("/api/projects", async (req, reply) => {
    const u = requireUser(hub, req);
    const body = parse(CreateProjectBody, req.body ?? {}, "body");
    const row = await svc.create(u.name, body.name, body.origin?.trim() || null);
    return reply.code(201).send(await svc.toProtocol(row));
  });

  app.get("/api/projects/:id", async (req) => {
    const { row } = owned(req);
    return svc.toProtocol(row);
  });

  /** The only place that deletes a project — explicit user action, guarded by canDelete(). */
  app.delete("/api/projects/:id", async (req, reply) => {
    const { user, row } = owned(req);
    const q = parse(DeleteProjectQuery, req.query ?? {}, "query");
    const body = parse(DeleteProjectBody, req.body ?? {}, "body");
    const discard = body.discardRemaining || q.discardRemaining === "true" || q.discardRemaining === "1";
    await svc.assertDeletable(row, discard);
    // Live Claude processes working inside the project are closed first (history is kept);
    // remove() re-checks under the project lock.
    await hub.sessions.closeSessionsUnder(user, svc.paths(row).rel);
    await svc.remove(row, discard);
    return reply.code(204).send();
  });

  // Raw request bodies (tar streams, large-file chunks) for the baseline and large-file routes only.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, _payload, done) => done(null));
    scope.post("/api/projects/:id/baseline", async (req, reply) => {
      const { row } = owned(req);
      diskGuard(hub);
      const repo = await svc.repo(row);
      const enc = String(req.headers[BASELINE_ENCODING_HEADER.toLowerCase()] ?? "").trim().toLowerCase();
      const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
      const plain = enc === "tar" || (!enc && ctype.startsWith("application/x-tar"));
      if (enc && enc !== "tar" && enc !== "tar.zst" && enc !== "zstd") throw badRequest("invalid_request", `${BASELINE_ENCODING_HEADER} must be "tar" or "tar.zst"`);
      const c = hub.config.baseline;
      let result;
      try {
        result = await repo.importBaseline(req.raw, {
          format: plain ? "tar" : "tar.zst",
          limits: { maxCompressedBytes: c.maxCompressedBytes, maxExtractedBytes: c.maxExtractedBytes, maxFiles: c.maxFiles, maxMs: c.maxMs },
        });
      } catch (err) {
        // Over a limit: answer, then drop the connection instead of reading the rest of the body.
        if (isSyncCoreError(err, "baseline_too_large") || isSyncCoreError(err, "baseline_timeout") || isSyncCoreError(err, "baseline_unsupported_entry")) {
          reply.header("connection", "close");
          reply.raw.once("finish", () => req.raw.destroy());
        }
        throw err;
      }
      svc.changed(row.id);
      return result;
    });

    /**
     * Large files (> MAX_SYNC_FILE_BYTES): one raw chunk per request, streamed to disk; the last one completes a sync
     * write of the pointer (largeFiles.ts). A conflict comes back as `result` with HTTP 200 (409 = offset only).
     */
    scope.put("/api/projects/:id/large", async (req, reply) => {
      const { user, row } = owned(req);
      diskGuard(hub);
      const q = parse(LargeUploadQuery, req.query ?? {}, "query");
      try {
        const r = await svc.large.putChunk(row, q, req.raw);
        if (r.complete) svc.changed(row.id);
        if (r.result?.status === "conflict") hub.ws.toUser(user, { type: "sync_conflict", projectId: row.id, path: r.path, reason: r.result.reason ?? "conflict" });
        return r;
      } catch (err) {
        if (err instanceof LargeOffsetMismatch) return reply.code(409).send({ ...err.progress, error: err.message, code: "stale" });
        throw err;
      }
    });
  });

  app.get("/api/projects/:id/large", async (req) => {
    const { row } = owned(req);
    const q = parse(LargeProgressQuery, req.query ?? {}, "query");
    return svc.large.progress(row, q);
  });

  app.post("/api/projects/:id/manifest", { bodyLimit: 64 * 1024 * 1024 }, async (req) => {
    const { row } = owned(req);
    const body = parse(ManifestBody, req.body ?? {}, "body");
    // Large files included: sync-core compares them by the real sha256/size in their pointers.
    return (await svc.repo(row)).manifest(body.entries);
  });

  // The Mac's unchecked paths: the only exclusions on the server besides .git (no defaults, no .gitignore).
  app.put("/api/projects/:id/excludes", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { row } = owned(req);
    const body = parse(ProjectExcludesBody, req.body ?? {}, "body");
    await svc.setExcludes(row, body.paths.map(excludePattern));
    return reply.code(204).send();
  });

  app.put("/api/projects/:id/files", { bodyLimit: 160 * 1024 * 1024 }, async (req, reply) => {
    const { user, row } = owned(req);
    diskGuard(hub);
    const body = parse(SyncBody, req.body ?? {}, "body");
    // Deletes and large → small writes of large files are ordinary ops; a large write is `skipped: too_large`
    // (large files come through PUT …/large).
    const r = await (await svc.repo(row)).applyOps(body.ops);
    svc.changed(row.id);
    const out: SyncResultBody = { localCommit: r.localCommit, results: r.results };
    const conflicts = r.results.filter((x) => x.status === "conflict");
    for (const c of conflicts) hub.ws.toUser(user, { type: "sync_conflict", projectId: row.id, path: c.path, reason: c.reason ?? "conflict" });
    if (conflicts.length) {
      // The rest of the batch is applied; the body is the SyncResult plus ErrorBody fields.
      return reply.code(409).send({ ...out, error: `${conflicts.length} file(s) could not be merged`, code: "sync_conflict" });
    }
    return out;
  });

  app.get("/api/projects/:id/review", async (req) => {
    const { row } = owned(req);
    const repo = await svc.repo(row);
    const review = await repo.review();
    const sizeBytes = (await repo.size()) + (await repo.largeStoreSize());
    const project = await svc.toProtocol(row, { localCommit: review.localCommit, pendingFiles: review.files.length, sizeBytes });
    return { project, files: svc.fillTouches(row.id, review.files) };
  });

  app.get("/api/projects/:id/review/diff", async (req) => {
    const { row } = owned(req);
    const q = parse(PathQuery, req.query, "query");
    const fd = await (await svc.repo(row)).diffFile(q.path);
    const out: FileDiff & Record<string, unknown> = { ...fd, diffId: diffIdOf(fd) };
    return out;
  });

  app.get("/api/projects/:id/review/patch", async (req, reply) => {
    const { row } = owned(req);
    const patch = await reviewPatch(await svc.repo(row));
    return reply.header("content-type", "text/x-diff; charset=utf-8").header("cache-control", "no-store").send(patch);
  });

  app.post("/api/projects/:id/review/accept", async (req) => {
    const { row } = owned(req);
    const body = parse(AcceptBody, req.body ?? {}, "body") as AcceptLike;
    const repo = await svc.repo(row);
    const r = await checkedHunks(row, repo, body, () => repo.accept(body));
    svc.changed(row.id);
    return r;
  });

  app.post("/api/projects/:id/review/reject", async (req) => {
    const { row } = owned(req);
    const body = parse(RejectBody, req.body ?? {}, "body") as AcceptLike;
    const repo = await svc.repo(row);
    const r = await checkedHunks(row, repo, body, () => repo.reject(body));
    svc.changed(row.id);
    return r;
  });

  app.get("/api/projects/:id/history", async (req) => {
    const { row } = owned(req);
    const q = parse(HistoryQuery, req.query ?? {}, "query");
    return (await svc.repo(row)).history(q.limit !== undefined ? { limit: q.limit } : {});
  });

  app.post("/api/projects/:id/restore", async (req) => {
    const { row } = owned(req);
    const body = parse(RestoreBody, req.body ?? {}, "body");
    const r = await (await svc.repo(row)).restore(body);
    svc.changed(row.id);
    return r;
  });

  /**
   * Raw bytes, streamed, with HTTP Range (one `bytes=` range → 206 + Content-Range; unsatisfiable → 416). Without
   * `ref`: the working tree (marks the file as downloaded for canDelete once its last byte was sent). With `ref`
   * (commit id, `local`, refs/backups|snapshots|trash/…, or a blob id): that version from the review repo; a large
   * file's pointer is resolved from the project's large-file store (500 `large_missing` when the store lacks it);
   * nothing marked. `inline=1` previews (sandboxed by CSP); otherwise an attachment.
   */
  app.get("/api/projects/:id/raw", async (req, reply) => {
    const { row } = owned(req);
    const q = parse(PathQuery, req.query, "query");
    const raw = parse(RawQuery, req.query, "query");
    const inlineArg = (req.query as { inline?: string }).inline;
    const inline = inlineArg === "1" || inlineArg === "true";
    const repo = await svc.repo(row);
    const name = q.path.split("/").pop() ?? q.path;
    const mediaType = mediaTypeFor(name);

    let size: number;
    let open: (r: { start: number; end: number } | null) => Readable | Promise<Readable>;
    let workTree = false;
    if (raw.ref !== undefined && raw.ref !== "") {
      const blob = await blobAt(repo, raw.ref, q.path);
      if (!blob) throw notFound(`no such file at ${raw.ref}: ${q.path}`);
      const ptr = await repo.largePointer(blob.oid);
      if (ptr) {
        await repo.largeStore.require(ptr, q.path); // before any header is sent
        size = ptr.size;
        open = (r) => repo.largeStore.open(ptr, q.path, r ?? undefined);
      } else {
        size = blob.size;
        open = (r) => (r ? sliceStream(blobStream(repo, blob.oid), r.start, r.end) : blobStream(repo, blob.oid));
      }
    } else {
      const abs = await repo.resolveFile(q.path);
      if (!abs) throw notFound(`no such file: ${q.path}`);
      const st = await stat(abs);
      if (!st.isFile()) throw notFound(`not a file: ${q.path}`);
      size = st.size;
      workTree = true;
      open = (r) => createReadStream(abs, r ?? {});
    }

    const range = parseRange(req.headers.range, size);
    reply.header("Accept-Ranges", "bytes");
    if (range === "unsatisfiable") {
      return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: `range not satisfiable (size ${size})`, code: "invalid_request" });
    }
    reply.header("Content-Type", inline ? mediaType : mediaType === "text/html" ? "application/octet-stream" : mediaType);
    reply.header("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", name));
    reply.header("X-Content-Type-Options", "nosniff");
    if (inline) reply.header("Content-Security-Policy", "sandbox");
    if (range) {
      reply.code(206);
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      reply.header("Content-Length", String(range.end - range.start + 1));
    } else {
      reply.header("Content-Length", String(size));
    }
    const stream = await open(range);
    if (workTree && (!range || range.end === size - 1)) {
      stream.on("end", () => {
        repo.markDownloaded([q.path]).then(
          () => svc.changed(row.id),
          (err: unknown) => hub.log.warn({ projectId: row.id, path: q.path, err: errorMessage(err) }, "markDownloaded failed"),
        );
      });
    }
    return reply.send(stream);
  });

  /** Mac-side backups (refs/backups/…): never touch local, the work tree, review or snapshots; never pruned. */
  app.get("/api/projects/:id/backups", async (req) => {
    const { row } = owned(req);
    return { backups: await listBackups(await svc.repo(row)) };
  });

  // base64 inflates 50 MB to ~67 MB; the decoded total is checked exactly (413 too_large).
  app.post("/api/projects/:id/backups", { bodyLimit: Math.ceil((MAX_BACKUP_BYTES * 4) / 3) + 4 * 1024 * 1024 }, async (req, reply) => {
    const { row } = owned(req);
    diskGuard(hub);
    const body = parse(ProjectBackupBody, req.body ?? {}, "body");
    const backup = await createBackup(await svc.repo(row), body);
    hub.log.info({ projectId: row.id, ref: backup.ref, files: backup.files.length, reason: backup.reason }, "project backup stored");
    return reply.code(201).send(backup);
  });
}
