import { describe, expect, it } from "vitest";
import { prepareMarkdownMath, scanMath, splitCodeRegions, splitMath } from "./math";

const kinds = (src: string) => scanMath(src).map((p) => (p.kind === "math" ? `${p.display ? "display" : "inline"}:${p.tex}` : p.kind === "dollar" ? "$" : `text:${p.raw}`));

describe("scanMath — what is math", () => {
  it("finds inline math in both delimiters and display math in both", () => {
    expect(kinds("Let $x^2$ and \\(y_1\\) be")).toEqual(["text:Let ", "inline:x^2", "text: and ", "inline:y_1", "text: be"]);
    expect(kinds("$$a+b$$")).toEqual(["display:a+b"]);
    expect(kinds("\\[ \\int_0^1 f \\]")).toEqual(["display:\\int_0^1 f"]);
    expect(kinds("a\n$$\nx = 1\n$$\nb")).toEqual(["text:a\n", "display:x = 1", "text:\nb"]);
  });

  it("does not treat currency as math: a space after the opening or before the closing dollar, a digit after the closing one", () => {
    expect(kinds("It costs $5 and $10.")).toEqual(["text:It costs ", "$", "text:5 and ", "$", "text:10."]);
    expect(kinds("$ 5 $")).toEqual(["$", "text: 5 ", "$"]);
    expect(kinds("a $b $ c")).toEqual(["text:a ", "$", "text:b ", "$", "text: c"]);
    expect(kinds("$x$5")).toEqual(["$", "text:x", "$", "text:5"]);
    expect(kinds("from $5 to $x$")).toEqual(["text:from ", "$", "text:5 to ", "inline:x"]);
  });

  it("a lone dollar, an unclosed delimiter and an empty pair stay text", () => {
    expect(kinds("only $HOME here")).toEqual(["text:only ", "$", "text:HOME here"]);
    expect(kinds("open \\( never closed")).toEqual(["text:open \\( never closed"]);
    expect(kinds("$$ $$")).toEqual(["$", "$", "text: ", "$", "$"]);
  });

  it("an escaped dollar is a literal dollar, and math cannot span a blank line", () => {
    expect(kinds("\\$5 and \\$10")).toEqual(["text:\\$5 and \\$10"]);
    expect(kinds("$a\n\nb$")).toEqual(["$", "text:a\n\nb", "$"]);
    expect(kinds("$a\nb$")).toEqual(["inline:a\nb"]);
  });

  it("keeps a backslash-escaped closing delimiter inside the formula", () => {
    expect(kinds("$a\\$b$")).toEqual(["inline:a\\$b"]);
    expect(kinds("\\( a \\\\ b \\)")).toEqual(["inline:a \\\\ b"]);
  });
});

describe("splitCodeRegions", () => {
  it("separates fenced blocks (kept whole, also when unclosed) and inline code spans", () => {
    const md = "a `x` b\n```js\nconst a = $b;\n```\nc ``y ` z`` d";
    expect(splitCodeRegions(md).map((r) => [r.code, r.text])).toEqual([
      [false, "a "],
      [true, "`x`"],
      [false, " b\n"],
      [true, "```js\nconst a = $b;\n```\n"],
      [false, "c "],
      [true, "``y ` z``"],
      [false, " d"],
    ]);
    expect(splitCodeRegions("x\n```\nopen $a$").map((r) => r.code)).toEqual([false, true]);
    expect(splitCodeRegions("~~~\n$a$\n~~~").map((r) => r.code)).toEqual([true]);
  });

  it("a backtick run with no closing run is plain text, and an indented fence inside a list is still code", () => {
    expect(splitCodeRegions("a ` b").map((r) => r.code)).toEqual([false]);
    expect(splitCodeRegions("- item\n    ```sh\n    echo $HOME $USER\n    ```\n").some((r) => r.code && r.text.includes("$HOME"))).toBe(true);
  });
});

describe("prepareMarkdownMath — Markdown ready for remark-math", () => {
  it("converts \\( \\) and \\[ \\] and leaves $ delimiters alone", () => {
    expect(prepareMarkdownMath("a \\( x+1 \\) b")).toBe("a $x+1$ b");
    expect(prepareMarkdownMath("\\[\nx = 2\n\\]")).toBe("$$\nx = 2\n$$");
    expect(prepareMarkdownMath("$a$ and $$b$$")).toBe("$a$ and $$b$$");
  });

  it("escapes dollars that are not math, so \"$5 and $10\" cannot pair up", () => {
    expect(prepareMarkdownMath("It costs $5 and $10.")).toBe("It costs \\$5 and \\$10.");
    expect(prepareMarkdownMath("$5 or $x$")).toBe("\\$5 or $x$");
    expect(prepareMarkdownMath("price $5 and \\(x\\)")).toBe("price \\$5 and $x$");
  });

  it("a lone dollar and text without any math pass through untouched", () => {
    expect(prepareMarkdownMath("echo $HOME")).toBe("echo $HOME");
    expect(prepareMarkdownMath("no math here")).toBe("no math here");
  });

  it("never touches code: fenced blocks and inline spans keep their dollars and backslashes", () => {
    const md = "run `echo $A $B` then\n```bash\necho $A $B \\(x\\)\n```\nand $x$";
    expect(prepareMarkdownMath(md)).toBe(md);
    expect(prepareMarkdownMath("`\\(x\\)` and \\(y\\)")).toBe("`\\(x\\)` and $y$");
  });
});

describe("splitMath — a user bubble's text", () => {
  it("is one text segment when there is no math", () => {
    expect(splitMath("plain text, $5 and $10")).toEqual([{ kind: "text", text: "plain text, $5 and $10" }]);
  });

  it("splits text and formulas and keeps the source of each", () => {
    expect(splitMath("see $x^2$ and\n$$y$$ ok")).toEqual([
      { kind: "text", text: "see " },
      { kind: "inline", tex: "x^2", raw: "$x^2$" },
      { kind: "text", text: " and\n" },
      { kind: "display", tex: "y", raw: "$$y$$" },
      { kind: "text", text: " ok" },
    ]);
  });

  it("leaves code spans alone", () => {
    expect(splitMath("use `$x$` here")).toEqual([{ kind: "text", text: "use `$x$` here" }]);
  });
});
