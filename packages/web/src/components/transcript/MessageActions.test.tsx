import type { Session, StoredMessage } from "@agent-workstation/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, resultMsg, session, SID, toolResult, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, type PendingUser } from "../../lib/session-reducer";

const mocks = vi.hoisted(() => ({
  rewind: vi.fn(),
  fork: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  copyText: vi.fn(async (_t: string) => true),
}));

vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, rewind: mocks.rewind, fork: mocks.fork, pinMessage: mocks.pinMessage, unpinMessage: mocks.unpinMessage } };
});
vi.mock("../../lib/clipboard", () => ({ copyText: (t: string) => mocks.copyText(t) }));
vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));

import { useComposer } from "../../store/composer";
import { useSessions } from "../../store/sessions";
import { PinnedCard } from "../overview/PinnedCard";
import { stopSpeaking } from "../../lib/speech";
import { Transcript } from "./Transcript";

const NEW_ID = "22222222-2222-4222-8222-222222222222";

function Live() {
  const view = useSessions((s) => s.views[SID]);
  return view ? <Transcript view={view} /> : null;
}
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

interface Setup {
  kind?: "code" | "chat";
  cwd?: string;
  status?: Session["status"];
  parentSessionId?: string;
  pinned?: string[];
  pending?: PendingUser[];
  extra?: ReactNode;
}

function setup(messages: StoredMessage[], o: Setup = {}) {
  const s = session({ kind: o.kind ?? "code", cwd: o.cwd ?? (o.kind === "chat" ? ".chat" : ""), status: o.status ?? "idle", ...(o.parentSessionId ? { parentSessionId: o.parentSessionId } : {}), ...(o.pinned ? { pinnedMessages: o.pinned } : {}) });
  useSessions.getState().reset();
  useSessions.getState().setSessions([s]);
  const view = { ...insertMessages(emptyView(SID, s), messages), snapshotReceived: true, pendingUser: o.pending ?? [] };
  useSessions.setState((st) => ({ views: { ...st.views, [SID]: view } }));
  return render(
    <TestRouter initialEntries={[`/s/${SID}`]}>
      <Routes>
        <Route
          path="/s/:id"
          element={
            <>
              <Live />
              {o.extra}
              <Where />
            </>
          }
        />
      </Routes>
    </TestRouter>,
  );
}

const rowNames = (row: HTMLElement) => within(row).queryAllByRole("button").map((b) => b.getAttribute("aria-label"));
const userRow = () => within(screen.getByTestId("user-message")).getByTestId("message-actions");
const assistantRow = (i = 0) => within(screen.getAllByTestId("assistant-message")[i]!).getByTestId("message-actions");

const speech = {
  speak: vi.fn(),
  cancel: vi.fn(),
  getVoices: vi.fn(() => [{ lang: "en-US", name: "Local", default: true, localService: true, voiceURI: "local" }]),
};
function mockSpeech() {
  class Utterance {
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    lang = "";
    voice: unknown = null;
    constructor(public text: string) {}
  }
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: speech });
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useComposer.setState({ drafts: {} });
  mocks.rewind.mockResolvedValue({ draft: "the removed text", filesRestored: false });
  mocks.fork.mockResolvedValue({ session: session({ id: NEW_ID, title: "Test session (fork)" }), draft: "forked draft" });
  mocks.pinMessage.mockResolvedValue({});
  mocks.unpinMessage.mockResolvedValue({});
});
afterEach(() => {
  act(() => stopSpeaking());
  delete (window as { speechSynthesis?: unknown }).speechSynthesis;
  vi.unstubAllGlobals();
});

const TURN = [userText(1, "hello **x**", "u-1"), assistant(2, [{ type: "text", text: "Here is `code`." }])];

