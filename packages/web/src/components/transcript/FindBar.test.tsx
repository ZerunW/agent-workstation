import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { emptyView, insertMessages, type SessionView } from "../../lib/session-reducer";

const loadEarlier = vi.fn();
vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: (...a: unknown[]) => loadEarlier(...a) }));

import { useFindHotkey } from "../../hooks/useFindHotkey";
import { useApp } from "../../store/app";
import { Transcript } from "./Transcript";

function Harness({ view, withTranscript = true }: { view: SessionView; withTranscript?: boolean }) {
  useFindHotkey();
  return withTranscript ? <Transcript view={view} /> : <div data-testid="home" />;
}

const viewOf = (messages: ReturnType<typeof userText>[], over: Partial<SessionView> = {}): SessionView => ({ ...insertMessages(emptyView(SID, session()), messages), snapshotReceived: true, ...over });

/** keydown on the page; false = the app called preventDefault (so the browser's own find stays closed). */
const press = (init: KeyboardEventInit, target: Element = document.body) => fireEvent.keyDown(target, init);
const cmdF = (target?: Element) => press({ key: "f", metaKey: true }, target);

const MESSAGES = [userText(1, "alpha beta", "u-1"), assistant(2, [{ type: "text", text: "Alpha again. And alpha." }])];

const count = () => screen.getByTestId("find-count");
const openAndType = async (q: string) => {
  cmdF();
  await userEvent.type(await screen.findByTestId("find-input"), q);
};
const marks = () => Array.from(document.querySelectorAll("mark[data-find]"));
const currentMark = () => document.querySelector("mark[data-find-current]");

beforeEach(() => {
  loadEarlier.mockClear();
  useApp.setState({ searchOpen: false });
});
afterEach(() => vi.restoreAllMocks());

