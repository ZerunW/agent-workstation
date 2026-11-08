import { describe, expect, it } from "vitest";
import { clickCount, containRect, frameWidthFor, keyInput, mapPoint, normalizeUrl, textInputs, wheelPixels } from "./browser";

const key = (key: string, over: Partial<Parameters<typeof keyInput>[0]> = {}) => keyInput({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over });
const VIEWPORT = { width: 1280, height: 800 };

describe("containRect / mapPoint", () => {
  it("letterboxes a wide frame in a tall box and pillarboxes a tall one in a wide box", () => {
    expect(containRect({ left: 10, top: 20, width: 400, height: 300 }, { width: 640, height: 400 })).toEqual({ left: 10, top: 45, width: 400, height: 250 });
    expect(containRect({ left: 0, top: 0, width: 800, height: 400 }, { width: 640, height: 400 })).toEqual({ left: 80, top: 0, width: 640, height: 400 });
  });

  it("scales displayed pixels to viewport CSS pixels (frame smaller than the viewport)", () => {
    const box = { left: 0, top: 0, width: 640, height: 400 };
    expect(mapPoint(box, { width: 320, height: 200 }, VIEWPORT, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(mapPoint(box, { width: 320, height: 200 }, VIEWPORT, 320, 200)).toEqual({ x: 640, y: 400 });
    expect(mapPoint(box, { width: 320, height: 200 }, VIEWPORT, 640, 400)).toEqual({ x: 1280, y: 800 });
  });

  it("accounts for the box offset and the letterbox bars", () => {
    const box = { left: 10, top: 20, width: 400, height: 300 }; // image is 400x250 at top 45
    const frame = { width: 640, height: 400 };
    expect(mapPoint(box, frame, VIEWPORT, 210, 170)).toEqual({ x: 640, y: 400 });
    expect(mapPoint(box, frame, VIEWPORT, 10, 45)).toEqual({ x: 0, y: 0 });
    expect(mapPoint(box, frame, VIEWPORT, 410, 295)).toEqual({ x: 1280, y: 800 });
  });

  it("returns null in the bars, or clamps to the image edge on request", () => {
    const box = { left: 10, top: 20, width: 400, height: 300 };
    const frame = { width: 640, height: 400 };
    expect(mapPoint(box, frame, VIEWPORT, 100, 30)).toBeNull();
    expect(mapPoint(box, frame, VIEWPORT, 500, 100)).toBeNull();
    expect(mapPoint(box, frame, VIEWPORT, 500, 20, true)).toEqual({ x: 1280, y: 0 });
    expect(mapPoint(box, frame, VIEWPORT, -50, 999, true)).toEqual({ x: 0, y: 800 });
  });

  it("is null for an empty box", () => {
    expect(mapPoint({ left: 0, top: 0, width: 0, height: 0 }, { width: 10, height: 10 }, VIEWPORT, 0, 0)).toBeNull();
  });
});

describe("normalizeUrl", () => {
  it("adds https:// to bare hosts and keeps explicit schemes", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
    expect(normalizeUrl("  example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  });
  it("rejects empties, spaces and non-web schemes", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("two words")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("keyInput", () => {
  it("sends a press with the DOM key and modifiers", () => {
    expect(key("a")).toEqual({ kind: "key", action: "press", key: "a" });
    expect(key("Enter")).toEqual({ kind: "key", action: "press", key: "Enter" });
    expect(key("A", { shiftKey: true })).toEqual({ kind: "key", action: "press", key: "A", modifiers: ["Shift"] });
    expect(key("ArrowLeft", { ctrlKey: true, altKey: true })).toEqual({ kind: "key", action: "press", key: "ArrowLeft", modifiers: ["Alt", "Control"] });
  });
  it("keeps ⌘-shortcuts, bare modifiers, IME and Ctrl+V for the app", () => {
    expect(key("k", { metaKey: true })).toBeNull();
    expect(key("Shift", { shiftKey: true })).toBeNull();
    expect(key("a", { isComposing: true })).toBeNull();
    expect(key("Process", { keyCode: 229 })).toBeNull();
    expect(key("v", { ctrlKey: true })).toBeNull();
    expect(key("c", { ctrlKey: true })).not.toBeNull();
  });
});

describe("wheel / text / width", () => {
  it("maps the DOM click detail to clickCount (1..3)", () => {
    expect([0, 1, 2, 3, 5].map(clickCount)).toEqual([1, 1, 2, 3, 3]);
  });
  it("converts line and page deltas to pixels", () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 500)).toEqual({ deltaX: 0, deltaY: 120 });
    expect(wheelPixels({ deltaX: 1, deltaY: 3, deltaMode: 1 }, 500)).toEqual({ deltaX: 16, deltaY: 48 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 500)).toEqual({ deltaX: 0, deltaY: 500 });
  });
  it("splits long pastes into protocol-sized chunks", () => {
    expect(textInputs("hi")).toEqual([{ kind: "text", text: "hi" }]);
    const parts = textInputs("x".repeat(25_000));
    expect(parts.map((p) => (p.kind === "text" ? p.text.length : 0))).toEqual([10_000, 10_000, 5_000]);
    expect(textInputs("")).toEqual([]);
  });
  it("sizes frames from the panel width and pixel ratio", () => {
    expect(frameWidthFor(0, 2)).toBe(960);
    expect(frameWidthFor(500, 2)).toBe(1000);
    expect(frameWidthFor(500, 3)).toBe(1000);
    expect(frameWidthFor(100, 1)).toBe(320);
    expect(frameWidthFor(5000, 2)).toBe(1920);
  });
});
