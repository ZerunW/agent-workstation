import "../usage/testMatchers";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestRouter } from "../../test/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../../test/fixtures";

const mocks = vi.hoisted(() => ({ getReview: vi.fn(), runDownload: vi.fn() }));
vi.mock("../../embed/reviewApi", () => ({ getReview: mocks.getReview, accept: vi.fn(), reject: vi.fn(), getReviewDiff: vi.fn() }));
vi.mock("../../lib/downloadToasts", () => ({ runDownload: mocks.runDownload }));

import type { ProjectInfo } from "../../lib/api";
import { useApp } from "../../store/app";
import { useChanged } from "../../store/changed";
import { useProjects } from "../../store/projects";
import { useSessions } from "../../store/sessions";
import { ChangesTab } from "./ChangesTab";
import { HistoryTab } from "./HistoryTab";

const PID = "11111111-1111-4111-8111-111111111111";
const project: ProjectInfo = { id: PID, user: "alice", name: "demo-app", path: "projects/demo-app", createdAt: "2026-10-31T00:00:00Z", localCommit: "abc", pendingFiles: 1, sizeBytes: 10, origin: null };

const renderTab = (ui = <ChangesTab sessionId={SID} />) =>
  render(
    <TestRouter>
      {ui}
    </TestRouter>,
  );
const setSession = (over: Parameters<typeof session>[0] = {}) => useSessions.setState({ sessions: { [SID]: { ...session(over) } as never } });

beforeEach(() => {
  vi.clearAllMocks();
  useSessions.getState().reset();
  useChanged.getState().clear();
  useProjects.setState({ list: [project], status: "ready", error: null });
  useApp.setState({ filesChangedOnly: false, rightOpen: true, rightTab: "changes" });
  mocks.getReview.mockResolvedValue({ project, files: [] });
});

describe("ChangesTab", () => {
  it("asks for a session when none is open", () => {
    renderTab(<ChangesTab sessionId={null} />);
    expect(screen.getByText("No session open")).toBeInTheDocument();
  });

  it("shows the review list for a session whose cwd is inside a project (no projectId needed)", async () => {
    setSession({ cwd: "projects/demo-app/src" });
    renderTab();
    expect(await screen.findByTestId("project-review")).toBeInTheDocument();
    expect(mocks.getReview).toHaveBeenCalledWith(PID);
    expect(screen.getByText("demo-app")).toBeInTheDocument();
  });

  it("uses Session.projectId when the hub sends it", async () => {
    setSession({ cwd: "", ...({ projectId: PID } as object) });
    renderTab();
    await screen.findByTestId("project-review");
    expect(mocks.getReview).toHaveBeenCalledWith(PID);
  });

  it("names the missing linked project, with no explanation, for a session outside every project", async () => {
    setSession({ cwd: "" });
    renderTab();
    expect(screen.getByText("No linked project")).toBeInTheDocument();
    expect(screen.queryByText(/macOS app/)).toBeNull();
    expect(screen.getByRole("link", { name: "Open Projects" })).toHaveAttribute("href", "/projects");
    expect(mocks.getReview).not.toHaveBeenCalled();
  });

  it("offers the session's changed files as a download (deleted files excluded) and can jump to the Files filter", async () => {
    const u = userEvent.setup();
    setSession({ cwd: "" });
    renderTab();
    const btn = screen.getByTestId("download-session-files");
    expect(btn).toBeDisabled(); // nothing changed yet
    expect(screen.getByText("No files changed in this session yet.")).toBeInTheDocument();

    act(() => {
      useChanged.getState().record({ path: "b.txt", kind: "add", sessionId: SID, at: "2026-10-31T00:00:01Z" });
      useChanged.getState().record({ path: "a/x.ts", kind: "change", sessionId: SID, at: "2026-10-31T00:00:02Z" });
      useChanged.getState().record({ path: "gone.txt", kind: "unlink", sessionId: SID, at: "2026-10-31T00:00:03Z" });
      useChanged.getState().record({ path: "elsewhere.txt", kind: "add", sessionId: "other-session", at: "2026-10-31T00:00:04Z" });
    });
    expect(screen.getByTestId("download-session-files")).toBeEnabled();
    await u.click(screen.getByTestId("download-session-files"));
    expect(mocks.runDownload).toHaveBeenCalledWith(["a/x.ts", "b.txt"], "2 changed files");

    await u.click(screen.getByRole("button", { name: "Show in Files" }));
    expect(useApp.getState().filesChangedOnly).toBe(true);
    expect(useApp.getState().rightTab).toBe("files");
  });

  it("says so when the session's project is not known to the hub", async () => {
    useProjects.setState({ list: [], status: "ready", error: null });
    setSession({ cwd: "projects/ghost" });
    renderTab();
    expect(await screen.findByText("Project not found yet")).toBeInTheDocument();
    expect(screen.getByText(/“ghost”/)).toBeInTheDocument();
  });

  it("waits for the project list instead of flashing an error", () => {
    useProjects.setState({ list: [], status: "loading", error: null });
    setSession({ cwd: "projects/demo-app" });
    const { container } = renderTab();
    expect(screen.queryByText("Project not found yet")).toBeNull();
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
  });
});

describe("HistoryTab", () => {
  it("names the missing project the same way", () => {
    setSession({ cwd: "docs" });
    renderTab(<HistoryTab sessionId={SID} />);
    expect(screen.getByText("No linked project")).toBeInTheDocument();
  });

  it("mounts the project history for a project session", async () => {
    const projectHistory = vi.fn().mockResolvedValue([]);
    const { api } = await import("../../lib/api");
    const spy = vi.spyOn(api, "projectHistory").mockImplementation(projectHistory);
    setSession({ cwd: "projects/demo-app" });
    renderTab(<HistoryTab sessionId={SID} />);
    await waitFor(() => expect(projectHistory).toHaveBeenCalledWith(PID));
    expect(await screen.findByText("No history yet")).toBeInTheDocument();
    spy.mockRestore();
  });
});
