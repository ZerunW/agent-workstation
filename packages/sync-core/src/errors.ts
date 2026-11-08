/**
 * Error type thrown by sync-core. `code` is stable and meant to be mapped to an
 * HTTP status by the hub (see README "Error codes").
 */
export type SyncCoreErrorCode =
  /** Path is absolute, contains `..`/`.git`/empty segments, or is otherwise not allowed. */
  | "invalid_path"
  /** Ref, session id or other argument is malformed. */
  | "invalid_argument"
  /** Path / ref does not exist. */
  | "not_found"
  /** A symlink is in the way (either the target or a parent directory). */
  | "symlink"
  /** File is larger than MAX_SYNC_FILE_BYTES (where whole content is needed in memory, e.g. rawFile). */
  | "too_large"
  /** Hunk-level operation requested on a binary (or > 2 MB) file. */
  | "binary"
  /** Hunk indices do not match the current diff, or `localCommit` moved. */
  | "stale"
  /** Operation is not supported for this kind of change (e.g. hunks on a rename). */
  | "unsupported"
  /** A file could not be read from the work tree. */
  | "unreadable"
  /** A git invocation failed unexpectedly. */
  | "git"
  /** Some external tool (tar, du) failed. */
  | "tool"
  /** A baseline archive exceeds a limit (upload size, extracted size or entry count; details: { limit }). */
  | "baseline_too_large"
  /** A baseline upload took longer than its time limit. */
  | "baseline_timeout"
  /** A baseline archive has an entry type tar does not extract here (sparse, multi-volume, unknown) or a damaged header. */
  | "baseline_unsupported_entry"
  /** A large-file pointer names a version the project's large-file store does not hold (details: sha256, size). */
  | "large_missing";

export class SyncCoreError extends Error {
  readonly code: SyncCoreErrorCode;
  readonly details?: unknown;

  constructor(code: SyncCoreErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "SyncCoreError";
    this.code = code;
    this.details = details;
  }
}

export function isSyncCoreError(e: unknown, code?: SyncCoreErrorCode): e is SyncCoreError {
  return e instanceof SyncCoreError && (code === undefined || e.code === code);
}
