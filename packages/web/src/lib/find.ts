/**
 * Find in a session: which transcript answers ⌘F, and the DOM search + highlighting behind the find bar.
 */

// ---------------------------------------------------------------------------
// Who answers ⌘F
// ---------------------------------------------------------------------------
const openers: Array<() => void> = [];

/** A mounted transcript registers how to open its find bar; the latest one wins. */
export function registerFind(open: () => void): () => void {
  openers.push(open);
  return () => {
    const i = openers.lastIndexOf(open);
    if (i >= 0) openers.splice(i, 1);
  };
}

/** Open the find bar of the visible session; false when no session transcript is mounted. */
export function requestFind(): boolean {
  const open = openers[openers.length - 1];
  if (!open) return false;
  open();
  return true;
}

// ---------------------------------------------------------------------------
// Searching the rendered transcript
// ---------------------------------------------------------------------------
export interface Segment {
  node: Text;
  start: number;
  end: number;
}
/** One occurrence: a run of text, possibly across inline elements (`foo <b>bar</b>`). */
export type FindMatch = Segment[];

const BLOCK = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BUTTON", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL", "TEXTAREA"]);

const blockOf = (node: Node, root: Element): Element => {
  let el = node.parentElement;
  while (el && el !== root && !BLOCK.has(el.tagName)) el = el.parentElement;
  return el ?? root;
};

/** Text that is not on screen or is a duplicate (the MathML twin of a formula, a closed `<details>` body). */
function skipped(node: Text, root: Element): boolean {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.classList.contains("katex-mathml") || el.hasAttribute("data-find-skip")) return true;
    if (el.tagName === "DETAILS" && !(el as HTMLDetailsElement).open) {
      let inSummary = false;
      for (let s: Element | null = node.parentElement; s && s !== el; s = s.parentElement) if (s.tagName === "SUMMARY") inSummary = true;
      if (!inSummary) return true;
    }
  }
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every occurrence of `query` (case-insensitive) in the text under `root`, in document order. */
export function findMatches(root: Element, query: string): FindMatch[] {
  if (!query) return [];
  const re = new RegExp(escapeRe(query), "giu");
  const out: FindMatch[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let block: Element | null = null;
  let nodes: Text[] = [];

  const flush = () => {
    if (nodes.length === 0) return;
    const text = nodes.map((n) => n.data).join("");
    // where each node starts inside the block's text
    const starts: number[] = [];
    let acc = 0;
    for (const n of nodes) {
      starts.push(acc);
      acc += n.data.length;
    }
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const from = m.index;
      const to = from + m[0].length;
      const segs: Segment[] = [];
      nodes.forEach((node, i) => {
        const s = starts[i]!;
        const e = s + node.data.length;
        if (e <= from || s >= to) return;
        segs.push({ node, start: Math.max(from, s) - s, end: Math.min(to, e) - s });
      });
      if (segs.length) out.push(segs);
    }
    nodes = [];
  };

  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (n.data === "" || skipped(n, root)) continue;
    const b = blockOf(n, root);
    if (b !== block) {
      flush();
      block = b;
    }
    nodes.push(n);
  }
  flush();
  return out;
}

export function matchRange(m: FindMatch): Range {
  const range = document.createRange();
  range.setStart(m[0]!.node, m[0]!.start);
  const last = m[m.length - 1]!;
  range.setEnd(last.node, last.end);
  return range;
}

// ---------------------------------------------------------------------------
// Highlighting: CSS Custom Highlight API, `<mark>` elements where it is missing
// ---------------------------------------------------------------------------
export const HIGHLIGHT_ALL = "find-match";
export const HIGHLIGHT_CURRENT = "find-current";

interface HighlightRegistry {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}
const registry = (): HighlightRegistry | null => {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === "function" ? css.highlights : null;
};

export function clearHighlights(root: Element | null): void {
  const reg = registry();
  reg?.delete(HIGHLIGHT_ALL);
  reg?.delete(HIGHLIGHT_CURRENT);
  if (!root) return;
  // unwrap without normalize(): React keeps references to its text nodes
  for (const mark of Array.from(root.querySelectorAll("mark[data-find]"))) mark.replaceWith(...Array.from(mark.childNodes));
}

/** Paint the matches; the current one is stronger. Returns the element to scroll to. */
export function paintHighlights(root: Element, matches: FindMatch[], current: number): Element | null {
  clearHighlights(root);
  const reg = registry();
  if (reg) {
    const Highlight = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    reg.set(HIGHLIGHT_ALL, new Highlight(...matches.map(matchRange)));
    const cur = matches[current];
    if (cur) reg.set(HIGHLIGHT_CURRENT, new Highlight(matchRange(cur)));
    return cur ? (cur[0]!.node.parentElement ?? null) : null;
  }
  // fallback: wrap each run in a <mark>; last first so the earlier offsets of a node stay valid
  let target: Element | null = null;
  for (let index = matches.length - 1; index >= 0; index--) {
    const m = matches[index]!;
    for (let i = m.length - 1; i >= 0; i--) {
      const { node, start, end } = m[i]!;
      const mark = document.createElement("mark");
      mark.setAttribute("data-find", "");
      if (index === current) mark.setAttribute("data-find-current", "");
      const rest = start > 0 ? node.splitText(start) : node;
      if (end - start < rest.data.length) rest.splitText(end - start);
      rest.replaceWith(mark);
      mark.appendChild(rest);
      if (index === current) target = mark;
    }
  }
  return target;
}
