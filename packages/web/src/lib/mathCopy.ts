/**
 * Copying rendered math: the browser would put KaTeX's hidden MathML and its glyph spans on the clipboard. Instead every
 * formula in the selection becomes its TeX source again — `$x^2$` inline, `$$ … $$` display — read from KaTeX's
 * `<annotation encoding="application/x-tex">`.
 */

const ANNOTATION = 'annotation[encoding="application/x-tex"]';

/** The formula element (`.katex`, or `.katex-display` around it) an offset in `node` sits inside, if any. */
function formulaAround(node: Node | null): Element | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const katex = el?.closest(".katex") ?? null;
  return katex?.closest(".katex-display") ?? katex;
}

/** The TeX of one `.katex` / `.katex-display` element, wrapped in its delimiters. */
export function texOf(formula: Element): string {
  const display = formula.classList.contains("katex-display");
  const tex = (formula.querySelector(ANNOTATION)?.textContent ?? "").trim();
  if (!tex) return formula.textContent ?? "";
  return display ? `$$\n${tex}\n$$` : `$${tex}$`;
}

/** Replace every formula under `root` with a text node holding its TeX (display ones as their own block). */
export function inlineFormulas(root: ParentNode, doc: Document): void {
  const formulas = Array.from(root.querySelectorAll(".katex-display, .katex")).filter((el) => !el.parentElement?.closest(".katex-display, .katex"));
  for (const f of formulas) {
    const display = f.classList.contains("katex-display");
    const tex = texOf(f);
    f.replaceWith(display ? Object.assign(doc.createElement("div"), { textContent: tex }) : doc.createTextNode(tex));
  }
}

/**
 * Plain text for the current selection with formulas as TeX, or null when the selection holds none (the browser's own copy
 * then runs untouched). A selection that starts or ends inside a formula takes the whole formula.
 */
export function selectionTextWithMath(selection: Selection | null, doc: Document = document): string | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const first = formulaAround(range.startContainer);
  const last = formulaAround(range.endContainer);
  if (first) range.setStartBefore(first);
  if (last) range.setEndAfter(last);
  const fragment = range.cloneContents();
  if (!fragment.querySelector(".katex")) return null;
  inlineFormulas(fragment, doc);
  // An off-screen element gives `innerText` its block line breaks; engines without layout (jsdom) fall back to textContent.
  const host = doc.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;white-space:pre-wrap;";
  host.appendChild(fragment);
  doc.body.appendChild(host);
  const text = (host.innerText ?? host.textContent ?? "").replace(/\u00a0/g, " ");
  host.remove();
  return text;
}

/** `onCopy` for a transcript: puts the LaTeX-bearing text on the clipboard when the selection has formulas. */
export function handleCopyWithMath(e: { clipboardData: DataTransfer | null; preventDefault: () => void }): void {
  const text = selectionTextWithMath(window.getSelection());
  if (text == null || !e.clipboardData) return;
  e.clipboardData.setData("text/plain", text);
  e.preventDefault();
}
