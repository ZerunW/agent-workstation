import type { Hunk } from "./types.js";
import { SyncCoreError } from "./errors.js";

/**
 * Unified-diff helpers. Both functions work on a single-file patch as printed
 * by `git diff` (file header lines, then `@@` hunks). Hunk indices are the
 * 0-based order of hunks in that patch; they are stable for a given pair of
 * (local blob, work-tree content) because the diff options are pinned.
 *
 * To filter a patch losslessly regardless of file encoding, decode git's raw
 * output as `latin1` (1 byte = 1 char), filter, and re-encode as `latin1`.
 * For display, decode as UTF-8 — hunk structure lines are ASCII so indices agree.
 */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

interface RawHunk {
  hunk: Hunk;
  /** Text after the closing `@@` (function context), preserved on rewrite. */
  section: string;
}

interface SplitPatch {
  header: string[];
  hunks: RawHunk[];
}

function splitPatch(text: string): SplitPatch {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const header: string[] = [];
  const hunks: RawHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = HUNK_RE.exec(line);
    if (!m) {
      if (hunks.length > 0) {
        if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) break; // next file
        i++; // stray line between hunks: ignore
        continue;
      }
      header.push(line);
      i++;
      continue;
    }
    const oldStart = Number(m[1]);
    const oldLines = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newLines = m[4] === undefined ? 1 : Number(m[4]);
    const body: string[] = [];
    let o = oldLines;
    let n = newLines;
    i++;
    while (i < lines.length && (o > 0 || n > 0)) {
      const l = lines[i]!;
      const c = l[0];
      if (c === " ") {
        o--;
        n--;
      } else if (c === "-") o--;
      else if (c === "+") n--;
      else if (c === "\\") {
        /* "\ No newline at end of file" — belongs to the previous line */
      } else if (l === "") {
        // an empty context line whose leading space was stripped by some tool
        o--;
        n--;
      } else break;
      body.push(l);
      i++;
    }
    while (i < lines.length && lines[i]!.startsWith("\\")) {
      body.push(lines[i]!);
      i++;
    }
    hunks.push({
      hunk: { index: hunks.length, oldStart, oldLines, newStart, newLines, header: line, lines: body },
      section: m[5] ?? "",
    });
  }
  return { header, hunks };
}

/** Parse the hunks of the first file in a unified diff. */
export function parseUnifiedDiff(text: string): Hunk[] {
  return splitPatch(text).hunks.map((h) => h.hunk);
}

/** File header lines (everything before the first hunk) of the first file. */
export function patchHeader(text: string): string[] {
  return splitPatch(text).header;
}

export interface FilterPatchOptions {
  /**
   * The patch will be applied with `git apply -R` (reject: the *new* side is
   * what is on disk). Line-number hints are then recomputed on the old side
   * instead of the new side.
   */
  reverse?: boolean;
  /** Keep `old mode` / `new mode` header lines (default false: a partial selection never changes the mode). */
  keepModeChange?: boolean;
}

/**
 * Keep only the hunks whose indices are listed and rewrite the line-number
 * hints of the kept hunks so that `git apply` (forward) or `git apply -R`
 * (with `reverse: true`) places each hunk exactly, even when identical context
 * appears elsewhere in the file. Returns "" when no hunk is selected.
 * Throws `stale` on an out-of-range or non-integer index.
 */
export function filterPatch(patchText: string, hunkIndices: readonly number[], opts: FilterPatchOptions = {}): string {
  const sp = splitPatch(patchText);
  const selected = new Set<number>();
  for (const idx of hunkIndices) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= sp.hunks.length) {
      throw new SyncCoreError("stale", `hunk index ${idx} out of range (file has ${sp.hunks.length} hunks)`);
    }
    selected.add(idx);
  }
  if (selected.size === 0) return "";

  const header = opts.keepModeChange ? sp.header : sp.header.filter((l) => !/^(old|new) mode /.test(l));
  const out = [...header];
  let keptDelta = 0;
  for (const { hunk: h, section } of sp.hunks) {
    if (!selected.has(h.index)) continue;
    let oldStart = h.oldStart;
    let newStart = h.newStart;
    if (!opts.reverse) {
      // Applying forward to the old file: hunk k sits at its old position shifted by kept hunks only.
      const eff = (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart) + keptDelta;
      newStart = h.newLines === 0 ? eff - 1 : eff;
    } else {
      // Applying in reverse to the new file: hunk k sits at its new position minus the kept hunks already reverted.
      const eff = (h.newLines === 0 ? h.newStart + 1 : h.newStart) - keptDelta;
      oldStart = h.oldLines === 0 ? eff - 1 : eff;
    }
    keptDelta += h.newLines - h.oldLines;
    out.push(`@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@${section}`);
    out.push(...h.lines);
  }
  return out.join("\n") + "\n";
}
