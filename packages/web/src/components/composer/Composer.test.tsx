import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../../test/fixtures";
import { TooltipProvider } from "../ui/overlays";

const sendMessage = vi.fn(async () => ({ ok: true as const, uuid: "u" }));
const stopSession = vi.fn();
vi.mock("../../store/actions", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...(a as [])),
  stopSession: (...a: unknown[]) => stopSession(...a),
  createSession: vi.fn(),
  patchSettings: vi.fn(),
}));
const apiMe = vi.fn();
const uploadFile = vi.fn(async (file: File, opts: { path: string; onProgress?: (p: { sentBytes: number; totalBytes: number; chunksDone: number; chunksTotal: number }) => void }) => {
  opts.onProgress?.({ sentBytes: file.size, totalBytes: file.size, chunksDone: 1, chunksTotal: 1 });
  return { path: opts.path, uploadId: "u1" };
});
vi.mock("../../lib/upload", () => ({ uploadFile: (...a: unknown[]) => uploadFile(...(a as [File, { path: string }])) }));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      me: (...a: unknown[]) => apiMe(...a),
      commands: vi.fn(async () => [
        { name: "compact", description: "Compact the conversation", argumentHint: "[instructions]" },
        { name: "clear", description: "Clear history" },
        { name: "review-pr", description: "Review a PR", isSkill: true },
      ]),
      filesTree: vi.fn(async () => [
        { path: "inbox", name: "inbox", kind: "dir", size: 0, mtime: "x" },
        { path: "projects", name: "projects", kind: "dir", size: 0, mtime: "x" },
        { path: "projects/app/main.ts", name: "main.ts", kind: "file", size: 1, mtime: "x" },
      ]),
    },
  };
});

import { Composer } from "./Composer";
import { useApp } from "../../store/app";
import { useComposer } from "../../store/composer";
import { useSessions } from "../../store/sessions";
import { resetMentionIndex } from "./mentions";

const me = { user: { name: "alice", createdAt: "x", isAdmin: false, enabled: true, terminalEnabled: true, weeklyTokenLimit: null, modelAllowlist: null }, settings: { remoteClaudeEnabled: true, diskWarnPercent: 80, diskBlockPercent: 95, defaultWeeklyTokenLimit: 0, defaultModel: "opus", defaultEffort: "high" as const }, disk: "ok" as const, apiAvailable: true, protocolVersion: 1 as const };

