import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onSyncChanged, pendingDefault, syncCheck } from "../../lib/sync";
import { entry, installBridge, makeBridge, pendingItem, PID, removeBridge } from "../../test/syncBridge";
import { SyncTab } from "./SyncTab";

afterEach(removeBridge);

const setup = (opts: Parameters<typeof makeBridge>[0] = {}) => {
  const bridge = makeBridge(opts);
  installBridge(bridge);
  render(<SyncTab projectId={PID} />);
  return bridge;
};
const pendingRow = async (path: string) => within(await screen.findByTestId("sync-pending")).getByText(path).closest("li") as HTMLElement;
const treeRow = async (path: string) => {
  await waitFor(() => expect(document.querySelector(`[data-testid="sync-row"][data-path="${path}"]`)).not.toBeNull());
  return document.querySelector(`[data-testid="sync-row"][data-path="${path}"]`) as HTMLElement;
};
const boxOf = (row: HTMLElement) => within(row).getAllByTestId("sync-check")[0]!;

describe("pending", () => {
  const items = [
    pendingItem({ path: "src", kind: "folder", files: 12, bytes: 40_000, suggestion: "sync", source: "rule", reason: "Source code" }),
    pendingItem({ path: "node_modules", kind: "folder", files: 900, bytes: 9_000_000, suggestion: "skip", source: "rule", reason: "Dependencies" }),
    pendingItem({ path: "notes.txt", suggestion: null }),
    pendingItem({ path: "movie.mov", suggestion: null, large: true, bytes: 2_500_000_000 }),
  ];

  it("starts with the suggestion: sync checked, skip unchecked, none checked unless large", async () => {
    setup({ pending: items });
    const checked = async (p: string) => (within(await pendingRow(p)).getByRole("checkbox") as HTMLInputElement).checked;
    expect(await checked("src")).toBe(true);
    expect(await checked("node_modules")).toBe(false);
    expect(await checked("notes.txt")).toBe(true);
    expect(await checked("movie.mov")).toBe(false);
    expect(pendingDefault({ suggestion: "sync", large: true })).toBe(true);
  });

  it("shows size, file count, a one-line reason with its source, and a prominent size for large items", async () => {
    setup({ pending: items });
    const src = await pendingRow("src");
    expect(src).toHaveTextContent("12 files");
    expect(within(src).getByTestId("sync-reason")).toHaveTextContent("Source code");
    expect(src).toHaveTextContent("rule");
    const big = await pendingRow("movie.mov");
    expect(within(big).getByTestId("sync-large")).toHaveTextContent("2.33 GB");
    expect(within(await pendingRow("notes.txt")).queryByTestId("sync-large")).toBeNull();
  });

  it("never shows an AI spinner (there is no AI pass): a pending item without a suggestion shows no reason", async () => {
    setup({ pending: items });
    await pendingRow("notes.txt");
    expect(screen.queryByTestId("sync-thinking")).toBeNull();
  });

  it("Confirm sends every row: checked → sync, unchecked → skip, with the item's kind", async () => {
    const bridge = setup({ pending: items });
    await userEvent.click(within(await pendingRow("notes.txt")).getByRole("checkbox"));
    await userEvent.click(within(await pendingRow("movie.mov")).getByRole("checkbox"));
    await userEvent.click(screen.getByTestId("sync-confirm"));
    await waitFor(() => expect(bridge.decide).toHaveBeenCalledTimes(1));
    expect(bridge.decide).toHaveBeenCalledWith(PID, [
      { path: "src", kind: "folder", decision: "sync" },
      { path: "node_modules", kind: "folder", decision: "skip" },
      { path: "notes.txt", kind: "file", decision: "skip" },
      { path: "movie.mov", kind: "file", decision: "sync" },
    ]);
  });

  it("has no pending block without items", async () => {
    setup({ tree: { "": [entry({ path: "a.txt" })] } });
    await treeRow("a.txt");
    expect(screen.queryByTestId("sync-pending")).toBeNull();
    expect(screen.queryByTestId("sync-confirm")).toBeNull();
  });
});

