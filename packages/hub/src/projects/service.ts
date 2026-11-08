/**
 * Projects: folder sync from the Mac app + git-based review (plan phases 5b/5c/5e),
 * mounted on `@agent-workstation/sync-core`.
 *
 *   work tree  <user root>/projects/<name>         (Claude's cwd; no .git inside)
 *   bare repo  <user root>/.sync/<name>.git        (branch `local` = what the Mac has)
 *   large      <user root>/.sync/<name>.large      (sync-core's large-file store `objects/`, uploads in progress
 *                                                   `uploads/` — largeFiles.ts; removed only with the project)
 *
 * One ProjectRepo per project, opened lazily and cached; `lockKey` = project id,
 * the same key the PreToolUse→PostToolUse holds use (see holds.ts). Every repo
 * method takes that lock itself (re-entrant), so routes never wrap single calls.
 *
 * Iron rule: nothing here deletes user data on its own. `remove()` is only
 * reachable from DELETE /api/projects/:id (explicit user action), and refuses
 * while changes are pending or files were never downloaded unless the user
 * passed `discardRemaining`.
 */
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DiskStatus, Project, ReviewFile } from "@agent-workstation/protocol";
import { openProject, withLock, type ProjectRepo } from "@agent-workstation/sync-core";
import type { ProjectRow, Store } from "../db/store.js";
import { resolveInRoot } from "../files/paths.js";
import type { SessionProjects } from "../sessions/runtime.js";
import { badRequest, errorMessage, HttpError, notFound } from "../util/errors.js";
import { uuid as newUuid } from "../util/ids.js";
import type { Logger } from "../util/log.js";
import type { Broadcaster } from "../ws/protocol.js";
import { ToolHolds } from "./holds.js";
import { LargeFiles } from "./largeFiles.js";

export const PROJECT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const PROJECTS_DIR = "projects";
export const SYNC_DIR = ".sync";

export type DiskProject = DiskStatus["projects"][number];

export interface ProjectServiceDeps {
  store: Store;
  log: Logger;
  bus: Broadcaster;
  userRoot: (user: string) => string;
  /** review_changed is only computed for users with a live connection (default: always). */
  isConnected?: (user: string) => boolean;
  /** Minimum spacing of review_changed per project (default 1000 ms). */
  notifyIntervalMs?: number;
  /** Extra exclude patterns for every project (appended to sync-core's defaults). */
  excludes?: string[];
  holdAutoReleaseMs?: number;
  holdAcquireTimeoutMs?: number;
  /** Large files: size threshold and chunk limit (default MAX_SYNC_FILE_BYTES / LARGE_FILE_CHUNK_BYTES; tests lower them). */
  largeFileMinBytes?: number;
  largeFileChunkBytes?: number;
}

/** Rejects names git or the file system would treat specially. */
export function validateProjectName(name: unknown): string {
  if (typeof name !== "string" || !PROJECT_NAME_RE.test(name) || name.startsWith(".") || name.endsWith(".git") || name.endsWith(".lock")) {
    throw badRequest("invalid_request", "project name must match [A-Za-z0-9._-]{1,64}, must not start with '.' and must not end with .git/.lock");
  }
  return name;
}

interface NotifyState {
  timer: NodeJS.Timeout | null;
  lastAt: number;
}

