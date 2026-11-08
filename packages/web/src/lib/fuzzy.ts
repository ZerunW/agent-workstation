export interface FuzzyResult {
  score: number;
  /** indexes into the haystack that matched, for highlighting */
  indexes: number[];
}

/**
 * Small subsequence fuzzy matcher. Higher score = better.
 * Prefers: exact > prefix > word-boundary starts > consecutive runs > earlier matches.
 * Returns null when the needle is not a subsequence of the haystack.
 */
export function fuzzyMatch(needle: string, haystack: string): FuzzyResult | null {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (n === "") return { score: 0, indexes: [] };
  if (h === n) return { score: 1000, indexes: Array.from({ length: h.length }, (_, i) => i) };
  if (h.startsWith(n)) return { score: 800 - h.length * 0.1, indexes: Array.from({ length: n.length }, (_, i) => i) };

  const indexes: number[] = [];
  let hi = 0;
  let score = 0;
  let prev = -2;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni]!;
    let found = -1;
    for (let j = hi; j < h.length; j++) {
      if (h[j] === ch) {
        found = j;
        break;
      }
    }
    if (found < 0) return null;
    indexes.push(found);
    const boundary = found === 0 || /[\s\-_:/.]/.test(h[found - 1]!);
    score += 10;
    if (boundary) score += 25;
    if (found === prev + 1) score += 15;
    score -= Math.min(found, 20) * 0.3;
    prev = found;
    hi = found + 1;
  }
  const sub = h.indexOf(n);
  if (sub >= 0) score += 120 - Math.min(sub, 60);
  score -= h.length * 0.05;
  return { score, indexes };
}