describe("⌘F inside a session", () => {
  it("opens the find bar (not the search dialog) and keeps the browser's own find away", async () => {
    render(<Harness view={viewOf(MESSAGES)} />);
    expect(screen.queryByTestId("find-bar")).toBeNull();
    expect(cmdF()).toBe(false); // preventDefault was called
    const input = await screen.findByTestId("find-input");
    expect(input).toHaveFocus();
    expect(useApp.getState().searchOpen).toBe(false);
    expect(press({ key: "f", ctrlKey: true })).toBe(false); // Ctrl+F too
  });

  it("counts the matches in the whole session, highlights them and walks them with Enter, Shift+Enter and the buttons", async () => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    render(<Harness view={viewOf(MESSAGES)} />);
    await openAndType("alpha");
    await waitFor(() => expect(count()).toHaveTextContent("1/3"));
    expect(marks()).toHaveLength(3);
    expect(marks().map((m) => m.textContent)).toEqual(["alpha", "Alpha", "alpha"]);
    expect(marks().indexOf(currentMark()!)).toBe(0);
    expect(scrolled.length).toBeGreaterThan(0); // scrolled to the first match

    const input = screen.getByTestId("find-input");
    await userEvent.type(input, "{Enter}");
    await waitFor(() => expect(count()).toHaveTextContent("2/3"));
    expect(marks().indexOf(currentMark()!)).toBe(1);
    expect(scrolled[scrolled.length - 1]).toBe(currentMark());
    await userEvent.type(input, "{Enter}");
    await waitFor(() => expect(count()).toHaveTextContent("3/3"));
    await userEvent.type(input, "{Enter}");
    await waitFor(() => expect(count()).toHaveTextContent("1/3")); // wraps
    await userEvent.type(input, "{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(count()).toHaveTextContent("3/3"));

    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(count()).toHaveTextContent("2/3"));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(count()).toHaveTextContent("3/3"));
  });

  it("Esc closes the bar and clears the highlights", async () => {
    render(<Harness view={viewOf(MESSAGES)} />);
    await openAndType("alpha");
    await waitFor(() => expect(marks()).toHaveLength(3));
    await userEvent.type(screen.getByTestId("find-input"), "{Escape}");
    expect(screen.queryByTestId("find-bar")).toBeNull();
    expect(marks()).toHaveLength(0);
    expect(screen.getByTestId("transcript")).toHaveTextContent("alpha beta"); // the text is whole again
  });

  it("shows 0/0 for no match and nothing for an empty query; Enter then does nothing", async () => {
    render(<Harness view={viewOf(MESSAGES)} />);
    cmdF();
    expect(count()).toHaveTextContent("");
    await userEvent.type(await screen.findByTestId("find-input"), "zzz{Enter}");
    await waitFor(() => expect(count()).toHaveTextContent("0/0"));
    expect(marks()).toHaveLength(0);
  });

  it("⌘F again while the bar is open focuses its input", async () => {
    render(<Harness view={viewOf(MESSAGES)} />);
    await openAndType("alpha");
    (document.activeElement as HTMLElement).blur();
    expect(screen.getByTestId("find-input")).not.toHaveFocus();
    cmdF(screen.getByTestId("transcript"));
    await waitFor(() => expect(screen.getByTestId("find-input")).toHaveFocus());
  });

  it("opens only the folded tool groups that hold a match", async () => {
    const view = viewOf([
      userText(1, "run things"),
      assistant(2, [
        { type: "text", text: "first" },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "echo needle" } },
        { type: "text", text: "middle" },
        { type: "tool_use", id: "tu2", name: "Bash", input: { command: "echo other" } },
        { type: "text", text: "end" },
      ]),
      toolResult(3, "tu1", "needle\n"),
      toolResult(4, "tu2", "other\n"),
    ]);
    render(<Harness view={view} />);
    const groups = screen.getAllByTestId("tool-group");
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.dataset.open)).toEqual(["false", "false"]);
    await openAndType("needle");
    await waitFor(() => expect(screen.getAllByTestId("tool-group").map((g) => g.dataset.open)).toEqual(["true", "false"]));
    await waitFor(() => expect(count().textContent).toMatch(/^1\/[1-9]/));
    expect(within(screen.getAllByTestId("tool-group")[0]!).getByTestId("tool-card")).toBeInTheDocument();
    expect(within(screen.getAllByTestId("tool-group")[1]!).queryByTestId("tool-card")).toBeNull();
  });

  it("a query that is nowhere in a folded group leaves every group closed", async () => {
    const view = viewOf([userText(1, "go"), assistant(2, [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }, { type: "text", text: "done" }]), toolResult(3, "tu1", "x")]);
    render(<Harness view={view} />);
    await openAndType("done");
    await waitFor(() => expect(count()).toHaveTextContent("1/1"));
    expect(screen.getByTestId("tool-group").dataset.open).toBe("false");
  });

  it("loads the earlier pages first when not everything is loaded", async () => {
    render(<Harness view={viewOf([userText(5, "later alpha"), assistant(6, [{ type: "text", text: "later" }])], { truncated: true })} />);
    cmdF();
    await screen.findByTestId("find-input");
    expect(loadEarlier).not.toHaveBeenCalled(); // nothing to search for yet
    await userEvent.type(screen.getByTestId("find-input"), "alpha");
    await waitFor(() => expect(loadEarlier).toHaveBeenCalledWith(SID));
    expect(loadEarlier).toHaveBeenCalledTimes(1);
  });
});

describe("⌘F outside a session", () => {
  it("opens the session search dialog and keeps the browser's own find away", () => {
    render(<Harness view={viewOf([])} withTranscript={false} />);
    expect(useApp.getState().searchOpen).toBe(false);
    expect(cmdF()).toBe(false);
    expect(useApp.getState().searchOpen).toBe(true);
    expect(screen.queryByTestId("find-bar")).toBeNull();
  });

  it("leaves other shortcuts and a focused terminal alone", () => {
    render(<Harness view={viewOf([])} withTranscript={false} />);
    expect(press({ key: "f" })).toBe(true); // no modifier
    expect(press({ key: "f", metaKey: true, shiftKey: true })).toBe(true);
    const term = document.createElement("div");
    term.className = "xterm";
    document.body.appendChild(term);
    expect(cmdF(term)).toBe(true);
    term.remove();
    expect(useApp.getState().searchOpen).toBe(false);
  });
});
