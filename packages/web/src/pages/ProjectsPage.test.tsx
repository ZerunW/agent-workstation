import "../components/usage/testMatchers";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestRouter } from "../test/router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ projects: vi.fn(), runDownload: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, projects: mocks.projects, project: vi.fn(), disk: vi.fn() } };
});
vi.mock("../lib/downloadToasts", () => ({ runDownload: mocks.runDownload }));

import { ApiError, type ProjectInfo } from "../lib/api";
import { useApp } from "../store/app";
import { useProjects } from "../store/projects";
import ProjectsPage from "./ProjectsPage";

const mk = (name: string, over: Partial<ProjectInfo> = {}): ProjectInfo => ({
  id: `${name.length}1111111-1111-4111-8111-111111111111`,
  user: "alice",
  name,
  path: `projects/${name}`,
  createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  localCommit: "0123456789abcdef0123456789abcdef01234567",
  pendingFiles: 0,
  sizeBytes: 5 * 1024 * 1024,
  origin: "my-mac",
  ...over,
});
const demo = mk("demo-app", { pendingFiles: 4 });
const notes = mk("notes", { localCommit: null, sizeBytes: 42 });

const renderPage = () =>
  render(
    <TestRouter>
      <ProjectsPage />
    </TestRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useProjects.getState().reset();
  mocks.projects.mockResolvedValue([demo, notes]);
  useApp.setState({ disk: { level: "ok", usedPercent: 1, totalBytes: 1, freeBytes: 1, warnPercent: 80, blockPercent: 95, breakdown: [], projects: [{ id: demo.id, name: "demo-app", pendingFiles: 4, undownloadedFiles: 3, bytes: 1 }] } });
});

describe("ProjectsPage", () => {
  it("lists name, size, pending, undownloaded, short commit and age, with no explanatory copy", async () => {
    renderPage();
    const rows = await screen.findAllByTestId("project-row");
    expect(rows.map((r) => r.dataset.name)).toEqual(["demo-app", "notes"]);
    expect(screen.queryByTestId("mac-hint")).toBeNull();
    expect(screen.queryByText(/macOS app/)).toBeNull();
    const demoRow = within(rows[0]!);
    expect(demoRow.getByText("5.00 MB")).toBeInTheDocument();
    expect(demoRow.getByTestId("cell-pending")).toHaveTextContent("4");
    expect(demoRow.getByTestId("cell-undownloaded")).toHaveTextContent("3"); // from DiskStatus.projects[]
    expect(demoRow.getByText("0123456")).toBeInTheDocument();
    expect(demoRow.getByText(/ago$/)).toBeInTheDocument();
    const notesRow = within(rows[1]!);
    expect(notesRow.getByText("—", { selector: "code" })).toBeInTheDocument(); // no local commit yet
    expect(notesRow.getByTestId("cell-undownloaded")).toHaveTextContent("—"); // disk status does not know it
    for (const h of ["Name", "Size", "Pending", "Not downloaded", "Local commit", "Created"]) expect(screen.getByRole("columnheader", { name: h })).toBeInTheDocument();
  });

  it("row actions: open review, download as zip of projects/<name>, delete dialog", async () => {
    const u = userEvent.setup();
    renderPage();
    const row = within((await screen.findAllByTestId("project-row"))[0]!);
    expect(row.getByRole("link", { name: "Review" })).toHaveAttribute("href", `/projects/${demo.id}`);
    await u.click(row.getByRole("button", { name: "Download zip" }));
    expect(mocks.runDownload).toHaveBeenCalledWith(["projects/demo-app"], "demo-app.zip");
    await u.click(row.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Delete project demo-app?");
  });

  it("shows an empty state, 'not available yet' on 501 and an error with retry", async () => {
    mocks.projects.mockResolvedValueOnce([]);
    const a = renderPage();
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    a.unmount();

    useProjects.getState().reset();
    mocks.projects.mockRejectedValueOnce(new ApiError(501, "not implemented"));
    const b = renderPage();
    expect(await screen.findByText("Not available yet")).toBeInTheDocument();
    b.unmount();

    useProjects.getState().reset();
    mocks.projects.mockRejectedValueOnce(new ApiError(500, "db locked")).mockResolvedValueOnce([demo]);
    renderPage();
    expect(await screen.findByText("db locked")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("projects-table");
  });
});
