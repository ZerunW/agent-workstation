/** Workspace files: tree, preview, download (zip), chunked upload, mkdir, delete. */
import { createReadStream } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { DownloadQuery, MkdirBody, PathQuery, TreeQuery, UPLOAD_CHUNK_BYTES, UploadStatusQuery, type FileEntry } from "@agent-workstation/protocol";
import { parse, requireUser } from "../auth.js";
import { contentDisposition, planDownload, zipStream } from "../files/download.js";
import { isBrowserPath, normalizeRelPath, resolveInRoot } from "../files/paths.js";
import { listTree, readContent } from "../files/tree.js";
import { parseUploadHeaders } from "../files/upload.js";
import type { Hub } from "../hub.js";
import { badRequest, forbidden, HttpError } from "../util/errors.js";

/** `.sync/` holds the projects' review repositories: never written or deleted through the files API. */
const isSyncPath = (rel: string) => rel === ".sync" || rel.startsWith(".sync/");
const syncRefused = () => forbidden("invalid_request", ".sync/ is managed by the hub (project review repositories)");
/** `.browser/` (the server browser's profile) is not reachable through the files API at all. */
function refuseBrowserPath(path: string): void {
  if (isBrowserPath(normalizeRelPath(path, true))) throw forbidden("invalid_request", ".browser/ is managed by the hub (the server browser's profile)");
}

/** FileEntry.reviewStatus for files inside synced projects (one review() per project listed). */
async function annotateReview(hub: Hub, user: string, entries: FileEntry[]): Promise<FileEntry[]> {
  const byProject = new Map<string, { id: string; idx: { i: number; inner: string }[] }>();
  entries.forEach((e, i) => {
    if (e.kind !== "file") return;
    const pj = hub.projects.projectForPath(user, e.path);
    if (!pj || !pj.inner) return;
    const g = byProject.get(pj.id) ?? { id: pj.id, idx: [] };
    g.idx.push({ i, inner: pj.inner });
    byProject.set(pj.id, g);
  });
  for (const g of byProject.values()) {
    const row = hub.store.getProject(g.id);
    if (!row) continue;
    try {
      const review = await (await hub.projects.repo(row)).review();
      const status = new Map(review.files.map((f) => [f.path, f.status === "typechange" ? ("modified" as const) : f.status]));
      for (const { i, inner } of g.idx) {
        const st = status.get(inner);
        if (st) entries[i] = { ...entries[i]!, reviewStatus: st };
      }
    } catch (err) {
      hub.log.debug({ projectId: g.id, err: String(err) }, "tree review annotation failed");
    }
  }
  return entries;
}

export function registerFileRoutes(app: FastifyInstance, hub: Hub): void {
  app.get("/api/files/tree", async (req) => {
    const u = requireUser(hub, req);
    const q = parse(TreeQuery, req.query, "query");
    refuseBrowserPath(q.path);
    const entries = await listTree(hub.users.root(u.name), q.path, q.depth);
    return annotateReview(hub, u.name, entries);
  });

  app.get("/api/files/content", async (req) => {
    const u = requireUser(hub, req);
    const q = parse(PathQuery, req.query, "query");
    refuseBrowserPath(q.path);
    return readContent(hub.users.root(u.name), q.path);
  });

  app.get("/api/files/download", async (req, reply) => {
    const u = requireUser(hub, req);
    const q = parse(DownloadQuery, req.query, "query");
    const paths = Array.isArray(q.path) ? q.path : [q.path];
    paths.forEach(refuseBrowserPath);
    const plan = await planDownload(hub.users.root(u.name), paths);
    if (plan.kind === "file") {
      const inline = q.inline === "1";
      reply.header("Content-Type", inline ? plan.mediaType : plan.mediaType === "text/html" ? "application/octet-stream" : plan.mediaType);
      reply.header("Content-Length", String(plan.size));
      reply.header("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", plan.name));
      reply.header("X-Content-Type-Options", "nosniff");
      if (inline) reply.header("Content-Security-Policy", "sandbox");
      return reply.send(createReadStream(plan.abs));
    }
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition("attachment", plan.name));
    return reply.send(zipStream(plan, hub.log));
  });

  // Raw-body parser scoped to the upload route only.
  app.register(async (scope) => {
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: UPLOAD_CHUNK_BYTES + 64 * 1024 }, (_req, body, done) => done(null, body));
    scope.put("/api/files/upload", { bodyLimit: UPLOAD_CHUNK_BYTES + 64 * 1024 }, async (req) => {
      const u = requireUser(hub, req);
      if (hub.disk.level === "block") throw new HttpError(507, "disk_block", "the server's disk is almost full; uploads are paused");
      const h = parseUploadHeaders(req.headers);
      if (isSyncPath(h.path)) throw syncRefused();
      refuseBrowserPath(h.path);
      const body = Buffer.isBuffer(req.body) ? req.body : req.body == null ? Buffer.alloc(0) : Buffer.from(String(req.body));
      return hub.uploads.putChunk(u.name, h, body);
    });
  });

  app.get("/api/files/upload", async (req) => {
    const u = requireUser(hub, req);
    const q = parse(UploadStatusQuery, req.query, "query");
    return hub.uploads.status(u.name, q.uploadId);
  });

  app.post("/api/files/mkdir", async (req, reply) => {
    const u = requireUser(hub, req);
    const body = parse(MkdirBody, req.body ?? {}, "body");
    refuseBrowserPath(body.path);
    const root = hub.users.root(u.name);
    const r = await resolveInRoot(root, body.path);
    if (isSyncPath(r.rel)) throw syncRefused();
    if (r.exists && !(await lstat(r.abs)).isDirectory()) throw new HttpError(409, "exists", `${r.rel} exists and is not a directory`);
    await mkdir(r.abs, { recursive: true });
    await resolveInRoot(root, body.path, { mustExist: true });
    const st = await lstat(r.abs);
    return reply.code(201).send({ path: r.rel, name: r.rel.split("/").pop() ?? r.rel, kind: "dir", size: 0, mtime: st.mtime.toISOString() });
  });

  /** User-initiated delete only — the hub itself never deletes workspace files. */
  app.delete("/api/files", async (req, reply) => {
    const u = requireUser(hub, req);
    const q = parse(PathQuery, req.query, "query");
    refuseBrowserPath(q.path);
    const r = await resolveInRoot(hub.users.root(u.name), q.path, { mustExist: true, noFollowLast: true });
    if (!r.rel) throw forbidden("invalid_request", "refusing to delete the workspace root");
    if (r.rel.split("/").length === 1 && ["inbox", "projects", ".chat", ".claude"].includes(r.rel)) {
      throw badRequest("invalid_request", `"${r.rel}" is a workspace folder; delete its contents instead`);
    }
    if (isSyncPath(r.rel)) throw syncRefused();
    const pj = hub.projects.projectForPath(u.name, r.rel);
    if (pj && pj.inner === "") {
      throw new HttpError(409, "project_not_empty", `${r.rel} is a synced project; delete it with DELETE /api/projects/${pj.id}`);
    }
    await rm(r.abs, { recursive: true, force: false });
    return reply.code(204).send();
  });
}
