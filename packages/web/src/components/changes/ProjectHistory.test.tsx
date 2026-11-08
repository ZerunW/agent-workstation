import "../usage/testMatchers";
import type { Snapshot } from "@agent-workstation/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ projectHistory: vi.fn(), restoreProject: vi.fn() }));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, projectHistory: mocks.projectHistory, restoreProject: mocks.restoreProject } };
});

import { ApiError } from "../../lib/api";
import { useReview } from "../../store/review";
import { useToasts } from "../../store/toasts";
import { ProjectHistory } from "./ProjectHistory";

const PID = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const snap = (kind: Snapshot["kind"], ref: string, at: string, message: string, extra: Partial<Snapshot> = {}): Snapshot => ({ ref, sessionId: null, turn: null, at, message, kind, ...extra });
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const HISTORY: Snapshot[] = [
  snap("trash", "ttt0000000000", ago(10), "Before restore of a.ts"),
  snap("snapshot", "sss1111111111", ago(60), "Turn 1: first", { sessionId: SESSION, turn: 1 }),
  snap("sync", "yyy2222222222", ago(300), "Sync from mac: 4 files"),
  snap("snapshot", "sss3333333333", ago(30), "Turn 2: second", { sessionId: SESSION, turn: 2 }),
  snap("accept", "aaa4444444444", ago(20), "Accepted src/app.ts"),
];

beforeEach(() => {
  vi.clearAllMocks();
  useReview.getState().clear();
  useToasts.setState({ toasts: [] });
  mocks.projectHistory.mockResolvedValue(HISTORY);
  mocks.restoreProject.mockResolvedValue({ localCommit: "x" });
});

describe("ProjectHistory", () => {
  it("groups entries by kind (sync, snapshot, accept, trash), newest first, with time, message and turn", async () => {
    render(<ProjectHistory projectId={PID} projectName="demo" />);
    await screen.findByTestId("project-history");
    const order = ["sync", "snapshot", "accept", "trash"];
    const groups = order.map((k) => screen.getByTestId(`history-group-${k}`));
    for (let i = 1; i < groups.length; i++) expect(groups[i - 1]!.compareDocumentPosition(groups[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(groups[1]!).getAllByTestId("history-row").map((r) => r.dataset.ref)).toEqual(["sss3333333333", "sss1111111111"]);
    expect(within(groups[1]!).getByText("Turn 2: second")).toBeInTheDocument();
    expect(within(groups[1]!).getByText("turn 2")).toBeInTheDocument();
    expect(within(groups[1]!).getAllByText(/ago$/)[0]).toHaveTextContent("30m ago");
    expect(within(groups[0]!).getByText("Synced from your Mac")).toBeInTheDocument();
    expect(within(groups[3]!).getByText("Trash")).toBeInTheDocument();
    expect(within(groups[1]!).getByText("sss3333")).toBeInTheDocument(); // short ref
  });

  it("Restore all asks for confirmation (no explanatory copy), then restores by ref", async () => {
    const u = userEvent.setup();
    render(<ProjectHistory projectId={PID} projectName="demo" />);
    const row = (await screen.findAllByTestId("history-row")).find((r) => r.dataset.ref === "sss3333333333")!;
    await u.click(within(row).getByRole("button", { name: "Restore all" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Restore all of demo?");
    expect(dialog).not.toHaveTextContent(/overwrites every file/);
    expect(dialog).not.toHaveTextContent(/trash snapshot/);
    expect(mocks.restoreProject).not.toHaveBeenCalled();

    mocks.projectHistory.mockResolvedValue([...HISTORY, snap("trash", "new-trash", ago(0), "Before restore of all files")]);
    await u.click(within(dialog).getByTestId("restore-confirm"));
    expect(mocks.restoreProject).toHaveBeenCalledWith(PID, { ref: "sss3333333333" });
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.tone === "success" && t.title.includes("the whole project"))).toBe(true));
    // the history refetches (review_changed bump) and shows the new trash entry
    await waitFor(() => expect(screen.getAllByTestId("history-row").some((r) => r.dataset.ref === "new-trash")).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Restore file… needs a valid project-relative path, and passes it to the hub", async () => {
    const u = userEvent.setup();
    render(<ProjectHistory projectId={PID} projectName="demo" />);
    const row = (await screen.findAllByTestId("history-row")).find((r) => r.dataset.ref === "yyy2222222222")!;
    await u.click(within(row).getByRole("button", { name: "Restore file…" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByTestId("restore-confirm");
    expect(confirm).toBeDisabled();

    const input = within(dialog).getByLabelText("File path");
    await u.type(input, "../secret");
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText(/relative to the project/)).toBeInTheDocument();
    await u.clear(input);
    await u.type(input, "src/app.ts");
    expect(confirm).toBeEnabled();
    expect(dialog).not.toHaveTextContent(/overwrites/);
    await u.click(confirm);
    expect(mocks.restoreProject).toHaveBeenCalledWith(PID, { ref: "yyy2222222222", path: "src/app.ts" });
  });

  it("keeps the dialog open and toasts when the restore fails", async () => {
    const u = userEvent.setup();
    mocks.restoreProject.mockRejectedValue(new ApiError(404, "unknown ref"));
    render(<ProjectHistory projectId={PID} projectName="demo" />);
    const row = (await screen.findAllByTestId("history-row"))[0]!;
    await u.click(within(row).getByRole("button", { name: "Restore all" }));
    await u.click(within(await screen.findByRole("dialog")).getByTestId("restore-confirm"));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.tone === "error" && t.title.includes("unknown ref"))).toBe(true));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows an empty state, 'not available yet' on 404 and an error with retry otherwise", async () => {
    mocks.projectHistory.mockResolvedValueOnce([]);
    const a = render(<ProjectHistory projectId={PID} projectName="demo" />);
    expect(await screen.findByText("No history yet")).toBeInTheDocument();
    a.unmount();

    mocks.projectHistory.mockRejectedValueOnce(new ApiError(404, "not found: GET /api/projects/x/history"));
    const b = render(<ProjectHistory projectId={PID} projectName="demo" />);
    expect(await screen.findByText("Not available yet")).toBeInTheDocument();
    b.unmount();

    mocks.projectHistory.mockRejectedValueOnce(new ApiError(500, "db locked")).mockResolvedValueOnce(HISTORY);
    render(<ProjectHistory projectId={PID} projectName="demo" />);
    expect(await screen.findByText("db locked")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("project-history");
  });
});