describe("one copy button", () => {
  it("an assistant message that starts with a code block has no floating message button; its Copy is in the action row", () => {
    setup([userText(1, "q"), assistant(2, [{ type: "text", text: "```js\nconst a = 1;\n```\n\nAfter the code." }])]);
    const msg = screen.getByTestId("assistant-message");
    const copies = within(msg).getAllByRole("button", { name: /^Copy/ });
    expect(copies.map((b) => b.getAttribute("aria-label"))).toEqual(["Copy code", "Copy"]);
    const message = within(msg).getByRole("button", { name: "Copy" });
    expect(message.closest("[data-testid=message-actions]")).not.toBeNull();
    expect(message.closest(".absolute")).toBeNull();
    // nothing sits beside the code block but the code block's own button
    const code = within(msg).getByRole("button", { name: "Copy code" });
    expect(code.closest("[data-testid=message-actions]")).toBeNull();
  });

  it("the user bubble has no floating button either", () => {
    setup(TURN);
    const bubble = screen.getByTestId("user-message");
    expect(within(bubble).getAllByRole("button", { name: "Copy" })).toHaveLength(1);
    expect(within(bubble).getByRole("button", { name: "Copy" }).closest("[data-testid=message-actions]")).not.toBeNull();
  });
});

describe("the action row per kind and role", () => {
  beforeEach(mockSpeech);

  it("Code, user: ✓✓ · time · Copy · Rewind · Fork", () => {
    setup(TURN);
    const row = userRow();
    expect(within(row).getByTestId("delivered")).toHaveTextContent("✓✓");
    expect(within(row).getByTestId("message-time")).toBeInTheDocument();
    expect(rowNames(row)).toEqual(["Copy", "Rewind", "Fork"]);
    // the time comes before the buttons
    expect(row.textContent).toMatch(/^✓✓/);
  });

  it("the latest finished turn keeps its row visible; older turns show theirs on hover", () => {
    setup([...TURN, userText(3, "again", "u-3"), assistant(4, [{ type: "text", text: "Second answer." }])]);
    expect(assistantRow(0).dataset.always).toBeUndefined();
    expect(assistantRow(1).dataset.always).toBe("true");
    expect(within(assistantRow(1)).getAllByRole("button")[0]!.parentElement!.className).not.toContain("opacity-0");
    expect(within(assistantRow(0)).getAllByRole("button")[0]!.parentElement!.className).toContain("opacity-0");
  });

  it("Code, assistant: Copy · Fork · Pin · Read aloud · time", () => {
    setup(TURN);
    const row = assistantRow();
    expect(rowNames(row)).toEqual(["Copy", "Fork", "Pin", "Read aloud"]);
    const items = Array.from(row.querySelectorAll("button, time")).map((e) => e.tagName.toLowerCase());
    expect(items[items.length - 1]).toBe("time");
  });

  it("Chat, user: time · Retry · Edit · Copy", () => {
    setup(TURN, { kind: "chat" });
    const row = userRow();
    expect(rowNames(row)).toEqual(["Retry", "Edit", "Copy"]);
    expect(within(row).getByTestId("message-time")).toBeInTheDocument();
    expect(within(row).queryByTestId("delivered")).toBeNull();
    const first = row.querySelector("button, time");
    expect(first?.tagName.toLowerCase()).toBe("time");
  });

  it("Chat, assistant: Copy · Read aloud · Retry · time", () => {
    setup(TURN, { kind: "chat" });
    expect(rowNames(assistantRow())).toEqual(["Copy", "Read aloud", "Retry"]);
  });

  it("a subagent's child session shows no Rewind and no Fork", () => {
    setup(TURN, { parentSessionId: "33333333-3333-4333-8333-333333333333" });
    expect(rowNames(userRow())).toEqual(["Copy"]);
    expect(rowNames(assistantRow())).toEqual(["Copy", "Pin", "Read aloud"]);
  });

  it("the row is hidden until hover (always shown on touch screens) and the time has the full date as its tooltip", () => {
    const at = new Date(2026, 0, 15, 9, 0).toISOString();
    setup([{ ...userText(1, "hi"), at }, { ...assistant(2, [{ type: "text", text: "yo" }]), at }]);
    const row = userRow();
    const group = row.firstElementChild!;
    expect(group.className).toContain("opacity-0");
    expect(group.className).toContain("group-hover/msg:opacity-100");
    expect(group.className).toContain("[@media(hover:none)]:opacity-100");
    expect(within(row).getByTestId("message-time")).toHaveAttribute("title", "Jan 15, 2026, 9:00 AM");
    expect(within(assistantRow()).getByTestId("message-time")).toHaveAttribute("title", "Jan 15, 2026, 9:00 AM");
  });

  it("only the last assistant message of a turn gets a row, under its final text", () => {
    setup([
      userText(1, "go", "u-1"),
      assistant(2, [{ type: "text", text: "Let me check." }]),
      assistant(3, [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }]),
      toolResult(4, "tu1", "a.txt"),
      assistant(5, [{ type: "text", text: "Final answer." }]),
      userText(6, "again", "u-6"),
      assistant(7, [{ type: "text", text: "Second." }]),
    ]);
    const msgs = screen.getAllByTestId("assistant-message");
    expect(msgs).toHaveLength(2);
    expect(within(msgs[0]!).getAllByTestId("message-actions")).toHaveLength(1);
    expect(within(msgs[1]!).getAllByTestId("message-actions")).toHaveLength(1);
  });

  it("a turn split by a failed result gets the row on its last piece only; a running turn has none yet", () => {
    const { unmount } = setup([userText(1, "go"), assistant(2, [{ type: "text", text: "first part" }]), resultMsg(3, { subtype: "error_during_execution", is_error: true, errors: ["boom"] }), assistant(4, [{ type: "text", text: "second part" }])]);
    const msgs = screen.getAllByTestId("assistant-message");
    expect(within(msgs[0]!).queryByTestId("message-actions")).toBeNull();
    expect(within(msgs[1]!).getByTestId("message-actions")).toBeInTheDocument();
    unmount();
    setup(TURN, { status: "running" });
    expect(within(screen.getByTestId("assistant-message")).queryByTestId("message-actions")).toBeNull();
    expect(screen.getByTestId("user-message")).toBeInTheDocument();
  });

  it("a message that is still going out shows a single ✓", () => {
    setup([], { pending: [{ uuid: "p1", text: "on its way", images: [], state: "sending", position: null, at: Date.now() }] });
    expect(within(screen.getByTestId("pending-user")).getByTestId("sent-mark")).toHaveTextContent(/^✓$/);
  });
});

