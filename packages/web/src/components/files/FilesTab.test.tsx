import type { FileEntry, Session } from "@agent-workstation/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

expect.extend(jestDomMatchers); // setup.ts registers jest-dom on a different vitest copy, so register the matchers here

const e = (path: string, kind: FileEntry["kind"] = "file", size = 10): FileEntry => ({ path, name: path.split("/").pop()!, kind, size, mtime: "2026-10-31T00:00:00Z" });

const listings: Record<string, FileEntry[]> = {
  "": [e("readme.md", "file", 1536), e("docs", "dir", 0), e("inbox", "dir", 0)],
  docs: [e("docs/a.md", "file", 2048), e("docs/b.md", "file", 1048576)],
  inbox: [],
};
const nested: FileEntry[] = [e("docs/a.md", "file", 2048), e("docs/b.md", "file", 1048576), e("docs/sub", "dir", 0)];

const mocks = vi.hoisted(() => ({
  filesTree: vi.fn(),
  filesContent: vi.fn(),
  filesDelete: vi.fn(),
  filesMkdir: vi.fn(),
  downloadFiles: vi.fn(),
  uploadFilesWithToasts: vi.fn(),
  sessionOutputs: vi.fn(),
}));

vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, filesTree: mocks.filesTree, filesContent: mocks.filesContent, filesDelete: mocks.filesDelete, filesMkdir: mocks.filesMkdir, sessionOutputs: mocks.sessionOutputs },
    downloadFiles: mocks.downloadFiles,
    fetchFileBlob: vi.fn(),
  };
});
vi.mock("../../lib/uploadToasts", () => ({ uploadFilesWithToasts: mocks.uploadFilesWithToasts }));

import { useApp } from "../../store/app";
import { useChanged } from "../../store/changed";
import { useComposer } from "../../store/composer";
import { useOutputs } from "../../store/outputs";
import { useSessions } from "../../store/sessions";
import { session } from "../../test/fixtures";
import { useToasts } from "../../store/toasts";
import { FilesTab } from "./FilesTab";

beforeEach(() => {
  vi.clearAllMocks();
  useChanged.getState().clear();
  useOutputs.setState({ bySession: {} });
  mocks.sessionOutputs.mockResolvedValue([]);
  useSessions.setState({ sessions: {}, views: {} });
  useToasts.setState({ toasts: [] });
  useApp.setState({ disk: null, me: { user: { name: "u" } } as never, meError: null, filesChangedOnly: false });
  mocks.filesTree.mockImplementation(async (path: string, depth: number) => (depth > 1 ? nested : (listings[path] ?? [])));
  mocks.filesDelete.mockResolvedValue(undefined);
  mocks.filesMkdir.mockResolvedValue(undefined);
  mocks.uploadFilesWithToasts.mockResolvedValue([]);
  mocks.filesContent.mockResolvedValue({ path: "readme.md", size: 5, truncated: false, text: "hello", mediaType: "text/markdown" });
});

const rowNames = () => screen.getAllByRole("treeitem").map((r) => r.getAttribute("data-path"));

