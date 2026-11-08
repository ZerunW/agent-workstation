/**
 * `FileDiff.diffId`: sha256 of the unified diff a hunk listing was computed
 * from. Clients send it back with hunk-level accept/reject; the hub recomputes
 * the diff under the project lock and answers 409 `stale_diff` when it moved,
 * so hunk indices can never silently point at different hunks.
 *
 * sync-core does not compute it (yet); when a future sync-core fills
 * `diffId` itself, that value is used for both the listing and the check.
 */
import { createHash } from "node:crypto";

export interface DiffLike {
  path: string;
  oldPath?: string | undefined;
  status?: string;
  binary: boolean;
  hunks: { header: string; lines: string[] }[];
  diffId?: string;
}

/** Canonical unified diff text (file header + every hunk) → sha256 hex. */
export function computeDiffId(d: DiffLike): string {
  const h = createHash("sha256");
  h.update(`--- a/${d.oldPath ?? d.path}\n+++ b/${d.path}\n`);
  h.update(`status ${d.status ?? ""} binary ${d.binary ? 1 : 0}\n`);
  for (const hunk of d.hunks) {
    h.update(hunk.header);
    h.update("\n");
    for (const line of hunk.lines) {
      h.update(line);
      h.update("\n");
    }
  }
  return h.digest("hex");
}

export function diffIdOf(d: DiffLike): string {
  return typeof d.diffId === "string" && d.diffId ? d.diffId : computeDiffId(d);
}
