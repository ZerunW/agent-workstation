import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, type SessionView } from "../../lib/session-reducer";

const mocks = vi.hoisted(() => ({ knownHeadsUps: vi.fn(), addKnownHeadsUp: vi.fn() }));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});
vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));
const clipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../lib/clipboard", () => ({ copyText: clipboard }));

import { useHeadsUp } from "../../store/headsUp";
import { useToasts } from "../../store/toasts";
import { StreamingTail } from "./Items";
import { HeadsUpCard } from "./HeadsUpCard";
import { Transcript } from "./Transcript";

const TOOL = "mcp__workstation_turn__heads_up";
const TEXT = "The lockfile is out of date";
const DETAIL = "npm ci will fail until you run npm install.";

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  useHeadsUp.setState({ known: [], loaded: true, dismissed: {} });
  mocks.knownHeadsUps.mockResolvedValue([]);
  mocks.addKnownHeadsUp.mockImplementation(async (text: string) => ({ id: "k1", text, at: "2026-10-31T12:00:00Z" }));
});

const card = (input = { text: TEXT, detail: DETAIL }, id = "h1") => render(<HeadsUpCard id={id} input={input} />);

describe("HeadsUpCard", () => {
  it("shows a bold title, the text and the actions; the detail stays folded", () => {
    card();
    const c = screen.getByTestId("heads-up");
    expect(within(c).getByText("Heads up")).toHaveClass("font-semibold");
    expect(within(c).getByTestId("heads-up-text")).toHaveTextContent(TEXT);
    expect(within(c).getByRole("button", { name: "Learn more" })).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Knew this already" })).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByTestId("heads-up-detail")).not.toBeInTheDocument();
  });

  it("Learn more expands the detail inline and toggles it back", async () => {
    card();
    const more = screen.getByRole("button", { name: "Learn more" });
    await userEvent.click(more);
    expect(screen.getByTestId("heads-up-detail")).toHaveTextContent(DETAIL);
    expect(more).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(more);
    expect(screen.queryByTestId("heads-up-detail")).not.toBeInTheDocument();
  });

  it("has no Learn more without detail", () => {
    card({ text: TEXT } as never);
    expect(screen.queryByRole("button", { name: "Learn more" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Knew this already" })).toBeInTheDocument();
  });

  it("Knew this already POSTs the text, then the card is gone for good", async () => {
    const { unmount } = card();
    await userEvent.click(screen.getByRole("button", { name: "Knew this already" }));
    await waitFor(() => expect(screen.queryByTestId("heads-up")).not.toBeInTheDocument());
    expect(mocks.addKnownHeadsUp).toHaveBeenCalledWith(TEXT);
    expect(useHeadsUp.getState().known.map((k) => k.text)).toEqual([TEXT]);
    // a remount (another render of the message) stays hidden
    unmount();
    card();
    expect(screen.queryByTestId("heads-up")).not.toBeInTheDocument();
  });

  it("stays hidden when the hub already lists the text", async () => {
    useHeadsUp.setState({ loaded: false });
    mocks.knownHeadsUps.mockResolvedValue([{ id: "k0", text: TEXT, at: "2026-10-30T00:00:00Z" }]);
    card();
    await waitFor(() => expect(screen.queryByTestId("heads-up")).not.toBeInTheDocument());
  });

  it("keeps the card and toasts when the POST fails", async () => {
    mocks.addKnownHeadsUp.mockRejectedValue(new Error("boom"));
    card();
    await userEvent.click(screen.getByRole("button", { name: "Knew this already" }));
    await waitFor(() => expect(useToasts.getState().toasts.map((x) => x.title)).toContain("Couldn't save that: boom"));
    expect(screen.getByTestId("heads-up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Knew this already" })).toBeEnabled();
  });

  it("× hides it for this page view only: no request, nothing stored", async () => {
    const { unmount } = card();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("heads-up")).not.toBeInTheDocument();
    expect(mocks.addKnownHeadsUp).not.toHaveBeenCalled();
    expect(useHeadsUp.getState().known).toEqual([]);
    unmount();
    card(); // same page view: still closed
    expect(screen.queryByTestId("heads-up")).not.toBeInTheDocument();
  });

  it("the … menu copies the text (and the detail)", async () => {
    card();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
    expect(clipboard).toHaveBeenCalledWith(`${TEXT}\n\n${DETAIL}`);
  });

  it("the menu copies just the text when there is no detail", async () => {
    card({ text: TEXT } as never);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
    expect(clipboard).toHaveBeenCalledWith(TEXT);
  });
});

describe("heads-up in the transcript", () => {
  const viewWith = (messages: ReturnType<typeof userText>[], status: "idle" | "running" = "idle"): SessionView => ({ ...insertMessages(emptyView(SID, session({ status, kind: "chat" })), messages), snapshotReceived: true });
  const call = (input: unknown, id = "h1") => assistant(2, [{ type: "text", text: "Done." }, { type: "tool_use", id, name: TOOL, input }]);
  const show = (messages: ReturnType<typeof userText>[], status: "idle" | "running" = "idle") =>
    render(
      <TestRouter>
        <Transcript view={viewWith(messages, status)} />
      </TestRouter>,
    );

  it("a heads_up call is a card under the message, not a tool row or group", () => {
    show([userText(1, "go"), call({ text: TEXT, detail: DETAIL }), toolResult(3, "h1", "ok")]);
    const msg = screen.getByTestId("assistant-message");
    const c = within(msg).getByTestId("heads-up");
    expect(c).toHaveTextContent(TEXT);
    expect(within(msg).getByText("Done.").compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("tool-group")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument();
  });

  it("other tool calls in the same message still group, without the heads-up in them", () => {
    show([
      userText(1, "go"),
      assistant(2, [
        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "a.ts" } },
        { type: "tool_use", id: "h1", name: TOOL, input: { text: TEXT } },
      ]),
      toolResult(3, "r1", "ok"),
      toolResult(4, "h1", "ok"),
    ]);
    expect(screen.getAllByTestId("tool-group")).toHaveLength(1);
    expect(screen.getByTestId("tool-group")).toHaveTextContent("Read a.ts");
    expect(screen.getByTestId("tool-group")).not.toHaveTextContent(/heads|workstation_turn/i);
    expect(screen.getByTestId("heads-up")).toBeInTheDocument();
  });

  it("renders only once the input is complete: nothing while streaming, nothing for an unusable input", () => {
    render(<StreamingTail blocks={[{ type: "tool_use", toolUseId: "h1", toolName: TOOL, partialJson: '{"text":"The lock' }]} />);
    expect(screen.queryByTestId("heads-up")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-group")).not.toBeInTheDocument();
    show([userText(1, "go"), call({ detail: "no text" })]);
    expect(screen.queryByTestId("heads-up")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-group")).not.toBeInTheDocument();
  });

  it("a failed call shows no card", () => {
    show([userText(1, "go"), call({ text: TEXT }), toolResult(3, "h1", "boom", true)]);
    expect(screen.queryByTestId("heads-up")).not.toBeInTheDocument();
  });
});
