import { describe, expect, it } from "vitest";
import { isAllowedNavigation, keyDefinition, mapInput, newInputState } from "../src/input.js";

const types = (cmds: { params: { type?: string } }[]) => cmds.map((c) => c.params.type);

describe("mouse", () => {
  it("raw down/up map to mousePressed/mouseReleased with the client's clickCount", () => {
    const st = newInputState();
    const down = mapInput({ kind: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 1 }, st);
    expect(types(down)).toEqual(["mouseMoved", "mousePressed"]); // pointer was elsewhere: move first (touch clients)
    expect(down[1]!.params).toMatchObject({ x: 10, y: 20, button: "left", buttons: 1, clickCount: 1 });
    const up = mapInput({ kind: "mouse", action: "up", x: 10, y: 20, button: "left", clickCount: 1 }, st);
    expect(types(up)).toEqual(["mouseReleased"]);
    expect(up[0]!.params).toMatchObject({ buttons: 0, clickCount: 1 });
    // the second press of a double click
    const down2 = mapInput({ kind: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 2 }, st);
    expect(down2.map((c) => c.params.clickCount)).toEqual([2]);
    expect(mapInput({ kind: "mouse", action: "up", x: 10, y: 20, clickCount: 2 }, st)[0]!.params.clickCount).toBe(2);
  });

  it("defaults clickCount to 1 and the button to left", () => {
    const st = newInputState();
    mapInput({ kind: "mouse", action: "move", x: 5, y: 5 }, st);
    const [press] = mapInput({ kind: "mouse", action: "down", x: 5, y: 5 }, st);
    expect(press!.params).toMatchObject({ type: "mousePressed", button: "left", clickCount: 1 });
  });

  it("moves while a button is held carry it (drag)", () => {
    const st = newInputState();
    mapInput({ kind: "mouse", action: "down", x: 0, y: 0, button: "right" }, st);
    const [move] = mapInput({ kind: "mouse", action: "move", x: 50, y: 60 }, st);
    expect(move!.params).toMatchObject({ type: "mouseMoved", button: "right", buttons: 2, x: 50, y: 60 });
  });

  it("compat click/dblclick synthesize press+release pairs", () => {
    const st = newInputState();
    const click = mapInput({ kind: "mouse", action: "click", x: 1, y: 2 }, st);
    expect(types(click)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(click.slice(1).map((c) => c.params.clickCount)).toEqual([1, 1]);
    const dbl = mapInput({ kind: "mouse", action: "dblclick", x: 1, y: 2 }, st);
    expect(types(dbl)).toEqual(["mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]);
    expect(dbl.map((c) => c.params.clickCount)).toEqual([1, 1, 2, 2]);
    expect(st.buttons).toBe(0);
  });

  it("wheel maps to mouseWheel with clamped deltas", () => {
    const [w] = mapInput({ kind: "wheel", x: 3, y: 4, deltaX: 0, deltaY: 1e9 }, newInputState());
    expect(w!.params).toMatchObject({ type: "mouseWheel", x: 3, y: 4, deltaX: 0, deltaY: 10_000 });
  });

  it("uses held modifier keys on mouse events (shift-click)", () => {
    const st = newInputState();
    mapInput({ kind: "key", action: "down", key: "Shift" }, st);
    const cmds = mapInput({ kind: "mouse", action: "down", x: 0, y: 0 }, st);
    expect(cmds[cmds.length - 1]!.params.modifiers).toBe(8);
    mapInput({ kind: "key", action: "up", key: "Shift" }, st);
    expect(st.modifiers).toBe(0);
  });
});

describe("keyboard", () => {
  it("printable keys send text with US-layout codes", () => {
    const [down, up] = mapInput({ kind: "key", action: "press", key: "a" }, newInputState());
    expect(down!.params).toMatchObject({ type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
    expect(up!.params).toMatchObject({ type: "keyUp", key: "a", code: "KeyA" });
    expect(keyDefinition("!")).toMatchObject({ code: "Digit1", keyCode: 49, text: "!" });
    expect(keyDefinition("?")).toMatchObject({ code: "Slash", keyCode: 191 });
    expect(keyDefinition(" ")).toMatchObject({ code: "Space", keyCode: 32, text: " " });
    expect(keyDefinition("é")).toMatchObject({ code: "", keyCode: 0, text: "é" });
  });

  it("Enter carries \\r, navigation keys are raw (no text)", () => {
    const [enter] = mapInput({ kind: "key", action: "down", key: "Enter" }, newInputState());
    expect(enter!.params).toMatchObject({ type: "keyDown", windowsVirtualKeyCode: 13, text: "\r" });
    const [left] = mapInput({ kind: "key", action: "down", key: "ArrowLeft" }, newInputState());
    expect(left!.params).toMatchObject({ type: "rawKeyDown", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
    expect(left!.params.text).toBeUndefined();
  });

  it("chords with Control produce no text; Shift alone keeps it", () => {
    const [ctrlA] = mapInput({ kind: "key", action: "down", key: "a", modifiers: ["Control"] }, newInputState());
    expect(ctrlA!.params).toMatchObject({ type: "rawKeyDown", modifiers: 2 });
    expect(ctrlA!.params.text).toBeUndefined();
    const [shiftA] = mapInput({ kind: "key", action: "down", key: "A", modifiers: ["Shift"] }, newInputState());
    expect(shiftA!.params).toMatchObject({ type: "keyDown", modifiers: 8, text: "A" });
  });

  it("Meta+letter becomes Control+letter for the Linux browser (configurable)", () => {
    const [mapped] = mapInput({ kind: "key", action: "press", key: "a", modifiers: ["Meta"] }, newInputState(), { metaAsControl: true });
    expect(mapped!.params.modifiers).toBe(2);
    const [kept] = mapInput({ kind: "key", action: "press", key: "a", modifiers: ["Meta"] }, newInputState(), { metaAsControl: false });
    expect(kept!.params.modifiers).toBe(4);
  });

  it("text → Input.insertText; navigation/history produce no Input commands", () => {
    expect(mapInput({ kind: "text", text: "你好" }, newInputState())).toEqual([{ method: "Input.insertText", params: { text: "你好" } }]);
    expect(mapInput({ kind: "navigate", url: "https://example.com" }, newInputState())).toEqual([]);
    expect(mapInput({ kind: "history", action: "back" }, newInputState())).toEqual([]);
  });
});

describe("isAllowedNavigation", () => {
  it("allows only http(s) and about:blank", () => {
    expect(isAllowedNavigation("https://example.com/a")).toBe(true);
    expect(isAllowedNavigation("http://127.0.0.1:3000/")).toBe(true);
    expect(isAllowedNavigation("about:blank")).toBe(true);
    for (const u of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,x", "not a url"]) expect(isAllowedNavigation(u)).toBe(false);
  });
});
