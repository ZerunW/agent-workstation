/**
 * Person input from the live view (protocol `BrowserInput`) → CDP `Input.*` commands. Pure functions; the instance
 * sends the commands to the active tab's session. Navigation and history are handled by the instance.
 */
import type { BrowserInput } from "@agent-workstation/protocol";

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

type Button = "left" | "middle" | "right";
const BUTTON_BIT: Record<Button, number> = { left: 1, right: 2, middle: 4 };
const MOD_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
type Modifier = keyof typeof MOD_BIT;

/** Per-tab input state carried between events (held buttons and modifier keys, last pointer position). */
export interface InputState {
  buttons: number;
  modifiers: number;
  x: number | null;
  y: number | null;
}

export const newInputState = (): InputState => ({ buttons: 0, modifiers: 0, x: null, y: null });

export interface MapOptions {
  /**
   * Treat Meta+<letter> as Control+<letter> (Cmd+A/C/V/X/Z from a Mac viewer do the Linux browser's editing
   * shortcuts). Default: true unless the browser runs on macOS.
   */
  metaAsControl?: boolean;
}

const finite = (v: number, lim = 100_000): number => (Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);

// ---------------------------------------------------------------------------
// Keyboard (US layout)
// ---------------------------------------------------------------------------

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
}

const SPECIAL: Record<string, [code: string, keyCode: number, text?: string, location?: number]> = {
  Enter: ["Enter", 13, "\r"],
  Tab: ["Tab", 9],
  Backspace: ["Backspace", 8],
  Escape: ["Escape", 27],
  Delete: ["Delete", 46],
  Insert: ["Insert", 45],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowUp: ["ArrowUp", 38],
  ArrowRight: ["ArrowRight", 39],
  ArrowDown: ["ArrowDown", 40],
  Home: ["Home", 36],
  End: ["End", 35],
  PageUp: ["PageUp", 33],
  PageDown: ["PageDown", 34],
  Shift: ["ShiftLeft", 16, undefined, 1],
  Control: ["ControlLeft", 17, undefined, 1],
  Alt: ["AltLeft", 18, undefined, 1],
  Meta: ["MetaLeft", 91, undefined, 1],
  CapsLock: ["CapsLock", 20],
  ContextMenu: ["ContextMenu", 93],
  " ": ["Space", 32, " "],
};
for (let i = 1; i <= 12; i++) SPECIAL[`F${i}`] = [`F${i}`, 111 + i];

const PUNCT: Record<string, [code: string, keyCode: number]> = {
  ";": ["Semicolon", 186], ":": ["Semicolon", 186],
  "=": ["Equal", 187], "+": ["Equal", 187],
  ",": ["Comma", 188], "<": ["Comma", 188],
  "-": ["Minus", 189], _: ["Minus", 189],
  ".": ["Period", 190], ">": ["Period", 190],
  "/": ["Slash", 191], "?": ["Slash", 191],
  "`": ["Backquote", 192], "~": ["Backquote", 192],
  "[": ["BracketLeft", 219], "{": ["BracketLeft", 219],
  "\\": ["Backslash", 220], "|": ["Backslash", 220],
  "]": ["BracketRight", 221], "}": ["BracketRight", 221],
  "'": ["Quote", 222], '"': ["Quote", 222],
};
const SHIFTED_DIGITS = ")!@#$%^&*(";

export function keyDefinition(key: string): KeyDef {
  const special = SPECIAL[key];
  if (special) {
    const [code, keyCode, text, location] = special;
    return { key, code, keyCode, ...(text !== undefined ? { text } : {}), ...(location !== undefined ? { location } : {}) };
  }
  if ([...key].length === 1) {
    if (/^[a-zA-Z]$/.test(key)) return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
    if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, keyCode: 48 + Number(key), text: key };
    const d = SHIFTED_DIGITS.indexOf(key);
    if (d >= 0) return { key, code: `Digit${d}`, keyCode: 48 + d, text: key };
    const p = PUNCT[key];
    if (p) return { key, code: p[0], keyCode: p[1], text: key };
    return { key, code: "", keyCode: 0, text: key }; // non-ASCII character: text only
  }
  return { key, code: "", keyCode: 0 }; // "Unidentified", "Dead", media keys…: forwarded without text
}

const modifierMask = (mods: readonly Modifier[] | undefined): number => (mods ?? []).reduce((m, k) => m | (MOD_BIT[k] ?? 0), 0);

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

type MouseInput = Extract<BrowserInput, { kind: "mouse" }>;
type KeyInput = Extract<BrowserInput, { kind: "key" }>;

