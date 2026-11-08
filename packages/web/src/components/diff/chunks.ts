import type { Hunk } from "@agent-workstation/protocol";
import type { Text } from "@codemirror/state";

/** A changed region as reported to the host (all line numbers are 1-based, inclusive; end = start - 1 means "empty side"). */
export interface DiffChunkInfo {
  /** Ordinal of the chunk in the viewer (0-based). */
  index: number;
  /** Protocol `Hunk.index` values whose changed lines overlap this chunk. */
  hunkIndexes: number[];
  /** Document offsets (A = old text, B = new text), straight from @codemirror/merge. */
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
}

/** Structural subset of @codemirror/merge `Chunk` (keeps this module testable without a view). */
export interface ChunkLike {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  endA: number;
  endB: number;
}

/** 1-based inclusive line range covered by a chunk side; empty sides give end = start - 1. */
export function chunkLineRange(doc: Text, from: number, to: number, end: number): { start: number; end: number } {
  const clampedFrom = Math.min(from, doc.length);
  const start = doc.lineAt(clampedFrom).number;
  if (to <= from) return { start, end: start - 1 };
  const endLine = doc.lineAt(Math.min(end, doc.length)).number;
  return { start, end: Math.max(start, endLine) };
}

/** Old/new line numbers (1-based) of the lines a hunk actually changes (context excluded). */
export function hunkChangedLines(h: Pick<Hunk, "oldStart" | "newStart" | "lines">): { removed: number[]; added: number[] } {
  let o = h.oldStart;
  let n = h.newStart;
  const removed: number[] = [];
  const added: number[] = [];
  for (const line of h.lines) {
    const tag = line[0];
    if (tag === "-") removed.push(o++);
    else if (tag === "+") added.push(n++);
    else if (tag === " ") {
      o++;
      n++;
    }
  }
  return { removed, added };
}

const intersects = (lines: number[], start: number, end: number) => end >= start && lines.some((l) => l >= start && l <= end);

/**
 * Which protocol hunks does a viewer chunk belong to?
 * 1. hunks whose changed lines intersect the chunk's old or new line range;
 * 2. otherwise the nearest hunk by distance to the chunk's new-side start;
 * 3. without hunks: the chunk's ordinal (hub hunks are indexed in diff order, same as chunks).
 */
export function mapChunkToHunks(chunk: Pick<DiffChunkInfo, "index" | "oldStartLine" | "oldEndLine" | "newStartLine" | "newEndLine">, hunks: readonly Hunk[] | undefined): number[] {
  if (!hunks || hunks.length === 0) return [chunk.index];
  const hits: number[] = [];
  for (const h of hunks) {
    const { removed, added } = hunkChangedLines(h);
    if (intersects(removed, chunk.oldStartLine, chunk.oldEndLine) || intersects(added, chunk.newStartLine, chunk.newEndLine)) hits.push(h.index);
  }
  if (hits.length) return hits.sort((a, b) => a - b);
  let best = hunks[0]!;
  let bestDist = Infinity;
  for (const h of hunks) {
    const dist = Math.abs(h.newStart - chunk.newStartLine);
    if (dist < bestDist) {
      best = h;
      bestDist = dist;
    }
  }
  return [best.index];
}

export function chunkInfo(chunk: ChunkLike, index: number, docA: Text, docB: Text, hunks?: readonly Hunk[]): DiffChunkInfo {
  const a = chunkLineRange(docA, chunk.fromA, chunk.toA, chunk.endA);
  const b = chunkLineRange(docB, chunk.fromB, chunk.toB, chunk.endB);
  const base = { index, fromA: chunk.fromA, toA: chunk.toA, fromB: chunk.fromB, toB: chunk.toB, oldStartLine: a.start, oldEndLine: a.end, newStartLine: b.start, newEndLine: b.end };
  return { ...base, hunkIndexes: mapChunkToHunks(base, hunks) };
}

/** Smallest single replacement turning `a` into `b` (common prefix/suffix trimmed) so scroll position survives updates. */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}
