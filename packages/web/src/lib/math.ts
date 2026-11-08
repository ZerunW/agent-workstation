/**
 * LaTeX in messages: which parts of a text are math, by the usual rules.
 *
 *   inline   `$x^2$`   `\(x^2\)`        display   `$$ … $$`   `\[ … \]`
 *
 * A single-dollar span is math only when the character after the opening `$` and before the closing `$` is not
 * whitespace, the closing `$` is not followed by a digit, and the span holds no blank line — so "costs $5 and $10" is
 * just text. `\$` is a literal dollar. Code (fenced blocks, `inline code`) is never touched.
 *
 * Two users: the plain text of a user bubble (`splitMath`) and the Markdown renderer (`prepareMarkdownMath`), which
 * leaves real math as remark-math syntax and escapes every other `$` so remark-math cannot pair it up by accident.
 */

export type MathPiece =
  | { kind: "text"; raw: string }
  /** A `$` that is not math. */
  | { kind: "dollar" }
  | { kind: "math"; display: boolean; delim: "$" | "$$" | "\\(" | "\\["; /** the whole span as written */ raw: string; /** between the delimiters, as written */ inner: string; /** inner, trimmed */ tex: string };

const WS = /\s/;
const BLANK_LINE = /\n[ \t]*\n/;

/** Index of the next `close` (one of `$`, `$$`, `\)`, `\]`) at or after `from`, skipping backslash-escaped characters; -1 if none. */
function findClose(src: string, from: number, close: string): number {
  for (let j = from; j < src.length; ) {
    const c = src[j];
    if (c === "\\") {
      if (close.startsWith("\\") && src.startsWith(close, j)) return j;
      j += 2;
    } else if (!close.startsWith("\\") && c === "$" && src.startsWith(close, j)) return j;
    else j++;
  }
  return -1;
}

