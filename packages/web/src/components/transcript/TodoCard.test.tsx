import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { assistant, session, SID, userText } from "../../test/fixtures";
import { emptyView, insertMessages, type SessionView } from "../../lib/session-reducer";

vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));

import { Transcript } from "./Transcript";

const todoWrite = (seq: number, id: string, todos: unknown[]) => assistant(seq, [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }]);

function viewWith(messages: ReturnType<typeof userText>[], status: "idle" | "running" = "idle"): SessionView {
  return { ...insertMessages(emptyView(SID, session({ status })), messages), snapshotReceived: true };
}

describe("pinned task list", () => {
  const todos = [
    { content: "Read the code", activeForm: "Reading the code", status: "completed" },
    { content: "Write the card", activeForm: "Writing the card", status: "in_progress" },
    { content: "Run the tests", activeForm: "Running the tests", status: "pending" },
  ];

  it("renders the latest TodoWrite: status icons, activeForm for the running step, completed rows muted", () => {
    render(<Transcript view={viewWith([userText(1, "go"), todoWrite(2, "t1", [{ content: "stale", activeForm: "Stale", status: "pending" }]), todoWrite(3, "t2", todos)], "running")} />);
    const rows = screen.getAllByTestId("todo-row");
    expect(rows.map((r) => r.dataset.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(rows[0]).toHaveTextContent("Read the code");
    expect(rows[0]).toHaveClass("text-muted");
    expect(within(rows[0]!).getByTestId("todo-done")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Writing the card");
    expect(within(rows[1]!).getByTestId("todo-active")).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("Run the tests");
    expect(rows[2]).not.toHaveClass("text-muted");
    expect(within(rows[2]!).getByTestId("todo-pending")).toBeInTheDocument();
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getAllByTestId("todo-card")).toHaveLength(1);
  });

  it("stays after the turn ended and sits below the assistant message", () => {
    render(<Transcript view={viewWith([userText(1, "go"), assistant(2, [{ type: "text", text: "Working on it" }]), todoWrite(3, "t1", todos)])} />);
    const card = screen.getByTestId("todo-card");
    const message = screen.getByTestId("assistant-message");
    expect(message.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides TodoWrite calls from the folded tool groups", () => {
    render(<Transcript view={viewWith([userText(1, "go"), todoWrite(2, "t1", todos)])} />);
    expect(screen.queryByTestId("tool-group")).toBeNull();
    expect(screen.getByTestId("todo-card")).toBeInTheDocument();
  });

  it("keeps other tools in their group when mixed with TodoWrite", () => {
    render(<Transcript view={viewWith([userText(1, "go"), assistant(2, [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }, { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos } }])])} />);
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Ran a command");
    expect(screen.getByTestId("todo-card")).toBeInTheDocument();
  });

  it("is absent without a TodoWrite call", () => {
    render(<Transcript view={viewWith([userText(1, "go"), assistant(2, [{ type: "text", text: "hi" }])])} />);
    expect(screen.queryByTestId("todo-card")).toBeNull();
  });
});
