import { afterEach, describe, expect, it, vi } from "vitest";
import { clearHighlights, findMatches, matchRange, paintHighlights, registerFind, requestFind } from "./find";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}
afterEach(() => {
  document.body.innerHTML = "";
});

describe("findMatches", () => {
  it("finds every occurrence, case-insensitively, in document order", () => {
    const root = mount("<p>Foo bar foo</p><p>FOO</p>");
    const found = findMatches(root, "foo");
    expect(found.map((m) => matchRange(m).toString())).toEqual(["Foo", "foo", "FOO"]);
  });

  it("matches across inline elements of one block, but not across blocks", () => {
    const root = mount("<p>run <code>npm</code> <b>test</b> now</p><p>npm</p><p>test</p>");
    expect(findMatches(root, "npm test").map((m) => matchRange(m).toString())).toEqual(["npm test"]);
    expect(findMatches(root, "npm").length).toBe(2);
  });

  it("treats the query literally (no regex)", () => {
    const root = mount("<p>a.b a+b (x)</p>");
    expect(findMatches(root, ".").length).toBe(1);
    expect(findMatches(root, "a+b").length).toBe(1);
    expect(findMatches(root, "(x)").length).toBe(1);
  });

  it("skips the MathML twin of a formula and the body of a closed <details>", () => {
    const root = mount('<p><span class="katex-mathml">x2</span><span class="katex-html">x2</span></p><details><summary>sum x2</summary>hidden x2</details><details open>shown x2</details>');
    expect(findMatches(root, "x2").length).toBe(3); // html twin, closed summary, open body
  });

  it("is empty for an empty query", () => {
    expect(findMatches(mount("<p>a</p>"), "")).toEqual([]);
  });
});

describe("highlighting without the CSS Custom Highlight API", () => {
  it("wraps each match in a <mark>, the current one marked, and unwraps again", () => {
    const root = mount("<p>one <b>two</b> one</p>");
    const found = findMatches(root, "one");
    const target = paintHighlights(root, found, 1);
    const marks = Array.from(root.querySelectorAll("mark[data-find]"));
    expect(marks.map((m) => m.textContent)).toEqual(["one", "one"]);
    expect(root.querySelectorAll("mark[data-find-current]").length).toBe(1);
    expect(target).toBe(root.querySelector("mark[data-find-current]"));
    expect(root.textContent).toBe("one two one");
    clearHighlights(root);
    expect(root.querySelector("mark")).toBeNull();
    expect(root.textContent).toBe("one two one");
  });

  it("splits a match across inline elements into one mark per run", () => {
    const root = mount("<p>a <b>b</b>c</p>");
    paintHighlights(root, findMatches(root, "a bc"), 0);
    expect(Array.from(root.querySelectorAll("mark")).map((m) => m.textContent)).toEqual(["a ", "b", "c"]);
    expect(root.textContent).toBe("a bc");
  });
});

describe("highlighting with the CSS Custom Highlight API", () => {
  it("registers all matches and the current one by name, and removes them", () => {
    const registry = new Map<string, unknown>();
    class FakeHighlight {
      ranges: Range[];
      constructor(...r: Range[]) {
        this.ranges = r;
      }
    }
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", FakeHighlight);
    try {
      const root = mount("<p>x y x</p>");
      const found = findMatches(root, "x");
      const target = paintHighlights(root, found, 0);
      expect((registry.get("find-match") as FakeHighlight).ranges.length).toBe(2);
      expect((registry.get("find-current") as FakeHighlight).ranges.map(String)).toEqual(["x"]);
      expect(root.querySelector("mark")).toBeNull(); // the DOM is left alone
      expect(target).toBe(root.querySelector("p"));
      clearHighlights(root);
      expect(registry.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("who answers ⌘F", () => {
  it("the latest registered transcript opens; none registered = false", () => {
    expect(requestFind()).toBe(false);
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerFind(a);
    const offB = registerFind(b);
    expect(requestFind()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    offB();
    requestFind();
    expect(a).toHaveBeenCalledTimes(1);
    offA();
    expect(requestFind()).toBe(false);
  });
});
