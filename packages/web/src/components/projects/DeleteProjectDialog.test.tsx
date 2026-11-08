import "../usage/testMatchers";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestRouter } from "../../test/router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ project: vi.fn(), disk: vi.fn(), deleteProject: vi.fn() }));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, project: mocks.project, disk: mocks.disk, deleteProject: mocks.deleteProject } };
});

import { ApiError, type ProjectInfo } from "../../lib/api";
import { useApp } from "../../store/app";
import { useProjects } from "../../store/projects";
import { useToasts } from "../../store/toasts";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

const PID = "11111111-1111-4111-8111-111111111111";
const project: ProjectInfo = { id: PID, user: "alice", name: "demo-app", path: "projects/demo-app", createdAt: "2026-10-31T00:00:00Z", localCommit: "abc", pendingFiles: 0, sizeBytes: 10, origin: null };
const disk = (pendingFiles: number, undownloadedFiles: number) => ({
  level: "ok", usedPercent: 10, totalBytes: 1, freeBytes: 1, warnPercent: 80, blockPercent: 95, breakdown: [],
  projects: [{ id: PID, name: "demo-app", pendingFiles, undownloadedFiles, bytes: 1 }],
});
const onClose = vi.fn();
const open = () =>
  render(
    <TestRouter>
      <DeleteProjectDialog project={project} onClose={onClose} />
    </TestRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  useProjects.setState({ list: [project], status: "ready", error: null });
  useApp.setState({ disk: null });
  mocks.project.mockResolvedValue({ ...project, pendingFiles: 0 });
  mocks.disk.mockResolvedValue(disk(0, 0));
  mocks.deleteProject.mockResolvedValue(undefined);
});

describe("DeleteProjectDialog", () => {
  it("clean project: step 1 shows zero counts, step 2 needs the name, then deletes without discarding", async () => {
    const u = userEvent.setup();
    open();
    expect(await screen.findByTestId("count-pending")).toHaveTextContent("0");
    expect(screen.getByTestId("count-undownloaded")).toHaveTextContent("0");
    expect(screen.queryByText(/every change has been accepted/)).toBeNull();
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    await u.click(screen.getByTestId("delete-continue"));

    const confirm = screen.getByTestId("delete-confirm");
    expect(confirm).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull(); // nothing to discard
    await u.type(screen.getByLabelText("Project name"), "demo-app");
    expect(confirm).toBeEnabled();
    await u.click(confirm);
    expect(mocks.deleteProject).toHaveBeenCalledWith(PID, false);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useProjects.getState().list).toEqual([]);
    expect(useToasts.getState().toasts.some((t) => t.tone === "success" && t.title.includes("demo-app"))).toBe(true);
  });

  it("with pending changes or undownloaded files step 1 refuses to just continue: review first, or discard explicitly", async () => {
    const u = userEvent.setup();
    mocks.project.mockResolvedValue({ ...project, pendingFiles: 4 });
    mocks.disk.mockResolvedValue(disk(4, 3));
    open();
    expect(await screen.findByTestId("count-pending")).toHaveTextContent("4");
    expect(screen.getByTestId("count-undownloaded")).toHaveTextContent("3");
    expect(screen.queryByTestId("delete-continue")).toBeNull();
    expect(screen.getByRole("link", { name: "Review first" })).toHaveAttribute("href", `/projects/${PID}`);

    await u.click(screen.getByTestId("delete-discard-anyway"));
    const confirm = screen.getByTestId("delete-confirm");
    await u.type(screen.getByLabelText("Project name"), "demo-app");
    expect(confirm).toBeDisabled(); // the name alone is not enough
    await u.click(screen.getByRole("checkbox", { name: /Discard 4 pending changes and 3 undownloaded files/ }));
    expect(confirm).toBeEnabled();
    await u.click(confirm);
    expect(mocks.deleteProject).toHaveBeenCalledWith(PID, true);
  });

  it("the typed name must match exactly", async () => {
    const u = userEvent.setup();
    open();
    await u.click(await screen.findByTestId("delete-continue"));
    await u.type(screen.getByLabelText("Project name"), "demo");
    expect(screen.getByTestId("delete-confirm")).toBeDisabled();
  });

  it("goes back to step 1 with fresh counts when the hub says the project is not empty", async () => {
    const u = userEvent.setup();
    mocks.deleteProject.mockRejectedValue(new ApiError(409, "pending", "project_not_empty"));
    open();
    await u.click(await screen.findByTestId("delete-continue"));
    await u.type(screen.getByLabelText("Project name"), "demo-app");
    mocks.project.mockResolvedValue({ ...project, pendingFiles: 2 });
    mocks.disk.mockResolvedValue(disk(2, 0));
    await u.click(screen.getByTestId("delete-confirm"));
    expect(await screen.findByText(/Pending changes or undownloaded files remain/)).toBeInTheDocument();
    expect(await screen.findByText("2", { selector: "[data-testid=count-pending]" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("toasts other delete errors and stays open; a failed check offers retry", async () => {
    const u = userEvent.setup();
    mocks.project.mockRejectedValueOnce(new Error("hub down"));
    open();
    expect(await screen.findByText(/Couldn't check the project: hub down/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Retry" }));
    await u.click(await screen.findByTestId("delete-continue"));
    mocks.deleteProject.mockRejectedValue(new ApiError(500, "disk error"));
    await u.type(screen.getByLabelText("Project name"), "demo-app");
    await u.click(screen.getByTestId("delete-confirm"));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.tone === "error" && t.title.includes("disk error"))).toBe(true));
    expect(within(screen.getByRole("dialog")).getByTestId("delete-step-2")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