function mouse(input: MouseInput, st: InputState): CdpCommand[] {
  const x = finite(input.x);
  const y = finite(input.y);
  const button: Button = input.button ?? "left";
  const out: CdpCommand[] = [];
  const ev = (type: string, extra: Record<string, unknown> = {}): CdpCommand => ({ method: "Input.dispatchMouseEvent", params: { type, x, y, modifiers: st.modifiers, ...extra } });
  const heldButton = (): Button | "none" => (st.buttons & 1 ? "left" : st.buttons & 2 ? "right" : st.buttons & 4 ? "middle" : "none");
  const moveFirst = (): void => {
    if (st.x !== x || st.y !== y) out.push(ev("mouseMoved", { button: heldButton(), buttons: st.buttons }));
  };
  const press = (clickCount: number): void => {
    st.buttons |= BUTTON_BIT[button];
    out.push(ev("mousePressed", { button, buttons: st.buttons, clickCount }));
  };
  const release = (clickCount: number): void => {
    st.buttons &= ~BUTTON_BIT[button];
    out.push(ev("mouseReleased", { button, buttons: st.buttons, clickCount }));
  };
  switch (input.action) {
    case "move":
      out.push(ev("mouseMoved", { button: heldButton(), buttons: st.buttons }));
      break;
    case "down":
      moveFirst();
      press(input.clickCount ?? 1);
      break;
    case "up":
      moveFirst();
      release(input.clickCount ?? 1);
      break;
    case "click": // compatibility: the web client sends raw down/up
      moveFirst();
      press(1);
      release(1);
      break;
    case "dblclick":
      moveFirst();
      press(1);
      release(1);
      press(2);
      release(2);
      break;
  }
  st.x = x;
  st.y = y;
  return out;
}

function key(input: KeyInput, st: InputState, opts: MapOptions): CdpCommand[] {
  const def = keyDefinition(input.key);
  const isModifierKey = input.key in MOD_BIT;
  // modifiers: explicit list on the event wins; otherwise what the held modifier keys say
  let mods = input.modifiers ? modifierMask(input.modifiers) : st.modifiers;
  const metaAsControl = opts.metaAsControl ?? process.platform !== "darwin";
  if (metaAsControl && !isModifierKey && mods & MOD_BIT.Meta && !(mods & MOD_BIT.Control) && /^[a-zA-Z]$/.test(input.key)) mods = (mods & ~MOD_BIT.Meta) | MOD_BIT.Control;
  // like a real keyboard: Ctrl/Alt/Meta chords produce no text (Shift alone does)
  const text = mods & (MOD_BIT.Alt | MOD_BIT.Control | MOD_BIT.Meta) ? undefined : def.text;
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    ...(def.location !== undefined ? { location: def.location } : {}),
  };
  const down = (): CdpCommand => {
    if (isModifierKey) st.modifiers |= MOD_BIT[input.key as Modifier];
    const m = isModifierKey ? mods | MOD_BIT[input.key as Modifier] : mods;
    return { method: "Input.dispatchKeyEvent", params: { type: text ? "keyDown" : "rawKeyDown", modifiers: m, ...base, ...(text ? { text, unmodifiedText: text } : {}) } };
  };
  const up = (): CdpCommand => {
    if (isModifierKey) st.modifiers &= ~MOD_BIT[input.key as Modifier];
    const m = isModifierKey ? mods & ~MOD_BIT[input.key as Modifier] : mods;
    return { method: "Input.dispatchKeyEvent", params: { type: "keyUp", modifiers: m, ...base } };
  };
  if (input.action === "down") return [down()];
  if (input.action === "up") return [up()];
  return [down(), up()];
}

/** CDP commands for mouse, wheel, key and text input (navigate/history return []). Mutates `st`. */
export function mapInput(input: BrowserInput, st: InputState, opts: MapOptions = {}): CdpCommand[] {
  switch (input.kind) {
    case "mouse":
      return mouse(input, st);
    case "wheel": {
      const x = finite(input.x);
      const y = finite(input.y);
      st.x = x;
      st.y = y;
      return [{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x, y, deltaX: finite(input.deltaX, 10_000), deltaY: finite(input.deltaY, 10_000), modifiers: st.modifiers } }];
    }
    case "key":
      return key(input, st, opts);
    case "text":
      return input.text ? [{ method: "Input.insertText", params: { text: input.text } }] : [];
    default:
      return [];
  }
}

/** Live-view navigation is limited to the web: http(s) and about:blank. */
export function isAllowedNavigation(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
