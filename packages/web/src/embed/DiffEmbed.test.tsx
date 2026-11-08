import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiBase, setApiUser } from "../lib/api";
import { useToasts } from "../store/toasts";
import { DiffEmbed, diffMode, type DiffEmbedHandle } from "./DiffEmbed";

beforeAll(() => {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
  const list = Object.assign([] as unknown[], { item: () => null });
  (Range.prototype as any).getClientRects = () => list;
  (Range.prototype as any).getBoundingClientRect = () => rect;
});

const PID = "11111111-1111-4111-8111-111111111111";
const OLD = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const NEW = OLD.replace("line 3\n", "line three\n").replace("line 18\n", "line 18\nextra\n");
const HUNKS = [
  { index: 0, oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, header: "@@ -1,6 +1,6 @@", lines: [" line 1", " line 2", "-line 3", "+line three", " line 4", " line 5", " line 6"] },
  { index: 1, oldStart: 15, oldLines: 6, newStart: 15, newLines: 7, header: "@@ -15,6 +15,7 @@", lines: [" line 15", " line 16", " line 17", " line 18", "+extra", " line 19", " line 20"] },
];
const diff = (over: Record<string, unknown> = {}) => ({ path: "src/a.ts", localCommit: "abc", diffId: "d1", binary: false, oldText: OLD, newText: NEW, hunks: HUNKS, ...over });

interface Call {
  method: string;
  url: string;
  body?: any;
}
let calls: Call[];
let responses: Array<() => Response>;

