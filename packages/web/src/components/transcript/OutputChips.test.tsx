import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, type SessionView } from "../../lib/session-reducer";

const mocks = vi.hoisted(() => ({ sessionOutputs: vi.fn(), filesTree: vi.fn(), downloadFiles: vi.fn(async () => {}), fetchFileBlob: vi.fn(async () => ({ blob: new Blob(["png"]), filename: "plot.png" })) }));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, sessionOutputs: mocks.sessionOutputs, filesTree: mocks.filesTree }, downloadFiles: mocks.downloadFiles, fetchFileBlob: mocks.fetchFileBlob };
});
vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));

import { useOutputs } from "../../store/outputs";
import { matchOutputs } from "./OutputChips";
import { Transcript } from "./Transcript";

const out = (path: string, missing = false) => ({ path, tool: "Write", turn: 1, at: "2026-11-01T10:00:00Z", missing });
const write = (id: string, file_path: string, name = "Write") => ({ type: "tool_use", id, name, input: { file_path, content: "x" } });

const view = (kind: "chat" | "code", messages: ReturnType<typeof userText>[]): SessionView => ({ ...insertMessages(emptyView(SID, session({ kind, cwd: ".chat" })), messages), snapshotReceived: true });
const renderView = (v: SessionView) =>
  render(
    <TestRouter>
      <Transcript view={v} />
    </TestRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useOutputs.setState({ bySession: {} });
  mocks.sessionOutputs.mockResolvedValue([out(".chat/report.csv"), out(".chat/plot.png"), out(".chat/other.txt"), out(".chat/gone.txt", true)]);
  mocks.filesTree.mockResolvedValue([{ path: ".chat/report.csv", name: "report.csv", kind: "file", size: 2048, mtime: "2026-11-01T10:00:00Z" }]);
});

describe("matchOutputs", () => {
  it("matches absolute, workspace-relative and session-relative paths; skips missing ones", () => {
    const outputs = [out(".chat/a.txt"), out(".chat/sub/b.txt"), out(".chat/c.txt", true), out(".chat/d.txt")];
    expect(matchOutputs(outputs, ["/srv/ws/alice/.chat/a.txt", "sub/b.txt", "./.chat/c.txt"], ".chat").map((o) => o.path)).toEqual([".chat/a.txt", ".chat/sub/b.txt"]);
  });
});

describe("chat output chips", () => {
  it("shows chips (icon, name, size) under the message that wrote the files, and not for other files", async () => {
    renderView(view("chat", [userText(1, "make a report"), assistant(2, [write("w1", "/srv/ws/alice/.chat/report.csv")]), toolResult(3, "w1", "ok"), assistant(4, [{ type: "text", text: "Done" }])]));
    const chips = await screen.findByTestId("output-chips");
    await waitFor(() => expect(within(chips).getByTestId("file-card")).toHaveTextContent("2.00 KB"));
    const card = within(chips).getByTestId("file-card");
    expect(card).toHaveTextContent("report.csv");
    expect(card.querySelector("svg")).not.toBeNull();
    expect(within(chips).queryByText("other.txt")).toBeNull();
    expect(mocks.sessionOutputs).toHaveBeenCalledWith(SID);
    expect(screen.getAllByTestId("output-chips")).toHaveLength(1);
  });

  it("a click downloads the file", async () => {
    renderView(view("chat", [userText(1, "go"), assistant(2, [write("w1", ".chat/report.csv")]), toolResult(3, "w1", "ok")]));
    await userEvent.click(await within(await screen.findByTestId("output-chips")).findByTestId("file-card"));
    expect(mocks.downloadFiles).toHaveBeenCalledWith(".chat/report.csv");
  });

  it("an image shows a small thumbnail that downloads on click", async () => {
    const create = vi.fn(() => "blob:thumb");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    renderView(view("chat", [userText(1, "plot"), assistant(2, [write("w1", ".chat/plot.png")]), toolResult(3, "w1", "ok")]));
    const chip = await screen.findByTestId("output-chip");
    const img = await within(chip).findByRole("img", { name: "plot.png" });
    expect(img).toHaveAttribute("src", "blob:thumb");
    expect(mocks.fetchFileBlob).toHaveBeenCalledWith(".chat/plot.png");
    await userEvent.click(chip);
    expect(mocks.downloadFiles).toHaveBeenCalledWith(".chat/plot.png");
  });

  it("no chips for a message without file writes, and none in a code session", async () => {
    renderView(view("chat", [userText(1, "hi"), assistant(2, [{ type: "text", text: "hello" }])]));
    renderView(view("code", [userText(1, "go"), assistant(2, [write("w1", ".chat/report.csv")]), toolResult(3, "w1", "ok")]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("output-chips")).toBeNull();
  });
});
