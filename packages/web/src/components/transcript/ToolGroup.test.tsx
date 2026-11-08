import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, reduceSessionEvent, type SessionView } from "../../lib/session-reducer";

vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));

import { Transcript } from "./Transcript";

const viewWith = (messages: ReturnType<typeof userText>[], status: "idle" | "running" = "idle"): SessionView => ({ ...insertMessages(emptyView(SID, session({ status })), messages), snapshotReceived: true });
const call = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const renderTx = (view: SessionView) =>
  render(
    <TestRouter>
      <Transcript view={view} />
    </TestRouter>,
  );
const toggle = (group: HTMLElement) => within(group).getAllByRole("button")[0]!;

describe("tool groups", () => {
  const two = () =>
    viewWith([
      userText(1, "go"),
      assistant(2, [call("a", "Bash", { command: "npx tsc --noEmit" }), call("b", "Bash", { command: "npx vitest run" })]),
      toolResult(3, "a", "ok"),
      toolResult(4, "b", "passed"),
    ]);

  it("folds consecutive calls into one muted line, collapsed by default (no card, no rows)", () => {
    renderTx(two());
    expect(screen.getAllByTestId("tool-group")).toHaveLength(1);
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Ran 2 commands");
    expect(screen.queryByTestId("tool-group-rows")).toBeNull();
    expect(screen.queryByTestId("tool-card")).toBeNull();
    expect(toggle(screen.getByTestId("tool-group"))).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the edit stat next to the summary", () => {
    renderTx(viewWith([assistant(1, [call("e", "Edit", { file_path: "/p/agent.test.ts", old_string: "a", new_string: "b" })]), toolResult(2, "e", "ok")]));
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Edited agent.test.ts");
    expect(screen.getByTestId("tool-group-diff")).toHaveTextContent("+1−1");
    expect(within(screen.getByTestId("tool-group-diff")).getByText("+1")).toHaveClass("text-ok");
    expect(within(screen.getByTestId("tool-group-diff")).getByText("−1")).toHaveClass("text-danger");
  });

  it("expands to one collapsed row per tool, and a row to its detail; both collapse again", async () => {
    renderTx(two());
    const group = screen.getByTestId("tool-group");
    await userEvent.click(toggle(group));
    expect(group).toHaveAttribute("data-open", "true");
    const rows = screen.getAllByTestId("tool-card");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("npx tsc --noEmit");
    expect(rows[0]!.querySelector("svg.text-ok")).not.toBeNull();
    expect(screen.queryByText("passed")).toBeNull();

    await userEvent.click(within(rows[1]!).getAllByRole("button")[0]!);
    expect(screen.getByText("passed")).toBeInTheDocument();
    await userEvent.click(within(rows[1]!).getAllByRole("button")[0]!);
    expect(screen.queryByText("passed")).toBeNull();

    await userEvent.click(toggle(group));
    expect(screen.queryByTestId("tool-group-rows")).toBeNull();
  });

  it("keeps its state while the transcript is mounted, but starts collapsed on a new page view", async () => {
    const { rerender, unmount } = renderTx(two());
    await userEvent.click(toggle(screen.getByTestId("tool-group")));
    rerender(
      <TestRouter>
        <Transcript view={viewWith([userText(1, "go"), assistant(2, [call("a", "Bash", { command: "npx tsc --noEmit" }), call("b", "Bash", { command: "npx vitest run" })]), toolResult(3, "a", "ok"), toolResult(4, "b", "passed"), assistant(5, [{ type: "text", text: "done" }])])} />
      </TestRouter>,
    );
    expect(screen.getByTestId("tool-group")).toHaveAttribute("data-open", "true");
    unmount();
    renderTx(two());
    expect(screen.getByTestId("tool-group")).toHaveAttribute("data-open", "false");
  });

  it("is split by assistant text: one group before it, one after", () => {
    renderTx(
      viewWith([
        assistant(1, [call("a", "Read", { file_path: "/p/a.ts" }), { type: "text", text: "Found it." }, call("b", "Bash", { command: "ls" }), call("c", "Bash", { command: "pwd" })]),
        toolResult(2, "a", "x"),
        toolResult(3, "b", "x"),
        toolResult(4, "c", "x"),
      ]),
    );
    const texts = screen.getAllByTestId("tool-group-text").map((n) => n.textContent);
    expect(texts).toEqual(["Read a.ts", "Ran 2 commands"]);
  });

  it("while the last tool runs the line shows it live with a spinner, then becomes the summary", () => {
    const calling = viewWith([userText(1, "go"), assistant(2, [call("a", "Read", { file_path: "/p/a.ts" }), call("b", "Bash", { command: "npx tsc --noEmit" })]), toolResult(3, "a", "x")], "running");
    const { rerender } = renderTx(calling);
    const group = screen.getByTestId("tool-group");
    expect(group).toHaveAttribute("data-state", "running");
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Running npx tsc --noEmit…");
    expect(group.querySelector("svg.animate-spin")).not.toBeNull();

    rerender(
      <TestRouter>
        <Transcript view={viewWith([userText(1, "go"), assistant(2, [call("a", "Read", { file_path: "/p/a.ts" }), call("b", "Bash", { command: "npx tsc --noEmit" })]), toolResult(3, "a", "x"), toolResult(4, "b", "ok")], "running")} />
      </TestRouter>,
    );
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Read a.ts, ran a command");
    expect(screen.getByTestId("tool-group").querySelector("svg.animate-spin")).toBeNull();
  });

  it("a streaming call is live too (Editing …)", () => {
    let v = viewWith([userText(1, "go")], "running");
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_start", messageId: "m", toolUseId: "t", toolName: "Edit" } });
    v = reduceSessionEvent(v, { type: "delta", sessionId: SID, delta: { part: "tool_use_input", messageId: "m", toolUseId: "t", partialJson: '{"file_path":"/p/agent.test.ts"' } });
    renderTx(v);
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Editing agent.test.ts…");
  });

  it("a failed tool keeps the group collapsed, with a red ✗ and the number of failures", () => {
    renderTx(
      viewWith([
        assistant(1, [call("a", "Bash", { command: "x" }), call("b", "Bash", { command: "y" }), call("c", "Bash", { command: "z" })]),
        toolResult(2, "a", "ok"),
        toolResult(3, "b", "boom", true),
        toolResult(4, "c", "bang", true),
      ]),
    );
    const failed = screen.getByTestId("tool-group-failed");
    expect(failed).toHaveTextContent("2");
    expect(failed).toHaveClass("text-danger");
    expect(failed.querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("tool-group")).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Ran 3 commands");
  });

  it("no failure marker when everything succeeded", () => {
    renderTx(two());
    expect(screen.queryByTestId("tool-group-failed")).toBeNull();
  });

  describe("permissions", () => {
    const request = { requestId: "r1", sessionId: SID, toolName: "Bash", input: { command: "rm -rf build" }, toolUseId: "tu1", at: "2026-10-31T00:00:00Z" };
    const base = () => viewWith([assistant(1, [call("tu1", "Bash", request.input)])], "running");

    it("a pending request stays a full card outside the group", () => {
      renderTx(reduceSessionEvent(base(), { type: "permission_request", request }));
      const card = screen.getByTestId("permission-card");
      expect(screen.getByTestId("tool-group").contains(card)).toBe(false);
      expect(screen.getByTestId("tool-group")).toBeInTheDocument();
    });

    it("an answered request is a row inside the group, not a row of its own", async () => {
      const v = reduceSessionEvent(reduceSessionEvent(base(), { type: "permission_request", request }), { type: "permission_resolved", sessionId: SID, requestId: "r1", behavior: "allow" });
      renderTx(v);
      expect(screen.queryByTestId("permission-resolved")).toBeNull();
      expect(screen.getByTestId("tool-group-text")).toHaveTextContent(/^Running rm -rf build…$/);
      await userEvent.click(toggle(screen.getByTestId("tool-group")));
      expect(within(screen.getByTestId("tool-group")).getByTestId("permission-resolved")).toHaveAttribute("data-status", "allowed");
    });
  });

  describe("browser site permissions", () => {
    const request = { requestId: "r2", sessionId: SID, toolName: "mcp__browser__browser_navigate", input: { url: "https://github.com/x" }, toolUseId: "tu2", browserSite: { origin: "https://github.com" }, at: "2026-10-31T00:00:00Z" };
    const base = () => viewWith([assistant(1, [call("tu2", "mcp__browser__browser_navigate", request.input)])], "running");

    it("a pending question is its own card outside the group", () => {
      renderTx(reduceSessionEvent(base(), { type: "permission_request", request }));
      const card = screen.getByTestId("site-card");
      expect(screen.getByTestId("tool-group").contains(card)).toBe(false);
      expect(screen.queryByTestId("permission-card")).toBeNull();
    });

    it("folds into the group once answered: 'Allowed github.com' / 'Denied github.com'", async () => {
      for (const [behavior, label] of [["allow", "Allowed github.com"], ["deny", "Denied github.com"]] as const) {
        const v = reduceSessionEvent(reduceSessionEvent(base(), { type: "permission_request", request }), { type: "permission_resolved", sessionId: SID, requestId: "r2", behavior });
        const { unmount } = renderTx(v);
        expect(screen.queryByTestId("site-card")).toBeNull();
        await userEvent.click(toggle(screen.getByTestId("tool-group")));
        expect(within(screen.getByTestId("tool-group")).getByTestId("permission-resolved")).toHaveTextContent(new RegExp(`^${label}$`));
        unmount();
      }
    });
  });

  it("show_visual stays inline between groups", () => {
    const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    renderTx(
      viewWith([
        assistant(1, [call("a", "Read", { file_path: "/p/a.ts" }), call("v", "mcp__workstation-visual__show_visual", { title: "Flow", svg }), call("b", "Bash", { command: "ls" })]),
        toolResult(2, "a", "x"),
        toolResult(3, "v", "ok"),
        toolResult(4, "b", "x"),
      ]),
    );
    const figure = screen.getByTestId("visual-figure");
    for (const g of screen.getAllByTestId("tool-group")) expect(g.contains(figure)).toBe(false);
    expect(screen.getAllByTestId("tool-group-text").map((n) => n.textContent)).toEqual(["Read a.ts", "Ran a command"]);
  });

  it("thinking folds into the group of the calls it precedes", async () => {
    renderTx(viewWith([assistant(1, [{ type: "thinking", thinking: "hmm" }, call("a", "Bash", { command: "ls" })]), toolResult(2, "a", "x")]));
    expect(screen.getAllByTestId("tool-group")).toHaveLength(1);
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Ran a command");
    await userEvent.click(toggle(screen.getByTestId("tool-group")));
    expect(screen.getByTestId("thinking")).toBeInTheDocument();
    expect(screen.getAllByTestId("tool-card")).toHaveLength(1);
  });

});