function jsonRes(body: unknown, status = 200) {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  responses = [];
  setApiUser("alice");
  setApiBase("");
  useToasts.setState({ toasts: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch ${url}`);
      return next();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("DiffEmbed", () => {
  it("loads the diff, shows stats and posts open_file when the path is clicked", async () => {
    responses.push(jsonRes(diff()));
    const post = vi.fn();
    render(<DiffEmbed projectId={PID} path="src/a.ts" post={post} />);
    expect(await screen.findByTestId("diff-viewer")).toBeTruthy();
    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[0]!.url).toBe(`/api/projects/${PID}/review/diff?path=src%2Fa.ts`);
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(post).toHaveBeenCalledWith({ type: "open_file", path: "src/a.ts", projectId: PID });
  });

  it("per-chunk accept posts the hunk indexes then refetches the diff", async () => {
    responses.push(jsonRes(diff()), jsonRes({ localCommit: "c2", files: [] }), jsonRes(diff({ hunks: [{ ...HUNKS[1], index: 0 }], oldText: OLD.replace("line 3\n", "line three\n") })));
    const { container } = render(<DiffEmbed projectId={PID} path="src/a.ts" post={() => {}} />);
    await screen.findByTestId("diff-viewer");
    const accept = container.querySelectorAll<HTMLButtonElement>("button[name=accept]");
    expect(accept).toHaveLength(2);
    act(() => {
      accept[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[1]).toMatchObject({ method: "POST", url: `/api/projects/${PID}/review/accept`, body: { path: "src/a.ts", hunks: [1], diffId: "d1" } });
    expect(calls[2]!.method).toBe("GET");
    await waitFor(() => expect(container.querySelectorAll("button[name=accept]")).toHaveLength(1));
  });

  it("exposes the host-driven handle (acceptHunks / rejectFile / reload)", async () => {
    responses.push(jsonRes(diff()), jsonRes({ localCommit: "c2", files: [] }), jsonRes(diff()), jsonRes({}), jsonRes(diff({ oldText: NEW, hunks: [] })), jsonRes(diff()));
    const ref = createRef<DiffEmbedHandle>();
    render(<DiffEmbed ref={ref} projectId={PID} path="src/a.ts" post={() => {}} />);
    await screen.findByTestId("diff-viewer");
    await act(async () => ref.current!.acceptHunks([0, 1]));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls[1]!.body).toEqual({ path: "src/a.ts", hunks: [0, 1], diffId: "d1" });
    await waitFor(() => expect(calls).toHaveLength(3));
    await act(async () => ref.current!.rejectFile());
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(calls[3]).toMatchObject({ url: `/api/projects/${PID}/review/reject`, body: { path: "src/a.ts" } });
    // now identical => "no changes" state
    expect(await screen.findByText("No changes to review")).toBeTruthy();
    await act(async () => ref.current!.reload());
    await waitFor(() => expect(calls).toHaveLength(6));
  });

  it("shows binary and error states, and toasts a failed accept", async () => {
    responses.push(jsonRes(diff({ binary: true, oldText: null, newText: null, hunks: [] })));
    const { unmount } = render(<DiffEmbed projectId={PID} path="logo.png" post={() => {}} />);
    expect(await screen.findByText(/binary file: accept or reject the whole file/i)).toBeTruthy();
    unmount();

    responses.push(jsonRes({ error: "nope", code: "not_found" }, 404));
    const second = render(<DiffEmbed projectId={PID} path="x.ts" post={() => {}} />);
    expect(await screen.findByText("Couldn't load the diff")).toBeTruthy();
    expect(screen.getByText("nope")).toBeTruthy();
    second.unmount();

    responses.push(jsonRes(diff()), jsonRes({ error: "conflict", code: "conflict" }, 409));
    render(<DiffEmbed projectId={PID} path="src/a.ts" post={() => {}} />);
    await screen.findByTestId("diff-viewer");
    fireEvent.click(screen.getByRole("button", { name: /accept file/i }));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.tone === "error" && t.title.includes("conflict"))).toBe(true));
  });

  it("409 stale_diff on a hunk action refetches the diff, toasts and notifies the host", async () => {
    const fresh = diff({ diffId: "d2", hunks: [{ ...HUNKS[1], index: 0 }], oldText: OLD.replace("line 3\n", "line three\n") });
    responses.push(jsonRes(diff()), jsonRes({ error: "file changed", code: "stale_diff" }, 409), jsonRes(fresh));
    const onStale = vi.fn();
    const onChanged = vi.fn();
    const { container } = render(<DiffEmbed projectId={PID} path="src/a.ts" onStale={onStale} onChanged={onChanged} />);
    await screen.findByTestId("diff-viewer");
    act(() => {
      container.querySelectorAll<HTMLButtonElement>("button[name=accept]")[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[1]).toMatchObject({ method: "POST", body: { path: "src/a.ts", hunks: [0], diffId: "d1" } });
    expect(calls[2]!.method).toBe("GET");
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.some((t) => t.title.includes("changed on the server"))).toBe(true);
    // the refetched diff (one hunk left) replaced the stale one
    await waitFor(() => expect(container.querySelectorAll("button[name=accept]")).toHaveLength(1));
  });

  it("reports successful actions through onChanged and treats a 404 refetch as 'no changes'", async () => {
    responses.push(jsonRes(diff()), jsonRes({ localCommit: "c2", files: [] }), jsonRes({ error: "gone", code: "not_found" }, 404));
    const onChanged = vi.fn();
    render(<DiffEmbed projectId={PID} path="src/a.ts" onChanged={onChanged} />);
    await screen.findByTestId("diff-viewer");
    fireEvent.click(screen.getByRole("button", { name: /accept file/i }));
    expect(await screen.findByText("No changes to review")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith({ kind: "accept", path: "src/a.ts", hunks: undefined });
    // without a host `post` the path is plain text
    expect(screen.queryByRole("button", { name: "src/a.ts" })).toBeNull();
  });

  it("lists raw hunks when the hub omits both texts (file too large) and acts on a hunk", async () => {
    responses.push(jsonRes(diff({ oldText: null, newText: null })), jsonRes({ localCommit: "c2", files: [] }), jsonRes(diff({ oldText: null, newText: null, hunks: [HUNKS[1]] })));
    render(<DiffEmbed projectId={PID} path="src/a.ts" />);
    expect(await screen.findByTestId("hunk-list")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /^accept$/i })[1]!);
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[1]).toMatchObject({ body: { path: "src/a.ts", hunks: [1], diffId: "d1" } });
  });
});

describe("diffMode", () => {
  const base = { path: "a", localCommit: null, diffId: "x", binary: false, oldText: "a\n", newText: "b\n", hunks: [] };
  it("classifies diffs by which texts the hub sent", () => {
    expect(diffMode({ ...base, binary: true, oldText: null, newText: null })).toEqual({ kind: "binary" });
    expect(diffMode({ ...base, oldText: "same", newText: "same" })).toEqual({ kind: "empty" });
    expect(diffMode({ ...base })).toEqual({ kind: "text", oldText: "a\n", newText: "b\n" });
    // added / deleted files: the missing side is empty
    expect(diffMode({ ...base, oldText: null })).toEqual({ kind: "text", oldText: "", newText: "b\n" });
    expect(diffMode({ ...base, newText: null })).toEqual({ kind: "text", oldText: "a\n", newText: "" });
    // too large: hunks only
    expect(diffMode({ ...base, oldText: null, newText: null, hunks: [HUNKS[0]!] })).toEqual({ kind: "hunks" });
    expect(diffMode({ ...base, oldText: null, newText: null })).toEqual({ kind: "empty" });
  });
});