/** Classify the math in one stretch of non-code text. */
export function scanMath(src: string): MathPiece[] {
  const out: MathPiece[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", raw: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[i + 1];
      if (n === "(" || n === "[") {
        const close = n === "(" ? "\\)" : "\\]";
        const end = findClose(src, i + 2, close);
        const inner = end < 0 ? "" : src.slice(i + 2, end);
        if (end >= 0 && inner.trim() !== "") {
          flush();
          out.push({ kind: "math", display: n === "[", delim: n === "(" ? "\\(" : "\\[", raw: src.slice(i, end + 2), inner, tex: inner.trim() });
          i = end + 2;
          continue;
        }
      }
      text += n === undefined ? c : c + n; // any other escape, `\$` included, stays as it is
      i += n === undefined ? 1 : 2;
      continue;
    }
    if (c === "$") {
      if (src[i + 1] === "$") {
        const end = findClose(src, i + 2, "$$");
        const inner = end < 0 ? "" : src.slice(i + 2, end);
        if (end >= 0 && inner.trim() !== "") {
          flush();
          out.push({ kind: "math", display: true, delim: "$$", raw: src.slice(i, end + 2), inner, tex: inner.trim() });
          i = end + 2;
          continue;
        }
        flush();
        out.push({ kind: "dollar" }, { kind: "dollar" });
        i += 2;
        continue;
      }
      const next = src[i + 1];
      if (next !== undefined && !WS.test(next)) {
        const end = findClose(src, i + 1, "$");
        if (end > i + 1) {
          const inner = src.slice(i + 1, end);
          const after = src[end + 1];
          if (!WS.test(src[end - 1]!) && !(after !== undefined && after >= "0" && after <= "9") && !BLANK_LINE.test(inner)) {
            flush();
            out.push({ kind: "math", display: false, delim: "$", raw: src.slice(i, end + 1), inner, tex: inner });
            i = end + 1;
            continue;
          }
        }
      }
      flush();
      out.push({ kind: "dollar" });
      i++;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// code regions
// ---------------------------------------------------------------------------

interface Region {
  code: boolean;
  text: string;
}

const FENCE_OPEN = /^[\t >]*(?:(?:[-*+]|\d+[.)])[\t ]+)?(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[\t >]*(`{3,}|~{3,})[\t ]*$/;

/** Inline code spans inside a stretch with no fenced block: a run of n backticks closes at the next run of exactly n. */
function splitInlineCode(text: string): Region[] {
  const out: Region[] = [];
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (text[j] === "`") j++;
    const n = j - i;
    let k = j;
    let found = -1;
    while (k < text.length) {
      if (text[k] !== "`") {
        k++;
        continue;
      }
      let m = k;
      while (text[m] === "`") m++;
      if (m - k === n) {
        found = k;
        break;
      }
      k = m;
    }
    if (found < 0) {
      i = j; // no closing run: the backticks are plain characters
      continue;
    }
    if (i > last) out.push({ code: false, text: text.slice(last, i) });
    out.push({ code: true, text: text.slice(i, found + n) });
    last = i = found + n;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

/** Split Markdown into fenced code (kept whole, an unclosed fence runs to the end), inline code spans and the rest. */
export function splitCodeRegions(md: string): Region[] {
  const lines = md.split(/(?<=\n)/);
  const out: Region[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain) out.push(...splitInlineCode(plain));
    plain = "";
  };
  for (let li = 0; li < lines.length; li++) {
    const open = FENCE_OPEN.exec(lines[li]!.replace(/\r?\n$/, ""));
    // a backtick fence's info string cannot hold a backtick (that would be an inline span)
    if (open && !(open[1]!.startsWith("`") && open[2]!.includes("`"))) {
      flushPlain();
      const fence = open[1]!;
      let block = lines[li]!;
      while (++li < lines.length) {
        block += lines[li];
        const close = FENCE_CLOSE.exec(lines[li]!.replace(/\r?\n$/, ""));
        if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) break;
      }
      out.push({ code: true, text: block });
      continue;
    }
    plain += lines[li];
  }
  flushPlain();
  return out;
}

/** True when a text could hold math at all (cheap pre-check; false positives are fine). */
export const mayHaveMath = (s: string): boolean => s.includes("$") || s.includes("\\(") || s.includes("\\[");

// ---------------------------------------------------------------------------
// the two consumers
// ---------------------------------------------------------------------------

export type MathSegment = { kind: "text"; text: string } | { kind: "inline" | "display"; tex: string; raw: string };

/** Plain text (a user bubble) as text and math segments. Code spans are left alone, like in Markdown. */
export function splitMath(text: string): MathSegment[] {
  if (!mayHaveMath(text)) return [{ kind: "text", text }];
  const segs: MathSegment[] = [];
  const addText = (s: string) => {
    const last = segs[segs.length - 1];
    if (last?.kind === "text") last.text += s;
    else if (s) segs.push({ kind: "text", text: s });
  };
  for (const region of splitCodeRegions(text)) {
    if (region.code) {
      addText(region.text);
      continue;
    }
    for (const p of scanMath(region.text)) {
      if (p.kind === "text") addText(p.raw);
      else if (p.kind === "dollar") addText("$");
      else segs.push({ kind: p.display ? "display" : "inline", tex: p.tex, raw: p.raw });
    }
  }
  return segs;
}

/**
 * Markdown for remark-math: `\( x \)` becomes `$x$`, `\[ … \]` becomes `$$ … $$` (in place, so container indentation and
 * line structure survive), real `$…$` / `$$…$$` stay, and every other `$` is escaped — when there is another `$` it could
 * wrongly pair with (a lone `$` cannot start math, so shell prompts and prices in unusual code stay byte for byte).
 */
export function prepareMarkdownMath(md: string): string {
  if (!mayHaveMath(md)) return md;
  return splitCodeRegions(md)
    .map((region) => {
      if (region.code || !mayHaveMath(region.text)) return region.text;
      const pieces = scanMath(region.text);
      const dollars = pieces.reduce((n, p) => n + (p.kind === "dollar" ? 1 : p.kind === "math" ? (p.display ? 4 : 2) : 0), 0);
      return pieces
        .map((p) => {
          if (p.kind === "text") return p.raw;
          if (p.kind === "dollar") return dollars >= 2 ? "\\$" : "$";
          if (p.delim === "\\(") return /(^|[^\\])\$/.test(p.tex) ? p.raw : `$${p.tex}$`;
          if (p.delim === "\\[") return /(^|[^\\])\$/.test(p.inner) ? p.raw : `$$${p.inner}$$`;
          return p.raw;
        })
        .join("");
    })
    .join("");
}
