import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../../test/fixtures";
import { TooltipProvider } from "../ui/overlays";

const createSession = vi.fn();
const sendMessage = vi.fn(async () => ({ ok: true as const, uuid: "u" }));
vi.mock("../../store/actions", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...(a as [])),
  stopSession: vi.fn(),
  createSession: (...a: unknown[]) => createSession(...a),
  patchSettings: vi.fn(),
}));
const ingestFiles = vi.fn();
vi.mock("../../lib/attachments", async (orig) => ({ ...(await orig<typeof import("../../lib/attachments")>()), ingestFiles: (...a: unknown[]) => ingestFiles(...a) }));

import { Composer } from "./Composer";
import { useApp } from "../../store/app";
import { useComposer } from "../../store/composer";
import { useSessions } from "../../store/sessions";

const me = { user: { name: "alice", createdAt: "x", isAdmin: false, enabled: true, terminalEnabled: true, weeklyTokenLimit: null, modelAllowlist: null }, settings: { remoteClaudeEnabled: true, diskWarnPercent: 80, diskBlockPercent: 95, defaultWeeklyTokenLimit: 0, defaultModel: "opus", defaultEffort: "high" as const }, disk: "ok" as const, apiAvailable: true, protocolVersion: 1 as const };

const view = (sessionId: string | null) =>
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Composer sessionId={sessionId} />
      </TooltipProvider>
    </MemoryRouter>,
  );

describe("Composer: working directory chip and folder button", () => {
  beforeEach(() => {
    createSession.mockReset();
    sendMessage.mockClear();
    ingestFiles.mockClear();
    useComposer.setState({ drafts: {}, newSettings: {}, newCwd: "" });
    useApp.setState({ me, disk: null, sendBlock: null, user: "alice", mode: "code", models: [], modelsLoaded: true });
    useSessions.setState({ sessions: {}, views: {}, listLoaded: true });
  });
  afterEach(() => {
    delete window.__workstationShell;
  });

  it("a draft shows its cwd: folder name in the chip, full path in the tooltip", async () => {
    useComposer.setState({ newCwd: "projects/my-app" });
    view(null);
    const chip = screen.getByTestId("composer-cwd");
    expect(chip).toHaveTextContent("my-app");
    expect(chip).not.toHaveTextContent("projects/");
    await userEvent.hover(chip);
    expect((await screen.findAllByText("projects/my-app")).length).toBeGreaterThan(0);
  });

  it("the workspace root reads Workspace", () => {
    view(null);
    expect(screen.getByTestId("composer-cwd")).toHaveTextContent("Workspace");
  });

  it("an existing session shows Session.cwd (read-only)", () => {
    useComposer.setState({ newCwd: "projects/other" });
    useSessions.setState({ sessions: { [SID]: session({ kind: "code", cwd: "inbox/demo" }) }, views: {}, listLoaded: true });
    view(SID);
    const chip = screen.getByTestId("composer-cwd");
    expect(chip).toHaveTextContent("demo");
    expect(chip.tagName).not.toBe("BUTTON");
    useSessions.setState({ sessions: { [SID]: session({ kind: "code", cwd: "" }) }, views: {}, listLoaded: true });
  });

  it("no chip in Chat", () => {
    useApp.setState({ mode: "chat" });
    view(null);
    expect(screen.queryByTestId("composer-cwd")).not.toBeInTheDocument();
  });

  it("the first send creates the session with the draft's cwd", async () => {
    useComposer.setState({ newCwd: "projects/my-app" });
    createSession.mockResolvedValue(session({ id: "new-1", kind: "code", cwd: "projects/my-app" }));
    view(null);
    await userEvent.type(screen.getByTestId("composer-input"), "hi{Enter}");
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledWith("code", expect.objectContaining({ cwd: "projects/my-app" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("new-1", "hi", []));
  });

  it("the folder button exists only inside the app and calls pickFolder; the paperclip stays a file picker", async () => {
    view(null);
    expect(screen.queryByRole("button", { name: "Choose folder" })).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-file-input")).not.toHaveAttribute("webkitdirectory");
    document.body.innerHTML = "";

    const pickFolder = vi.fn();
    window.__workstationShell = { pickFolder };
    view(null);
    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("composer-file-input")).not.toHaveAttribute("webkitdirectory");
    expect(ingestFiles).not.toHaveBeenCalled();
  });

  it("a shell without pickFolder gets no button", () => {
    window.__workstationShell = {};
    view(null);
    expect(screen.queryByRole("button", { name: "Choose folder" })).not.toBeInTheDocument();
  });
});
