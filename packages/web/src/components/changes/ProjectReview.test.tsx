import "../usage/testMatchers";
import type { ReviewFile } from "@agent-workstation/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getReview: vi.fn(), accept: vi.fn(), reject: vi.fn(), getReviewDiff: vi.fn() }));
vi.mock("../../embed/reviewApi", () => ({ getReview: mocks.getReview, accept: mocks.accept, reject: mocks.reject, getReviewDiff: mocks.getReviewDiff }));
// The merge view has its own tests (DiffEmbed.test); here it is a stub that exposes what the list hands it.
vi.mock("../../embed/DiffEmbed", () => ({
  DiffEmbed: (p: { path: string; layout?: string; banner?: unknown; onChanged?: (e: unknown) => void; onStale?: () => void }) => (
    <div data-testid="diff-embed-stub" data-path={p.path} data-layout={p.layout}>
      {p.banner as never}
      <button onClick={() => p.onChanged?.({ kind: "accept", path: p.path })}>stub-accepted</button>
      <button onClick={() => p.onStale?.()}>stub-stale</button>
    </div>
  ),
}));

import { ApiError } from "../../lib/api";
import { useReview } from "../../store/review";
import { useToasts } from "../../store/toasts";
import { ProjectReview } from "./ProjectReview";

const PID = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const touched = (sessionId: string) => ({ sessionId, turn: 2, tool: "Edit", at: "2026-10-31T00:00:00Z" });
const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, status: "modified", binary: false, additions: 3, deletions: 1, sizeBytes: 2048, lastTouchedBy: null, ...over });
const FILES: ReviewFile[] = [
  file("src/app.ts", { lastTouchedBy: touched(ME) }),
  file("src/new.ts", { status: "added", additions: 10, deletions: 0, sizeBytes: 300, lastTouchedBy: touched(OTHER) }),
  file("old.txt", { status: "deleted", additions: 0, deletions: 5 }),
  file("lib/renamed.ts", { status: "renamed", oldPath: "lib/was.ts" }),
  file("logo.png", { binary: true, additions: 0, deletions: 0, sizeBytes: 5000 }),
];
const review = (files: ReviewFile[]) => ({ project: { id: PID, name: "demo" }, files });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useReview.getState().clear();
  useToasts.setState({ toasts: [] });
  mocks.getReview.mockResolvedValue(review(FILES));
  mocks.accept.mockResolvedValue({ localCommit: "c", files: [] });
  mocks.reject.mockResolvedValue({});
});

const rows = () => screen.getAllByTestId("review-row");

describe("ProjectReview list", () => {
  it("shows status badges, +/- counts, sizes, the binary flag and who touched each file", async () => {
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    expect(rows().map((r) => r.dataset.path)).toEqual(["lib/renamed.ts", "logo.png", "old.txt", "src/app.ts", "src/new.ts"]); // sorted by path
    expect(screen.getByTestId("pending-count")).toHaveTextContent("5 to review");

    const byPath = (p: string) => within(rows().find((r) => r.dataset.path === p)!);
    expect(byPath("src/app.ts").getByTestId("status-badge")).toHaveTextContent("M");
    expect(byPath("src/new.ts").getByTestId("status-badge")).toHaveTextContent("A");
    expect(byPath("old.txt").getByTestId("status-badge")).toHaveTextContent("D");
    expect(byPath("lib/renamed.ts").getByTestId("status-badge")).toHaveTextContent("R");
    expect(byPath("src/app.ts").getByText("+3")).toBeInTheDocument();
    expect(byPath("src/app.ts").getByText("−1")).toBeInTheDocument();
    expect(byPath("src/app.ts").getByText("2.00 KB")).toBeInTheDocument();
    expect(byPath("logo.png").getByText("binary")).toBeInTheDocument();
    expect(byPath("logo.png").queryByText("+0")).toBeNull(); // no line counts for binary files
    expect(byPath("lib/renamed.ts").getByText("was lib/was.ts")).toBeInTheDocument();
    expect(byPath("src/app.ts").getByTestId("touched-by")).toHaveTextContent("this session");
    expect(byPath("src/new.ts").getByTestId("touched-by")).toHaveTextContent("other");
    expect(byPath("old.txt").queryByTestId("touched-by")).toBeNull(); // unknown toucher: no label
  });

  it("the 'This session' filter keeps only files this session touched last, and says so when none are left", async () => {
    const u = userEvent.setup();
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    await u.click(screen.getByTestId("filter-session"));
    expect(rows().map((r) => r.dataset.path)).toEqual(["src/app.ts"]);
    expect(screen.getByTestId("filter-session")).toHaveAttribute("aria-checked", "true");

    mocks.getReview.mockResolvedValue(review([file("x.ts", { lastTouchedBy: touched(OTHER) })]));
    act(() => useReview.getState().bump(PID));
    expect(await screen.findByText(/No pending changes from this session/)).toBeInTheDocument();
  });

  it("has no session filter outside a session (Projects page)", async () => {
    render(<ProjectReview projectId={PID} projectName="demo" />);
    await screen.findAllByTestId("review-row");
    expect(screen.queryByTestId("filter-session")).toBeNull();
    expect(screen.queryByTestId("touched-by")).toBeNull();
  });

  it("refetches when review_changed bumps the project version", async () => {
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    mocks.getReview.mockResolvedValue(review([file("fresh.ts")]));
    act(() => useReview.getState().bump(PID));
    await waitFor(() => expect(rows().map((r) => r.dataset.path)).toEqual(["fresh.ts"]));
    expect(mocks.getReview).toHaveBeenCalledTimes(2);
  });

  it("Accept all sends {all: true} and reloads the list", async () => {
    const u = userEvent.setup();
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    mocks.getReview.mockResolvedValue(review([]));
    await u.click(screen.getByTestId("accept-all"));
    expect(mocks.accept).toHaveBeenCalledWith(PID, { all: true });
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
    expect(useToasts.getState().toasts.some((t) => t.tone === "success")).toBe(true);
  });

  it("per-file accept acts immediately; reject asks first", async () => {
    const u = userEvent.setup();
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    await u.click(screen.getByRole("button", { name: "Accept src/app.ts" }));
    expect(mocks.accept).toHaveBeenCalledWith(PID, { path: "src/app.ts" });

    await u.click(screen.getByRole("button", { name: "Reject src/new.ts" }));
    expect(mocks.reject).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Reject all changes to src/new.ts?");
    await u.click(within(dialog).getByRole("button", { name: "Reject file" }));
    expect(mocks.reject).toHaveBeenCalledWith(PID, { path: "src/new.ts" });
  });

  it("shows an error toast when an action fails", async () => {
    const u = userEvent.setup();
    mocks.accept.mockRejectedValue(new ApiError(500, "disk on fire"));
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    await u.click(screen.getByTestId("accept-all"));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.tone === "error" && t.title.includes("disk on fire"))).toBe(true));
  });

  it("sync_conflict events show an inline alert on the file row (and clear once the file is accepted)", async () => {
    const u = userEvent.setup();
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    act(() => useReview.getState().addConflict(PID, "src/app.ts", "both sides edited line 12"));
    const alert = await screen.findByTestId("row-conflict");
    expect(alert).toHaveTextContent("both sides edited line 12");
    expect(within(rows().find((r) => r.dataset.path === "src/app.ts")!).getByTestId("row-conflict")).toBe(alert);
    await u.click(screen.getByRole("button", { name: "Accept src/app.ts" }));
    await waitFor(() => expect(screen.queryByTestId("row-conflict")).toBeNull());
  });

  it("degrades to 'Not available yet' on 404/501 and to an error with retry otherwise", async () => {
    const u = userEvent.setup();
    mocks.getReview.mockRejectedValueOnce(new ApiError(501, "not implemented"));
    const { unmount } = render(<ProjectReview projectId={PID} projectName="demo" />);
    expect(await screen.findByText("Not available yet")).toBeInTheDocument();
    unmount();

    mocks.getReview.mockRejectedValueOnce(new ApiError(500, "kaput")).mockResolvedValueOnce(review(FILES));
    render(<ProjectReview projectId={PID} projectName="demo" />);
    expect(await screen.findByText("Couldn't load the changes")).toBeInTheDocument();
    expect(screen.getByText("kaput")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findAllByTestId("review-row");
  });
});