describe("Copy", () => {
  it("copies the user message as written, and the final text of the turn's last assistant message (no tool output)", async () => {
    setup([
      userText(1, "hello **x**", "u-1"),
      assistant(2, [{ type: "text", text: "Let me check." }]),
      assistant(3, [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }]),
      toolResult(4, "tu1", "TOOL OUTPUT"),
      assistant(5, [
        { type: "text", text: "Part one.\n\n- a\n- b" },
        { type: "text", text: "Part **two**." },
      ]),
    ]);
    await userEvent.click(within(userRow()).getByRole("button", { name: "Copy" }));
    expect(mocks.copyText).toHaveBeenLastCalledWith("hello **x**");
    await userEvent.click(within(assistantRow()).getByRole("button", { name: "Copy" }));
    expect(mocks.copyText).toHaveBeenLastCalledWith("Part one.\n\n- a\n- b\n\nPart **two**.");
  });
});

describe("Rewind (Code)", () => {
  it("asks first; Rewind sends the message uuid and the removed text lands in the composer", async () => {
    setup(TURN);
    await userEvent.click(within(userRow()).getByRole("button", { name: "Rewind" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Rewind to before this message?" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Rewind code too" })).toBeNull(); // not a synced project
    expect(mocks.rewind).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));
    expect(mocks.rewind).toHaveBeenCalledWith(SID, { messageUuid: "u-1" });
    await waitFor(() => expect(useComposer.getState().drafts[SID]?.text).toBe("the removed text"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers Rewind code too in a synced project and sends files: true", async () => {
    setup(TURN, { cwd: "projects/demo" });
    await userEvent.click(within(userRow()).getByRole("button", { name: "Rewind" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Rewind code too" }));
    expect(mocks.rewind).toHaveBeenCalledWith(SID, { messageUuid: "u-1", files: true });
    await waitFor(() => expect(useComposer.getState().drafts[SID]?.text).toBe("the removed text"));
  });

  it("Cancel does nothing", async () => {
    setup(TURN);
    await userEvent.click(within(userRow()).getByRole("button", { name: "Rewind" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(mocks.rewind).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps what is already typed in the composer behind the restored text", async () => {
    useComposer.getState().setText(SID, "half-typed");
    setup(TURN);
    await userEvent.click(within(userRow()).getByRole("button", { name: "Rewind" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rewind" }));
    await waitFor(() => expect(useComposer.getState().drafts[SID]?.text).toBe("the removed text\n\nhalf-typed"));
  });
});

describe("Fork (Code)", () => {
  it("forks at a user message, opens the new session and puts the draft into its composer", async () => {
    setup(TURN);
    await userEvent.click(within(userRow()).getByRole("button", { name: "Fork" }));
    expect(mocks.fork).toHaveBeenCalledWith(SID, "u-1");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/s/${NEW_ID}`));
    expect(useComposer.getState().drafts[NEW_ID]?.text).toBe("forked draft");
    expect(useSessions.getState().sessions[NEW_ID]).toBeDefined();
  });

  it("forks at an assistant message without a draft", async () => {
    mocks.fork.mockResolvedValue({ session: session({ id: NEW_ID }), draft: null });
    setup(TURN);
    await userEvent.click(within(assistantRow()).getByRole("button", { name: "Fork" }));
    expect(mocks.fork).toHaveBeenCalledWith(SID, "u-2");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/s/${NEW_ID}`));
    expect(useComposer.getState().drafts[NEW_ID]).toBeUndefined();
  });
});

describe("Pin (Code)", () => {
  it("pins and unpins, with a pin mark while pinned", async () => {
    setup(TURN);
    expect(screen.queryByTestId("pin-mark")).toBeNull();
    await userEvent.click(within(assistantRow()).getByRole("button", { name: "Pin" }));
    expect(mocks.pinMessage).toHaveBeenCalledWith(SID, "u-2");
    expect(useSessions.getState().sessions[SID]?.pinnedMessages).toEqual(["u-2"]);
    expect(await screen.findByTestId("pin-mark")).toBeInTheDocument();
    await userEvent.click(within(assistantRow()).getByRole("button", { name: "Unpin" }));
    expect(mocks.unpinMessage).toHaveBeenCalledWith(SID, "u-2");
    expect(useSessions.getState().sessions[SID]?.pinnedMessages).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId("pin-mark")).toBeNull());
  });

  it("puts the mark back when the hub refuses", async () => {
    mocks.pinMessage.mockRejectedValue(new Error("nope"));
    setup(TURN);
    await userEvent.click(within(assistantRow()).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(useSessions.getState().sessions[SID]?.pinnedMessages).toEqual([]));
    expect(screen.queryByTestId("pin-mark")).toBeNull();
  });

  it("Overview gets a Pinned card with the first line of each pinned message; a click scrolls to the message", async () => {
    const scrolled: Element[] = [];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    try {
      setup([userText(1, "q"), assistant(2, [{ type: "text", text: "# Heading line\n\nbody" }]), userText(3, "q2"), assistant(4, [{ type: "text", text: "**Second** pinned" }])], { pinned: ["u-4", "u-2"], extra: <PinnedCard sessionId={SID} /> });
      const items = screen.getAllByTestId("overview-pinned-item");
      expect(items.map((i) => i.textContent)).toEqual(["Second pinned", "Heading line"]); // pin order
      await userEvent.click(items[1]!);
      const target = scrolled[scrolled.length - 1]!;
      expect(target.getAttribute("data-uuids")).toContain("u-2");
      expect(target).toHaveTextContent("Heading line");
    } finally {
      spy.mockRestore();
    }
  });

  it("the card is hidden when nothing is pinned", () => {
    setup(TURN, { extra: <PinnedCard sessionId={SID} /> });
    expect(screen.queryByTestId("overview-pinned")).toBeNull();
  });
});

describe("Retry and Edit (Chat)", () => {
  it("Retry on a user message rewinds to it with an empty resend", async () => {
    setup(TURN, { kind: "chat" });
    await userEvent.click(within(userRow()).getByRole("button", { name: "Retry" }));
    expect(mocks.rewind).toHaveBeenCalledWith(SID, { messageUuid: "u-1", resend: {} });
    expect(useComposer.getState().drafts[SID]).toBeUndefined(); // a resend does not touch the composer
  });

  it("Retry on an assistant message rewinds to its user message", async () => {
    setup([userText(1, "first", "u-1"), assistant(2, [{ type: "text", text: "one" }]), userText(3, "second", "u-3"), assistant(4, [{ type: "text", text: "two" }])], { kind: "chat" });
    await userEvent.click(within(assistantRow(1)).getByRole("button", { name: "Retry" }));
    expect(mocks.rewind).toHaveBeenCalledWith(SID, { messageUuid: "u-3", resend: {} });
  });

  it("Edit turns the bubble into an editor; Send rewinds with the new text, Cancel puts the bubble back", async () => {
    setup(TURN, { kind: "chat" });
    await userEvent.click(within(userRow()).getByRole("button", { name: "Edit" }));
    const editor = screen.getByTestId("user-editor");
    const box = within(editor).getByRole("textbox");
    expect(box).toHaveValue("hello **x**");
    await userEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("user-editor")).toBeNull();
    expect(screen.getByTestId("user-message")).toHaveTextContent("hello");
    expect(mocks.rewind).not.toHaveBeenCalled();

    await userEvent.click(within(userRow()).getByRole("button", { name: "Edit" }));
    const box2 = within(screen.getByTestId("user-editor")).getByRole("textbox");
    await userEvent.clear(box2);
    await userEvent.type(box2, "better question");
    await userEvent.click(within(screen.getByTestId("user-editor")).getByRole("button", { name: "Send" }));
    expect(mocks.rewind).toHaveBeenCalledWith(SID, { messageUuid: "u-1", resend: { text: "better question" } });
    expect(screen.queryByTestId("user-editor")).toBeNull();
  });

  it("Send is disabled while the editor is empty", async () => {
    setup(TURN, { kind: "chat" });
    await userEvent.click(within(userRow()).getByRole("button", { name: "Edit" }));
    await userEvent.clear(within(screen.getByTestId("user-editor")).getByRole("textbox"));
    expect(within(screen.getByTestId("user-editor")).getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

describe("Read aloud", () => {
  const TWO = [userText(1, "q1"), assistant(2, [{ type: "text", text: "First answer." }]), userText(3, "q2"), assistant(4, [{ type: "text", text: "Second answer.\n\n```py\nskipped()\n```" }])];

  it("speaks the message, the button turns into Stop, and Stop cancels", async () => {
    mockSpeech();
    setup(TURN);
    await userEvent.click(within(assistantRow()).getByRole("button", { name: "Read aloud" }));
    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect(speech.speak.mock.calls[0]![0].text).toBe("Here is code."); // Markdown stripped
    const stop = within(assistantRow()).getByRole("button", { name: "Stop" });
    speech.cancel.mockClear();
    await userEvent.click(stop);
    expect(speech.cancel).toHaveBeenCalled();
    expect(within(assistantRow()).getByRole("button", { name: "Read aloud" })).toBeInTheDocument();
  });

  it("goes back to Read aloud when the speech ends", async () => {
    mockSpeech();
    setup(TURN);
    await userEvent.click(within(assistantRow()).getByRole("button", { name: "Read aloud" }));
    const u = speech.speak.mock.calls[0]![0] as { onend: () => void };
    act(() => u.onend());
    expect(within(assistantRow()).getByRole("button", { name: "Read aloud" })).toBeInTheDocument();
  });

  it("only one message speaks at a time, and code blocks are skipped", async () => {
    mockSpeech();
    setup(TWO);
    await userEvent.click(within(assistantRow(0)).getByRole("button", { name: "Read aloud" }));
    expect(within(assistantRow(0)).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await userEvent.click(within(assistantRow(1)).getByRole("button", { name: "Read aloud" }));
    expect(within(assistantRow(1)).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(within(assistantRow(0)).getByRole("button", { name: "Read aloud" })).toBeInTheDocument();
    expect(speech.speak.mock.calls[1]![0].text).toBe("Second answer.");
  });

  it("is not offered where speechSynthesis is missing", () => {
    setup(TURN);
    expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
    expect(rowNames(assistantRow())).toEqual(["Copy", "Fork", "Pin"]);
  });
});
