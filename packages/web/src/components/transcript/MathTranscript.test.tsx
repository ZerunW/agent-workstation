import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, type SessionView } from "../../lib/session-reducer";

const copyText = vi.fn(async (_text: string) => true);
vi.mock("../../lib/clipboard", () => ({ copyText: (t: string) => copyText(t) }));
vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));

import { selectionTextWithMath, texOf } from "../../lib/mathCopy";
import { Transcript } from "./Transcript";

const view = (messages: ReturnType<typeof userText>[]): SessionView => ({ ...insertMessages(emptyView(SID, session()), messages), snapshotReceived: true });
const renderTx = (messages: ReturnType<typeof userText>[]) =>
  render(
    <TestRouter>
      <Transcript view={view(messages)} />
    </TestRouter>,
  );
const annotations = (root: ParentNode) => Array.from(root.querySelectorAll('annotation[encoding="application/x-tex"]')).map((a) => a.textContent);

function selectAll(el: Node) {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.selectAllChildren(el);
  return sel;
}

/** Fire a copy on the transcript and return what the handler put on the clipboard (undefined = the browser's own copy ran). */
function copyEvent(el: Element): { text: string | undefined; prevented: boolean } {
  let text: string | undefined;
  const clipboardData = { setData: (_type: string, v: string) => void (text = v) };
  const notPrevented = fireEvent.copy(el, { clipboardData });
  return { text, prevented: !notPrevented };
}

beforeEach(() => copyText.mockClear());

describe("math in the transcript", () => {
  it("renders LaTeX in user bubbles (inline and display, both delimiters) and in assistant markdown", () => {
    renderTx([userText(1, "Is $a^2+b^2=c^2$ true? Also \\(x_1\\) and\n$$\\sum_i i$$"), assistant(2, [{ type: "text", text: "Yes: $e^{i\\pi}=-1$.\n\n\\[ \\int_0^1 x\\,dx \\]" }])]);
    const user = screen.getByTestId("user-message");
    expect(annotations(user)).toEqual(["a^2+b^2=c^2", "x_1", "\\sum_i i"]);
    expect(user.querySelectorAll(".katex-display")).toHaveLength(1);
    const asst = screen.getByTestId("assistant-message");
    expect(annotations(asst)).toEqual(["e^{i\\pi}=-1", "\\int_0^1 x\\,dx"]);
    expect(asst.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  it("currency is plain text in both a user bubble and an assistant message", () => {
    renderTx([userText(1, "It costs $5 and $10."), assistant(2, [{ type: "text", text: "That is $15 in total, or $ 15 $." }])]);
    expect(screen.getByTestId("user-message").querySelector(".katex")).toBeNull();
    expect(screen.getByTestId("user-message")).toHaveTextContent("It costs $5 and $10.");
    expect(screen.getByTestId("assistant-message").querySelector(".katex")).toBeNull();
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("That is $15 in total, or $ 15 $.");
  });

  it("code is never rendered as math, in a user bubble or an assistant message", () => {
    renderTx([userText(1, "run `echo $x$` now"), assistant(2, [{ type: "text", text: "```tex\n$$x$$\n```\n\nand `\\(y\\)`" }])]);
    expect(document.querySelector(".katex")).toBeNull();
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("$$x$$");
  });

  it("selecting rendered math and copying puts the LaTeX source on the clipboard, not the glyphs", () => {
    renderTx([assistant(1, [{ type: "text", text: "Energy is $E=mc^2$ and\n\n$$\\int_0^1 x\\,dx$$\n\ndone." }])]);
    const transcript = screen.getByTestId("transcript");
    selectAll(transcript);
    const { text, prevented } = copyEvent(transcript);
    expect(prevented).toBe(true);
    expect(text).toContain("Energy is $E=mc^2$ and");
    expect(text).toContain("$$\n\\int_0^1 x\\,dx\n$$");
    expect(text).toContain("done.");
    // no MathML text, no duplicated glyph spans
    expect(text).not.toMatch(/E=mc2|𝐸|∫/);
  });

  it("also for a user bubble's formulas", () => {
    renderTx([userText(1, "what is $\\alpha+\\beta$?")]);
    const bubble = screen.getByTestId("user-message");
    selectAll(bubble);
    const { text } = copyEvent(screen.getByTestId("transcript"));
    expect(text).toContain("what is $\\alpha+\\beta$?");
  });

  it("a selection that starts or ends inside a formula takes the whole formula", () => {
    renderTx([assistant(1, [{ type: "text", text: "A $x^2$ B" }])]);
    const html = document.querySelector(".katex-html")!;
    selectAll(html);
    expect(selectionTextWithMath(window.getSelection())).toBe("$x^2$");
  });

  it("leaves the browser's own copy alone when the selection has no math", () => {
    renderTx([assistant(1, [{ type: "text", text: "Just words, $5 and $10." }])]);
    const transcript = screen.getByTestId("transcript");
    selectAll(transcript);
    const { text, prevented } = copyEvent(transcript);
    expect(prevented).toBe(false);
    expect(text).toBeUndefined();
    expect(selectionTextWithMath(window.getSelection())).toBeNull();
  });

  it("texOf wraps inline formulas in $…$ and display ones in $$…$$", () => {
    renderTx([assistant(1, [{ type: "text", text: "$a$\n\n$$b$$" }])]);
    const inline = document.querySelector(".katex:not(.katex-display .katex)")!;
    const display = document.querySelector(".katex-display")!;
    expect(texOf(inline)).toBe("$a$");
    expect(texOf(display)).toBe("$$\nb\n$$");
  });

  it("the message Copy buttons copy the raw text, LaTeX included", async () => {
    const md = "Energy is $E=mc^2$ and \\(x_1\\)\n\n$$\\int_0^1 x\\,dx$$";
    renderTx([userText(1, "what is $\\alpha$?"), assistant(2, [{ type: "text", text: md }])]);
    await userEvent.click(within(screen.getByTestId("user-message")).getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenLastCalledWith("what is $\\alpha$?");
    await userEvent.click(within(screen.getByTestId("assistant-message")).getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenLastCalledWith(md);
  });
});
