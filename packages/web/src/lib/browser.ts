import type { BrowserInput } from "@agent-workstation/protocol";

export interface Size {
  width: number;
  height: number;
}
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where `content` is drawn inside `box` with `object-fit: contain` (centred, aspect kept: letterbox / pillarbox). */
export function containRect(box: Box, content: Size): Box {
  if (content.width <= 0 || content.height <= 0 || box.width <= 0 || box.height <= 0) return { left: box.left, top: box.top, width: box.width, height: box.height };
  const scale = Math.min(box.width / content.width, box.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/**
 * Pointer position in the page (client px) -> viewport CSS px of the remote browser. `frame` is the image that is
 * displayed (it sets the letterboxing), `viewport` the remote page size. Outside the image: null, or clamped to its edge.
 */
export function mapPoint(box: Box, frame: Size, viewport: Size, clientX: number, clientY: number, clamp = false): { x: number; y: number } | null {
  const r = containRect(box, frame);
  if (r.width <= 0 || r.height <= 0) return null;
  let u = (clientX - r.left) / r.width;
  let v = (clientY - r.top) / r.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    if (!clamp) return null;
    u = Math.min(1, Math.max(0, u));
    v = Math.min(1, Math.max(0, v));
  }
  return { x: Math.round(u * viewport.width * 10) / 10, y: Math.round(v * viewport.height * 10) / 10 };
}

/** Address-bar text -> a URL the hub accepts (https:// is assumed when there is no scheme); null when it is not one. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : /^(about|data|file|mailto|javascript):/i.test(s) ? "" : `https://${s}`;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

type Mod = "Alt" | "Control" | "Meta" | "Shift";
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "Fn", "OS"]);

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * A key press for the remote page, or null when the app should keep it: ⌘-shortcuts, a bare modifier, IME composition
 * (committed text arrives as `text`) and Ctrl+V (so the browser still fires `paste`).
 */
export function keyInput(e: KeyLike): BrowserInput | null {
  if (e.metaKey || e.isComposing || e.keyCode === 229 || e.key === "Process" || e.key === "Unidentified") return null;
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "v") return null;
  const modifiers: Mod[] = [];
  if (e.altKey) modifiers.push("Alt");
  if (e.ctrlKey) modifiers.push("Control");
  if (e.shiftKey) modifiers.push("Shift");
  return { kind: "key", action: "press", key: e.key, ...(modifiers.length ? { modifiers } : {}) };
}

const BUTTONS = ["left", "middle", "right"] as const;
export const mouseButton = (b: number): (typeof BUTTONS)[number] => BUTTONS[b] ?? "left";

/** DOM `detail` of a mouse event (1 single, 2 second press of a double, 3 triple) as the protocol's `clickCount`. */
export const clickCount = (detail: number): 1 | 2 | 3 => (detail >= 3 ? 3 : detail === 2 ? 2 : 1);

/** Wheel deltas in CSS px whatever the device reports (lines / pages are converted). */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }, pageHeight: number): { deltaX: number; deltaY: number } {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
  return { deltaX: Math.round(e.deltaX * k), deltaY: Math.round(e.deltaY * k) };
}

/** Text inputs are capped at 10000 chars by the protocol: split longer pastes. */
export function textInputs(text: string): BrowserInput[] {
  const out: BrowserInput[] = [];
  for (let i = 0; i < text.length; i += 10000) out.push({ kind: "text", text: text.slice(i, i + 10000) });
  return out;
}

/** Frames of the remote page are sized for the panel: CSS width x device pixel ratio (max 2), within sane bounds. */
export function frameWidthFor(cssWidth: number, dpr: number): number {
  if (!(cssWidth > 0)) return 960;
  return Math.max(320, Math.min(1920, Math.round(cssWidth * Math.min(2, Math.max(1, dpr || 1)))));
}