describe("ProjectReview detail", () => {
  it("opens the diff for a file, passes the persisted layout and goes back to the list", async () => {
    const u = userEvent.setup();
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    await u.click(screen.getByRole("button", { name: "Review src/app.ts" }));
    const stub = await screen.findByTestId("diff-embed-stub");
    expect(stub).toHaveAttribute("data-path", "src/app.ts");
    expect(stub).toHaveAttribute("data-layout", "unified");

    await u.click(screen.getByTestId("layout-split"));
    expect(screen.getByTestId("diff-embed-stub")).toHaveAttribute("data-layout", "split");
    expect(localStorage.getItem("workstation.diffLayout")).toBe("split");

    await u.click(screen.getByRole("button", { name: "All changes" }));
    expect(screen.getByTestId("project-review")).toBeInTheDocument();
    // the choice sticks for the next file
    await u.click(screen.getByRole("button", { name: "Review src/new.ts" }));
    expect(screen.getByTestId("diff-embed-stub")).toHaveAttribute("data-layout", "split");
  });

  it("shows the file's sync conflict above the diff", async () => {
    const u = userEvent.setup();
    useReview.getState().addConflict(PID, "src/app.ts", "base changed");
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    await u.click(screen.getByRole("button", { name: "Review src/app.ts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("base changed");
  });

  it("reloads the list after a diff action and when the diff reports a stale file", async () => {
    const u = userEvent.setup();
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    await u.click(screen.getByRole("button", { name: "Review src/app.ts" }));
    await screen.findByTestId("diff-embed-stub");
    expect(mocks.getReview).toHaveBeenCalledTimes(1);
    await u.click(screen.getByText("stub-stale"));
    await waitFor(() => expect(mocks.getReview).toHaveBeenCalledTimes(2));
    await u.click(screen.getByText("stub-accepted"));
    await waitFor(() => expect(mocks.getReview).toHaveBeenCalledTimes(3));
  });

  it("returns to the list when the open file leaves the review (accepted elsewhere)", async () => {
    const u = userEvent.setup();
    render(<ProjectReview projectId={PID} projectName="demo" sessionId={ME} />);
    await screen.findAllByTestId("review-row");
    await u.click(screen.getByRole("button", { name: "Review src/app.ts" }));
    await screen.findByTestId("diff-embed-stub");
    mocks.getReview.mockResolvedValue(review(FILES.filter((f) => f.path !== "src/app.ts")));
    act(() => useReview.getState().bump(PID));
    await waitFor(() => expect(screen.queryByTestId("diff-embed-stub")).toBeNull());
    expect(screen.getByTestId("project-review")).toBeInTheDocument();
  });
});
