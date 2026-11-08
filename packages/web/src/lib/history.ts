import type { Snapshot } from "@agent-workstation/protocol";

export type HistoryKind = Snapshot["kind"];

/** Display order of the groups. */
export const HISTORY_KINDS: readonly HistoryKind[] = ["sync", "snapshot", "accept", "trash"];

export interface HistoryGroup {
  kind: HistoryKind;
  /** Newest first. */
  items: Snapshot[];
}

/** Group a project's history by kind (empty kinds are dropped), each group newest first. Unknown kinds are ignored. */
export function groupHistory(snapshots: readonly Snapshot[]): HistoryGroup[] {
  const by = new Map<HistoryKind, Snapshot[]>();
  for (const s of snapshots) {
    if (!HISTORY_KINDS.includes(s.kind)) continue;
    const arr = by.get(s.kind) ?? [];
    arr.push(s);
    by.set(s.kind, arr);
  }
  return HISTORY_KINDS.filter((k) => by.has(k)).map((kind) => ({ kind, items: by.get(kind)!.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) }));
}

/** A file path entered for "Restore file…": relative to the project root, no leading slash, no `..` segments. */
export function validRestorePath(p: string): boolean {
  const v = p.trim();
  return v.length > 0 && !v.startsWith("/") && !v.split("/").includes("..") && !v.includes("\0");
}
