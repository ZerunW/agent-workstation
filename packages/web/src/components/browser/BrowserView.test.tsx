import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import type { BrowserState } from "@agent-workstation/protocol";

expect.extend(jestDomMatchers);

const mocks = vi.hoisted(() => ({ input: vi.fn() }));
vi.mock("../../store/hub", () => ({ sendBrowserInput: mocks.input, sendBrowserView: vi.fn() }));

import { useBrowser } from "../../store/browser";
import { BrowserView } from "./BrowserView";

const STATE: BrowserState = { running: true, url: "https://example.com/", title: "Example", controlledBy: "user", sessionId: null, viewers: 1, viewport: { width: 1280, height: 800 } };
const FRAME = { data: "AAAA", width: 640, height: 400, at: "2026-10-31T00:00:00.000Z" };

// requestAnimationFrame is driven by hand so "one draw per animation frame" is observable
let rafQueue: Array<FrameRequestCallback | null> = [];
const flushRaf = () => {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb?.(0);
};
const drawImage = vi.fn();
let images: Array<{ src: string; onload?: () => void }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  rafQueue = [];
  images = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafQueue.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue[id - 1] = null;
  });
  vi.stubGlobal(
    "Image",
    class {
      onload?: () => void;
      set src(v: string) {
        images.push({ src: v, onload: this.onload });
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  useBrowser.getState().reset();
  useBrowser.getState().setState(STATE);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mount, give the canvas a 400x300 box at (10, 20) and draw a 640x400 frame: the image then sits at (10..410, 45..295). */
function setup() {
  render(<BrowserView />);
  const canvas = screen.getByTestId("browser-canvas") as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320, x: 10, y: 20, toJSON: () => ({}) });
  act(() => useBrowser.getState().setFrame(FRAME));
  act(flushRaf);
  act(() => images.at(-1)?.onload?.());
  return { canvas, input: screen.getByTestId("browser-input") as HTMLTextAreaElement, wrap: screen.getByTestId("browser-view") };
}
const sent = () => mocks.input.mock.calls.map((c) => c[0]);

describe("BrowserView drawing", () => {
  it("draws the newest frame once per animation frame", () => {
    render(<BrowserView />);
    act(() => {
      useBrowser.getState().setFrame({ ...FRAME, data: "ONE" });
      useBrowser.getState().setFrame({ ...FRAME, data: "TWO" });
      useBrowser.getState().setFrame({ ...FRAME, data: "THREE" });
    });
    expect(images).toHaveLength(0); // nothing is decoded before the animation frame
    act(flushRaf);
    expect(images).toHaveLength(1);
    expect(images[0].src).toBe("data:image/jpeg;base64,THREE");
    act(() => images[0].onload?.());
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 640, 400);
    const canvas = screen.getByTestId("browser-canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(640);
    expect(canvas.dataset.frames).toBe("1");
  });

  it("drops a decoded frame that a newer one has overtaken", () => {
    render(<BrowserView />);
    act(() => useBrowser.getState().setFrame({ ...FRAME, data: "OLD" }));
    act(flushRaf);
    act(() => useBrowser.getState().setFrame({ ...FRAME, data: "NEW" }));
    act(() => images[0].onload?.());
    expect(drawImage).not.toHaveBeenCalled();
    act(flushRaf);
    act(() => images[1].onload?.());
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner until the first frame arrives", () => {
    render(<BrowserView />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    act(() => useBrowser.getState().setFrame(FRAME));
    expect(screen.queryByLabelText("Loading")).toBeNull();
  });
});

describe("BrowserView mouse", () => {
  it("maps down / up from the displayed image to viewport pixels, with clickCount from the DOM detail, and no click messages", () => {
    const { canvas } = setup();
    // centre of the image: (210, 170) -> (640, 400)
    fireEvent.mouseDown(canvas, { clientX: 210, clientY: 170, button: 0, detail: 1 });
    fireEvent.mouseUp(canvas, { clientX: 210, clientY: 170, button: 0, detail: 1 });
    fireEvent.click(canvas, { clientX: 210, clientY: 170, button: 0, detail: 1 });
    fireEvent.mouseDown(canvas, { clientX: 410, clientY: 295, button: 0, detail: 2 });
    fireEvent.mouseUp(canvas, { clientX: 410, clientY: 295, button: 0, detail: 2 });
    fireEvent.doubleClick(canvas, { clientX: 410, clientY: 295, button: 0, detail: 2 });
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 45, button: 0, detail: 3 });
    fireEvent.mouseUp(canvas, { clientX: 10, clientY: 45, button: 0, detail: 3 });
    expect(sent()).toEqual([
      { kind: "mouse", action: "down", x: 640, y: 400, button: "left", clickCount: 1 },
      { kind: "mouse", action: "up", x: 640, y: 400, button: "left", clickCount: 1 },
      { kind: "mouse", action: "down", x: 1280, y: 800, button: "left", clickCount: 2 },
      { kind: "mouse", action: "up", x: 1280, y: 800, button: "left", clickCount: 2 },
      { kind: "mouse", action: "down", x: 0, y: 0, button: "left", clickCount: 3 },
      { kind: "mouse", action: "up", x: 0, y: 0, button: "left", clickCount: 3 },
    ]);
  });

  it("ignores the letterbox bars and maps the right button", () => {
    const { canvas } = setup();
    fireEvent.mouseDown(canvas, { clientX: 210, clientY: 30, button: 0 });
    expect(sent()).toEqual([]);
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 45, button: 2 });
    expect(sent()).toEqual([{ kind: "mouse", action: "down", x: 0, y: 0, button: "right", clickCount: 1 }]);
    expect(fireEvent.contextMenu(canvas)).toBe(false); // the app's own menu stays closed
  });

  it("releases outside the canvas clamped to the image edge, and only after a press", () => {
    const { canvas } = setup();
    fireEvent.mouseUp(window, { clientX: 900, clientY: 100 });
    expect(sent()).toEqual([]);
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    mocks.input.mockClear();
    fireEvent.mouseUp(window, { clientX: 900, clientY: 100, button: 0 });
    expect(sent()).toEqual([{ kind: "mouse", action: "up", x: 1280, y: expect.closeTo(((100 - 45) / 250) * 800, 0), button: "left", clickCount: 1 }]);
  });

  it("throttles moves: first at once, the rest coalesced into the newest position", () => {
    vi.useFakeTimers();
    try {
      const { canvas } = setup();
      fireEvent.mouseMove(canvas, { clientX: 110, clientY: 70 });
      fireEvent.mouseMove(canvas, { clientX: 120, clientY: 70 });
      fireEvent.mouseMove(canvas, { clientX: 130, clientY: 70 });
      expect(sent()).toHaveLength(1);
      vi.advanceTimersByTime(60);
      expect(sent()).toHaveLength(2);
      expect(sent()[1]).toMatchObject({ kind: "mouse", action: "move", x: (120 / 400) * 1280 });
      vi.advanceTimersByTime(200);
      expect(sent()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BrowserView wheel", () => {
  it("sends coalesced wheel deltas once per animation frame and stops the panel from scrolling", () => {
    const { wrap } = setup();
    const e1 = createEvent.wheel(wrap, { clientX: 210, clientY: 170, deltaY: 100, deltaX: 5, cancelable: true });
    fireEvent(wrap, e1);
    fireEvent.wheel(wrap, { clientX: 210, clientY: 170, deltaY: 50 });
    expect(e1.defaultPrevented).toBe(true);
    expect(sent()).toEqual([]);
    act(flushRaf);
    expect(sent()).toEqual([{ kind: "wheel", x: 640, y: 400, deltaX: 5, deltaY: 150 }]);
  });

  it("leaves wheel events over the bars to the panel", () => {
    const { wrap } = setup();
    const e = createEvent.wheel(wrap, { clientX: 210, clientY: 25, deltaY: 100, cancelable: true });
    fireEvent(wrap, e);
    act(flushRaf);
    expect(e.defaultPrevented).toBe(false);
    expect(sent()).toEqual([]);
  });
});

describe("BrowserView keyboard and text", () => {
  it("shows the focus ring only while the view has focus", () => {
    const { input, wrap } = setup();
    expect(wrap).toHaveAttribute("data-capturing", "false");
    fireEvent.focus(input);
    expect(wrap).toHaveAttribute("data-capturing", "true");
    expect(wrap.className).toContain("ring-accent");
    fireEvent.blur(input);
    expect(wrap).toHaveAttribute("data-capturing", "false");
  });

  it("sends keys with modifiers and prevents the default of what it captures", () => {
    const { input } = setup();
    const a = createEvent.keyDown(input, { key: "a" });
    fireEvent(input, a);
    const tab = createEvent.keyDown(input, { key: "Tab", shiftKey: true });
    fireEvent(input, tab);
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(a.defaultPrevented).toBe(true);
    expect(tab.defaultPrevented).toBe(true);
    expect(sent()).toEqual([
      { kind: "key", action: "press", key: "a" },
      { kind: "key", action: "press", key: "Tab", modifiers: ["Shift"] },
      { kind: "key", action: "press", key: "c", modifiers: ["Control"] },
    ]);
  });

  it("keeps ⌘-shortcuts and bare modifiers for the app", () => {
    const { input } = setup();
    const k = createEvent.keyDown(input, { key: "k", metaKey: true });
    fireEvent(input, k);
    const shift = createEvent.keyDown(input, { key: "Shift", shiftKey: true });
    fireEvent(input, shift);
    expect(k.defaultPrevented).toBe(false);
    expect(shift.defaultPrevented).toBe(false);
    expect(sent()).toEqual([]);
  });

  it("sends pasted text as text input (not keys)", () => {
    const { input } = setup();
    const paste = createEvent.paste(input, { clipboardData: { getData: () => "hello\nworld" } });
    fireEvent(input, paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(sent()).toEqual([{ kind: "text", text: "hello\nworld" }]);
  });

  it("sends IME text once, on composition end, and ignores the keys typed during it", () => {
    const { input } = setup();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Process", keyCode: 229 });
    fireEvent.keyDown(input, { key: "n", isComposing: true });
    fireEvent.input(input, { target: { value: "ni" }, isComposing: true });
    expect(sent()).toEqual([]);
    fireEvent.compositionEnd(input, { data: "你" });
    fireEvent.input(input, { target: { value: "" } });
    expect(sent()).toEqual([{ kind: "text", text: "你" }]);
  });

  it("sends text typed through a soft keyboard (input without key events)", () => {
    const { input } = setup();
    fireEvent.input(input, { target: { value: "é" } });
    expect(sent()).toEqual([{ kind: "text", text: "é" }]);
    expect(input.value).toBe("");
  });
});
