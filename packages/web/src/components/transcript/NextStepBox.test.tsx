import type { NextStep } from "@agent-workstation/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, userText } from "../../test/fixtures";
import { emptyView, insertMessages, reduceSessionEvent, type SessionView } from "../../lib/session-reducer";

const sendMessage = vi.fn();
vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));
vi.mock("../../store/actions", async (orig) => ({ ...(await orig<typeof import("../../store/actions")>()), sendMessage: (...a: unknown[]) => sendMessage(...a) }));

import { Transcript } from "./Transcript";

const step = (over: Partial<NextStep> = {}): NextStep => ({ recap: "Added the card and its tests.", at: "2026-10-31T12:00:00Z", ...over });

function viewWith(nextStep?: NextStep | null): SessionView {
  const v = insertMessages(emptyView(SID, session()), [userText(1, "go"), assistant(2, [{ type: "text", text: "Done." }])]);
  return { ...v, snapshotReceived: true, nextStep };
}

describe("next-step box", () => {
  beforeEach(() => sendMessage.mockReset());

  it("is absent without a next step (null or an older hub)", () => {
    const { rerender } = render(<Transcript view={viewWith()} />);
    expect(screen.queryByTestId("next-step")).toBeNull();
    rerender(<Transcript view={viewWith(null)} />);
    expect(screen.queryByTestId("next-step")).toBeNull();
  });

  it("renders the recap alone when there is no ask", () => {
    render(<Transcript view={viewWith(step())} />);
    expect(screen.getByTestId("next-step-recap")).toHaveTextContent("Added the card and its tests.");
    expect(screen.queryByTestId("next-step-ask")).toBeNull();
    expect(screen.queryByTestId("next-step-action")).toBeNull();
  });

  it("renders recap, ask in bold and actions (first primary, others outline) below the last message", () => {
    render(<Transcript view={viewWith(step({ ask: "Ship it?", actions: [{ label: "Ship" }, { label: "Review first" }, { label: "Not now" }] }))} />);
    expect(screen.getByTestId("next-step-ask")).toHaveTextContent("Ship it?");
    expect(screen.getByTestId("next-step-ask")).toHaveClass("font-semibold");
    const buttons = screen.getAllByTestId("next-step-action");
    expect(buttons.map((b) => b.textContent)).toEqual(["Ship", "Review first", "Not now"]);
    expect(buttons[0]).toHaveClass("bg-accent");
    expect(buttons[1]).toHaveClass("border");
    expect(buttons[1]).not.toHaveClass("bg-accent");
    const message = screen.getByTestId("assistant-message");
    expect(message.compareDocumentPosition(screen.getByTestId("next-step")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a button sends its label and disables the buttons", () => {
    render(<Transcript view={viewWith(step({ ask: "Ship it?", actions: [{ label: "Ship" }, { label: "Review first" }] }))} />);
    fireEvent.click(screen.getByRole("button", { name: "Review first" }));
    expect(sendMessage).toHaveBeenCalledWith(SID, "Review first");
    for (const b of screen.getAllByTestId("next-step-action")) expect(b).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("is not copied into the transcript as a message", () => {
    render(<Transcript view={viewWith(step({ ask: "Ship it?", actions: [{ label: "Ship" }] }))} />);
    expect(screen.getAllByTestId("assistant-message")).toHaveLength(1);
    expect(screen.queryByTestId("tool-group")).toBeNull();
  });

  it("clears on a next_step event with null and when the user sends anything", () => {
    let view = reduceSessionEvent(viewWith(), { type: "next_step", sessionId: SID, step: step({ recap: "Recap" }) });
    const { rerender } = render(<Transcript view={view} />);
    expect(screen.getByTestId("next-step")).toBeInTheDocument();

    rerender(<Transcript view={reduceSessionEvent(view, { type: "next_step", sessionId: SID, step: null })} />);
    expect(screen.queryByTestId("next-step")).toBeNull();

    view = reduceSessionEvent(view, { type: "pending_user_add", entry: { uuid: "p1", text: "hello", images: [], state: "sending", position: null, at: Date.now() } });
    expect(view.nextStep).toBeNull();
    rerender(<Transcript view={view} />);
    expect(screen.queryByTestId("next-step")).toBeNull();
  });

  it("a new box enables its buttons again", () => {
    const first = step({ actions: [{ label: "Ship" }], at: "2026-10-31T12:00:00Z" });
    const { rerender } = render(<Transcript view={viewWith(first)} />);
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(screen.getByRole("button", { name: "Ship" })).toBeDisabled();
    rerender(<Transcript view={viewWith(step({ actions: [{ label: "Ship" }], at: "2026-10-31T12:05:00Z" }))} />);
    expect(screen.getByRole("button", { name: "Ship" })).toBeEnabled();
  });
});
