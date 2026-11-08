import { act, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, resultMsg, session, SID, snapshotEvent, toolResult, usageDelta, userText } from "../../test/fixtures";
import { openToolGroups } from "../../test/groups";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, reduceSessionEvent, type SessionView } from "../../lib/session-reducer";

const sendPermissionResponse = vi.fn();
const loadEarlier = vi.fn();
vi.mock("../../store/hub", () => ({ sendPermissionResponse: (...a: unknown[]) => sendPermissionResponse(...a), backfill: vi.fn(), loadEarlier: (...a: unknown[]) => loadEarlier(...a) }));

import { Transcript } from "./Transcript";

/** Tool groups start collapsed: most tests look at what is inside them, so this render opens them (`rtlRender` leaves them closed). */
const render = (ui: ReactElement) => {
  const r = rtlRender(ui);
  openToolGroups();
  return r;
};

function viewWith(messages: ReturnType<typeof userText>[], over: Partial<SessionView> = {}, status: "idle" | "running" = "idle"): SessionView {
  const v = insertMessages(emptyView(SID, session({ status })), messages);
  return { ...v, snapshotReceived: true, ...over };
}

describe("Transcript", () => {
  beforeEach(() => {
    sendPermissionResponse.mockClear();
    loadEarlier.mockClear();
  });

  it("offers 'Load earlier messages' only when a truncated replay left a gap, and asks the store to fetch them", async () => {
    const { rerender } = render(<Transcript view={viewWith([userText(5, "later question"), assistant(6, [{ type: "text", text: "later answer" }])], { truncated: true })} />);
    await userEvent.click(screen.getByTestId("load-earlier"));
    expect(loadEarlier).toHaveBeenCalledWith(SID);

    rerender(<Transcript view={viewWith([userText(5, "later question")], { truncated: true, loadingEarlier: true })} />);
    expect(screen.getByTestId("load-earlier")).toBeDisabled();

    // contiguous from seq 1 (or never truncated): no control
    rerender(<Transcript view={viewWith([userText(1, "a"), userText(2, "b")], { truncated: true })} />);
    expect(screen.queryByTestId("load-earlier")).toBeNull();
    rerender(<Transcript view={viewWith([userText(5, "e")], { truncated: false })} />);
    expect(screen.queryByTestId("load-earlier")).toBeNull();
  });

  it("renders user bubbles and markdown assistant text, and a successful result leaves no row", () => {
    const view = viewWith([userText(1, "Hello there"), assistant(2, [{ type: "text", text: "## Heading\n\nSome **bold** text and `code`." }]), resultMsg(3)]);
    render(<Transcript view={view} />);
    expect(screen.getByTestId("user-message")).toHaveTextContent("Hello there");
    expect(screen.getByRole("heading", { level: 2, name: "Heading" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.queryByTestId("result-divider")).toBeNull();
    expect(screen.queryByText(/\$0\.012/)).toBeNull();
    expect(screen.queryByTestId("turn-indicator")).toBeNull(); // idle
  });

  it("shows the error state on failed results", () => {
    const view = viewWith([userText(1, "x"), resultMsg(2, { subtype: "error_during_execution", is_error: true, errors: ["spawn failed"] })]);
    render(<Transcript view={view} />);
    const r = screen.getByTestId("result-divider");
    expect(r).toHaveAttribute("data-error", "true");
    expect(r).toHaveTextContent("error during execution");
    expect(r).toHaveTextContent("spawn failed");
  });

  it("renders a collapsed tool card with a one-line summary and expands to input + paired result", async () => {
    const view = viewWith([
      userText(1, "list files"),
      assistant(2, [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la", description: "List files" } }]),
      toolResult(3, "tu1", "total 0\nfile-a.txt"),
    ]);
    rtlRender(<Transcript view={view} />);
    expect(screen.queryByTestId("tool-card")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Ran a command/ }));
    const card = screen.getByTestId("tool-card");
    expect(card).toHaveTextContent("Bash");
    expect(card).toHaveTextContent("List files");
    expect(screen.queryByText(/file-a\.txt/)).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: /Bash/ }));
    expect(screen.getByText(/file-a\.txt/)).toBeInTheDocument();
    expect(card).toHaveTextContent("ls -la");
  });

  it("renders Edit tool calls as a diff inside a collapsed row", async () => {
    const view = viewWith([
      assistant(1, [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" } }]),
      toolResult(2, "e1", "updated"),
    ]);
    rtlRender(<Transcript view={view} />);
    expect(screen.queryByTestId("diff-view")).toBeNull();
    await userEvent.click(screen.getByTestId("tool-group").querySelector("button")!);
    expect(screen.queryByTestId("diff-view")).toBeNull(); // the row is collapsed too
    await userEvent.click(within(screen.getByTestId("tool-card")).getByRole("button"));
    const diff = screen.getByTestId("diff-view");
    expect(diff).toHaveTextContent("src/a.ts");
    expect(diff).toHaveTextContent("+2");
    expect(diff).toHaveTextContent("−1");
    expect(diff).toHaveTextContent("const b = 3;");
  });

  it("folds thinking into a group line; the group and its row open to the text", async () => {
    const view = viewWith([assistant(1, [{ type: "thinking", thinking: "secret reasoning" }, { type: "text", text: "answer" }])]);
    rtlRender(<Transcript view={view} />);
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Thought");
    expect(screen.queryByText("secret reasoning")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Thought/ }));
    await userEvent.click(within(screen.getByTestId("thinking")).getByRole("button"));
    expect(screen.getByText("secret reasoning", { selector: "div" })).toBeInTheDocument();
  });

  it("renders in-flight streaming text and a thinking/tool partial", () => {
    let v = viewWith([userText(1, "go")], {}, "running");
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "text", messageId: "m", text: "Streaming so far" } });
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_start", messageId: "m", toolUseId: "t", toolName: "Read" } });
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_input", messageId: "m", toolUseId: "t", partialJson: '{"file_path":"/a/b.ts"' } });
    render(<Transcript view={v} />);
    const s = screen.getByTestId("streaming");
    expect(s).toHaveTextContent("Streaming so far");
    expect(s).toHaveTextContent("b.ts");
    // the indicator is the last line of the transcript, after what is streaming
    const indicator = screen.getByTestId("turn-indicator");
    expect(s.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows pending/queued/failed optimistic user messages", () => {
    const v = reduceSessionEvent(
      reduceSessionEvent(viewWith([]), { type: "pending_user_add", entry: { uuid: "p1", text: "queued one", images: [], state: "queued", position: 2, at: 0 } }),
      { type: "pending_user_add", entry: { uuid: "p2", text: "bad one", images: [], state: "failed", position: null, error: "boom", at: 0 } },
    );
    render(<Transcript view={v} />);
    expect(screen.getByText("queued one")).toBeInTheDocument();
    expect(screen.getByText(/position 2/)).toBeInTheDocument();
    expect(screen.getByText(/Failed to send: boom/)).toBeInTheDocument();
  });

  it("renders rate-limit assistant errors as a notice with the reset time", () => {
    const view = viewWith([assistant(1, [{ type: "text", text: "You've hit your session limit · resets 3pm (America/New_York)" }], { error: "rate_limit" })]);
    render(<Transcript view={view} />);
    const n = screen.getByTestId("assistant-error");
    expect(n).toHaveTextContent("Rate limit reached · resets 3pm");
  });

  it("renders compact-boundary dividers and the empty state", () => {
    const { rerender } = render(<Transcript view={viewWith([])} />);
    expect(screen.getByText("Start a code session")).toBeInTheDocument();
    expect(screen.queryByText(/Describe what you want/)).toBeNull();
    rerender(<Transcript view={viewWith([{ ...userText(1, "x"), kind: "system", payload: { type: "system", subtype: "compact_boundary" } }])} />);
    expect(screen.getByTestId("divider")).toHaveAttribute("data-variant", "compact");
  });
});

