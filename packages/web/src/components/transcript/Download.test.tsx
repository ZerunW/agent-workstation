import type { PermissionRequest } from "@agent-workstation/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, reduceSessionEvent, type PermissionEntry, type SessionView } from "../../lib/session-reducer";

const sendPermissionResponse = vi.fn();
vi.mock("../../store/hub", () => ({ sendPermissionResponse: (...a: unknown[]) => sendPermissionResponse(...a), backfill: vi.fn(), loadEarlier: vi.fn() }));
const downloadFiles = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, downloadFiles };
});

import { useSessions } from "../../store/sessions";
import { PermissionCard } from "./PermissionCard";
import { Transcript } from "./Transcript";

const TOOL = "mcp__workstation_fetch__download_file";
const URL_FULL = "https://files.example.org/releases/tool-1.2.tar.gz?token=abc123&dl=1";
const REASON = "Looks like a normal release download.";
const input = { url: URL_FULL, filename: "tool-1.2.tar.gz" };

const viewWith = (messages: ReturnType<typeof userText>[], status: "idle" | "running" = "idle"): SessionView => ({ ...insertMessages(emptyView(SID, session({ status, cwd: "chats/c1" })), messages), snapshotReceived: true });
const call = (id: string, inp: unknown = input) => ({ type: "tool_use", id, name: TOOL, input: inp });
const renderTx = (view: SessionView) =>
  render(
    <TestRouter>
      <Transcript view={view} />
    </TestRouter>,
  );
const open = async () => {
  await userEvent.click(within(screen.getByTestId("tool-group")).getAllByRole("button")[0]!);
  return screen.getByTestId("download-row");
};

beforeEach(() => {
  vi.clearAllMocks();
  useSessions.setState({ sessions: { [SID]: session({ cwd: "chats/c1" }) }, views: {}, listLoaded: true });
});

describe("download tool row", () => {
  it("done: 'Downloaded <filename>', the host muted and the file as a download chip", async () => {
    renderTx(viewWith([userText(1, "get it"), assistant(2, [call("d1")]), toolResult(3, "d1", "path: tool-1.2.tar.gz\nsize: 2048\ncontent type: application/gzip")]));
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Downloaded tool-1.2.tar.gz");
    const row = await open();
    expect(row).toHaveAttribute("data-state", "done");
    expect(within(row).getByTestId("download-label")).toHaveTextContent("Downloaded tool-1.2.tar.gz");
    expect(within(row).getByTestId("download-host")).toHaveTextContent("files.example.org");
    expect(within(row).getByTestId("download-host")).toHaveClass("text-muted");
    const chip = within(row).getByTestId("file-card");
    expect(chip).toHaveTextContent("tool-1.2.tar.gz");
    expect(chip).toHaveTextContent("2.00 KB");
    await userEvent.click(chip);
    expect(downloadFiles).toHaveBeenCalledWith("chats/c1/tool-1.2.tar.gz");
  });

  it("the saved name comes from the result when the call named none", async () => {
    renderTx(viewWith([userText(1, "get it"), assistant(2, [call("d1", { url: URL_FULL })]), toolResult(3, "d1", JSON.stringify({ path: "sub/renamed.zip", size: 10 }))]));
    const row = await open();
    expect(within(row).getByTestId("download-label")).toHaveTextContent("Downloaded renamed.zip");
    await userEvent.click(within(row).getByTestId("file-card"));
    expect(downloadFiles).toHaveBeenCalledWith("chats/c1/sub/renamed.zip");
  });

  it("live: spinner and 'Downloading…', no chip", async () => {
    renderTx(viewWith([userText(1, "get it"), assistant(2, [call("d1")])], "running"));
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Downloading…");
    const row = await open();
    expect(row).toHaveAttribute("data-state", "pending");
    expect(within(row).getByTestId("download-label")).toHaveTextContent("Downloading…");
    expect(within(row).getByLabelText("Running…")).toBeInTheDocument();
    expect(within(row).getByTestId("download-host")).toHaveTextContent("files.example.org");
    expect(within(row).queryByTestId("file-card")).toBeNull();
  });

  it("failed: the error replaces the label, no chip", async () => {
    renderTx(viewWith([userText(1, "get it"), assistant(2, [call("d1")]), toolResult(3, "d1", "Refused: the host resolves to a private address.", true)]));
    const row = await open();
    expect(row).toHaveAttribute("data-state", "failed");
    expect(within(row).getByTestId("download-label")).toHaveTextContent("Refused: the host resolves to a private address.");
    expect(within(row).queryByText(/^Downloaded/)).toBeNull();
    expect(within(row).queryByTestId("file-card")).toBeNull();
  });

  it("a streaming call without its URL yet still shows the live label", () => {
    let view = viewWith([userText(1, "get it")], "running");
    view = reduceSessionEvent(view, { type: "delta", sessionId: SID, delta: { part: "tool_use_start", messageId: "m1", toolUseId: "d1", toolName: TOOL } });
    renderTx(view);
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Downloading…");
  });
});

const request = (inp: unknown = { ...input, check: { safe: false, reason: REASON } }): PermissionRequest => ({ requestId: "r1", sessionId: SID, toolName: TOOL, input: inp, at: "2026-10-31T00:00:00.000Z" });
const entry = (over: Partial<PermissionEntry> = {}): PermissionEntry => ({ request: request(), status: "pending", local: null, elsewhere: false, afterSeq: 0, ...over });

describe("download approval card", () => {
  it("title with the host, the full URL in monospace with the query set apart, the check's reason muted", () => {
    render(<PermissionCard entry={entry()} sessionId={SID} />);
    const card = screen.getByTestId("download-card");
    expect(within(card).getByTestId("download-title")).toHaveTextContent("Download from files.example.org?");
    const url = within(card).getByTestId("download-url");
    expect(url).toHaveTextContent(URL_FULL);
    expect(url).toHaveClass("font-mono", "break-all");
    const query = within(url).getByTestId("download-query");
    expect(query).toHaveTextContent("?token=abc123&dl=1");
    expect(query).not.toHaveClass("font-mono");
    expect(url.firstChild?.textContent).toBe("https://files.example.org/releases/tool-1.2.tar.gz");
    expect(within(card).getByTestId("download-reason")).toHaveTextContent(REASON);
    expect(within(card).getByTestId("download-reason")).toHaveClass("text-muted");
  });

  it("has just Download and Don't download, no always-allow or edit options", () => {
    render(<PermissionCard entry={entry()} sessionId={SID} />);
    const card = screen.getByTestId("download-card");
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["Download", "Don't download"]);
    expect(within(card).queryByText(/always/i)).toBeNull();
    expect(screen.queryByTestId("perm-always")).toBeNull();
    expect(screen.queryByTestId("perm-edit")).toBeNull();
  });

  it("Download allows, Don't download denies", async () => {
    render(<PermissionCard entry={entry()} sessionId={SID} />);
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(sendPermissionResponse).toHaveBeenLastCalledWith(SID, { requestId: "r1", behavior: "allow" });
    await userEvent.click(screen.getByRole("button", { name: "Don't download" }));
    expect(sendPermissionResponse).toHaveBeenLastCalledWith(SID, { requestId: "r1", behavior: "deny" });
  });

  it("a request without a reason shows no reason line; once sent, the buttons give way", () => {
    const { rerender } = render(<PermissionCard entry={entry({ request: request(input) })} sessionId={SID} />);
    expect(screen.queryByTestId("download-reason")).toBeNull();
    rerender(<PermissionCard entry={entry({ local: "allow" as never })} sessionId={SID} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