describe("tree", () => {
  const tree = {
    "": [
      entry({ path: "apps", kind: "folder", decision: "sync", effective: "sync", files: 3 }),
      entry({ path: "libs", kind: "folder", decision: "sync", effective: "sync", mixed: true, files: 3 }),
      entry({ path: "build", kind: "folder", decision: "skip", effective: "skip", source: "rule", reason: "Build output", files: 2 }),
      entry({ path: "a.txt", decision: null, effective: "sync" }),
      entry({ path: "b.txt", decision: null, effective: "skip", source: "ai", reason: "Looks like a scratch file" }),
      entry({ path: "c.txt", decision: null, effective: null }),
    ],
    build: [entry({ path: "build/out.js", decision: null, effective: "skip" }), entry({ path: "build/sub", kind: "folder", decision: null, effective: "skip" })],
  };

  it("shows approved, mixed, skipped, inherited and waiting rows distinctly", async () => {
    setup({ tree });
    const state = async (p: string) => boxOf(await treeRow(p)).getAttribute("data-state");
    expect(await state("apps")).toBe("approved");
    expect(await state("libs")).toBe("mixed");
    expect(await state("build")).toBe("skip");
    expect(await state("a.txt")).toBe("inherit-sync");
    expect(await state("b.txt")).toBe("inherit-skip");
    expect(await state("c.txt")).toBe("waiting");
    // checked: approved, mixed and inherited-sync; the mixed folder alone has the partial mark
    const checked = async (p: string) => boxOf(await treeRow(p)).getAttribute("aria-checked");
    expect([await checked("apps"), await checked("libs"), await checked("a.txt")]).toEqual(["true", "true", "true"]);
    expect([await checked("build"), await checked("b.txt"), await checked("c.txt")]).toEqual(["false", "false", "false"]);
    expect(within(await treeRow("libs")).getByTestId("sync-partial")).toBeInTheDocument();
    expect(within(await treeRow("apps")).queryByTestId("sync-partial")).toBeNull();
  });

  it("a file that is its own decision is not the same as an inherited one", () => {
    expect(syncCheck({ kind: "file", decision: "sync", effective: "sync" }, false)).toEqual({ state: "approved", checked: true, dimmed: false });
    expect(syncCheck({ kind: "file", decision: null, effective: "sync" }, false)).toEqual({ state: "inherit-sync", checked: true, dimmed: true });
    expect(syncCheck({ kind: "file", decision: "sync", effective: "sync", mixed: true }, false).state).toBe("approved");
    expect(syncCheck({ kind: "folder", decision: "sync", effective: "sync", mixed: true }, false).state).toBe("mixed");
  });

  it("rule reasons are a muted second line; the full text is the hover title", async () => {
    setup({ tree });
    const b = await treeRow("b.txt");
    expect(within(b).getByTestId("sync-reason")).toHaveTextContent("Looks like a scratch file");
    expect(within(b).queryByText("AI")).toBeNull();
    expect(b.querySelector('[title="Looks like a scratch file"]')).not.toBeNull();
    expect(within(await treeRow("build")).getByTestId("sync-reason")).toHaveTextContent("Build output");
    expect(within(await treeRow("a.txt")).queryByTestId("sync-reason")).toBeNull();
  });

  it("expanding loads children lazily; rows inside a skipped folder are dimmed and not editable", async () => {
    const bridge = setup({ tree });
    await treeRow("build");
    expect(bridge.list).toHaveBeenCalledTimes(1);
    expect(bridge.list).toHaveBeenCalledWith(PID, "");
    await userEvent.click(screen.getByRole("button", { name: "Expand build" }));
    const out = await treeRow("build/out.js");
    expect(bridge.list).toHaveBeenCalledWith(PID, "build");
    expect(boxOf(out)).toBeDisabled();
    expect(boxOf(out)).toHaveAttribute("data-state", "locked");
    expect(out.firstElementChild).toHaveClass("opacity-50");
    expect(boxOf(await treeRow("build/sub"))).toBeDisabled();
    await userEvent.click(boxOf(out));
    expect(bridge.decide).not.toHaveBeenCalled();
    // the skipped folder itself and its siblings stay editable
    expect(boxOf(await treeRow("build"))).toBeEnabled();
    expect(boxOf(await treeRow("a.txt"))).toBeEnabled();
  });

  it("a click sets the row's own decision; an inherited check turns into skip", async () => {
    const bridge = setup({ tree });
    await userEvent.click(boxOf(await treeRow("c.txt")));
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "c.txt", kind: "file", decision: "sync" }]);
    await userEvent.click(boxOf(await treeRow("a.txt")));
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "a.txt", kind: "file", decision: "skip" }]);
    await userEvent.click(boxOf(await treeRow("b.txt")));
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "b.txt", kind: "file", decision: "sync" }]);
    await userEvent.click(boxOf(await treeRow("apps")));
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "apps", kind: "folder", decision: "skip" }]);
    await userEvent.click(boxOf(await treeRow("libs")));
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "libs", kind: "folder", decision: "skip" }]);
    await userEvent.click(boxOf(await treeRow("build")));
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "build", kind: "folder", decision: "sync" }]);
  });

  it("Option/Alt-click (and Delete on the focused box) clears the own decision", async () => {
    const bridge = setup({ tree });
    fireEvent.click(boxOf(await treeRow("apps")), { altKey: true });
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "apps", kind: "folder", decision: null }]);
    boxOf(await treeRow("build")).focus();
    await userEvent.keyboard("{Delete}");
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "build", kind: "folder", decision: null }]);
    expect(bridge.decide).toHaveBeenCalledTimes(2);
    // an undecided row has nothing to clear
    fireEvent.click(boxOf(await treeRow("a.txt")), { altKey: true });
    expect(bridge.decide).toHaveBeenCalledTimes(2);
  });

  it("reloads the tree after a decision", async () => {
    const bridge = setup({ tree });
    await treeRow("a.txt");
    const before = bridge.list.mock.calls.length;
    await userEvent.click(boxOf(await treeRow("c.txt")));
    await waitFor(() => expect(bridge.list.mock.calls.length).toBeGreaterThan(before));
  });

  it("the header button rechecks the whole folder", async () => {
    const bridge = setup({ tree });
    await treeRow("a.txt");
    await userEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(bridge.recheck).toHaveBeenCalledWith(PID));
  });

  it("shows a failure as one muted line", async () => {
    const bridge = makeBridge({ tree });
    bridge.list.mockRejectedValue(new Error("folder gone"));
    installBridge(bridge);
    render(<SyncTab projectId={PID} />);
    const line = await screen.findByTestId("sync-error");
    expect(line).toHaveTextContent("Sync failed: folder gone");
    expect(line).toHaveClass("text-muted");
  });

  it("shows a failed decision as the error line", async () => {
    const bridge = setup({ tree });
    bridge.decide.mockRejectedValue(new Error("busy"));
    await userEvent.click(boxOf(await treeRow("c.txt")));
    expect(await screen.findByTestId("sync-error")).toHaveTextContent("Sync failed: busy");
  });

  it("the checkboxes are keyboard operable", async () => {
    const bridge = setup({ tree });
    boxOf(await treeRow("c.txt")).focus();
    await userEvent.keyboard(" ");
    expect(bridge.decide).toHaveBeenLastCalledWith(PID, [{ path: "c.txt", kind: "file", decision: "sync" }]);
    expect(screen.getByRole("button", { name: "Expand apps" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("refresh", () => {
  it("reloads pending items and the tree when AgentWorkstation.app reports a change for this project", async () => {
    const bridge = setup({ tree: { "": [entry({ path: "a.txt" })] } });
    await treeRow("a.txt");
    expect(screen.queryByTestId("sync-pending")).toBeNull();
    bridge.pending.mockResolvedValue([pendingItem({ path: "fresh.txt", suggestion: "sync" })]);
    bridge.list.mockImplementation(() => Promise.resolve([entry({ path: "a.txt" }), entry({ path: "z.txt" })]));
    act(() => window.__workstationSyncChanged?.(PID));
    expect(await pendingRow("fresh.txt")).toBeInTheDocument();
    await treeRow("z.txt");
  });

  it("ignores other projects, and keeps what the person toggled while the list reloads", async () => {
    const bridge = setup({ pending: [pendingItem({ path: "x.txt", suggestion: "sync" }), pendingItem({ path: "y.txt", suggestion: "skip" })] });
    await userEvent.click(within(await pendingRow("x.txt")).getByRole("checkbox"));
    const calls = bridge.pending.mock.calls.length;
    act(() => window.__workstationSyncChanged?.("some-other-project"));
    expect(bridge.pending.mock.calls.length).toBe(calls);
    act(() => window.__workstationSyncChanged?.(PID));
    await waitFor(() => expect(bridge.pending.mock.calls.length).toBeGreaterThan(calls));
    expect((within(await pendingRow("x.txt")).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((within(await pendingRow("y.txt")).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("onSyncChanged chains the handler that was installed before and restores it", () => {
    const prev = vi.fn();
    window.__workstationSyncChanged = prev;
    const cb = vi.fn();
    const stop = onSyncChanged(PID, cb);
    window.__workstationSyncChanged?.(PID);
    window.__workstationSyncChanged?.("other");
    expect(prev).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
    expect(window.__workstationSyncChanged).toBe(prev);
  });
});
