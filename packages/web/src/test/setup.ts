import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";

expect.extend(matchers);
afterEach(() => cleanup());

// jsdom gaps used by the UI.
if (!("ResizeObserver" in globalThis)) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
    onchange: null,
  });
}
Element.prototype.scrollIntoView ??= function () {};

// CodeMirror measures text through Range geometry, which jsdom does not implement.
if (typeof Range !== "undefined") {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
  const list = Object.assign([] as unknown[], { item: () => null });
  const proto = Range.prototype as unknown as Record<string, unknown>;
  proto.getClientRects ??= () => list;
  proto.getBoundingClientRect ??= () => rect;
}

// jsdom's Blob lacks text()/arrayBuffer() (every browser has them).
if (typeof Blob !== "undefined") {
  const read = (b: Blob, as: "text" | "buffer") =>
    new Promise<string | ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string | ArrayBuffer);
      r.onerror = () => reject(r.error);
      if (as === "text") r.readAsText(b);
      else r.readAsArrayBuffer(b);
    });
  if (!Blob.prototype.text) Blob.prototype.text = function (this: Blob) { return read(this, "text") as Promise<string>; };
  if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function (this: Blob) { return read(this, "buffer") as Promise<ArrayBuffer>; };
}
