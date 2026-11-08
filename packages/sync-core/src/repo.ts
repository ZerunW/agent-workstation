import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { MAX_SYNC_FILE_BYTES } from "@agent-workstation/protocol";
import { DEFAULT_BASELINE_LIMITS, extractArchive, type BaselineFormat, type BaselineLimits } from "./archive.js";
import { filterPatch, parseUnifiedDiff } from "./diff.js";
import { SyncCoreError, isSyncCoreError } from "./errors.js";
import { ATTRIBUTES_FILE, renderExcludeFile } from "./excludes.js";
import { GitError, GitRunner, gitBaseEnv, runGitRaw, type GitResult, type GitRunOptions } from "./git.js";
import { EMPTY_TREE_OID, ZERO_OID, gitBlobOid, gitBlobOidOfFile, hashBytes } from "./hash.js";
import { LargeHashCache, LargeStore, POINTER_MAX_BYTES, hashFileStream, parsePointer, pointerText, type LargePointer } from "./large.js";
import { withLock } from "./mutex.js";
import {
  GIT_MODE_GITLINK,
  assertRelPath,
  gitFileMode,
  isExecutableMode,
  isInside,
  isSymlinkMode,
  lstatOrNull,
  pruneEmptyParents,
  resolveInside,
  writeFileAtomic,
} from "./paths.js";
import {
  pairRenames,
  parseLsFilesStageZ,
  parseLsTreeZ,
  parseNumstatZ,
  parsePorcelainV2,
  porcelainToChanges,
  splitNul,
  type ChangeRecord,
  type ChangeStatus,
  type NumstatEntry,
  type TreeEntry,
} from "./porcelain.js";
import type {
  AcceptBody,
  AcceptResponse,
  FileDiff,
  ManifestEntry,
  ManifestResponse,
  RejectBody,
  RestoreBody,
  ReviewFile,
  Snapshot,
  SyncOp,
  SyncOpStatus,
  SyncResult,
} from "./types.js";

const execFileP = promisify(execFile);

/** Files larger than this get no text payload (oldText/newText null, no hunks). */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const LOCAL_REF = "refs/heads/local";

/** Pinned diff options so hunk indices are reproducible. */
const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "-U3",
  "--diff-algorithm=myers",
  "--indent-heuristic",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenProjectOptions {
  /** Bare repository path (created if missing). Must not be inside the work tree. */
  gitDir: string;
  /** The project directory Claude works in (created if missing). */
  workTree: string;
  /** Extra gitignore patterns appended to {@link defaultExcludes}. */
  excludes?: readonly string[];
  /**
   * Write {@link defaultExcludes} into `info/exclude` (default true). false: only `.git` and `excludes` (the hub,
   * where the person's unchecked paths decide).
   */
  defaultExcludes?: boolean;
  /**
   * Mutex key used by every method. Defaults to the resolved gitDir. The hub
   * should pass the project id and use the same key for its own `withLock` /
   * `acquireLock` calls (PreToolUse → PostToolUse).
   */
  lockKey?: string;
  /** Reuse git's stat cache between operations (default true). */
  statCache?: boolean;
  /**
   * Honour in-tree `.gitignore` files in addition to `info/exclude` (default
   * true, i.e. standard git semantics). In-tree rules take precedence over
   * `info/exclude`, so a caller cannot un-ignore them with `!pattern`; pass
   * false to make `info/exclude` (defaults + `excludes`) the only rule set.
   */
  honorGitignore?: boolean;
  /**
   * Files larger than this are large files (default MAX_SYNC_FILE_BYTES): git stores a pointer blob, the content
   * lives in the large-file store. Tests lower it.
   */
  largeFileBytes?: number;
  /**
   * The project's content-addressed large-file store (default: next to the git dir, `<name>.large` for
   * `<name>.git`). Must be outside the work tree and on the same file system as files adopted into it.
   */
  largeStoreDir?: string;
}

export interface ImportBaselineOptions {
  /** Archive format of a stream/buffer source (default "tar.zst"). */
  format?: BaselineFormat;
  /** Limits of an archive source (defaults: DEFAULT_BASELINE_LIMITS). */
  limits?: Partial<BaselineLimits>;
}

export type BaselineSource = string | Readable | NodeJS.ReadableStream | Uint8Array;

export interface BaselineResult {
  localCommit: string;
  files: number;
  /** Trash ref holding the previous work tree, when it had content that differed from `local`. */
  trashRef: string | null;
  /** Non-fatal problems (e.g. a file could not be checked out because a directory is in the way). */
  warnings: string[];
}

export interface ReviewResult {
  files: ReviewFile[];
  localCommit: string;
}

export interface FileDiffResult extends FileDiff {
  status: ChangeStatus | "unchanged";
  oldPath?: string;
  /** Either side is larger than 2 MB: no text payload and no hunks. */
  tooLarge: boolean;
}

export interface ApplyOpsResult extends SyncResult {
  localCommit: string;
  /** Trash ref written before the first forced overwrite in this batch. */
  trashRef: string | null;
}

/** `localCommit` is an optional optimistic-concurrency check (rejects with `stale` if `local` moved). */
export type AcceptInput = AcceptBody & { localCommit?: string };
export type RejectInput = RejectBody & { localCommit?: string };

export interface AcceptResult extends AcceptResponse {
  /** Files left pending by an accept-all (too large, symlink, unreadable). */
  skipped: { path: string; reason: string }[];
}

export interface RejectResult {
  localCommit: string;
  trashRef: string | null;
  /** Paths whose work-tree content was reverted. */
  paths: string[];
}

export interface RestoreResult {
  localCommit: string;
  trashRef: string;
  /** Commit the content was taken from. */
  commit: string;
}

export interface SnapshotInput {
  sessionId: string;
  turn: number;
  message: string;
}

export interface SnapshotResult extends Snapshot {
  /** false when the tree is identical to the previous snapshot of this session (or to `local`). */
  changed: boolean;
  commit: string;
}

export interface HistoryOptions {
  /** Max entries returned (default 500). */
  limit?: number;
  /** Include turn snapshots whose tree did not change (default true). */
  includeUnchanged?: boolean;
}

export interface CanDeleteResult {
  /** True when nothing would be lost by deleting the server copy. */
  ok: boolean;
  /** All pending review entries (informational). */
  pendingFiles: number;
  /** New files on the server that were never downloaded (rawFile/markDownloaded) nor accepted. */
  undownloadedFiles: number;
}

export interface ProjectStats {
  localCommit: string;
  pendingFiles: number;
  /** Work tree + large-file store. */
  sizeBytes: number;
}

/**
 * A Mac push of a large file ({@link ProjectRepo.applyLargeWrite}). `baseHash` is the real sha256 of the version
 * the Mac last saw (null for a new file). `file` holds the content (a finished upload on the store's file system; it
 * is checked against `sha256` and moved into the store); without it the store must already hold that version.
 */
export interface LargeWriteInput {
  path: string;
  sha256: string;
  size: number;
  mode: number;
  baseHash: string | null;
  force?: boolean;
  file?: string;
}

export interface LargeWriteResult {
  localCommit: string;
  result: { status: SyncOpStatus; reason?: string };
  trashRef: string | null;
}

export type { LargePointer };

interface IndexUpdate {
  path: string;
  mode: number;
  oid: string;
}

interface StageInfo {
  /** Large files staged as pointers (path → pointer); assume-unchanged in the temp index. */
  large: Map<string, LargePointer>;
  /** Tracked large files that could not be hashed/stored: kept at their `local` version, reported unstaged. */
  failed: Set<string>;
}

interface TempIndex {
  file: string;
  /** Paths whose entries were set assume-unchanged (large-file pointers). */
  assumed: string[];
  run(args: readonly string[], o?: GitRunOptions): Promise<GitResult>;
}

interface Changes {
  recs: ChangeRecord[];
  counts: Map<string, NumstatEntry>;
  /** Pointer blobs among the records' old/new oids. */
  pointers: Map<string, LargePointer>;
}

type OpResult = { status: SyncOpStatus; reason?: string };

/** One side of a write: a small content blob, or a large file's pointer. */
type Version = { oid: string; data: Buffer; ptr?: undefined } | { oid: string; ptr: LargePointer; data?: undefined };

type WriteOp = Extract<SyncOp, { op: "write" }> & { large?: LargePointer };
type InternalOp = WriteOp | Extract<SyncOp, { op: "delete" }>;

interface ApplyCtx {
  local: string;
  tree: Map<string, TreeEntry>;
  updates: IndexUpdate[];
  removals: string[];
  blobs: Map<string, Buffer>;
  trashRef: string | null;
}

interface SidecarState {
  version: 1;
  /** path → git blob id of the content that was downloaded. */
  downloaded: Record<string, string>;
}

// ---------------------------------------------------------------------------
// sha1 → sha256 cache (blob ids are immutable, so the mapping never goes stale)
// ---------------------------------------------------------------------------

class BlobHashCache {
  private bySha1 = new Map<string, string>();
  private bySha256 = new Map<string, string>();
  private pending: string[] = [];
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const text = await readFile(this.file, "utf8");
      for (const line of text.split("\n")) {
        const [a, b] = line.split(" ");
        if (a && b && a.length === 40 && b.length === 64) {
          this.bySha1.set(a, b);
          this.bySha256.set(b, a);
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.loaded = true;
  }

  sha256Of(oid: string): string | undefined {
    return this.bySha1.get(oid);
  }

  oidFor(sha256: string): string | undefined {
    return this.bySha256.get(sha256);
  }

  remember(oid: string, sha256: string): void {
    if (this.bySha1.get(oid) === sha256) return;
    this.bySha1.set(oid, sha256);
    this.bySha256.set(sha256, oid);
    this.pending.push(`${oid} ${sha256}\n`);
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const data = this.pending.join("");
    this.pending = [];
    await appendFile(this.file, data);
  }
}

// ---------------------------------------------------------------------------
// openProject
// ---------------------------------------------------------------------------

/**
 * Open (creating if needed) the bare repository for a project: `git init
 * --bare`, HEAD → refs/heads/local, `info/exclude` + `info/attributes`, and an
 * initial empty-tree commit on `local` so the branch always exists.
 */
export async function openProject(opts: OpenProjectOptions): Promise<ProjectRepo> {
  const workTreeIn = path.resolve(opts.workTree);
  const gitDirIn = path.resolve(opts.gitDir);
  await mkdir(workTreeIn, { recursive: true });
  await mkdir(path.dirname(gitDirIn), { recursive: true });
  const workTree = await realpath(workTreeIn);
  const gitDir = path.join(await realpath(path.dirname(gitDirIn)), path.basename(gitDirIn));
  if (isInside(workTree, gitDir) || isInside(gitDir, workTree)) {
    throw new SyncCoreError("invalid_argument", "gitDir and workTree must not contain each other");
  }
  const lockKey = opts.lockKey ?? gitDir;
  const storeDir = path.resolve(opts.largeStoreDir ?? path.join(path.dirname(gitDir), `${path.basename(gitDir).replace(/\.git$/, "")}.large`));
  if (isInside(workTree, storeDir)) throw new SyncCoreError("invalid_argument", "largeStoreDir must be outside the work tree");
  return withLock(lockKey, async () => {
    const repo = new ProjectRepo(gitDir, workTree, lockKey, opts.statCache ?? true, opts.honorGitignore ?? true, {
      largeFileBytes: opts.largeFileBytes ?? MAX_SYNC_FILE_BYTES,
      largeStoreDir: storeDir,
      defaultExcludes: opts.defaultExcludes ?? true,
    });
    await repo._init(opts.excludes ?? []);
    return repo;
  });
}

// ---------------------------------------------------------------------------
// ProjectRepo
// ---------------------------------------------------------------------------

export class ProjectRepo {
  readonly gitDir: string;
  readonly workTree: string;
  readonly lockKey: string;
  private readonly statCache: boolean;
  private readonly honorGitignore: boolean;
  private readonly withDefaults: boolean;
  /** Files larger than this are large files (pointer in git, content in {@link largeStore}). */
  readonly largeFileBytes: number;
  /** The project's content-addressed large-file store. */
  readonly largeStore: LargeStore;
  private readonly largeHashes: LargeHashCache;
  /** blob id → pointer (or null: not a pointer); blob ids are immutable. */
  private readonly pointerCache = new Map<string, LargePointer | null>();
  private readonly git: GitRunner;
  private readonly stateDir: string;
  private readonly tmpDir: string;
  /** Always-empty directory: running check-ignore against it sees no in-tree .gitignore. */
  private readonly emptyDir: string;
  private readonly cacheIndex: string;
  private readonly stateFile: string;
  private readonly hashes: BlobHashCache;
  private lastStamp = 0;

