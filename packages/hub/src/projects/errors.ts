/** SyncCoreError.code → HTTP status (mapping suggested by the sync-core README). */
import { isSyncCoreError, type SyncCoreError } from "@agent-workstation/sync-core";
import { HttpError } from "../util/errors.js";

const STATUS: Record<string, number> = {
  invalid_path: 400,
  invalid_argument: 400,
  not_found: 404,
  stale: 409,
  binary: 422,
  unsupported: 422,
  symlink: 422,
  too_large: 413,
  /** A baseline upload over its size or file-count limit. */
  baseline_too_large: 413,
  baseline_timeout: 408,
  /** A baseline archive with an entry type or tar header that is not accepted (sparse, multi-volume, unknown, bad checksum). */
  baseline_unsupported_entry: 400,
  unreadable: 500,
  git: 500,
  tool: 500,
  /** A large-file pointer whose content the project's store lacks (details: sha256, size). */
  large_missing: 500,
};

export function syncCoreStatus(err: SyncCoreError): number {
  return STATUS[err.code] ?? 500;
}

/** Converts a SyncCoreError into the hub's HttpError (other errors pass through unchanged). */
export function toHttpError(err: unknown): unknown {
  if (!isSyncCoreError(err)) return err;
  return new HttpError(syncCoreStatus(err), err.code, err.message, err.details);
}