export class ProjectService implements SessionProjects {
  readonly holds: ToolHolds;
  /** Chunked uploads of files > MAX_SYNC_FILE_BYTES (pointer in git, content in the store; largeFiles.ts). */
  readonly large: LargeFiles;
  private readonly repos = new Map<string, Promise<ProjectRepo>>();
  private readonly notify = new Map<string, NotifyState>();
  private closed = false;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.holds = new ToolHolds({
      log: deps.log,
      ...(deps.holdAutoReleaseMs !== undefined ? { autoReleaseMs: deps.holdAutoReleaseMs } : {}),
      ...(deps.holdAcquireTimeoutMs !== undefined ? { acquireTimeoutMs: deps.holdAcquireTimeoutMs } : {}),
    });
    this.large = new LargeFiles({
      log: deps.log,
      paths: (row) => this.paths(row),
      repo: (row) => this.repo(row),
      ...(deps.largeFileMinBytes !== undefined ? { minBytes: deps.largeFileMinBytes } : {}),
      ...(deps.largeFileChunkBytes !== undefined ? { chunkBytes: deps.largeFileChunkBytes } : {}),
    });
  }

  /**
   * The server excludes only `.git`, the operator's configured patterns and the paths the person unchecked on the Mac
   * (`excludes`): no built-in defaults, no in-tree .gitignore (the person's selection is the only rule set).
   */
  private openRepo(id: string, p: { gitDir: string; workTree: string; largeDir: string }, excludes: readonly string[] = []): Promise<ProjectRepo> {
    return openProject({
      gitDir: p.gitDir,
      workTree: p.workTree,
      lockKey: id,
      largeStoreDir: p.largeDir,
      largeFileBytes: this.large.minBytes,
      defaultExcludes: false,
      honorGitignore: false,
      excludes: [...(this.deps.excludes ?? []), ...excludes],
    });
  }

  /** Replace a project's excluded paths (the Mac's unchecked paths) and rewrite the repository's exclude file. */
  async setExcludes(row: ProjectRow, patterns: readonly string[]): Promise<void> {
    this.deps.store.setProjectExcludes(row.id, patterns);
    const repo = await this.repo(row);
    await repo.setExcludes([...(this.deps.excludes ?? []), ...patterns]);
  }

  // ------------------------------------------------------------------ rows

  list(user: string): ProjectRow[] {
    return this.deps.store.listProjectRows(user);
  }

  /** The project if it belongs to `user`; 404 otherwise (never reveals other users' projects). */
  owned(user: string, id: string): ProjectRow {
    const row = this.deps.store.getProject(id);
    if (!row || row.user !== user) throw notFound("no such project");
    return row;
  }

  /** `largeDir`: the large-file store and partial uploads, next to the review repo (never inside the work tree). */
  paths(row: Pick<ProjectRow, "user" | "name">): { workTree: string; gitDir: string; largeDir: string; rel: string } {
    const root = this.deps.userRoot(row.user);
    return {
      workTree: join(root, PROJECTS_DIR, row.name),
      gitDir: join(root, SYNC_DIR, `${row.name}.git`),
      largeDir: join(root, SYNC_DIR, `${row.name}.large`),
      rel: `${PROJECTS_DIR}/${row.name}`,
    };
  }

  /** The project whose work tree contains `rel` (relative to the user root), with the path inside it. */
  projectForPath(user: string, rel: string): { id: string; name: string; inner: string } | null {
    const parts = rel.split("/");
    if (parts.length < 2 || parts[0] !== PROJECTS_DIR || !parts[1]) return null;
    const row = this.deps.store.getProjectByName(user, parts[1]);
    return row ? { id: row.id, name: row.name, inner: parts.slice(2).join("/") } : null;
  }

  projectIdForCwd(user: string, cwd: string): string | null {
    return this.projectForPath(user, cwd)?.id ?? null;
  }

  // ------------------------------------------------------------- lifecycle

  async create(user: string, nameInput: string, origin: string | null): Promise<ProjectRow> {
    const name = validateProjectName(nameInput);
    if (this.deps.store.getProjectByName(user, name)) throw new HttpError(409, "project_exists", `a project named ${name} already exists`);
    const root = this.deps.userRoot(user);
    // Both directories must be plain directories inside the workspace (no symlinks out).
    for (const rel of [`${PROJECTS_DIR}/${name}`, `${SYNC_DIR}/${name}.git`, `${SYNC_DIR}/${name}.large`]) {
      const r = await resolveInRoot(root, rel);
      if (r.exists) {
        const st = await lstat(r.abs);
        if (!st.isDirectory()) throw new HttpError(409, "project_exists", `${rel} exists and is not a directory`);
      }
    }
    const id = newUuid();
    const p = this.paths({ user, name });
    const opened = this.openRepo(id, p);
    this.repos.set(id, opened);
    try {
      await opened;
    } catch (err) {
      this.repos.delete(id);
      throw err;
    }
    try {
      return this.deps.store.insertProject({ id, user, name, origin });
    } catch (err) {
      this.repos.delete(id);
      if (/UNIQUE/i.test(errorMessage(err))) throw new HttpError(409, "project_exists", `a project named ${name} already exists`);
      throw err;
    }
  }

  /** Cached repository handle (opened on first use; openProject is idempotent). */
  repo(row: ProjectRow): Promise<ProjectRepo> {
    let r = this.repos.get(row.id);
    if (!r) {
      const p = this.paths(row);
      r = this.openRepo(row.id, p, row.excludes);
      this.repos.set(row.id, r);
      r.catch(() => {
        if (this.repos.get(row.id) === r) this.repos.delete(row.id);
      });
    }
    return r;
  }

  async toProtocol(row: ProjectRow, stats?: { localCommit: string | null; pendingFiles: number; sizeBytes: number }): Promise<Project> {
    const s = stats ?? (await (await this.repo(row)).projectStats());
    return {
      id: row.id,
      user: row.user,
      name: row.name,
      path: `${PROJECTS_DIR}/${row.name}`,
      createdAt: row.createdAt,
      localCommit: s.localCommit,
      pendingFiles: s.pendingFiles,
      sizeBytes: s.sizeBytes,
      origin: row.origin,
    };
  }

  /** ReviewFile.lastTouchedBy from file_touches (latest PostToolUse per path). */
  fillTouches(projectId: string, files: ReviewFile[]): ReviewFile[] {
    const touches = this.deps.store.lastTouches(projectId);
    return files.map((f) => {
      const t = touches.get(f.path) ?? (f.oldPath ? touches.get(f.oldPath) : undefined);
      return { ...f, lastTouchedBy: t ? { sessionId: t.sessionId, turn: t.turn, tool: t.tool, at: t.at } : null };
    });
  }

  /** 409 `project_not_empty` unless deleting would lose nothing (or the user discards the rest). */
  async assertDeletable(row: ProjectRow, discardRemaining: boolean): Promise<void> {
    if (discardRemaining) return;
    const can = await (await this.repo(row)).canDelete();
    if (!can.ok) throw this.notEmpty(row, can);
  }

  private notEmpty(row: ProjectRow, can: { pendingFiles: number; undownloadedFiles: number }): HttpError {
    return new HttpError(
      409,
      "project_not_empty",
      `${row.name} has ${can.pendingFiles} pending change(s) and ${can.undownloadedFiles} undownloaded file(s); accept or download them, or pass discardRemaining`,
      { pendingFiles: can.pendingFiles, undownloadedFiles: can.undownloadedFiles },
    );
  }

  /**
   * Deletes the server copy (work tree + review repo + row). Refuses with 409
   * `project_not_empty` while something would be lost, unless `discardRemaining`.
   */
  async remove(row: ProjectRow, discardRemaining: boolean): Promise<{ pendingFiles: number; undownloadedFiles: number }> {
    const repo = await this.repo(row);
    const p = this.paths(row);
    const result = await withLock(row.id, async () => {
      const can = await repo.canDelete();
      if (!can.ok && !discardRemaining) throw this.notEmpty(row, can);
      this.holds.releaseProject(row.id);
      await rm(p.workTree, { recursive: true, force: true });
      await rm(p.gitDir, { recursive: true, force: true });
      await this.large.dropProjectData(row);
      this.repos.delete(row.id);
      this.deps.store.deleteProject(row.id);
      return { pendingFiles: can.pendingFiles, undownloadedFiles: can.undownloadedFiles };
    });
    const st = this.notify.get(row.id);
    if (st?.timer) clearTimeout(st.timer);
    this.notify.delete(row.id);
    this.deps.log.info({ user: row.user, project: row.name, discardRemaining, ...result }, "project deleted by the user");
    return result;
  }

  // -------------------------------------------------------- review_changed

  /** Debounced `review_changed` (at most one per project per notifyIntervalMs). */
  changed(projectId: string): void {
    if (this.closed) return;
    const row = this.deps.store.getProject(projectId);
    if (!row) return;
    if (this.deps.isConnected && !this.deps.isConnected(row.user)) return;
    let st = this.notify.get(projectId);
    if (!st) {
      st = { timer: null, lastAt: 0 };
      this.notify.set(projectId, st);
    }
    if (st.timer) return;
    const interval = this.deps.notifyIntervalMs ?? 1000;
    const wait = Math.max(Math.min(50, interval), st.lastAt + interval - Date.now());
    const state = st;
    state.timer = setTimeout(() => {
      state.timer = null;
      state.lastAt = Date.now();
      void this.emitReviewChanged(projectId);
    }, wait);
    state.timer.unref?.();
  }

  /** Watcher events under `projects/<name>/…` (relative to the user root). */
  pathsChanged(user: string, rels: Iterable<string>): void {
    const seen = new Set<string>();
    for (const rel of rels) {
      const parts = rel.split("/");
      if (parts[0] !== PROJECTS_DIR || !parts[1] || seen.has(parts[1])) continue;
      seen.add(parts[1]);
      const row = this.deps.store.getProjectByName(user, parts[1]);
      if (row) this.changed(row.id);
    }
  }

  private async emitReviewChanged(projectId: string): Promise<void> {
    const row = this.deps.store.getProject(projectId);
    if (!row || this.closed) return;
    try {
      const repo = await this.repo(row);
      const pendingFiles = await repo.pendingCount();
      const localCommit = await repo.localCommit();
      this.deps.bus.toUser(row.user, { type: "review_changed", projectId, localCommit, pendingFiles });
    } catch (err) {
      if (this.deps.store.getProject(projectId)) this.deps.log.warn({ projectId, err: errorMessage(err) }, "review_changed computation failed");
    }
  }

  // ------------------------------------------------- session integration

  async beforeWrite(toolUseId: string, sessionId: string, projectId: string): Promise<void> {
    await this.holds.acquire(toolUseId, sessionId, projectId);
  }

  releaseTool(toolUseId: string | undefined): void {
    this.holds.release(toolUseId);
  }

  suspendHold(toolUseId: string | undefined): (() => Promise<void>) | null {
    return this.holds.suspend(toolUseId);
  }

  releaseSession(sessionId: string): void {
    this.holds.releaseSession(sessionId);
  }

  /** Turn end: snapshot every project the turn worked in, then announce review_changed. */
  turnEnded(t: { sessionId: string; turn: number; message: string; projectIds: string[] }): void {
    this.holds.releaseSession(t.sessionId);
    for (const id of new Set(t.projectIds)) {
      const row = this.deps.store.getProject(id);
      if (!row) continue;
      void (async () => {
        try {
          const repo = await this.repo(row);
          await repo.snapshot({ sessionId: t.sessionId, turn: t.turn, message: t.message });
        } catch (err) {
          this.deps.log.warn({ projectId: id, sessionId: t.sessionId, turn: t.turn, err: errorMessage(err) }, "turn snapshot failed");
        } finally {
          this.changed(id);
        }
      })();
    }
  }

  /** Rewind with files: refs/snapshots/<sessionId>/<turn> in the project holding `cwd`, when that snapshot exists. */
  async turnSnapshot(user: string, cwd: string, sessionId: string, turn: number): Promise<string | null> {
    const id = this.projectIdForCwd(user, cwd);
    const row = id ? this.deps.store.getProject(id) : null;
    if (!row || !Number.isInteger(turn) || turn < 1) return null;
    const ref = `refs/snapshots/${sessionId}/${turn}`;
    const history = await (await this.repo(row)).history({ limit: 1_000_000, includeUnchanged: true });
    return history.some((s: { ref: string }) => s.ref === ref) ? ref : null;
  }

  /** Rewind with files: the project's restore of the whole tree from `ref` (writes refs/trash first; `local` unchanged). */
  async restoreSnapshot(user: string, cwd: string, ref: string): Promise<{ trashRef: string }> {
    const id = this.projectIdForCwd(user, cwd);
    const row = id ? this.deps.store.getProject(id) : null;
    if (!row) throw notFound("no such project");
    const r = await (await this.repo(row)).restore({ ref });
    this.changed(row.id);
    return { trashRef: r.trashRef };
  }

  // ------------------------------------------------------------------ disk

  /** Per-project numbers for DiskStatus.projects, keyed by user (bytes = work tree + review repo + large-file store). */
  async diskProjects(): Promise<Map<string, DiskProject[]>> {
    const out = new Map<string, DiskProject[]>();
    for (const row of this.deps.store.listAllProjectRows()) {
      try {
        const repo = await this.repo(row);
        const can = await repo.canDelete();
        const bytes = (await repo.size()) + (await repo.gitDirSize()) + (await repo.largeStoreSize());
        const list = out.get(row.user) ?? [];
        list.push({ id: row.id, name: row.name, pendingFiles: can.pendingFiles, undownloadedFiles: can.undownloadedFiles, bytes });
        out.set(row.user, list);
      } catch (err) {
        this.deps.log.warn({ projectId: row.id, err: errorMessage(err) }, "project disk stats failed");
      }
    }
    return out;
  }

  close(): void {
    this.closed = true;
    for (const st of this.notify.values()) if (st.timer) clearTimeout(st.timer);
    this.notify.clear();
  }
}