describe("FilesTab", () => {
  it("lists the workspace root with folders first", async () => {
    render(<FilesTab sessionId="s1" />);
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(3));
    expect(rowNames()).toEqual(["docs", "inbox", "readme.md"]);
    expect(mocks.filesTree).toHaveBeenCalledWith("", 1);
    expect(mocks.filesTree).toHaveBeenCalledTimes(1); // lazy: nothing else was fetched
  });

  it("expands a folder lazily (one request on first expand, none on re-expand)", async () => {
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("docs");
    fireEvent.click(screen.getByText("docs"));
    await waitFor(() => expect(rowNames()).toContain("docs/a.md"));
    expect(mocks.filesTree).toHaveBeenCalledWith("docs", 1);
    fireEvent.click(screen.getByText("docs")); // collapse
    expect(rowNames()).not.toContain("docs/a.md");
    fireEvent.click(screen.getByText("docs")); // expand again from cache
    expect(rowNames()).toContain("docs/a.md");
    expect(mocks.filesTree.mock.calls.filter((c) => c[0] === "docs")).toHaveLength(1);
  });

  it("shows the file size in the delete confirmation and deletes on confirm", async () => {
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("readme.md");
    fireEvent.click(screen.getByLabelText("Delete readme.md"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/1\.50 KB/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.filesDelete).toHaveBeenCalledWith("readme.md"));
  });

  it("sums a folder's size (files + bytes) from a deep listing before allowing delete", async () => {
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("docs");
    fireEvent.click(screen.getByLabelText("Delete docs"));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/2 files · 1\.00 MB/)).toBeInTheDocument());
    expect(mocks.filesTree).toHaveBeenCalledWith("docs", 10);
    expect(mocks.filesDelete).not.toHaveBeenCalled(); // never without the explicit confirm click
  });

  it("filters to files changed in this session and marks them", async () => {
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("readme.md");
    act(() => useChanged.getState().record({ path: "docs/b.md", kind: "change", sessionId: "s1", at: "2026-10-31T00:00:00Z" }));
    act(() => useChanged.getState().record({ path: "readme.md", kind: "change", sessionId: "other", at: "2026-10-31T00:00:00Z" }));
    await waitFor(() => expect(screen.getAllByTestId("changed-dot").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("switch", { name: /changed this session/i }));
    await waitFor(() => expect(rowNames()).toEqual(["docs", "docs/b.md"]));
    expect(rowNames()).not.toContain("readme.md"); // changed by another session
  });

  it("disables upload and new folder when the disk is full but keeps download/delete", async () => {
    useApp.setState({ disk: { level: "block", usedPercent: 97, totalBytes: 1, freeBytes: 0, warnPercent: 80, blockPercent: 95, breakdown: [], projects: [] } });
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("readme.md");
    expect(screen.getByRole("button", { name: /^upload$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New folder" })).toBeDisabled();
    expect(screen.getByLabelText("Delete readme.md")).toBeEnabled();
    expect(screen.getByLabelText("Download readme.md")).toBeEnabled();
  });

  it("opens a text preview and falls back to a binary notice", async () => {
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("readme.md");
    fireEvent.click(screen.getByText("readme.md"));
    await waitFor(() => expect(screen.getByTestId("file-text")).toHaveTextContent("hello"));
    mocks.filesContent.mockResolvedValueOnce({ path: "docs/a.bin", size: 99, truncated: false, text: null, mediaType: "application/octet-stream" });
  });

  it("downloads selected files as a zip request", async () => {
    mocks.downloadFiles.mockResolvedValue(undefined);
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("readme.md");
    fireEvent.click(screen.getByLabelText("Select readme.md"));
    fireEvent.click(screen.getByLabelText("Select docs"));
    fireEvent.click(await screen.findByRole("button", { name: "Download 2 as zip" }));
    await waitFor(() => expect(mocks.downloadFiles).toHaveBeenCalledWith(["readme.md", "docs"]));
  });

  it("has no Context section (it lives on the Overview tab)", async () => {
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("readme.md");
    expect(screen.queryByTestId("context-panel")).toBeNull();
  });

  it("opens the file asked for by Overview → Outputs in its preview", async () => {
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("readme.md");
    mocks.filesContent.mockReset(); // drops a once-value an earlier test left queued
    mocks.filesContent.mockResolvedValue({ path: "docs/a.md", size: 5, truncated: false, text: "from outputs", mediaType: "text/markdown" });
    act(() => useApp.getState().openFile("docs/a.md"));
    expect(useApp.getState().rightTab).toBe("files");
    await waitFor(() => expect(mocks.filesContent).toHaveBeenCalledWith("docs/a.md"));
    await waitFor(() => expect(screen.getByTestId("file-text")).toHaveTextContent("from outputs"));
  });

  it("uploads chosen files into the default inbox/ folder", async () => {
    render(<FilesTab sessionId="s1" />);
    await screen.findByText("readme.md");
    const file = new File(["x"], "x.txt");
    fireEvent.change(screen.getByTestId("upload-input"), { target: { files: [file] } });
    await waitFor(() => expect(mocks.uploadFilesWithToasts).toHaveBeenCalledWith([file], { dir: "inbox" }));
  });
});

describe("FilesTab rooted at a Code session's cwd", () => {
  const S1 = "11111111-1111-4111-8111-111111111111";
  const S2 = "22222222-2222-4222-8222-222222222222";
  const proj: Record<string, FileEntry[]> = {
    "projects/hub": [e("projects/hub/src", "dir", 0), e("projects/hub/a.md", "file", 100)],
    "projects/hub/src": [e("projects/hub/src/x.ts", "file", 5)],
    "projects/other": [e("projects/other/z.md", "file", 1)],
    "": [e("projects", "dir", 0), e("inbox", "dir", 0), e("readme.md", "file", 1)],
  };
  const setSessions = (...list: Array<[string, Partial<Session>]>) =>
    useSessions.setState({ sessions: Object.fromEntries(list.map(([id, over]) => [id, session({ id, ...over })])), views: {}, listLoaded: true });

  beforeEach(() => {
    mocks.filesTree.mockImplementation(async (path: string, depth: number) => (depth > 1 ? [] : (proj[path] ?? [])));
  });

  it("roots the tree at the session cwd, shows the folder name and never requests outside it", async () => {
    setSessions([S1, { cwd: "projects/hub" }]);
    render(<FilesTab sessionId={S1} />);
    await screen.findByText("a.md");
    expect(screen.getByTestId("files-root")).toHaveTextContent("hub");
    expect(rowNames()).toEqual(["projects/hub/src", "projects/hub/a.md"]);
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => expect(rowNames()).toContain("projects/hub/src/x.ts"));
    for (const [path] of mocks.filesTree.mock.calls) expect((path as string) === "projects/hub" || (path as string).startsWith("projects/hub/")).toBe(true);
  });

  it("a new Code draft (no session yet) shows the folder it will start in; Chat drafts and empty folders show the root", async () => {
    useApp.setState({ mode: "code" });
    useComposer.setState({ newCwd: "projects/hub" });
    const first = render(<FilesTab sessionId={null} />);
    await screen.findByText("a.md");
    expect(screen.getByTestId("files-root")).toHaveTextContent("hub");
    first.unmount();
    useComposer.setState({ newCwd: "" });
    const second = render(<FilesTab sessionId={null} />);
    await screen.findByText("readme.md");
    second.unmount();
    useApp.setState({ mode: "chat" });
    useComposer.setState({ newCwd: "projects/hub" });
    render(<FilesTab sessionId={null} />);
    await screen.findByText("readme.md");
    useApp.setState({ mode: "code" });
    useComposer.setState({ newCwd: "" });
  });

  it("an empty cwd is the workspace root", async () => {
    setSessions([S1, { cwd: "" }]);
    render(<FilesTab sessionId={S1} />);
    await screen.findByText("readme.md");
    expect(rowNames()).toEqual(["inbox", "projects", "readme.md"]);
    expect(mocks.filesTree).toHaveBeenCalledWith("", 1);
  });

  it("uploads, new folder and delete act inside the root with workspace-relative paths", async () => {
    setSessions([S1, { cwd: "projects/hub" }]);
    render(<FilesTab sessionId={S1} />);
    await screen.findByText("a.md");
    const file = new File(["x"], "x.txt");
    fireEvent.change(screen.getByTestId("upload-input"), { target: { files: [file] } });
    await waitFor(() => expect(mocks.uploadFilesWithToasts).toHaveBeenCalledWith([file], { dir: "projects/hub" }));

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(await screen.findByPlaceholderText(/name/i), { target: { value: "newdir" } });
    fireEvent.submit(screen.getByPlaceholderText(/name/i).closest("form")!);
    await waitFor(() => expect(mocks.filesMkdir).toHaveBeenCalledWith("projects/hub/newdir"));

    fireEvent.click(screen.getByLabelText("Delete a.md"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.filesDelete).toHaveBeenCalledWith("projects/hub/a.md"));
  });

  it("'changed this session' only lists changes inside the root", async () => {
    setSessions([S1, { cwd: "projects/hub" }]);
    render(<FilesTab sessionId={S1} />);
    await screen.findByText("a.md");
    act(() => useChanged.getState().record({ path: "projects/hub/a.md", kind: "change", sessionId: S1, at: "2026-10-31T00:00:00Z" }));
    act(() => useChanged.getState().record({ path: "projects/other/z.md", kind: "change", sessionId: S1, at: "2026-10-31T00:00:00Z" }));
    fireEvent.click(screen.getByRole("switch", { name: /changed this session/i }));
    await waitFor(() => expect(rowNames()).toEqual(["projects/hub/a.md"]));
    expect(mocks.filesTree.mock.calls.some((c) => (c[0] as string).startsWith("projects/other"))).toBe(false);
  });

  it("'changed this session' also lists the outputs the hub recorded (after a reload), merged with live events", async () => {
    mocks.sessionOutputs.mockResolvedValue([
      { path: "projects/hub/a.md", tool: "Write", turn: 1, at: "2026-10-31T00:00:00Z", missing: false },
      { path: "projects/hub/src/x.ts", tool: "Edit", turn: 2, at: "2026-10-31T00:00:01Z", missing: false },
    ]);
    setSessions([S1, { cwd: "projects/hub" }]);
    render(<FilesTab sessionId={S1} />);
    await screen.findByText("a.md");
    await waitFor(() => expect(mocks.sessionOutputs).toHaveBeenCalledWith(S1));
    act(() => useChanged.getState().record({ path: "projects/hub/a.md", kind: "unlink", sessionId: S1, at: "2026-10-31T00:00:05Z" }));
    fireEvent.click(screen.getByRole("switch", { name: /changed this session/i }));
    await waitFor(() => expect(rowNames()).toEqual(["projects/hub/src", "projects/hub/src/x.ts"]));
  });

  it("re-roots when the session changes and remembers expanded folders per session", async () => {
    setSessions([S1, { cwd: "projects/hub" }], [S2, { cwd: "projects/other" }]);
    const { rerender } = render(<FilesTab sessionId={S1} />);
    await screen.findByText("a.md");
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => expect(rowNames()).toContain("projects/hub/src/x.ts"));

    rerender(<FilesTab sessionId={S2} />);
    await screen.findByText("z.md");
    expect(rowNames()).toEqual(["projects/other/z.md"]);
    expect(screen.getByTestId("files-root")).toHaveTextContent("other");

    rerender(<FilesTab sessionId={S1} />);
    await waitFor(() => expect(rowNames()).toContain("projects/hub/src/x.ts"));
  });

  it("keeps the whole workspace for chat sessions", async () => {
    setSessions([S1, { kind: "chat", cwd: ".chat" }]);
    render(<FilesTab sessionId={S1} />);
    await screen.findByText("readme.md");
    expect(rowNames()).toEqual(["inbox", "projects", "readme.md"]);
    expect(screen.queryByTestId("files-root")).toBeNull();
    expect(mocks.filesTree).toHaveBeenCalledWith("", 1);
  });
});
