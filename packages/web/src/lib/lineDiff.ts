import { structuredPatch } from "diff";

export interface DiffRow {
  kind: "ctx" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunkView {
  header: string;
  rows: DiffRow[];
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

/** Unified diff of two strings as render-ready rows (context 3 lines). */
export function buildDiff(oldText: string, newText: string, context = 3): { hunks: DiffHunkView[]; stats: DiffStats } {
  const patch = structuredPatch("a", "b", oldText, newText, "", "", { context });
  let additions = 0;
  let deletions = 0;
  const hunks: DiffHunkView[] = patch.hunks.map((h) => {
    let o = h.oldStart;
    let n = h.newStart;
    const rows: DiffRow[] = [];
    for (const line of h.lines) {
      const tag = line[0];
      const text = line.slice(1);
      if (tag === "+") {
        additions++;
        rows.push({ kind: "add", text, oldNo: null, newNo: n++ });
      } else if (tag === "-") {
        deletions++;
        rows.push({ kind: "del", text, oldNo: o++, newNo: null });
      } else if (tag === " ") {
        rows.push({ kind: "ctx", text, oldNo: o++, newNo: n++ });
      }
      // "\ No newline at end of file" markers are dropped
    }
    return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, rows };
  });
  return { hunks, stats: { additions, deletions } };
}
