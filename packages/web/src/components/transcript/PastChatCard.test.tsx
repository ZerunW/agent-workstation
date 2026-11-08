import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { openToolGroups } from "../../test/groups";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, reduceSessionEvent, type SessionView } from "../../lib/session-reducer";

vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));

import { useSessions } from "../../store/sessions";
import { PastChatCard } from "./PastChatCard";
import { Transcript } from "./Transcript";

const OTHER = "22222222-2222-4222-8222-222222222222";
const SEARCH = "mcp__workstation-history__search_conversations";
const READ = "mcp__workstation-history__read_conversation";

const viewWith = (messages: ReturnType<typeof userText>[], status: "idle" | "running" = "idle"): SessionView => ({ ...insertMessages(emptyView(SID, session({ status })), messages), snapshotReceived: true });
const call = (name: string, input: unknown, id = "h1") => assistant(2, [{ type: "tool_use", id, name, input }]);

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
const renderTx = (view: SessionView) => {
  const r = render(
    <TestRouter>
      <Routes>
        <Route path="*" element={<><Transcript view={view} /><Where /></>} />
      </Routes>
    </TestRouter>,
  );
  openToolGroups();
  return r;
};

beforeEach(() => useSessions.setState({ sessions: { [OTHER]: session({ id: OTHER, title: "Quarterly plan" }) }, views: {}, listLoaded: true }));

describe("search_conversations chip", () => {
  it("reads 'Searched past chats · <query>' as a compact card with the result one click away", async () => {
    renderTx(viewWith([userText(1, "find it"), call(SEARCH, { query: "invoice emails" }), toolResult(3, "h1", "- 2222  Billing notes  (2026-10-02)")]));
    const card = screen.getByTestId("pastchat-card");
    expect(card).toHaveAttribute("data-kind", "search");
    expect(card).toHaveAttribute("data-state", "done");
    expect(card).toHaveTextContent("Searched past chats · invoice emails");
    expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument(); // not the generic card
    expect(screen.queryByTestId("pastchat-result")).not.toBeInTheDocument();
    await userEvent.click(within(card).getByTestId("pastchat-toggle"));
    expect(within(card).getByTestId("pastchat-result")).toHaveTextContent("Billing notes");
    await userEvent.click(within(card).getByTestId("pastchat-toggle"));
    expect(screen.queryByTestId("pastchat-result")).not.toBeInTheDocument();
  });

  it("a click on the label of a search chip also opens the result, and a search never navigates", async () => {
    renderTx(viewWith([userText(1, "x"), call(SEARCH, { query: "q" }), toolResult(3, "h1", "nothing found")]));
    await userEvent.click(screen.getByText(/Searched past chats/));
    expect(screen.getByTestId("pastchat-result")).toHaveTextContent("nothing found");
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });

  it("says 'Searching past chats' while the call is pending, and flags a failure", async () => {
    const a = renderTx(viewWith([userText(1, "x"), call(SEARCH, { query: "q" })], "running"));
    expect(screen.getByTestId("pastchat-card")).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("pastchat-card")).toHaveTextContent("Searching past chats · q");
    a.unmount();
    renderTx(viewWith([userText(1, "x"), call(SEARCH, { query: "q" }), toolResult(3, "h1", "index unavailable", true)]));
    const card = screen.getByTestId("pastchat-card");
    expect(card).toHaveAttribute("data-state", "failed");
    await userEvent.click(within(card).getByTestId("pastchat-toggle"));
    expect(within(card).getByText("index unavailable")).toHaveClass("text-danger");
  });

  it("also renders while the call is still streaming in", () => {
    let v = viewWith([userText(1, "go")], "running");
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_start", messageId: "m", toolUseId: "t", toolName: SEARCH } });
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_input", messageId: "m", toolUseId: "t", partialJson: '{"query":"deploy che' } });
    renderTx(v);
    const card = screen.getByTestId("pastchat-card");
    expect(card).toHaveAttribute("data-state", "streaming");
    expect(card).toHaveTextContent("Searching past chats · deploy che");
  });

  it("matches the tool by suffix, whatever the prefix", () => {
    renderTx(viewWith([userText(1, "x"), call("search_conversations", { query: "other side" }), toolResult(3, "h1", "ok")]));
    expect(screen.getByTestId("pastchat-card")).toHaveTextContent("Searched past chats · other side");
  });
});

describe("read_conversation chip", () => {
  it("reads 'Read · <session title>' (the title from the sidebar's data) and opens that session on click", async () => {
    renderTx(viewWith([userText(1, "x"), call(READ, { session_id: OTHER }), toolResult(3, "h1", "# Quarterly plan\n\n[user] hello")]));
    const card = screen.getByTestId("pastchat-card");
    expect(card).toHaveAttribute("data-kind", "read");
    expect(card).toHaveTextContent("Read · Quarterly plan");
    await userEvent.click(within(card).getByTestId("pastchat-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/s/${OTHER}`);
  });

  it("falls back to the title the result states, then to the id", () => {
    useSessions.setState({ sessions: {} });
    const a = renderTx(viewWith([userText(1, "x"), call(READ, { session_id: OTHER }), toolResult(3, "h1", "# Title from the result\n\nbody")]));
    expect(screen.getByTestId("pastchat-card")).toHaveTextContent("Read · Title from the result");
    a.unmount();
    renderTx(viewWith([userText(1, "x"), call(READ, { session_id: OTHER }), toolResult(3, "h1", "plain body")]));
    expect(screen.getByTestId("pastchat-card")).toHaveTextContent(`Read · ${OTHER}`);
  });

  it("the result is collapsible", async () => {
    renderTx(viewWith([userText(1, "x"), call(READ, { session_id: OTHER }), toolResult(3, "h1", "[user] hello there")]));
    expect(screen.queryByTestId("pastchat-result")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("pastchat-toggle"));
    expect(screen.getByTestId("pastchat-result")).toHaveTextContent("[user] hello there");
    // the toggle does not navigate
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });

  it("an id that is not a session id is shown but not a link", () => {
    renderTx(viewWith([userText(1, "x"), call(READ, { session_id: "abc" }), toolResult(3, "h1", "No such conversation.")]));
    expect(screen.getByTestId("pastchat-card")).toHaveTextContent("Read · abc");
    expect(screen.queryByTestId("pastchat-open")).not.toBeInTheDocument();
  });

  it("matches the tool by suffix, also without a server prefix", () => {
    renderTx(viewWith([userText(1, "x"), call("read_conversation", { session_id: OTHER }), toolResult(3, "h1", "ok")]));
    expect(screen.getByTestId("pastchat-card")).toHaveTextContent("Read · Quarterly plan");
  });
});

describe("PastChatCard outside a router (the embed)", () => {
  it("renders as a plain chip without a link", () => {
    render(<PastChatCard kind="read" label="Quarterly plan" sessionId={OTHER} result="body" state="done" />);
    expect(screen.getByTestId("pastchat-card")).toHaveTextContent("Read · Quarterly plan");
    expect(screen.queryByTestId("pastchat-open")).not.toBeInTheDocument();
  });
});
