import "../usage/testMatchers";
import type { DiskStatus } from "@agent-workstation/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { TestRouter } from "../../test/router";
import { useApp } from "../../store/app";
import { DiskModal } from "./DiskModal";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const disk = (over: Partial<DiskStatus> = {}): DiskStatus => ({
  level: "warn",
  usedPercent: 86,
  totalBytes: 100,
  freeBytes: 14,
  warnPercent: 80,
  blockPercent: 95,
  breakdown: [{ label: "Projects", user: "alice", path: "projects", bytes: 2048 }],
  projects: [
    { id: A, name: "demo-app", pendingFiles: 4, undownloadedFiles: 3, bytes: 2 * 1024 * 1024 },
    { id: B, name: "notes", pendingFiles: 0, undownloadedFiles: 0, bytes: 1024 },
  ],
  ...over,
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
const renderModal = () =>
  render(
    <TestRouter>
      <Routes>
        <Route path="*" element={<><DiskModal /><Where /></>} />
      </Routes>
    </TestRouter>,
  );

beforeEach(() => useApp.setState({ disk: disk(), diskModalDismissed: false }));

describe("DiskModal projects", () => {
  it("lists every project with its pending/undownloaded counts and a link to its review", async () => {
    renderModal();
    const list = await screen.findByTestId("disk-projects");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.dataset.name)).toEqual(["demo-app", "notes"]);
    expect(items[0]).toHaveTextContent("4 unaccepted changes");
    expect(items[0]).toHaveTextContent("3 files not downloaded");
    const links = within(list).getAllByTestId("disk-project-review");
    expect(links[0]).toHaveAttribute("href", `/projects/${A}`);
    expect(links[1]).toHaveAttribute("href", `/projects/${B}`);
  });

  it("opening a project's review dismisses the modal and navigates there", async () => {
    const u = userEvent.setup();
    renderModal();
    await u.click((await screen.findAllByTestId("disk-project-review"))[0]!);
    expect(screen.getByTestId("where")).toHaveTextContent(`/projects/${A}`);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has a button to the Projects page", async () => {
    const u = userEvent.setup();
    renderModal();
    await u.click(await screen.findByTestId("disk-open-projects"));
    expect(screen.getByTestId("where")).toHaveTextContent("/projects");
    expect(useApp.getState().diskModalDismissed).toBe(true);
  });

  it("says so when there are no projects", async () => {
    useApp.setState({ disk: disk({ projects: [] }) });
    renderModal();
    expect(await screen.findByText("No synced projects.")).toBeInTheDocument();
    expect(screen.queryByTestId("disk-projects")).toBeNull();
  });
});