describe("turn indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const running = (startedAgoMs: number, tokens = 0): SessionView => {
    const started = new Date(Date.now() - startedAgoMs).toISOString();
    const v = reduceSessionEvent(viewWith([userText(1, "go")], {}, "running"), snapshotEvent(session({ status: "running" }), tokens ? { turnOutputTokens: tokens } : {}, null, started));
    return v;
  };

  it("shows dots with the elapsed time while busy, then the tokens once there are some", () => {
    const { rerender } = render(<Transcript view={running(12_000)} />);
    const el = screen.getByTestId("turn-indicator");
    expect(el).toHaveAttribute("role", "status");
    expect(el).toHaveTextContent(/^12s$/);
    expect(el.querySelectorAll(".turn-dot")).toHaveLength(3);

    rerender(<Transcript view={reduceSessionEvent(running(12_000), usageDelta(1_200))} />);
    expect(screen.getByTestId("turn-indicator")).toHaveTextContent("12s · 1.2k tokens");
  });

  it("ticks every second and formats minutes", () => {
    render(<Transcript view={running(5 * 60_000 + 20_000)} />);
    expect(screen.getByTestId("turn-indicator")).toHaveTextContent("5m 20s");
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("turn-indicator")).toHaveTextContent("5m 21s");
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByTestId("turn-indicator")).toHaveTextContent("5m 24s");
  });

  it("disappears the moment the turn ends", () => {
    const busy = running(3000, 500);
    const { rerender } = render(<Transcript view={busy} />);
    expect(screen.getByTestId("turn-indicator")).toBeInTheDocument();
    rerender(<Transcript view={reduceSessionEvent(busy, { type: "session_state", sessionId: SID, status: "idle", queuePosition: null })} />);
    expect(screen.queryByTestId("turn-indicator")).toBeNull();
  });

  it("is shown while waiting for a permission answer, above the permission card", () => {
    const request = { requestId: "r1", sessionId: SID, toolName: "Bash", input: { command: "ls" }, toolUseId: undefined, at: "2026-10-31T00:00:00Z" };
    const v = reduceSessionEvent(running(1000), { type: "permission_request", request });
    render(<Transcript view={v} />);
    const card = screen.getByTestId("permission-card");
    expect(screen.getByTestId("turn-indicator").compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("without a known start it still shows the dots (no time)", () => {
    const v = { ...viewWith([userText(1, "go")], {}, "queued" as never), turn: { startedAt: null, outputTokens: 0 } };
    render(<Transcript view={v} />);
    expect(screen.getByTestId("turn-indicator")).toBeInTheDocument();
    expect(screen.queryByTestId("turn-indicator-text")).toBeNull();
  });

  it("an error result keeps its box, even while idle", () => {
    render(<Transcript view={viewWith([userText(1, "x"), resultMsg(2, { subtype: "error_max_turns", is_error: true })])} />);
    expect(screen.getByTestId("result-divider")).toHaveAttribute("data-error", "true");
    expect(screen.queryByTestId("turn-indicator")).toBeNull();
  });
});

describe("memory chip", () => {
  const remember = (result?: { text: string; isError?: boolean }) =>
    viewWith([
      userText(1, "remember I like tea"),
      assistant(2, [{ type: "tool_use", id: "m1", name: "mcp__workstation-memory__remember", input: { text: "Likes tea." } }]),
      ...(result ? [toolResult(3, "m1", result.text, result.isError)] : []),
    ]);

  it("replaces the tool card with 'Memory saved · text' and a check once the result arrived", () => {
    render(<Transcript view={remember({ text: "Saved: Likes tea." })} />);
    const chip = screen.getByTestId("memory-chip");
    expect(chip).toHaveTextContent("Memory saved · Likes tea.");
    expect(chip).toHaveAttribute("data-state", "done");
    expect(chip.querySelector("svg.text-ok")).not.toBeNull();
    expect(screen.queryByTestId("tool-card")).toBeNull();
  });

  it("has no check before the result", () => {
    render(<Transcript view={remember()} />);
    expect(screen.getByTestId("memory-chip")).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("memory-chip").querySelector("svg.text-ok")).toBeNull();
  });

  it("a remember that came back as an error reads 'Not saved · <the tool's answer>', with no check", () => {
    render(<Transcript view={remember({ text: "Memory is turned off for this user; nothing was saved.", isError: true })} />);
    const chip = screen.getByTestId("memory-chip");
    expect(chip).toHaveAttribute("data-state", "failed");
    expect(chip).toHaveTextContent("Not saved · Memory is turned off for this user; nothing was saved.");
    expect(chip).not.toHaveTextContent("Memory saved");
    expect(chip.querySelector("svg.text-ok")).toBeNull();
    expect(chip.querySelector("svg.text-danger")).not.toBeNull();
    expect(chip.className).toContain("border-danger");
  });

  it("a forget that matched nothing reads 'Not removed · <the tool's answer>'", () => {
    const v = viewWith([assistant(1, [{ type: "tool_use", id: "f1", name: "mcp__workstation-memory__forget", input: { text: "Likes tea." } }]), toolResult(2, "f1", "No memory matches that text; nothing was removed.", true)]);
    render(<Transcript view={v} />);
    const chip = screen.getByTestId("memory-chip");
    expect(chip).toHaveTextContent("Not removed · No memory matches that text; nothing was removed.");
    expect(chip).toHaveAttribute("data-state", "failed");
    expect(chip.querySelector("svg.text-ok")).toBeNull();
  });

  it("an error result without any text falls back to the memory text", () => {
    render(<Transcript view={remember({ text: "", isError: true })} />);
    expect(screen.getByTestId("memory-chip")).toHaveTextContent("Not saved · Likes tea.");
  });

  it("renders forget as 'Memory removed'", () => {
    const v = viewWith([assistant(1, [{ type: "tool_use", id: "f1", name: "mcp__workstation-memory__forget", input: { text: "Likes tea." } }]), toolResult(2, "f1", "Removed: Likes tea.")]);
    render(<Transcript view={v} />);
    expect(screen.getByTestId("memory-chip")).toHaveTextContent("Memory removed · Likes tea.");
  });

  it("leaves other MCP tools as tool cards", () => {
    render(<Transcript view={viewWith([assistant(1, [{ type: "tool_use", id: "x1", name: "mcp__other__remember", input: { text: "x" } }])])} />);
    expect(screen.queryByTestId("memory-chip")).toBeNull();
    expect(screen.getByTestId("tool-card")).toBeInTheDocument();
  });

  it("shows 'Saving to memory…' while the call streams in", () => {
    let v = viewWith([userText(1, "go")], {}, "running");
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_start", messageId: "m", toolUseId: "t", toolName: "mcp__workstation-memory__remember" } });
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_input", messageId: "m", toolUseId: "t", partialJson: '{"text":"Likes' } });
    render(<Transcript view={v} />);
    const chip = screen.getByTestId("memory-chip");
    expect(chip).toHaveTextContent("Saving to memory…");
    expect(chip).not.toHaveTextContent("Likes");
    expect(chip).toHaveAttribute("data-state", "streaming");
    expect(screen.queryByTestId("tool-card")).toBeNull();
  });

  it("opens the Memory page on click (inside a router) and is a plain chip without one", async () => {
    render(
      <TestRouter initialEntries={["/s/x"]}>
        <Routes>
          <Route path="/s/x" element={<Transcript view={remember({ text: "Saved: Likes tea." })} />} />
          <Route path="/memory" element={<div data-testid="memory-route" />} />
        </Routes>
      </TestRouter>,
    );
    await userEvent.click(screen.getByTestId("memory-chip"));
    expect(screen.getByTestId("memory-route")).toBeInTheDocument();
  });

  it("renders without a router too (the embed, bare tests): not a button", () => {
    render(<Transcript view={remember({ text: "Saved: Likes tea." })} />);
    expect(screen.getByTestId("memory-chip").tagName).toBe("DIV");
  });
});