  /** @internal use {@link openProject} */
  constructor(
    gitDir: string,
    workTree: string,
    lockKey: string,
    statCache: boolean,
    honorGitignore = true,
    large: { largeFileBytes?: number; largeStoreDir?: string; defaultExcludes?: boolean } = {},
  ) {
    this.withDefaults = large.defaultExcludes ?? true;
    this.largeFileBytes = large.largeFileBytes ?? MAX_SYNC_FILE_BYTES;
    this.largeStore = new LargeStore(large.largeStoreDir ?? path.join(path.dirname(gitDir), `${path.basename(gitDir).replace(/\.git$/, "")}.large`));
    this.largeHashes = new LargeHashCache(path.join(gitDir, "workstation", "large-sha256.json"));
    this.gitDir = gitDir;
    this.workTree = workTree;
    this.lockKey = lockKey;
    this.statCache = statCache;
    this.honorGitignore = honorGitignore;
    this.stateDir = path.join(gitDir, "workstation");
    this.tmpDir = path.join(this.stateDir, "tmp");
    this.emptyDir = path.join(this.stateDir, "empty");
    this.cacheIndex = path.join(this.stateDir, "index.cache");
    this.stateFile = path.join(this.stateDir, "state.json");
    this.hashes = new BlobHashCache(path.join(this.stateDir, "blob-sha256"));
    this.git = new GitRunner(gitDir, workTree, path.join(this.stateDir, "placeholder-index"));
  }

  /** @internal */
  async _init(excludes: readonly string[]): Promise<void> {
    if (!(await lstatOrNull(path.join(this.gitDir, "HEAD")))) {
      await mkdir(this.gitDir, { recursive: true });
      await runGitRaw(["init", "--bare", "-q", this.gitDir], path.dirname(this.gitDir));
    }
    await mkdir(this.stateDir, { recursive: true });
    // Leftovers from an interrupted operation (we hold the project lock here).
    await rm(this.tmpDir, { recursive: true, force: true });
    await mkdir(this.tmpDir, { recursive: true });
    await mkdir(this.emptyDir, { recursive: true });
    await this.largeStore.init();
    await this.git.run(["symbolic-ref", "HEAD", LOCAL_REF]);
    await this.git.run(["config", "core.logAllRefUpdates", "false"]);
    await mkdir(path.join(this.gitDir, "info"), { recursive: true });
    await writeFile(path.join(this.gitDir, "info", "exclude"), renderExcludeFile(excludes, this.withDefaults));
    await writeFile(path.join(this.gitDir, "info", "attributes"), ATTRIBUTES_FILE);
    if (!(await this.localCommit())) {
      const empty = (await this.git.run(["mktree"], { input: "" })).stdout.toString().trim();
      const c = await this.commitTree(empty, [], "init", { "Workstation-Kind": "init" });
      await this.git.run(["update-ref", "-m", "init", LOCAL_REF, c, ZERO_OID]);
    }
  }

  // -------------------------------------------------------------------------
  // Small accessors
  // -------------------------------------------------------------------------

  /** Commit id of `local` (null only before initialisation). Lock-free. */
  async localCommit(): Promise<string | null> {
    const r = await this.git.run(["rev-parse", "--verify", "--quiet", `${LOCAL_REF}^{commit}`], { okCodes: [0, 1] });
    const s = r.stdout.toString().trim();
    return r.code === 0 && s ? s : null;
  }

  /** Rewrite `<gitDir>/info/exclude` with the defaults plus these patterns. */
  async setExcludes(excludes: readonly string[]): Promise<void> {
    await this.locked(() => writeFile(path.join(this.gitDir, "info", "exclude"), renderExcludeFile(excludes, this.withDefaults)));
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(this.lockKey, fn);
  }

  private async requireLocal(): Promise<string> {
    const c = await this.localCommit();
    if (!c) throw new SyncCoreError("git", "branch `local` is missing");
    return c;
  }

  private async checkExpected(body: { localCommit?: string }): Promise<void> {
    if (body.localCommit === undefined) return;
    const cur = await this.requireLocal();
    if (cur !== body.localCommit) throw new SyncCoreError("stale", `local moved: expected ${body.localCommit}, now ${cur}`);
  }

  // -------------------------------------------------------------------------
  // Baseline import
  // -------------------------------------------------------------------------

