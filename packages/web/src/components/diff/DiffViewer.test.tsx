import { act, render } from "@testing-library/react";
import type { Hunk } from "@agent-workstation/protocol";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DiffViewer, type DiffViewerHandle } from "./DiffViewer";

// CodeMirror measures text through Range geometry that jsdom does not implement.
beforeAll(() => {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
  const list = Object.assign([] as unknown[], { item: () => null });
  (Range.prototype as any).getClientRects = () => list;
  (Range.prototype as any).getBoundingClientRect = () => rect;
  (Element.prototype as any).getClientRects ??= () => list;
});

const OLD = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n") + "\n";
const lines = OLD.trimEnd().split("\n");
lines[1] = "const v2 = 'two';";
lines.splice(20, 0, "const added = true;");
const NEW = lines.join("\n") + "\n";
const HUNKS: Hunk[] = [
  { index: 0, oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, header: "@@", lines: [" const v1 = 1;", "-const v2 = 2;", "+const v2 = 'two';", " const v3 = 3;", " const v4 = 4;", " const v5 = 5;"] },
  { index: 1, oldStart: 18, oldLines: 6, newStart: 18, newLines: 7, header: "@@", lines: [" const v18 = 18;", " const v19 = 19;", " const v20 = 20;", "+const added = true;", " const v21 = 21;", " const v22 = 22;", " const v23 = 23;"] },
];

describe("DiffViewer", () => {
  it("mounts a read-only unified merge view with one chunk per change and exposes chunk info", () => {
    const ref = createRef<DiffViewerHandle>();
    const { container } = render(<DiffViewer ref={ref} path="a.ts" oldText={OLD} newText={NEW} hunks={HUNKS} onAcceptChunk={() => {}} onRejectChunk={() => {}} />);
    expect(container.querySelector(".cm-editor")).toBeTruthy();
    expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
    const chunks = ref.current!.chunks();
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.hunkIndexes)).toEqual([[0], [1]]);
    expect(chunks[0]).toMatchObject({ oldStartLine: 2, oldEndLine: 2, newStartLine: 2, newEndLine: 2 });
    expect(chunks[1]).toMatchObject({ oldStartLine: 21, oldEndLine: 20, newStartLine: 21, newEndLine: 21 });
  });

  it("calls the callbacks (and never edits its document) when a chunk button is pressed", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const { container } = render(<DiffViewer path="a.ts" oldText={OLD} newText={NEW} hunks={HUNKS} onAcceptChunk={onAccept} onRejectChunk={onReject} />);
    const accept = container.querySelectorAll<HTMLButtonElement>("button[name=accept]");
    const reject = container.querySelectorAll<HTMLButtonElement>("button[name=reject]");
    expect(accept).toHaveLength(2);
    act(() => {
      accept[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      reject[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0]![0]).toMatchObject({ index: 1, hunkIndexes: [1] });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0]![0]).toMatchObject({ index: 0, hunkIndexes: [0] });
    expect(container.querySelector(".cm-content")?.textContent).toContain("const added = true;");
  });

  it("hides the buttons when readOnly or when no callbacks are given", () => {
    const a = render(<DiffViewer oldText={OLD} newText={NEW} readOnly onAcceptChunk={() => {}} />);
    expect(a.container.querySelectorAll("button[name=accept]")).toHaveLength(0);
    const b = render(<DiffViewer oldText={OLD} newText={NEW} />);
    expect(b.container.querySelectorAll("button[name=accept]")).toHaveLength(0);
  });

  it("updates in place when the texts change (chunks shrink after a change is accepted)", () => {
    const ref = createRef<DiffViewerHandle>();
    const { rerender, container } = render(<DiffViewer ref={ref} oldText={OLD} newText={NEW} onAcceptChunk={() => {}} />);
    const editor = container.querySelector(".cm-editor");
    expect(ref.current!.chunks()).toHaveLength(2);
    // host accepted the first hunk: local copy now has the first change
    const acceptedOld = OLD.replace("const v2 = 2;", "const v2 = 'two';");
    rerender(<DiffViewer ref={ref} oldText={acceptedOld} newText={NEW} onAcceptChunk={() => {}} />);
    expect(container.querySelector(".cm-editor")).toBe(editor); // same editor instance: no rebuild
    expect(ref.current!.chunks()).toHaveLength(1);
    rerender(<DiffViewer ref={ref} oldText={NEW} newText={NEW} onAcceptChunk={() => {}} />);
    expect(ref.current!.chunks()).toHaveLength(0);
  });

  it("renders the split layout with two editors and intercepts the revert gutter", () => {
    const onReject = vi.fn();
    const ref = createRef<DiffViewerHandle>();
    const { container } = render(<DiffViewer ref={ref} layout="split" oldText={OLD} newText={NEW} hunks={HUNKS} onAcceptChunk={() => {}} onRejectChunk={onReject} />);
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(2);
    expect(ref.current!.chunks()).toHaveLength(2);
    // revert buttons are positioned after layout measurement (rAF); in jsdom just assert the capture handler contract
    const holder = document.createElement("div");
    holder.dataset.chunk = "1";
    const btn = document.createElement("button");
    btn.dataset.action = "reject";
    holder.append(btn);
    container.querySelector(".cm-mergeView")!.append(holder);
    act(() => {
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ index: 1, hunkIndexes: [1] }));
  });
});
