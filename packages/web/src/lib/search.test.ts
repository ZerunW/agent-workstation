import type { SearchHit } from "@agent-workstation/protocol";
import { describe, expect, it } from "vitest";
import { session } from "../test/fixtures";
import { newestFirst, parseSnippet } from "./search";

describe("parseSnippet", () => {
  it("splits «…» into marked parts and keeps the rest plain", () => {
    expect(parseSnippet("we talked about «debounce» in «search» boxes")).toEqual([
      { text: "we talked about ", mark: false },
      { text: "debounce", mark: true },
      { text: " in ", mark: false },
      { text: "search", mark: true },
      { text: " boxes", mark: false },
    ]);
  });

  it("collapses whitespace and newlines into single spaces", () => {
    expect(parseSnippet("  line one\n\n  «two»\tthree ").map((p) => p.text).join("")).toBe("line one two three");
  });

  it("is tolerant: an unclosed « marks the rest, a stray » is dropped, empty marks vanish", () => {
    expect(parseSnippet("a «b c")).toEqual([{ text: "a ", mark: false }, { text: "b c", mark: true }]);
    expect(parseSnippet("a » b")).toEqual([{ text: "a  b", mark: false }]);
    expect(parseSnippet("a «» b")).toEqual([{ text: "a ", mark: false }, { text: " b", mark: false }]);
  });

  it("returns nothing for no snippet, and never produces HTML (text is plain)", () => {
    expect(parseSnippet(null)).toEqual([]);
    expect(parseSnippet("")).toEqual([]);
    expect(parseSnippet("<b>«x»</b>")).toEqual([{ text: "<b>", mark: false }, { text: "x", mark: true }, { text: "</b>", mark: false }]);
  });
});

describe("newestFirst", () => {
  const h = (n: number, at: string): SearchHit => ({ session: session({ id: `${n}`.repeat(8) + "-1111-4111-8111-111111111111" }), snippet: null, at });
  it("sorts by the hit's time, newest first, stable for ties, unparsable last", () => {
    const hits = [h(1, "2026-10-01T00:00:00Z"), h(2, "2026-10-03T00:00:00Z"), h(3, "bad"), h(4, "2026-10-03T00:00:00Z"), h(5, "2026-10-02T00:00:00Z")];
    expect(newestFirst(hits).map((x) => x.session.id[0])).toEqual(["2", "4", "5", "1", "3"]);
    expect(hits[0]!.session.id[0]).toBe("1"); // the input is not mutated
  });
});
