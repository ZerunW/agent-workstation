/**
 * @agent-workstation/sync-core — folder sync + git review engine for Agent Workstation projects.
 * Pure library (no HTTP); `packages/hub` mounts it as routes. See README.md.
 */
export {
  openProject,
  ProjectRepo,
  MAX_TEXT_BYTES,
  validateRef,
  type OpenProjectOptions,
  type BaselineSource,
  type ImportBaselineOptions,
  type BaselineResult,
  type ReviewResult,
  type FileDiffResult,
  type ApplyOpsResult,
  type AcceptInput,
  type AcceptResult,
  type RejectInput,
  type RejectResult,
  type RestoreResult,
  type SnapshotInput,
  type SnapshotResult,
  type HistoryOptions,
  type CanDeleteResult,
  type ProjectStats,
  type LargeWriteInput,
  type LargeWriteResult,
} from "./repo.js";
export { LargeStore, parsePointer, pointerText, hashFileStream, POINTER_MAX_BYTES, type LargePointer } from "./large.js";
export { withLock, acquireLock, holdsLock, lockQueueLength, type LockHandle, type AcquireOptions } from "./mutex.js";
export { hashBytes, gitBlobOid, EMPTY_TREE_OID, ZERO_OID } from "./hash.js";
export { defaultExcludes, renderExcludeFile } from "./excludes.js";
export { parseUnifiedDiff, filterPatch, patchHeader, type FilterPatchOptions } from "./diff.js";
export {
  parsePorcelainV2,
  porcelainToChanges,
  pairRenames,
  parseNumstatZ,
  parseLsTreeZ,
  type PorcelainEntry,
  type ChangeRecord,
  type ChangeStatus,
  type NumstatEntry,
  type TreeEntry,
} from "./porcelain.js";
export { assertRelPath, lstatOrNull, pruneEmptyParents, resolveInside, writeFileAtomic } from "./paths.js";
export { DEFAULT_BASELINE_LIMITS, type BaselineFormat, type BaselineLimits } from "./archive.js";
export { SyncCoreError, isSyncCoreError, type SyncCoreErrorCode } from "./errors.js";
export { GitError, GIT_CONFIG } from "./git.js";
export { MAX_SYNC_FILE_BYTES } from "@agent-workstation/protocol";
export type * from "./types.js";