  /**
   * Import the Mac's folder as the new content of `local`. `source` is a
   * tar.zst stream/buffer (extracted with the `tar` CLI, `--zstd`) or a
   * directory path. Files are written into the work tree (unless `source` *is*
   * the work tree) and committed to `local` as "baseline: N files". Excluded
   * paths and symlinks are not imported; large files go into the store and
   * `local` holds their pointers.
   * A non-empty work tree that differs from `local` is saved to a trash ref first;
   * files that were in the old `local`, are unchanged on the server and are absent
   * from the new baseline are removed (the Mac deleted them).
   */
  async importBaseline(source: BaselineSource, opts: ImportBaselineOptions = {}): Promise<BaselineResult> {
    if (typeof source === "string") return this.importFromDir(await realpath(source));
    // Extract before taking the project lock (it can take a while); a failed or over-limit upload leaves nothing behind.
    await mkdir(this.tmpDir, { recursive: true });
    const tmp = await mkdtemp(path.join(this.tmpDir, "baseline-"));
    try {
      await extractArchive(source, tmp, opts.format ?? "tar.zst", { ...DEFAULT_BASELINE_LIMITS, ...opts.limits });
      return await this.importFromDir(tmp);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async importFromDir(srcDir: string): Promise<BaselineResult> {
    return this.locked(async () => {
      const local = await this.requireLocal();
      const localTree = await this.revParse(`${local}^{tree}`);
      let trashRef: string | null = null;
      await this.withIndex("staged", async (ix) => {
        const tree = await this.writeTree(ix);
        if (tree !== EMPTY_TREE_OID && tree !== localTree) trashRef = (await this.writeTrash(tree, "before baseline import")).ref;
      });

      const sameDir = srcDir === this.workTree;
      const warnings: string[] = [];
      const built = await this.withIndex(
        "empty",
        async (ix) => {
          const info = await this.stage(ix, { root: srcDir, skipSymlinks: true });
          const tree = await this.writeTree(ix);
          const entries = parseLsFilesStageZ((await ix.run(["ls-files", "-s", "-z"])).stdout);
          if (!sameDir) {
            // Small files through git; large files (pointers in the index) from the store, never as pointer text.
            const small = entries.filter((e) => !info.large.has(e.path)).map((e) => e.path);
            if (small.length > 0) {
              const r = await ix.run(["checkout-index", "-f", "-u", "-z", "--stdin"], { workTree: this.workTree, input: small.join("\0") + "\0", okCodes: [0, 1, 128] });
              if (r.code !== 0) warnings.push(...r.stderr.split("\n").filter((l) => l.trim() !== ""));
            }
            for (const e of entries) {
              const ptr = info.large.get(e.path);
              if (!ptr) continue;
              try {
                await this.materialize(e.path, ptr, e.mode);
              } catch (err) {
                if (!isSyncCoreError(err) || err.code === "large_missing") throw err;
                warnings.push(`${e.path}: ${err.message}`);
              }
            }
          }
          return { tree, entries };
        },
        { workTree: srcDir, saveCache: true },
      );

      // Files the Mac no longer has (absent from the source, not merely excluded):
      // drop them from the work tree when untouched on the server.
      const newPaths = new Set(built.entries.map((e) => e.path));
      for (const [p, e] of await this.lsTreeMap(local)) {
        if (sameDir || newPaths.has(p) || e.type !== "blob") continue;
        if (await lstatOrNull(path.join(srcDir, p))) continue;
        try {
          const abs = await resolveInside(this.workTree, p);
          const st = await lstatOrNull(abs);
          if (st?.isFile() && (await this.workTreeOid(p, abs, st)) === e.oid) {
            await unlink(abs);
            await pruneEmptyParents(this.workTree, abs);
          }
        } catch (err) {
          if (!isSyncCoreError(err)) throw err;
        }
      }

      const n = built.entries.length;
      const commit = await this.commitTree(built.tree, [local], `baseline: ${n} file${n === 1 ? "" : "s"}`, { "Workstation-Kind": "baseline" });
      await this.updateLocal(commit, local, "baseline");
      await this.ensureSha256(built.entries.filter((e) => e.type === "blob").map((e) => e.oid));
      return { localCommit: commit, files: n, trashRef, warnings };
    });
  }

  // -------------------------------------------------------------------------
  // Manifest reconciliation
  // -------------------------------------------------------------------------

  /**
   * Compare the Mac's full listing with the `local` tree. `need` = paths whose
   * content (sha256) or executable bit differs, or that `local` lacks — the Mac
   * should push them. `delete` = paths in `local` the Mac no longer lists — the
   * Mac should push delete ops (the hub never deletes on its own). Excluded
   * paths are ignored on both sides. Large files compare by their real sha256
   * and size (from the pointer in `local`); one whose content the store lacks
   * is needed again.
   */
  async manifest(entries: readonly ManifestEntry[]): Promise<ManifestResponse> {
    return this.locked(async () => {
      const local = await this.requireLocal();
      const byPath = new Map<string, ManifestEntry>();
      for (const e of entries) byPath.set(assertRelPath(e.path), e);
      const tree = await this.lsTreeMap(local);
      const blobs = [...tree.values()].filter((e) => e.type === "blob");
      await this.ensureSha256(blobs.map((e) => e.oid));
      const pointers = await this.pointersOf(blobs.map((e) => e.oid));
      const ignored = await this.checkIgnored([...new Set([...byPath.keys(), ...blobs.map((e) => e.path)])]);

      const need: string[] = [];
      for (const [p, e] of byPath) {
        if (ignored.has(p) || isSymlinkMode(e.mode)) continue;
        const l = tree.get(p);
        const ptr = l ? pointers.get(l.oid) : undefined;
        const sha = ptr ? ptr.sha256 : l ? this.hashes.sha256Of(l.oid) : undefined;
        if (!l || l.type !== "blob" || isSymlinkMode(l.mode) || sha !== e.hash.toLowerCase() || isExecutableMode(l.mode) !== isExecutableMode(e.mode)) {
          need.push(p);
        } else if (ptr && (ptr.size !== e.size || !(await this.largeStore.has(ptr)))) {
          need.push(p);
        }
      }
      const del = blobs.filter((e) => !byPath.has(e.path) && !ignored.has(e.path)).map((e) => e.path);
      return { need: need.sort(), delete: del.sort(), localCommit: local };
    });
  }

  // -------------------------------------------------------------------------
  // Pushes from the Mac
  // -------------------------------------------------------------------------

  /**
   * Apply a batch of Mac-side changes. All applied/merged ops become ONE commit
   * on `local` ("sync: N files"); noops create nothing (echo suppression).
   * See README for the per-op decision table.
   */
  async applyOps(ops: readonly SyncOp[]): Promise<ApplyOpsResult> {
    // Wire ops never carry a pointer: large files come through applyLargeWrite only.
    return this.applyBatch(ops.map((op): InternalOp => (op.op === "write" ? { ...op, large: undefined } : op)));
  }

  /**
   * A Mac push of a large file (the hub's chunked upload, once complete): the content goes into the store (`file`
   * is checked against `sha256` and moved there), then it is a sync write like any other — `local` gets the pointer
   * (one "sync: 1 file" commit), the work tree gets the content (streamed from the store), with the same baseHash /
   * merge / conflict / force rules as small writes; a large file changed on both sides is a conflict.
   */
  async applyLargeWrite(input: LargeWriteInput): Promise<LargeWriteResult> {
    const p = assertRelPath(input.path);
    const ptr: LargePointer = { sha256: String(input.sha256).toLowerCase(), size: input.size };
    if (!/^[0-9a-f]{64}$/.test(ptr.sha256)) throw new SyncCoreError("invalid_argument", `invalid sha256: ${input.sha256}`);
    if (!Number.isSafeInteger(ptr.size) || ptr.size <= this.largeFileBytes) {
      throw new SyncCoreError("invalid_argument", `${p}: files up to ${this.largeFileBytes} bytes are not large files`);
    }
    return this.locked(async () => {
      if (input.file !== undefined) await this.largeStore.adopt(input.file, ptr);
      else if (!(await this.largeStore.has(ptr))) {
        const local = await this.requireLocal();
        return { localCommit: local, result: { status: "need_content" }, trashRef: null };
      }
      const op: WriteOp = {
        op: "write",
        path: p,
        hash: ptr.sha256,
        size: ptr.size,
        mode: input.mode,
        baseHash: input.baseHash ? input.baseHash.toLowerCase() : null,
        large: ptr,
        ...(input.force ? { force: true } : {}),
      };
      const r = await this.applyBatch([op]);
      const res = r.results[0]!;
      return { localCommit: r.localCommit, result: res.reason !== undefined ? { status: res.status, reason: res.reason } : { status: res.status }, trashRef: r.trashRef };
    });
  }

  private async applyBatch(ops: readonly InternalOp[]): Promise<ApplyOpsResult> {
    return this.locked(async () => {
      const local = await this.requireLocal();
      await this.hashes.load();
      const results = new Map<number, OpResult>();
      const last = new Map<string, number>();
      ops.forEach((op, i) => {
        try {
          assertRelPath(op.path);
          last.set(op.path, i);
        } catch (e) {
          results.set(i, { status: "skipped", reason: (e as Error).message });
        }
      });
      const effective = [...last.values()].sort((a, b) => a - b);
      const tree = await this.lsTreeMap(local);
      const touched = effective.map((i) => tree.get(ops[i]!.path)).filter((e): e is TreeEntry => e?.type === "blob").map((e) => e.oid);
      await this.ensureSha256(touched);
      await this.pointersOf(touched);
      const ignored = await this.checkIgnored(effective.map((i) => ops[i]!.path));
      const ctx: ApplyCtx = { local, tree, updates: [], removals: [], blobs: new Map(), trashRef: null };

      // Deletes first so that a file can replace a directory (and vice versa) within one batch.
      for (const i of effective) {
        const op = ops[i]!;
        if (op.op === "delete") results.set(i, await this.applyDelete(op, ctx, ignored));
      }
      for (const i of effective) {
        const op = ops[i]!;
        if (op.op === "write") results.set(i, await this.applyWrite(op, ctx, ignored));
      }
      await this.largeHashes.flush();

      let localCommit = local;
      if (ctx.updates.length > 0 || ctx.removals.length > 0) {
        await this.writeBlobs(ctx.blobs);
        const newTree = await this.treeWith(ctx.updates, ctx.removals);
        const n = ctx.updates.length + ctx.removals.length;
        localCommit = await this.commitTree(newTree, [local], `sync: ${n} file${n === 1 ? "" : "s"}`, { "Workstation-Kind": "sync" });
        await this.updateLocal(localCommit, local, "sync");
      }
      await this.hashes.flush();

      const out: SyncResult["results"] = ops.map((op, i) => {
        const r = results.get(i) ?? results.get(last.get(op.path) ?? -1) ?? { status: "skipped" as const, reason: "superseded" };
        return r.reason !== undefined ? { path: op.path, status: r.status, reason: r.reason } : { path: op.path, status: r.status };
      });
      return { localCommit, results: out, trashRef: ctx.trashRef };
    });
  }

  private async applyWrite(op: WriteOp, ctx: ApplyCtx, ignored: Set<string>): Promise<OpResult> {
    const p = op.path;
    if (ignored.has(p)) return { status: "skipped", reason: "excluded" };
    if (isSymlinkMode(op.mode)) return { status: "skipped", reason: "symlink" };
    // Large files have their own route (chunked upload → applyLargeWrite).
    if (!op.large && op.size > this.largeFileBytes) return { status: "skipped", reason: "too_large" };

    const l = ctx.tree.get(p);
    if (l && l.type !== "blob") return { status: "conflict", reason: "path_blocked: `local` has a directory here" };
    const localSha = l ? this.realSha256(l.oid) ?? null : null;
    const exec = isExecutableMode(op.mode);
    const localExec = l ? isExecutableMode(l.mode) && !isSymlinkMode(l.mode) : false;
    if (l && !isSymlinkMode(l.mode) && localSha === op.hash && localExec === exec) return { status: "noop" };

    let abs: string;
    try {
      abs = await resolveInside(this.workTree, p);
    } catch (e) {
      if (isSyncCoreError(e, "symlink")) return { status: "skipped", reason: "symlink" };
      if (isSyncCoreError(e, "invalid_path")) return { status: "conflict", reason: `path_blocked: ${e.message}` };
      throw e;
    }
    const st = await lstatOrNull(abs);
    if (st?.isSymbolicLink()) return { status: "skipped", reason: "symlink" };
    if (st && !st.isFile()) return { status: "conflict", reason: "path_blocked: a directory exists here on the server" };

    let theirs: Version;
    if (op.large) {
      const ptrBuf = pointerText(op.large);
      theirs = { oid: gitBlobOid(ptrBuf), ptr: op.large };
    } else {
      let data: Buffer;
      if (op.contentBase64 !== undefined) {
        data = Buffer.from(op.contentBase64, "base64");
        if (hashBytes(data) !== op.hash) return { status: "need_content", reason: "hash_mismatch" };
      } else {
        const known = await this.blobForSha256(op.hash);
        if (!known) return { status: "need_content" };
        data = known;
      }
      if (data.length > this.largeFileBytes) return { status: "skipped", reason: "too_large" };
      theirs = { oid: gitBlobOid(data), data };
    }

    // The server's version: content when small, its pointer when large (hashed streaming, never read into memory).
    const ours: Version | null = st ? await this.workTreeVersion(p, abs, st) : null;
    const oursOid = ours?.oid ?? null;
    let baseOid = l?.oid ?? null;
    if (op.baseHash && op.baseHash !== localSha) {
      // The Mac edited an older version than `local` (e.g. an accept it has not written yet):
      // merge against what it actually started from.
      const b = await this.oidForSha256(op.baseHash);
      if (b) baseOid = b;
    }
    const oursExec = st ? isExecutableMode(st.mode) : localExec;
    // 3-way on the executable bit too: the Mac's change wins, otherwise keep the server's.
    const worktreeMode = (exec !== localExec ? exec : oursExec) ? 0o755 : 0o644;
    const commitLocal = (): void => {
      ctx.updates.push({ path: p, mode: gitFileMode(exec), oid: theirs.oid });
      if (theirs.ptr) {
        ctx.blobs.set(theirs.oid, pointerText(theirs.ptr));
        this.pointerCache.set(theirs.oid, theirs.ptr);
      } else {
        ctx.blobs.set(theirs.oid, theirs.data);
        this.hashes.remember(theirs.oid, op.hash);
      }
    };
    const writeTheirs = async (mode: number): Promise<void> => {
      if (theirs.ptr) await this.materialize(p, theirs.ptr, mode);
      else await writeFileAtomic(abs, theirs.data, mode);
    };

    if (oursOid === baseOid) {
      await writeTheirs(worktreeMode);
      commitLocal();
      return { status: "applied" };
    }
    if (oursOid === theirs.oid) {
      if (st && isExecutableMode(st.mode) !== isExecutableMode(worktreeMode)) await chmod(abs, worktreeMode);
      commitLocal();
      return { status: "applied" };
    }

    let reason: string;
    if (ours === null) {
      reason = "deleted on the server";
    } else if (ours.ptr || theirs.ptr || (baseOid && (await this.pointerOf(baseOid)))) {
      // No content merge for large files: changed on both sides is a conflict.
      reason = "large file changed on both sides";
    } else {
      const base = baseOid ? await this.readBlob(baseOid) : Buffer.alloc(0);
      const m = await this.mergeFile(ours.data!, base, theirs.data!);
      if (m.clean) {
        await writeFileAtomic(abs, m.result, worktreeMode);
        commitLocal();
        return { status: "merged" };
      }
      reason = m.reason;
    }
    if (op.force) {
      await this.ensureTrash(ctx, `sync force ${p}`);
      await writeTheirs(exec ? 0o755 : 0o644);
      commitLocal();
      return { status: "applied", reason: "forced" };
    }
    return { status: "conflict", reason };
  }

  private async applyDelete(op: Extract<SyncOp, { op: "delete" }>, ctx: ApplyCtx, ignored: Set<string>): Promise<OpResult> {
    const p = op.path;
    if (ignored.has(p)) return { status: "skipped", reason: "excluded" };
    const l = ctx.tree.get(p);
    if (!l || l.type !== "blob") return { status: "noop" };
    let abs: string;
    try {
      abs = await resolveInside(this.workTree, p);
    } catch (e) {
      if (isSyncCoreError(e, "symlink")) return { status: "skipped", reason: "symlink" };
      if (isSyncCoreError(e, "invalid_path")) {
        // A parent became a file on the server: the old path is gone from the work tree already.
        ctx.removals.push(p);
        return { status: "applied" };
      }
      throw e;
    }
    const st = await lstatOrNull(abs);
    if (!st) {
      ctx.removals.push(p);
      return { status: "applied" };
    }
    if (st.isDirectory()) return { status: "conflict", reason: "path_blocked: a directory exists here on the server" };
    const localSha = this.realSha256(l.oid);
    let baseOid = l.oid;
    if (op.baseHash && op.baseHash !== localSha) {
      const b = await this.oidForSha256(op.baseHash);
      if (b) baseOid = b;
    }
    const oursOid = st.isSymbolicLink() ? gitBlobOid(Buffer.from(await readlink(abs))) : (await this.workTreeVersion(p, abs, st)).oid;
    if (oursOid === l.oid || oursOid === baseOid) {
      await unlink(abs);
      await pruneEmptyParents(this.workTree, abs);
      ctx.removals.push(p);
      return { status: "applied" };
    }
    if (op.force) {
      await this.ensureTrash(ctx, `sync force delete ${p}`);
      await unlink(abs);
      await pruneEmptyParents(this.workTree, abs);
      ctx.removals.push(p);
      return { status: "applied", reason: "forced" };
    }
    return { status: "conflict", reason: "modified on the server" };
  }

  private async ensureTrash(ctx: ApplyCtx, reason: string): Promise<void> {
    if (ctx.trashRef) return;
    ctx.trashRef = await this.withIndex("staged", async (ix) => (await this.trashFromIndex(ix, reason)).ref);
  }

  // -------------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------------

  /**
   * Pending changes = work tree vs `local`, always recomputed from git
   * (status --porcelain=v2 + diff --numstat on a temp index that has the work
   * tree staged). `lastTouchedBy` is left null for the hub to fill in.
   */
  async review(): Promise<ReviewResult> {
    return this.locked(() =>
      this.withIndex("staged", async (ix, info) => {
        const ch = await this.collectChanges(ix, info);
        return { files: await this.toReviewFiles(ch), localCommit: await this.requireLocal() };
      }),
    );
  }

  /** Number of pending review entries. */
  async pendingCount(): Promise<number> {
    return (await this.review()).files.length;
  }

  /** Side-by-side texts and hunks for one path (old side = `local`, new side = work tree). */
  async diffFile(p: string): Promise<FileDiffResult> {
    assertRelPath(p);
    return this.locked(() =>
      this.withIndex("staged", async (ix, info) => {
        const ch = await this.collectChanges(ix, info);
        const local = await this.requireLocal();
        const rec = findRecord(ch.recs, p);
        if (!rec) {
          const e = await this.treeEntry(local, p);
          if (!e || e.type !== "blob") throw new SyncCoreError("not_found", `no such file: ${p}`);
          if (await this.pointerOf(e.oid)) {
            return { path: p, localCommit: local, diffId: hashBytes(Buffer.from(`unchanged:${e.oid}`)), binary: true, oldText: null, newText: null, hunks: [], status: "unchanged", tooLarge: true };
          }
          const blob = await this.readBlob(e.oid);
          const binary = looksBinary(blob);
          const tooLarge = blob.length > MAX_TEXT_BYTES;
          const text = binary || tooLarge ? null : blob.toString("utf8");
          return { path: p, localCommit: local, diffId: hashBytes(Buffer.from(`unchanged:${e.oid}`)), binary, oldText: text, newText: text, hunks: [], status: "unchanged", tooLarge };
        }
        const { patchLatin1: _ignored, ...fd } = await this.fileDiffFor(ix, rec, ch, local);
        return fd;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Accept / reject
  // -------------------------------------------------------------------------

  /**
   * new local = local ⊕ selected change, committed as "accept: <path>". The work
   * tree is not touched, so unselected hunks stay pending. Returns the new
   * content (base64) of every path whose `local` version changed, for the Mac to
   * write with echo suppression.
   */
  async accept(body: AcceptInput): Promise<AcceptResult> {
    return this.locked(async () => {
      await this.checkExpected(body);
      if ("all" in body && body.all === true) return this.acceptAll();
      if (!("path" in body)) throw new SyncCoreError("invalid_argument", "accept needs `path` or `all: true`");
      return this.acceptPath(assertRelPath(body.path), body.hunks);
    });
  }

  private acceptPath(p: string, hunks: readonly number[] | undefined): Promise<AcceptResult> {
    return this.withIndex("staged", async (ix, info) => {
      const ch = await this.collectChanges(ix, info);
      const local = await this.requireLocal();
      const rec = findRecord(ch.recs, p);
      if (!rec || (hunks !== undefined && hunks.length === 0)) return { localCommit: local, files: [], skipped: [] };

      let patch: string | null = null;
      if (hunks !== undefined) {
        const fd = await this.fileDiffFor(ix, rec, ch, local);
        const sel = this.selectHunks(rec, fd, hunks);
        if (sel !== "all") patch = filterPatch(fd.patchLatin1!, sel);
      }

      let tree: string;
      let files: AcceptResponse["files"];
      if (patch === null) {
        await this.assertAcceptable(rec, ch);
        const { updates, removals } = indexChangesFor([rec]);
        tree = await this.treeWith(updates, removals);
        files = await this.acceptedContents([rec], ch);
      } else {
        tree = await this.treeWithPatch(Buffer.from(patch, "latin1"));
        const e = await this.treeEntry(tree, rec.path);
        if (!e) throw new SyncCoreError("git", `accepted tree lacks ${rec.path}`);
        files = [{ path: rec.path, contentBase64: (await this.readBlob(e.oid)).toString("base64"), deleted: false }];
      }
      const commit = await this.commitTree(tree, [local], `accept: ${rec.path}`, { "Workstation-Kind": "accept" });
      await this.updateLocal(commit, local, "accept");
      return { localCommit: commit, files, skipped: [] };
    });
  }

  private acceptAll(): Promise<AcceptResult> {
    return this.withIndex("staged", async (ix, info) => {
      const ch = await this.collectChanges(ix, info);
      const local = await this.requireLocal();
      const ok: ChangeRecord[] = [];
      const skipped: AcceptResult["skipped"] = [];
      const sizes = await this.objectSizes(ch.recs.map((r) => r.newOid).filter((o): o is string => o !== null));
      for (const r of ch.recs) {
        try {
          await this.assertAcceptable(r, ch, sizes);
          ok.push(r);
        } catch (e) {
          if (!isSyncCoreError(e)) throw e;
          skipped.push({ path: r.path, reason: e.code });
        }
      }
      if (ok.length === 0) return { localCommit: local, files: [], skipped };
      const { updates, removals } = indexChangesFor(ok);
      const tree = await this.treeWith(updates, removals);
      const commit = await this.commitTree(tree, [local], `accept: all (${ok.length} file${ok.length === 1 ? "" : "s"})`, { "Workstation-Kind": "accept" });
      await this.updateLocal(commit, local, "accept");
      return { localCommit: commit, files: await this.acceptedContents(ok, ch), skipped };
    });
  }

  /**
   * Revert work-tree changes back to `local` (a trash ref is written first).
   * Whole file: `git restore --source=local` (removes a new file). Hunks:
   * `git apply -R` of the selected hunks.
   */
  async reject(body: RejectInput): Promise<RejectResult> {
    return this.locked(async () => {
      await this.checkExpected(body);
      return this.withIndex("staged", async (ix, info) => {
        const ch = await this.collectChanges(ix, info);
        const local = await this.requireLocal();
        let targets: ChangeRecord[];
        let hunks: readonly number[] | undefined;
        if ("all" in body && body.all === true) {
          targets = ch.recs;
        } else if ("path" in body) {
          const rec = findRecord(ch.recs, assertRelPath(body.path));
          targets = rec ? [rec] : [];
          hunks = body.hunks;
        } else {
          throw new SyncCoreError("invalid_argument", "reject needs `path` or `all: true`");
        }
        if (targets.length === 0 || (hunks !== undefined && hunks.length === 0)) return { localCommit: local, trashRef: null, paths: [] };

        let patch: string | null = null;
        if (hunks !== undefined) {
          const rec = targets[0]!;
          const fd = await this.fileDiffFor(ix, rec, ch, local);
          const sel = this.selectHunks(rec, fd, hunks);
          if (sel !== "all") patch = filterPatch(fd.patchLatin1!, sel, { reverse: true });
        }

        // Large files on the `local` side come back from the store: check it holds them before touching anything.
        const largeBack = new Map<string, { ptr: LargePointer; mode: number }>();
        if (patch === null) {
          for (const r of targets) {
            const ptr = r.oldOid ? ch.pointers.get(r.oldOid) : undefined;
            if (ptr && r.status !== "added") largeBack.set(r.oldPath ?? r.path, { ptr, mode: r.oldMode });
          }
          for (const [p, v] of largeBack) await this.largeStore.require(v.ptr, p);
        }

        const label = "all" in body ? "all" : targets[0]!.path + (patch ? ` (hunks ${hunks!.join(",")})` : "");
        const trash = await this.trashFromIndex(ix, `reject ${label}`);
        if (patch !== null) {
          await ix.run(["apply", "-R", "--whitespace=nowarn", "-"], { input: Buffer.from(patch, "latin1") });
        } else {
          const restore: string[] = [];
          const remove: string[] = [];
          for (const r of targets) {
            if (r.status === "added" && r.unstaged) remove.push(r.path);
            else {
              if (!largeBack.has(r.path)) restore.push(r.path);
              // A rename whose old side is large: the new path goes (not in `local`), the old one is materialized.
              if (r.oldPath && !largeBack.has(r.oldPath)) restore.push(r.oldPath);
            }
          }
          for (const [p, v] of largeBack) await this.materialize(p, v.ptr, v.mode);
          if (restore.length > 0) {
            await ix.run(["restore", `--source=${local}`, "--worktree", "--no-overlay", "--pathspec-from-file=-", "--pathspec-file-nul"], {
              input: restore.join("\0") + "\0",
            });
          }
          for (const p of remove) {
            const abs = await resolveInside(this.workTree, p);
            await unlink(abs).catch(() => undefined);
          }
        }
        return { localCommit: local, trashRef: trash.ref, paths: targets.map((r) => r.path) };
      });
    });
  }

  // -------------------------------------------------------------------------
  // Snapshots, trash, history, restore
  // -------------------------------------------------------------------------

  /**
   * End-of-turn snapshot: temp index ← work tree, write-tree, commit-tree with
   * the previous snapshot of the session (or `local`) as parent, update-ref
   * refs/snapshots/<sessionId>/<turn>. Touches neither work tree nor `local`.
   */
  async snapshot(input: SnapshotInput): Promise<SnapshotResult> {
    const { sessionId, turn } = input;
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
      throw new SyncCoreError("invalid_argument", `invalid session id: ${String(sessionId)}`);
    }
    if (!Number.isInteger(turn) || turn < 0) throw new SyncCoreError("invalid_argument", `invalid turn: ${turn}`);
    return this.locked(() =>
      this.withIndex("staged", async (ix) => {
        const tree = await this.writeTree(ix);
        const prefix = `refs/snapshots/${sessionId}/`;
        const refs = await this.forEachRef(`refs/snapshots/${sessionId}`);
        let parent = await this.requireLocal();
        let best = -1;
        for (const r of refs) {
          const t = Number(r.ref.slice(prefix.length));
          if (Number.isInteger(t) && t < turn && t > best) {
            best = t;
            parent = r.oid;
          }
        }
        const changed = (await this.revParse(`${parent}^{tree}`)) !== tree;
        const at = this.stamp();
        const message = oneLine(input.message) || `turn ${turn}`;
        const commit = await this.commitTree(tree, [parent], message, {
          "Workstation-Kind": "snapshot",
          "Workstation-At": at,
          "Workstation-Session": sessionId,
          "Workstation-Turn": String(turn),
          "Workstation-Changed": changed ? "yes" : "no",
        });
        const ref = `${prefix}${turn}`;
        await this.git.run(["update-ref", "-m", "snapshot", ref, commit]);
        return { ref, sessionId, turn, at, message, kind: "snapshot", changed, commit };
      }),
    );
  }

  /** Save the current work tree (non-ignored files ≤ MAX_SYNC_FILE_BYTES) to refs/trash/<timestamp>. */
  async trash(reason: string): Promise<Snapshot> {
    return this.locked(() => this.withIndex("staged", (ix) => this.trashFromIndex(ix, reason)));
  }

  /** `local` commits (sync/accept/baseline) + snapshot and trash refs, newest first. */
  async history(opts: HistoryOptions = {}): Promise<Snapshot[]> {
    const limit = opts.limit ?? 500;
    const includeUnchanged = opts.includeUnchanged ?? true;
    return this.locked(async () => {
      const out: Snapshot[] = [];
      const log = await this.git.run(["log", "-z", `--max-count=${limit}`, "--format=%H%x1f%cI%x1f%B", LOCAL_REF]);
      for (const rec of splitNul(log.stdout)) {
        const [oid, cdate, body = ""] = rec.split("\x1f");
        const tr = parseTrailers(body);
        const k = tr["Workstation-Kind"];
        if (k === "init") continue;
        out.push({ ref: oid!, sessionId: null, turn: null, at: tr["Workstation-At"] ?? isoUtc(cdate!), message: firstLine(body), kind: k === "accept" ? "accept" : "sync" });
      }
      const fmt = "--format=%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(contents)%00";
      const refs = await this.git.run(["for-each-ref", fmt, "refs/snapshots", "refs/trash"]);
      for (let rec of splitNul(refs.stdout)) {
        rec = rec.replace(/^\n/, "");
        if (!rec) continue;
        const [ref, , cdate, body = ""] = rec.split("\x1f");
        const tr = parseTrailers(body);
        if (ref!.startsWith("refs/snapshots/")) {
          if (!includeUnchanged && tr["Workstation-Changed"] === "no") continue;
          const rest = ref!.slice("refs/snapshots/".length);
          const slash = rest.lastIndexOf("/");
          const turn = Number(rest.slice(slash + 1));
          out.push({
            ref: ref!,
            sessionId: tr["Workstation-Session"] ?? rest.slice(0, slash),
            turn: Number.isInteger(turn) ? turn : null,
            at: tr["Workstation-At"] ?? isoUtc(cdate!),
            message: firstLine(body),
            kind: "snapshot",
          });
        } else {
          out.push({ ref: ref!, sessionId: null, turn: null, at: tr["Workstation-At"] ?? isoUtc(cdate!), message: firstLine(body), kind: "trash" });
        }
      }
      return out
        .map((s, i) => ({ s, i, t: Date.parse(s.at) }))
        .sort((a, b) => b.t - a.t || a.i - b.i)
        .slice(0, limit)
        .map((x) => x.s);
    });
  }

  /**
   * Write `path` (or the whole tree) from `ref` into the work tree, after
   * saving the current state to a trash ref. Files under `path` that do not
   * exist in `ref` are removed (no-overlay). `local` is not changed.
   */
  async restore(body: RestoreBody): Promise<RestoreResult> {
    const ref = validateRef(body.ref);
    const p = body.path === undefined ? undefined : assertRelPath(body.path);
    return this.locked(async () => {
      const local = await this.requireLocal();
      const commit = await this.resolveCommit(ref);
      return this.withIndex("staged", async (ix) => {
        if (p !== undefined) {
          const inRef = await this.treeEntry(commit, p);
          const inWork = await this.indexHasPath(ix, p);
          if (!inRef && !inWork) throw new SyncCoreError("not_found", `${p} exists neither in ${ref} nor in the work tree`);
        }
        // Large files in `ref` come from the store: all of them must be there before anything is touched.
        const large = await this.pointerEntries(commit, p);
        for (const e of large) await this.largeStore.require(e.ptr, e.path);
        const trash = await this.trashFromIndex(ix, `restore ${ref}${p ? ` ${p}` : ""}`);
        if (large.length === 0) {
          await ix.run(["restore", `--source=${commit}`, "--worktree", "--no-overlay", "--", p ?? "."]);
        } else {
          // git restores everything else (pointer paths excluded, so no pointer text is ever written)…
          const specs = [p === undefined ? "." : `:(literal)${p}`, ...large.map((e) => `:(exclude,literal)${e.path}`)];
          const r = await ix.run(["restore", `--source=${commit}`, "--worktree", "--no-overlay", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            input: specs.join("\0") + "\0",
            literalPathspecs: false,
            okCodes: "any",
          });
          // Nothing but large files under `path` (and nothing of it in the work tree): git has nothing to match.
          const unmatched = (l: string): boolean => /^error: pathspec .* did not match any file\(s\) known to git$/.test(l);
          if (r.code !== 0 && !r.stderr.split("\n").filter((l) => l.trim() !== "").every(unmatched)) {
            throw new GitError(["restore", `--source=${commit}`], r);
          }
          // …and the large files are streamed from the store (skipped when the work tree already holds that version).
          for (const e of large) await this.materialize(e.path, e.ptr, e.mode);
        }
        await this.largeHashes.flush();
        return { localCommit: local, trashRef: trash.ref, commit };
      });
    });
  }

  // -------------------------------------------------------------------------
  // Files, sizes, deletion checks, gc
  // -------------------------------------------------------------------------

  /**
   * Work-tree bytes of a regular file (null when missing, a directory, or a
   * symlink). Records the path as downloaded for {@link canDelete}.
   */
  async rawFile(p: string): Promise<Buffer | null> {
    assertRelPath(p);
    return this.locked(async () => {
      let abs: string;
      try {
        abs = await resolveInside(this.workTree, p);
      } catch (e) {
        if (isSyncCoreError(e, "symlink") || isSyncCoreError(e, "invalid_path")) return null;
        throw e;
      }
      const st = await lstatOrNull(abs);
      if (!st || !st.isFile()) return null;
      if (st.size > this.largeFileBytes) throw new SyncCoreError("too_large", `${p} is a large file (> ${this.largeFileBytes} bytes); stream it (resolveFile)`);
      const buf = await readFile(abs);
      await this.recordDownloaded([[p, gitBlobOid(buf)]]);
      return buf;
    });
  }

  /**
   * Absolute path of a work-tree file for streaming (e.g. zip downloads), or
   * null when it is not a regular file reachable without symlinks. Pair with
   * {@link markDownloaded}.
   */
  async resolveFile(p: string): Promise<string | null> {
    try {
      const abs = await resolveInside(this.workTree, p);
      const st = await lstatOrNull(abs);
      return st?.isFile() ? abs : null;
    } catch (e) {
      if (isSyncCoreError(e, "symlink") || isSyncCoreError(e, "invalid_path")) return null;
      throw e;
    }
  }

  /** Record that the current content of these paths was downloaded by the user. */
  async markDownloaded(paths: readonly string[]): Promise<void> {
    return this.locked(async () => {
      const pairs: [string, string][] = [];
      for (const p of paths) {
        const abs = await this.resolveFile(assertRelPath(p));
        if (!abs) continue;
        const st = await stat(abs);
        pairs.push([p, await this.workTreeOid(p, abs, st)]);
      }
      await this.recordDownloaded(pairs);
      await this.largeHashes.flush();
    });
  }

  /**
   * "Pull back and clear" gate. `ok` means: no tracked file differs from
   * `local`, and every new file was downloaded (or accepted). Ignored files are
   * not considered.
   */
  async canDelete(): Promise<CanDeleteResult> {
    return this.locked(() =>
      this.withIndex("staged", async (ix, info) => {
        const ch = await this.collectChanges(ix, info);
        const state = await this.loadState();
        let undownloaded = 0;
        let blocking = 0;
        for (const r of ch.recs) {
          if (r.status !== "added") {
            blocking++;
            continue;
          }
          let oid = r.newOid;
          if (!oid) {
            const abs = await this.resolveFile(r.path);
            if (abs) oid = await this.workTreeOid(r.path, abs, await stat(abs));
          }
          if (!oid || state.downloaded[r.path] !== oid) {
            undownloaded++;
            blocking++;
          }
        }
        return { ok: blocking === 0, pendingFiles: ch.recs.length, undownloadedFiles: undownloaded };
      }),
    );
  }

  /** Disk usage of the work tree in bytes (`du -sk`, falls back to summing file sizes). */
  async size(): Promise<number> {
    return diskUsage(this.workTree);
  }

  /** Disk usage of the bare repository in bytes. */
  async gitDirSize(): Promise<number> {
    return diskUsage(this.gitDir);
  }

  /** Disk usage of the large-file store in bytes (0 before the first large file). */
  async largeStoreSize(): Promise<number> {
    if (!(await lstatOrNull(this.largeStore.dir))) return 0;
    return diskUsage(this.largeStore.dir);
  }

  /** Fields of the protocol `Project` that come from the repository (size = work tree + large-file store). */
  async projectStats(): Promise<ProjectStats> {
    const { files, localCommit } = await this.review();
    return { localCommit, pendingFiles: files.length, sizeBytes: (await this.size()) + (await this.largeStoreSize()) };
  }

  /**
   * The pointer a blob holds, or null when it is not a large-file pointer. Cheap for any blob: only blobs of pointer
   * size are read.
   */
  async largePointer(oid: string): Promise<LargePointer | null> {
    return this.pointerOf(oid);
  }

  /** The large file at `path` on `local` (its pointer), or null when absent or not a large file. */
  async localLargeFile(p: string): Promise<LargePointer | null> {
    assertRelPath(p);
    const e = await this.treeEntry(LOCAL_REF, p);
    return e && e.type === "blob" ? this.pointerOf(e.oid) : null;
  }

  /** `git gc --auto` (synchronous; unreachable objects younger than 2 weeks are kept). */
  async gc(): Promise<void> {
    await this.locked(async () => {
      await this.git.run(["gc", "--auto", "--quiet"]);
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Run `fn` with a private temp index (GIT_INDEX_FILE) that is deleted
   * afterwards, so concurrent operations never share an index.
   *  - "staged": index = `local`, then the work tree staged on top
   *    (`add -u` + untracked files ≤ MAX_SYNC_FILE_BYTES). Seeded from and saved
   *    back to the stat cache so unchanged files are not re-hashed.
   *  - "local":  index = `local` only.
   *  - "empty":  empty index.
   */
  private async withIndex<T>(
    kind: "staged" | "local" | "empty",
    fn: (ix: TempIndex, info: StageInfo) => Promise<T>,
    o: { workTree?: string; saveCache?: boolean } = {},
  ): Promise<T> {
    const file = path.join(this.tmpDir, `index-${randomUUID()}`);
    const ix: TempIndex = {
      file,
      assumed: [],
      run: (args, ro = {}) => this.git.run(args, { ...ro, workTree: ro.workTree ?? o.workTree, env: { ...ro.env, GIT_INDEX_FILE: file } }),
    };
    let saved = false;
    try {
      let info: StageInfo = { large: new Map(), failed: new Set() };
      if (kind !== "empty") {
        const seeded = kind === "staged" && this.statCache && (await this.seedIndex(file));
        try {
          await ix.run(seeded ? ["read-tree", "-m", LOCAL_REF] : ["read-tree", LOCAL_REF]);
        } catch (e) {
          if (!seeded) throw e;
          await rm(file, { force: true });
          await ix.run(["read-tree", LOCAL_REF]);
        }
      }
      if (kind === "staged") info = await this.stage(ix, {});
      const result = await fn(ix, info);
      await this.largeHashes.flush();
      if ((kind === "staged" || o.saveCache) && this.statCache && (await lstatOrNull(file))) {
        // Pointer entries are assume-unchanged only for this operation: the next one decides their representation
        // again (a large file may have become small), so the cache must not keep the flag.
        if (ix.assumed.length > 0) {
          await ix.run(["update-index", "--no-assume-unchanged", "-z", "--stdin"], { input: ix.assumed.join("\0") + "\0", okCodes: "any", workTree: o.workTree });
        }
        await rename(file, this.cacheIndex);
        saved = true;
      }
      return result;
    } finally {
      if (!saved) await rm(file, { force: true });
      await rm(`${file}.lock`, { force: true });
    }
  }

  /**
   * Copy the stat cache into a fresh temp index. The copy keeps the cache's
   * mtime (minus 1 ms) because git's racy-clean detection compares entry
   * mtimes with the index file's own mtime.
   */
  private async seedIndex(file: string): Promise<boolean> {
    try {
      const st = await stat(this.cacheIndex);
      await copyFile(this.cacheIndex, file);
      const t = (st.mtimeMs - 1) / 1000;
      await utimes(file, t, t);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stage the work tree (or `root`) into the temp index. Large files never pass through git: each is hashed
   * (streamed, cached by stat), put into the store when absent, and staged as its pointer blob with the entry marked
   * assume-unchanged — so neither `add -u` nor `status` ever reads the file.
   */
  private async stage(ix: TempIndex, o: { root?: string; skipSymlinks?: boolean }): Promise<StageInfo> {
    const root = o.root ?? this.workTree;
    const wt = o.root ? { workTree: o.root } : {};
    const large = new Map<string, LargePointer>();
    const failed = new Set<string>();

    // Tracked paths whose file is now large (the "oversized" check for tracked files).
    const tracked = parseLsFilesStageZ((await ix.run(["ls-files", "-s", "-z"], wt)).stdout).filter(
      (e) => e.type === "blob" && !isSymlinkMode(e.mode),
    );
    const tstats = await mapLimit(tracked, 64, (e) => lstatOrNull(path.join(root, e.path)).catch(() => null));
    const largeFiles: [string, Stats][] = [];
    tracked.forEach((e, i) => {
      const st = tstats[i];
      if (st?.isFile() && st.size > this.largeFileBytes) largeFiles.push([e.path, st]);
    });
    const trackedLarge = largeFiles.length;

    const excludeArgs = this.honorGitignore ? ["--exclude-standard"] : [`--exclude-from=${path.join(this.gitDir, "info", "exclude")}`];
    const ls = await ix.run(["ls-files", "-o", "-z", ...excludeArgs], wt);
    const candidates = splitNul(ls.stdout).filter((p) => p !== "" && !p.endsWith("/"));
    const add: string[] = [];
    const stats = await mapLimit(candidates, 64, (p) => lstatOrNull(path.join(root, p)));
    candidates.forEach((p, i) => {
      const st = stats[i];
      if (!st) return;
      if (st.isSymbolicLink()) {
        if (!o.skipSymlinks) add.push(p);
        return;
      }
      if (!st.isFile()) return;
      if (st.size > this.largeFileBytes) largeFiles.push([p, st]);
      else add.push(p);
    });

    if (largeFiles.length > 0) {
      const lines: string[] = [];
      const blobs = new Map<string, Buffer>();
      for (const [i, [p, st]] of largeFiles.entries()) {
        let ptr: LargePointer;
        try {
          ptr = await this.ingestLarge(p, path.join(root, p), st, root === this.workTree);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (isSyncCoreError(e) || typeof code !== "string") throw e;
          // Vanished, unreadable, or the store could not take it: never let git hash it. A tracked one keeps its
          // `local` entry (reported unstaged); an untracked one stays out of the index (unstaged "added").
          if (i < trackedLarge) failed.add(p);
          continue;
        }
        const buf = pointerText(ptr);
        const oid = gitBlobOid(buf);
        blobs.set(oid, buf);
        this.pointerCache.set(oid, ptr);
        large.set(p, ptr);
        lines.push(`${gitFileMode(isExecutableMode(st.mode)).toString(8)} ${oid}\t${p}\0`);
      }
      await this.writeBlobs(blobs);
      if (lines.length > 0) await ix.run(["update-index", "--add", "--replace", "-z", "--index-info"], { ...wt, input: lines.join("") });
      const assume = [...large.keys(), ...failed];
      if (assume.length > 0) {
        await ix.run(["update-index", "--assume-unchanged", "-z", "--stdin"], { ...wt, input: assume.join("\0") + "\0" });
        ix.assumed.push(...assume);
      }
    }

    // Small tracked files (assume-unchanged pointer entries are skipped by `add -u`).
    await ix.run(["add", "-u", "--ignore-errors"], { ...wt, okCodes: [0, 1] });
    if (add.length > 0) {
      const input = add.join("\0") + "\0";
      const r = await ix.run(["update-index", "--add", "-z", "--stdin"], { ...wt, input, okCodes: "any" });
      if (r.code !== 0) {
        // A file vanished between listing and hashing: retry with what still exists.
        const still: string[] = [];
        for (const p of add) if (await lstatOrNull(path.join(root, p))) still.push(p);
        if (still.length > 0) await ix.run(["update-index", "--add", "-z", "--stdin"], { ...wt, input: still.join("\0") + "\0" });
      }
    }
    return { large, failed };
  }

  private async collectChanges(ix: TempIndex, info: StageInfo): Promise<Changes> {
    const st = await ix.run(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames"]);
    const gitlink = (m: number): boolean => (m & 0o170000) === GIT_MODE_GITLINK;
    let recs = pairRenames(porcelainToChanges(parsePorcelainV2(st.stdout)).filter((r) => !gitlink(r.oldMode) && !gitlink(r.newMode)));
    if (info.failed.size > 0) {
      // Tracked large files that could not be read: pending, but nothing can be accepted.
      const have = new Set(recs.map((r) => r.path));
      const extra: ChangeRecord[] = [];
      for (const p of info.failed) if (!have.has(p)) extra.push({ path: p, status: "modified", oldMode: 0, newMode: 0, oldOid: null, newOid: null, unstaged: true });
      recs = [...recs, ...extra].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    const ns = await ix.run(["diff", "--cached", "-M", "--numstat", "-z", "--no-ext-diff", "--no-textconv", LOCAL_REF, "--"]);
    const counts = new Map(parseNumstatZ(ns.stdout).map((e) => [e.path, e] as const));
    const pointers = await this.pointersOf(recs.flatMap((r) => [r.oldOid, r.newOid]).filter((o): o is string => o !== null));
    return { recs, counts, pointers };
  }

  private async toReviewFiles(ch: Changes): Promise<ReviewFile[]> {
    const isLarge = (r: ChangeRecord): boolean => (r.oldOid !== null && ch.pointers.has(r.oldOid)) || (r.newOid !== null && ch.pointers.has(r.newOid));
    const sizes = await this.objectSizes(ch.recs.filter((r) => r.oldOid && (r.status === "deleted" || isLarge(r))).map((r) => r.oldOid!));
    const localSize = (r: ChangeRecord): number => (r.oldOid ? ch.pointers.get(r.oldOid)?.size ?? sizes.get(r.oldOid) ?? 0 : 0);
    const out: ReviewFile[] = [];
    for (const r of ch.recs) {
      const c = ch.counts.get(r.path);
      const large = isLarge(r);
      let size = 0;
      if (r.status === "deleted") size = localSize(r);
      else size = (await lstatOrNull(path.join(this.workTree, r.path)))?.size ?? 0;
      const f: ReviewFile = {
        path: r.path,
        status: r.status,
        binary: large || r.unstaged ? true : (c?.binary ?? false),
        additions: large ? 0 : (c?.additions ?? 0),
        deletions: large ? 0 : (c?.deletions ?? 0),
        sizeBytes: size,
        lastTouchedBy: null,
      };
      if (r.oldPath !== undefined) f.oldPath = r.oldPath;
      if (large) {
        f.large = true;
        if (r.oldOid) f.oldSizeBytes = localSize(r);
      }
      out.push(f);
    }
    return out;
  }

  private async fileDiffFor(ix: TempIndex, rec: ChangeRecord, ch: Changes, localCommit: string): Promise<FileDiffResult & { patchLatin1: string | null }> {
    const sizes = await this.objectSizes([rec.oldOid, rec.newOid].filter((o): o is string => o !== null));
    const large = (rec.oldOid !== null && ch.pointers.has(rec.oldOid)) || (rec.newOid !== null && ch.pointers.has(rec.newOid));
    const oldSize = rec.oldOid ? sizes.get(rec.oldOid) ?? 0 : 0;
    const newSize = rec.newOid ? sizes.get(rec.newOid) ?? 0 : 0;
    // A large file (either side a pointer) has no text payload: whole-file accept/reject only.
    const tooLarge = large || oldSize > MAX_TEXT_BYTES || newSize > MAX_TEXT_BYTES;
    const binary = large || rec.unstaged ? true : (ch.counts.get(rec.path)?.binary ?? false);
    let hunks: FileDiff["hunks"] = [];
    let patchLatin1: string | null = null;
    let oldText: string | null = null;
    let newText: string | null = null;
    if (!binary && !tooLarge) {
      const paths = rec.oldPath ? [rec.oldPath, rec.path] : [rec.path];
      const out = await ix.run(["diff", "--cached", "-M", ...DIFF_FLAGS, LOCAL_REF, "--", ...paths]);
      patchLatin1 = out.stdout.toString("latin1");
      hunks = parseUnifiedDiff(out.stdout.toString("utf8"));
      oldText = rec.oldOid ? (await this.readBlob(rec.oldOid)).toString("utf8") : "";
      newText = rec.newOid ? (await this.readBlob(rec.newOid)).toString("utf8") : "";
    }
    const fd: FileDiffResult & { patchLatin1: string | null } = {
      path: rec.path,
      localCommit,
      // Fingerprint of the diff the hunk indices refer to; the hub rejects stale ids with 409.
      diffId: hashBytes(Buffer.from(patchLatin1 ?? `${rec.status}:${rec.oldOid ?? ""}:${rec.newOid ?? ""}`, "latin1")),
      binary,
      oldText,
      newText,
      hunks,
      status: rec.status,
      tooLarge,
      patchLatin1,
    };
    if (rec.oldPath !== undefined) fd.oldPath = rec.oldPath;
    return fd;
  }

  /** Validate a hunk selection; "all" when it covers every hunk (→ whole-file operation). */
  private selectHunks(rec: ChangeRecord, fd: FileDiffResult & { patchLatin1: string | null }, hunks: readonly number[]): number[] | "all" {
    if (fd.binary || fd.tooLarge || fd.patchLatin1 === null) {
      throw new SyncCoreError("binary", `${rec.path} has no text diff (binary or larger than 2 MB); accept or reject the whole file`);
    }
    const sel = new Set<number>();
    for (const h of hunks) {
      if (!Number.isInteger(h) || h < 0 || h >= fd.hunks.length) {
        throw new SyncCoreError("stale", `hunk ${h} does not exist (${rec.path} has ${fd.hunks.length} hunks)`);
      }
      sel.add(h);
    }
    if (sel.size === fd.hunks.length) return "all";
    if (rec.status !== "modified") throw new SyncCoreError("unsupported", `hunk selection is only supported for modified files (${rec.path} is ${rec.status})`);
    return [...sel].sort((a, b) => a - b);
  }

  private async assertAcceptable(r: ChangeRecord, ch: Changes, sizes?: Map<string, number>): Promise<void> {
    if (r.unstaged && r.status !== "deleted") throw new SyncCoreError("unreadable", `${r.path} could not be read`);
    if (r.status !== "deleted" && isSymlinkMode(r.newMode)) throw new SyncCoreError("symlink", `${r.path} is a symlink; symlinks are not synced`);
    if (r.newOid) {
      const ptr = ch.pointers.get(r.newOid);
      if (ptr) {
        // `local` only ever points at versions the store holds.
        await this.largeStore.require(ptr, r.path);
        return;
      }
      const size = (sizes ?? (await this.objectSizes([r.newOid]))).get(r.newOid) ?? 0;
      if (size > MAX_SYNC_FILE_BYTES) throw new SyncCoreError("too_large", `${r.path} is larger than ${MAX_SYNC_FILE_BYTES} bytes`);
    }
  }

  /** Large files come back as `{contentBase64: null, large: true, sha256, size}` (the Mac downloads them by Range). */
  private async acceptedContents(recs: readonly ChangeRecord[], ch: Changes): Promise<AcceptResponse["files"]> {
    const blobs = await this.readBlobs(recs.map((r) => r.newOid).filter((o): o is string => o !== null && !ch.pointers.has(o)));
    const out: AcceptResponse["files"] = [];
    for (const r of recs) {
      if (r.oldPath !== undefined) out.push({ path: r.oldPath, contentBase64: null, deleted: true });
      const ptr = r.newOid ? ch.pointers.get(r.newOid) : undefined;
      if (r.status === "deleted") out.push({ path: r.path, contentBase64: null, deleted: true });
      else if (ptr) out.push({ path: r.path, contentBase64: null, deleted: false, large: true, sha256: ptr.sha256, size: ptr.size });
      else out.push({ path: r.path, contentBase64: (blobs.get(r.newOid!) ?? Buffer.alloc(0)).toString("base64"), deleted: false });
    }
    return out;
  }

  /** Tree = `local` with these index entries replaced/removed. */
  private treeWith(updates: readonly IndexUpdate[], removals: readonly string[]): Promise<string> {
    return this.withIndex("local", async (ix) => {
      const lines =
        removals.map((p) => `0 ${ZERO_OID}\t${p}\0`).join("") + updates.map((u) => `${u.mode.toString(8)} ${u.oid}\t${u.path}\0`).join("");
      if (lines) await ix.run(["update-index", "--add", "--replace", "-z", "--index-info"], { input: lines });
      return this.writeTree(ix);
    });
  }

  /** Tree = `local` with a patch applied to the index (`git apply --cached`). */
  private treeWithPatch(patch: Buffer): Promise<string> {
    return this.withIndex("local", async (ix) => {
      try {
        await ix.run(["apply", "--cached", "--whitespace=nowarn", "-"], { input: patch });
      } catch (e) {
        throw new SyncCoreError("stale", `selected hunks no longer apply to local: ${(e as Error).message}`);
      }
      return this.writeTree(ix);
    });
  }

  private async writeTree(ix: TempIndex): Promise<string> {
    return (await ix.run(["write-tree"])).stdout.toString().trim();
  }

  private async trashFromIndex(ix: TempIndex, reason: string): Promise<Snapshot> {
    return this.writeTrash(await this.writeTree(ix), reason);
  }

  private async writeTrash(tree: string, reason: string): Promise<Snapshot> {
    const local = await this.requireLocal();
    const at = this.stamp();
    const ref = `refs/trash/${at.replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
    const message = `trash: ${oneLine(reason)}`;
    const commit = await this.commitTree(tree, [local], message, { "Workstation-Kind": "trash", "Workstation-At": at });
    await this.git.run(["update-ref", "-m", "trash", ref, commit, ZERO_OID]);
    return { ref, sessionId: null, turn: null, at, message, kind: "trash" };
  }

  /**
   * Millisecond timestamp, strictly increasing per instance, stored as the
   * `Workstation-At` trailer (git's own dates have 1 s resolution) so history order is exact.
   */
  private stamp(): string {
    let t = Date.now();
    if (t <= this.lastStamp) t = this.lastStamp + 1;
    this.lastStamp = t;
    return new Date(t).toISOString();
  }

  private async commitTree(tree: string, parents: readonly string[], subject: string, trailers: Record<string, string>): Promise<string> {
    const t: Record<string, string> = { ...trailers };
    if (t["Workstation-At"] === undefined) t["Workstation-At"] = this.stamp();
    const body = [oneLine(subject) || "(no message)", "", ...Object.entries(t).map(([k, v]) => `${k}: ${oneLine(v)}`)].join("\n") + "\n";
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])];
    return (await this.git.run(args, { input: body })).stdout.toString().trim();
  }

  private async updateLocal(next: string, prev: string, why: string): Promise<void> {
    await this.git.run(["update-ref", "-m", why, LOCAL_REF, next, prev]);
  }

  private async revParse(rev: string): Promise<string> {
    return (await this.git.run(["rev-parse", "--verify", "--end-of-options", rev])).stdout.toString().trim();
  }

  private async resolveCommit(ref: string): Promise<string> {
    const r = await this.git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { okCodes: [0, 1, 128] });
    const s = r.stdout.toString().trim();
    if (r.code !== 0 || !s) throw new SyncCoreError("not_found", `unknown ref ${ref}`);
    return s;
  }

  private async forEachRef(prefix: string): Promise<{ ref: string; oid: string }[]> {
    const r = await this.git.run(["for-each-ref", "--format=%(refname)%00%(objectname)", prefix]);
    return r.stdout
      .toString("utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [ref, oid] = l.split("\0");
        return { ref: ref!, oid: oid! };
      });
  }

  private async lsTreeMap(rev: string): Promise<Map<string, TreeEntry>> {
    const r = await this.git.run(["ls-tree", "-r", "-z", "--full-tree", rev]);
    return new Map(parseLsTreeZ(r.stdout).map((e) => [e.path, e] as const));
  }

  private async treeEntry(rev: string, p: string): Promise<TreeEntry | null> {
    const r = await this.git.run(["ls-tree", "-z", "--full-tree", rev, "--", p]);
    return parseLsTreeZ(r.stdout).find((e) => e.path === p) ?? null;
  }

  private async indexHasPath(ix: TempIndex, p: string): Promise<boolean> {
    const r = await ix.run(["ls-files", "-z", "--", p]);
    return r.stdout.length > 0;
  }

  private async hasObject(oid: string): Promise<boolean> {
    return (await this.git.run(["cat-file", "-e", oid], { okCodes: "any" })).code === 0;
  }

  private async readBlob(oid: string): Promise<Buffer> {
    return (await this.git.run(["cat-file", "blob", oid])).stdout;
  }

  private async readBlobs(oids: readonly string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    let cur: Buffer[] = [];
    let curOid = "";
    await this.catFileBatch([...new Set(oids)], {
      begin: (oid) => {
        curOid = oid;
        cur = [];
      },
      data: (c) => cur.push(c),
      end: () => out.set(curOid, Buffer.concat(cur)),
    });
    return out;
  }

  private async objectSizes(oids: readonly string[]): Promise<Map<string, number>> {
    const uniq = [...new Set(oids)];
    const out = new Map<string, number>();
    if (uniq.length === 0) return out;
    const r = await this.git.run(["cat-file", "--batch-check"], { input: uniq.join("\n") + "\n" });
    for (const line of r.stdout.toString("latin1").split("\n")) {
      const [oid, type, size] = line.split(" ");
      if (oid && type && type !== "missing" && size) out.set(oid, Number(size));
    }
    return out;
  }

  /** Make sure the sha256 of every listed blob is cached (streams `cat-file --batch`). */
  private async ensureSha256(oids: readonly string[]): Promise<void> {
    await this.hashes.load();
    const missing = [...new Set(oids)].filter((o) => this.hashes.sha256Of(o) === undefined);
    if (missing.length > 0) {
      let h = createHash("sha256");
      let curOid = "";
      await this.catFileBatch(missing, {
        begin: (oid) => {
          curOid = oid;
          h = createHash("sha256");
        },
        data: (c) => h.update(c),
        end: () => this.hashes.remember(curOid, h.digest("hex")),
      });
    }
    await this.hashes.flush();
  }

  // -------------------------------------------------------------------------
  // Large files: pointers, hashing, store
  // -------------------------------------------------------------------------

  /** Pointers among these blobs (others are absent from the map). Only blobs of pointer size are read. */
  private async pointersOf(oids: readonly string[]): Promise<Map<string, LargePointer>> {
    const out = new Map<string, LargePointer>();
    const unknown: string[] = [];
    for (const o of new Set(oids)) {
      const c = this.pointerCache.get(o);
      if (c) out.set(o, c);
      else if (c === undefined) unknown.push(o);
    }
    if (unknown.length === 0) return out;
    const sizes = await this.objectSizes(unknown);
    const small = unknown.filter((o) => (sizes.get(o) ?? Infinity) <= POINTER_MAX_BYTES);
    for (const o of unknown) if (sizes.has(o) && !small.includes(o)) this.pointerCache.set(o, null);
    if (small.length > 0) {
      const blobs = await this.readBlobs(small);
      for (const o of small) {
        const b = blobs.get(o);
        if (!b) continue;
        const ptr = parsePointer(b);
        this.pointerCache.set(o, ptr);
        if (ptr) out.set(o, ptr);
      }
    }
    return out;
  }

  private async pointerOf(oid: string): Promise<LargePointer | null> {
    return (await this.pointersOf([oid])).get(oid) ?? null;
  }

  /** Real sha256 of a blob's content: the pointer's for a large file (pointersOf/ensureSha256 must have run). */
  private realSha256(oid: string): string | undefined {
    return this.pointerCache.get(oid)?.sha256 ?? this.hashes.sha256Of(oid);
  }

  /** The blob (content or pointer) git holds for a real sha256, if any. */
  private async oidForSha256(sha256: string): Promise<string | null> {
    const b = this.hashes.oidFor(sha256);
    if (b && !this.pointerCache.get(b) && (await this.hasObject(b))) return b;
    if (/^[0-9a-f]{64}$/.test(sha256)) {
      const size = await this.largeStore.storedSize(sha256);
      if (size !== null) {
        const oid = gitBlobOid(pointerText({ sha256, size }));
        if (await this.hasObject(oid)) return oid;
      }
    }
    return null;
  }

  /** Large files (pointer blobs) in `rev`, optionally only under `under` (a file or directory). */
  private async pointerEntries(rev: string, under?: string): Promise<{ path: string; mode: number; ptr: LargePointer }[]> {
    const r = await this.git.run(["ls-tree", "-r", "-z", "--full-tree", rev, ...(under !== undefined ? ["--", under] : [])]);
    const blobs = parseLsTreeZ(r.stdout).filter((e) => e.type === "blob" && !isSymlinkMode(e.mode));
    const ptrs = await this.pointersOf(blobs.map((e) => e.oid));
    return blobs.filter((e) => ptrs.has(e.oid)).map((e) => ({ path: e.path, mode: e.mode, ptr: ptrs.get(e.oid)! }));
  }

  /**
   * sha256 of a large work-tree file: streamed, cached by stat (`useCache` only for files of this work tree). The
   * stat is re-checked after hashing; a file that changed meanwhile is not cached.
   */
  private async largeShaOf(rel: string, abs: string, st: Stats, useCache = true): Promise<LargePointer> {
    if (useCache) {
      const hit = await this.largeHashes.get(rel, st);
      if (hit) return hit;
    }
    const got = await hashFileStream(abs);
    const after = await lstatOrNull(abs);
    if (useCache && after && after.size === got.size && after.mtimeMs === st.mtimeMs && after.ctimeMs === st.ctimeMs && after.ino === st.ino) {
      await this.largeHashes.set(rel, after, got.sha256);
    }
    return got;
  }

  /** Hash a large file and make sure the store holds that version (copied in, streamed, when absent). */
  private async ingestLarge(rel: string, abs: string, st: Stats, useCache: boolean): Promise<LargePointer> {
    const ptr = await this.largeShaOf(rel, abs, st, useCache);
    if (await this.largeStore.has(ptr)) return ptr;
    // The copy is hashed again while it is written: what is stored is what the pointer names.
    return this.largeStore.addFile(abs);
  }

  /** The server's version of a work-tree file: content when small, pointer (hashed, not stored) when large. */
  private async workTreeVersion(rel: string, abs: string, st: Stats): Promise<Version> {
    if (st.size > this.largeFileBytes) {
      const ptr = await this.largeShaOf(rel, abs, st);
      return { oid: gitBlobOid(pointerText(ptr)), ptr };
    }
    const data = await readFile(abs);
    if (data.length > this.largeFileBytes) {
      // Grew between stat and read; never keep a large file in memory.
      const ptr = await this.largeShaOf(rel, abs, (await lstatOrNull(abs)) ?? st, false);
      return { oid: gitBlobOid(pointerText(ptr)), ptr };
    }
    return { oid: gitBlobOid(data), data };
  }

  /** The blob id a work-tree file has in our representation (pointer id for large files), streamed. */
  private async workTreeOid(rel: string, abs: string, st: Stats): Promise<string> {
    if (st.size > this.largeFileBytes) return gitBlobOid(pointerText(await this.largeShaOf(rel, abs, st)));
    return gitBlobOidOfFile(abs, st.size);
  }

  /**
   * Write a stored large version to the work tree (streamed, tmp + rename, `mode` from the git mode). A missing store
   * object throws `large_missing` before anything is written. Skipped when the file already holds that version.
   */
  private async materialize(rel: string, ptr: LargePointer, gitMode: number): Promise<void> {
    const abs = await resolveInside(this.workTree, rel);
    const mode = isExecutableMode(gitMode) ? 0o755 : 0o644;
    await this.largeStore.require(ptr, rel);
    const st = await lstatOrNull(abs);
    if (st?.isDirectory()) throw new SyncCoreError("invalid_path", `a directory is in the way of ${rel}`);
    if (st?.isFile() && st.size === ptr.size && st.size > this.largeFileBytes && (await this.largeShaOf(rel, abs, st)).sha256 === ptr.sha256) {
      if ((st.mode & 0o777) !== mode) await chmod(abs, mode);
      return;
    }
    await this.largeStore.copyOut(ptr, abs, mode, rel);
    const after = await lstatOrNull(abs);
    if (after) await this.largeHashes.set(rel, after, ptr.sha256);
  }

  private async blobForSha256(sha256: string): Promise<Buffer | null> {
    const oid = this.hashes.oidFor(sha256);
    if (!oid || !(await this.hasObject(oid))) return null;
    return this.readBlob(oid);
  }

  private catFileBatch(oids: readonly string[], h: { begin(oid: string, size: number): void; data(chunk: Buffer): void; end(): void }): Promise<void> {
    if (oids.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const child = this.git.spawn(["cat-file", "--batch"]);
      let buf: Buffer = Buffer.alloc(0);
      let state: 0 | 1 | 2 = 0; // header | body | trailing LF
      let remaining = 0;
      let stderr = "";
      let failed = false;
      const fail = (e: unknown): void => {
        if (failed) return;
        failed = true;
        child.kill();
        reject(e);
      };
      const pump = (): void => {
        for (;;) {
          if (state === 0) {
            const nl = buf.indexOf(10);
            if (nl < 0) return;
            const line = buf.subarray(0, nl).toString("latin1");
            buf = buf.subarray(nl + 1);
            const parts = line.split(" ");
            if (parts[1] === "missing") throw new SyncCoreError("git", `object ${parts[0]} is missing`);
            remaining = Number(parts[2]);
            h.begin(parts[0]!, remaining);
            state = 1;
          }
          if (state === 1) {
            if (remaining > 0) {
              if (buf.length === 0) return;
              const take = Math.min(remaining, buf.length);
              h.data(buf.subarray(0, take));
              buf = buf.subarray(take);
              remaining -= take;
              if (remaining > 0) return;
            }
            h.end();
            state = 2;
          }
          if (state === 2) {
            if (buf.length === 0) return;
            buf = buf.subarray(1);
            state = 0;
          }
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        buf = buf.length > 0 ? Buffer.concat([buf, chunk]) : chunk;
        try {
          pump();
        } catch (e) {
          fail(e);
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", fail);
      child.on("close", (code) => {
        if (failed) return;
        if (code === 0 && state === 0 && buf.length === 0) resolve();
        else fail(new SyncCoreError("git", `cat-file --batch exited ${code}: ${stderr.trim()}`));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(oids.join("\n") + "\n");
    });
  }

  private async writeBlobs(blobs: Map<string, Buffer>): Promise<void> {
    if (blobs.size === 0) return;
    const dir = await mkdtemp(path.join(this.tmpDir, "blobs-"));
    try {
      const files: [string, string][] = [];
      let i = 0;
      for (const [oid, buf] of blobs) {
        const f = path.join(dir, String(i++));
        await writeFile(f, buf);
        files.push([oid, f]);
      }
      const r = await this.git.run(["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: files.map(([, f]) => f).join("\n") + "\n" });
      const got = r.stdout.toString().trim().split("\n");
      files.forEach(([oid], j) => {
        if (got[j] !== oid) throw new SyncCoreError("git", `hash-object returned ${got[j]} for blob ${oid}`);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async mergeFile(ours: Buffer, base: Buffer, theirs: Buffer): Promise<{ clean: true; result: Buffer } | { clean: false; reason: string }> {
    const dir = await mkdtemp(path.join(this.tmpDir, "merge-"));
    try {
      const [o, b, t] = ["server", "base", "mac"].map((n) => path.join(dir, n)) as [string, string, string];
      await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
      const r = await this.git.run(["merge-file", "-p", "-L", "server", "-L", "local", "-L", "mac", o, b, t], { okCodes: "any" });
      if (r.code === 0) return { clean: true, result: r.stdout };
      if (r.code > 0 && r.code < 128) return { clean: false, reason: `merge conflict (${r.code} region${r.code === 1 ? "" : "s"})` };
      return { clean: false, reason: /binary/i.test(r.stderr) ? "binary file changed on both sides" : `merge failed: ${r.stderr.trim()}` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Paths matching info/exclude or an in-tree .gitignore. Uses
   * `check-ignore -v -n` so that results line up with the input order and a
   * matching negation (`!pattern`) counts as not ignored.
   */
  private async checkIgnored(paths: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (paths.length === 0) return out;
    const run = async (batch: readonly string[]): Promise<string[] | null> => {
      const r = await this.git.run(["check-ignore", "--no-index", "-v", "-n", "-z", "--stdin"], {
        input: batch.map((p) => `./${p}`).join("\0") + "\0",
        okCodes: "any",
        literalPathspecs: false,
        ...(this.honorGitignore ? {} : { workTree: this.emptyDir }),
      });
      if (r.code !== 0 && r.code !== 1) return null;
      return splitNul(r.stdout);
    };
    const consume = (batch: readonly string[], t: string[]): void => {
      batch.forEach((p, i) => {
        const pattern = t[i * 4 + 2];
        if (pattern && !pattern.startsWith("!")) out.add(p);
      });
    };
    const all = await run(paths);
    if (all && all.length >= paths.length * 4) {
      consume(paths, all);
      return out;
    }
    // One path made git bail out (e.g. it lies beyond a symlink): check one by one.
    for (const p of paths) {
      const t = await run([p]);
      if (t && t.length >= 4) consume([p], t);
    }
    return out;
  }

  private async loadState(): Promise<SidecarState> {
    try {
      const s = JSON.parse(await readFile(this.stateFile, "utf8")) as Partial<SidecarState>;
      return { version: 1, downloaded: s.downloaded ?? {} };
    } catch {
      return { version: 1, downloaded: {} };
    }
  }

  private async recordDownloaded(pairs: readonly [string, string][]): Promise<void> {
    if (pairs.length === 0) return;
    const s = await this.loadState();
    for (const [p, oid] of pairs) s.downloaded[p] = oid;
    const tmp = `${this.stateFile}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(s));
    await rename(tmp, this.stateFile);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findRecord(recs: readonly ChangeRecord[], p: string): ChangeRecord | undefined {
  return recs.find((r) => r.path === p) ?? recs.find((r) => r.oldPath === p);
}

function indexChangesFor(recs: readonly ChangeRecord[]): { updates: IndexUpdate[]; removals: string[] } {
  const updates: IndexUpdate[] = [];
  const removals: string[] = [];
  for (const r of recs) {
    if (r.oldPath !== undefined) removals.push(r.oldPath);
    if (r.status === "deleted") removals.push(r.path);
    else updates.push({ path: r.path, mode: r.newMode, oid: r.newOid! });
  }
  return { updates, removals };
}

/** git's heuristic: a NUL byte in the first 8000 bytes. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300);
}

function firstLine(body: string): string {
  return body.split("\n")[0] ?? "";
}

function parseTrailers(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = /^(Workstation-[A-Za-z]+): (.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function isoUtc(d: string): string {
  const t = Date.parse(d);
  return Number.isNaN(t) ? d : new Date(t).toISOString();
}

const REF_RE = /^(?:[0-9a-f]{7,64}|(?:refs\/heads\/)?local|refs\/(?:snapshots|trash)\/[A-Za-z0-9._\-/]+)$/;

/** Only commit ids, `local`, and our own snapshot/trash refs may be restored from. */
export function validateRef(ref: unknown): string {
  if (typeof ref !== "string" || !REF_RE.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")) {
    throw new SyncCoreError("invalid_argument", `invalid ref: ${String(ref)}`);
  }
  return ref;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function diskUsage(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileP("du", ["-sk", dir], { env: gitBaseEnv(), maxBuffer: 1024 * 1024 });
    const kb = parseInt(String(stdout).trim().split(/\s+/)[0] ?? "", 10);
    if (Number.isFinite(kb)) return kb * 1024;
  } catch {
    /* fall through */
  }
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p);
      else total += st.size;
    }
  };
  await walk(dir);
  return total;
}