function setup(status: "idle" | "running" = "idle", kind: "code" | "chat" = "code") {
  const s = session({ status, kind });
  useSessions.setState({ sessions: { [SID]: s }, views: {}, listLoaded: true });
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Composer sessionId={SID} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function setupWith(over: Parameters<typeof session>[0]) {
  const s = session(over);
  useSessions.setState({ sessions: { [SID]: s }, views: {}, listLoaded: true });
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Composer sessionId={SID} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("Composer", () => {
  beforeEach(() => {
    sendMessage.mockClear();
    stopSession.mockClear();
    resetMentionIndex();
    useComposer.setState({ drafts: {}, newSettings: {}, newCwd: "" });
    useApp.setState({ me, disk: null, sendBlock: null, user: "alice", mode: "code", models: [], modelsLoaded: true });
  });

  it("tells password managers to ignore the textarea", () => {
    setup();
    const input = screen.getByTestId("composer-input");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("data-1p-ignore");
    expect(input).toHaveAttribute("data-lpignore", "true");
    expect(input).toHaveAttribute("data-bwignore");
    expect(input).toHaveAttribute("data-form-type", "other");
  });

  it("Enter sends, Shift+Enter inserts a newline, and the draft clears", async () => {
    setup();
    const input = screen.getByTestId("composer-input");
    await userEvent.type(input, "hello{Shift>}{Enter}{/Shift}world");
    expect(input).toHaveValue("hello\nworld");
    await userEvent.keyboard("{Enter}");
    expect(sendMessage).toHaveBeenCalledWith(SID, "hello\nworld", []);
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("does not send while an IME composition is active", async () => {
    setup();
    const input = screen.getByTestId("composer-input");
    await userEvent.type(input, "你好");
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "isComposing", { value: true });
    input.dispatchEvent(ev);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("opens the slash palette on '/', filters, navigates with arrows and inserts on Enter", async () => {
    setup();
    const input = screen.getByTestId("composer-input");
    await userEvent.type(input, "/");
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(screen.getByText("skill")).toBeInTheDocument();
    await userEvent.type(input, "c");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(3));
    await userEvent.type(input, "omp");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option")).toHaveTextContent("[instructions]");
    await userEvent.keyboard("{Enter}");
    expect(input).toHaveValue("/compact ");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Escape closes the palette", async () => {
    setup();
    await userEvent.type(screen.getByTestId("composer-input"), "/");
    await screen.findByRole("listbox");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("completes @ mentions from the file tree", async () => {
    setup();
    const input = screen.getByTestId("composer-input");
    await userEvent.type(input, "see @main");
    const opt = await screen.findByRole("option", { name: /projects\/app\/main\.ts/ });
    expect(opt).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(input).toHaveValue("see @projects/app/main.ts ");
  });

  it("completes @ mentions from the session cwd, inserting paths relative to it", async () => {
    const { api } = await import("../../lib/api");
    const tree = vi.mocked(api.filesTree);
    tree.mockClear();
    tree.mockImplementationOnce(async () => [
      { path: "projects/app/src", name: "src", kind: "dir", size: 0, mtime: "x" },
      { path: "projects/app/src/main.ts", name: "main.ts", kind: "file", size: 1, mtime: "x" },
    ]);
    setupWith({ cwd: "projects/app" });
    const input = screen.getByTestId("composer-input");
    await userEvent.type(input, "see @main");
    await screen.findByRole("option", { name: /src\/main\.ts/ });
    expect(tree).toHaveBeenCalledWith("projects/app", 3);
    await userEvent.keyboard("{Enter}");
    expect(input).toHaveValue("see @src/main.ts ");
  });

  it("does not offer @ mentions in Chat mode", async () => {
    useApp.setState({ mode: "chat" });
    setup("idle", "chat");
    await userEvent.type(screen.getByTestId("composer-input"), "x @ma");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("a pasted file becomes an attachment tile (never @inbox text) and is sent as a file_ref", async () => {
    setup();
    const input = screen.getByTestId("composer-input");
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    expect(await screen.findByTestId("file-card")).toHaveTextContent("note.txt");
    // the pending tile (progress bar) is swapped for the attachment tile once the upload resolves
    await waitFor(() => expect(screen.getByTestId("file-card")).toHaveAttribute("data-state", "ready"));
    expect(input).toHaveValue("");
    expect(uploadFile).toHaveBeenCalledWith(file, expect.objectContaining({ path: "inbox/note.txt" }));
    await userEvent.type(input, "what is this{Enter}");
    expect(sendMessage).toHaveBeenCalledWith(SID, "what is this", [{ type: "file_ref", path: "inbox/note.txt", name: "note.txt", size: 5 }]);
    await waitFor(() => expect(screen.queryByTestId("file-card")).not.toBeInTheDocument());
  });

  it("a failed upload keeps Send disabled until the tile is removed", async () => {
    uploadFile.mockRejectedValueOnce(new Error("disk full"));
    setup();
    const input = screen.getByTestId("composer-input");
    fireEvent.paste(input, { clipboardData: { files: [new File(["x"], "big.bin")] } });
    const card = await screen.findByTestId("file-card");
    await waitFor(() => expect(card).toHaveAttribute("data-state", "error"));
    await userEvent.type(input, "hi");
    expect(screen.getByTestId("composer-send")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByTestId("file-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-send")).toBeEnabled();
  });

  it("shows Stop while running and calls the stop route", async () => {
    setup("running");
    await userEvent.click(screen.getByTestId("composer-stop"));
    expect(stopSession).toHaveBeenCalledWith(SID);
  });

  it("disables Send with an explanation when the disk is blocked", async () => {
    useApp.setState({ disk: { level: "block", usedPercent: 97, totalBytes: 1, freeBytes: 0, warnPercent: 80, blockPercent: 95, breakdown: [], projects: [] } });
    setup();
    await userEvent.type(screen.getByTestId("composer-input"), "hi");
    expect(screen.getByTestId("composer-send")).toBeDisabled();
    expect(screen.getByTestId("composer-blocked")).toHaveAttribute("data-code", "disk_block");
    expect(screen.getByTestId("composer-blocked")).toHaveTextContent(/Disk is almost full/);
  });

  it.each([
    ["remote_disabled", { settings: { ...me.settings, remoteClaudeEnabled: false } }, /switched off by an admin/],
    ["api_unavailable", { apiAvailable: false }, /No API credits are available on the server/],
  ])("explains %s", (code, patch, text) => {
    useApp.setState({ me: { ...me, ...patch } });
    setup();
    expect(screen.getByTestId("composer-blocked")).toHaveAttribute("data-code", code);
    expect(screen.getByTestId("composer-blocked")).toHaveTextContent(text);
  });

  it("shows the weekly-limit block from a rejected send, with a retry affordance", async () => {
    useApp.setState({ sendBlock: { code: "weekly_limit", message: "limit" } });
    setup();
    expect(screen.getByTestId("composer-blocked")).toHaveAttribute("data-code", "weekly_limit");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByTestId("composer-blocked")).not.toBeInTheDocument();
  });

  it("shows the queue position when the session is queued", () => {
    const s = session({ status: "queued", queuePosition: 3 });
    useSessions.setState({ sessions: { [SID]: s }, views: {} });
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Composer sessionId={SID} />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("queue-position")).toHaveTextContent("position 3");
  });

  it("without API credits the notice replaces the send; Retry re-reads the account and clears it", async () => {
    useApp.setState({ me: { ...me, apiAvailable: false } });
    setupWith({});
    const notice = screen.getByTestId("composer-blocked");
    expect(notice).toHaveAttribute("data-code", "api_unavailable");
    expect(screen.getByTestId("composer-send")).toBeDisabled();
    apiMe.mockResolvedValue({ ...me, apiAvailable: true });
    await userEvent.click(screen.getByTestId("composer-recheck"));
    await waitFor(() => expect(screen.queryByTestId("composer-blocked")).not.toBeInTheDocument());
    expect(useApp.getState().me?.apiAvailable).toBe(true);
  });

  it("an older hub that sends no apiAvailable does not block", () => {
    const { apiAvailable: _a, ...old } = me;
    useApp.setState({ me: old as never });
    setupWith({});
    expect(screen.queryByTestId("composer-blocked")).not.toBeInTheDocument();
  });

  it("a used-up budget from a rejected send blocks the composer with a retry affordance", async () => {
    useApp.setState({ sendBlock: { code: "api_limit_reached", message: "used up" } });
    setupWith({});
    expect(screen.getByTestId("composer-blocked")).toHaveAttribute("data-code", "api_limit_reached");
    expect(screen.getByTestId("composer-blocked")).toHaveTextContent("API credits used up this month.");
    expect(screen.queryByTestId("composer-switch-subscription")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByTestId("composer-blocked")).not.toBeInTheDocument();
  });

  it("every composer uses the Claude placeholder", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Composer sessionId={null} />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("composer-input")).toHaveAttribute("placeholder", expect.stringMatching(/^Message Claude/));
  });
});