describe("permission cards", () => {
  const request = { requestId: "r1", sessionId: SID, toolName: "Bash", input: { command: "rm -rf build", description: "Clean" }, toolUseId: "tu1", at: "2026-10-31T00:00:00Z" };
  const base = () =>
    reduceSessionEvent(viewWith([assistant(1, [{ type: "tool_use", id: "tu1", name: "Bash", input: request.input }])], {}, "running"), { type: "permission_request", request });

  beforeEach(() => {
    sendPermissionResponse.mockClear();
    loadEarlier.mockClear();
  });

  it("offers 'Load earlier messages' only when a truncated replay left a gap, and asks the store to fetch them", async () => {
    const { rerender } = render(<Transcript view={viewWith([userText(5, "later question"), assistant(6, [{ type: "text", text: "later answer" }])], { truncated: true })} />);
    await userEvent.click(screen.getByTestId("load-earlier"));
    expect(loadEarlier).toHaveBeenCalledWith(SID);

    rerender(<Transcript view={viewWith([userText(5, "later question")], { truncated: true, loadingEarlier: true })} />);
    expect(screen.getByTestId("load-earlier")).toBeDisabled();

    // contiguous from seq 1 (or never truncated): no control
    rerender(<Transcript view={viewWith([userText(1, "a"), userText(2, "b")], { truncated: true })} />);
    expect(screen.queryByTestId("load-earlier")).toBeNull();
    rerender(<Transcript view={viewWith([userText(5, "e")], { truncated: false })} />);
    expect(screen.queryByTestId("load-earlier")).toBeNull();
  });

  it("Allow sends an allow response", async () => {
    render(<Transcript view={base()} />);
    expect(screen.getByTestId("permission-card")).toHaveTextContent("rm -rf build");
    await userEvent.click(screen.getByTestId("perm-allow"));
    expect(sendPermissionResponse).toHaveBeenCalledWith(SID, { requestId: "r1", behavior: "allow" });
  });

  it("Always allow remembers for the session", async () => {
    render(<Transcript view={base()} />);
    await userEvent.click(screen.getByTestId("perm-always"));
    expect(sendPermissionResponse).toHaveBeenCalledWith(SID, { requestId: "r1", behavior: "allow", remember: "session" });
  });

  it("Deny asks for an optional reason and sends it", async () => {
    render(<Transcript view={base()} />);
    await userEvent.click(screen.getByTestId("perm-deny"));
    await userEvent.type(screen.getByLabelText(/Reason/), "too risky");
    await userEvent.click(screen.getByTestId("perm-confirm-deny"));
    expect(sendPermissionResponse).toHaveBeenCalledWith(SID, { requestId: "r1", behavior: "deny", message: "too risky" });
  });

  it("Allow with edits validates JSON and sends updatedInput", async () => {
    render(<Transcript view={base()} />);
    await userEvent.click(screen.getByTestId("perm-edit"));
    const ta = screen.getByLabelText("Allow with edits");
    await userEvent.clear(ta);
    await userEvent.type(ta, "{{ nope");
    expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
    expect(screen.getByTestId("perm-apply-edits")).toBeDisabled();
    await userEvent.clear(ta);
    await userEvent.type(ta, '{{"command":"rm -rf build/tmp"}');
    await userEvent.click(screen.getByTestId("perm-apply-edits"));
    expect(sendPermissionResponse).toHaveBeenCalledWith(SID, { requestId: "r1", behavior: "allow", updatedInput: { command: "rm -rf build/tmp" } });
  });

  it("disables the card with 'answered elsewhere' after permission_resolved from another tab", () => {
    const v = reduceSessionEvent(base(), { type: "permission_resolved", sessionId: SID, requestId: "r1", behavior: "deny" });
    render(<Transcript view={v} />);
    expect(screen.queryByTestId("permission-card")).not.toBeInTheDocument();
    const done = screen.getByTestId("permission-resolved");
    expect(done).toHaveTextContent(/answered elsewhere/i);
    expect(done).toHaveAttribute("data-status", "denied");
  });

  it("shows cancelled after permission_cancelled", () => {
    const v = reduceSessionEvent(base(), { type: "permission_cancelled", sessionId: SID, requestId: "r1" });
    render(<Transcript view={v} />);
    expect(screen.getByTestId("permission-resolved")).toHaveTextContent(/Cancelled/);
  });

  it("shows a diff preview for Edit permission requests", () => {
    const edit = { ...request, toolName: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" }, toolUseId: undefined };
    const v = reduceSessionEvent(viewWith([], {}, "running"), { type: "permission_request", request: edit });
    render(<Transcript view={v} />);
    expect(within(screen.getByTestId("permission-card")).getByTestId("diff-view")).toBeInTheDocument();
  });
});

describe("empty state", () => {
  it("names Claude for Code sessions; chat copy stays neutral", () => {
    const { rerender } = render(<Transcript view={{ ...viewWith([]), session: session({ kind: "code" }) }} />);
    expect(screen.getByText("Start a code session")).toBeInTheDocument();
    expect(screen.queryByText(/Describe what you want/)).toBeNull();

    rerender(<Transcript view={{ ...viewWith([]), session: session({ kind: "chat" }) }} />);
    expect(screen.getByText("Start a conversation")).toBeInTheDocument();
    expect(screen.queryByText("Say something to get started.")).toBeNull();
  });
});

describe("text that arrives as whole paragraphs", () => {
  const delta = (text: string, messageId = "g1") => ({ type: "delta", sessionId: SID, delta: { part: "text", messageId, text } }) as const;

  it("renders each paragraph delta as it lands, keeps the turn indicator below, and swaps to the persisted message without a duplicate", () => {
    let v = viewWith([userText(1, "explain")], {}, "running");
    v = reduceSessionEvent(v, delta("First paragraph, complete."));
    const { rerender } = render(<Transcript view={v} />);
    expect(screen.getByTestId("streaming")).toHaveTextContent("First paragraph, complete.");

    v = reduceSessionEvent(v, delta("\n\nSecond paragraph, also complete."));
    rerender(<Transcript view={v} />);
    const s = screen.getByTestId("streaming");
    expect(s.querySelectorAll("p")).toHaveLength(2); // two paragraphs, not one run-on string
    expect(s).toHaveTextContent("Second paragraph, also complete.");
    const indicator = screen.getByTestId("turn-indicator");
    expect(s.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("turn-indicator-text")?.textContent ?? "").not.toMatch(/tokens/); // no usage ticks

    // the hub persists the step: the partial gives way to the stored message
    v = reduceSessionEvent(v, { type: "message", sessionId: SID, message: assistant(2, [{ type: "text", text: "First paragraph, complete.\n\nSecond paragraph, also complete." }]) });
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "message_end", messageId: "g1" } });
    rerender(<Transcript view={v} />);
    expect(screen.queryByTestId("streaming")).toBeNull();
    expect(screen.getAllByTestId("assistant-message")).toHaveLength(1);
    expect(screen.getAllByText("First paragraph, complete.")).toHaveLength(1);
  });

  it("a step that is only a tool call after a whole paragraph shows the paragraph, then the tool card, in order", () => {
    let v = viewWith([userText(1, "go")], {}, "running");
    v = reduceSessionEvent(v, delta("Let me look at the project."));
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_start", messageId: "g1", toolUseId: "t1", toolName: "Bash" } });
    render(<Transcript view={v} />);
    const s = screen.getByTestId("streaming");
    expect(s.children).toHaveLength(2);
    expect(s.children[0]).toHaveTextContent("Let me look at the project.");
    expect(within(s).getByTestId("tool-group-text")).toHaveTextContent("Running a command…");
    expect(within(s).getByTestId("tool-card")).toHaveAttribute("data-tool", "Bash");
  });
});
