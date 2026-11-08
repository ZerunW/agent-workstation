import "../usage/testMatchers";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// xterm and the socket are replaced by recorders: the test is about what TerminalView does when the hub re-attaches.
const h = vi.hoisted(() => ({
  term: { reset: vi.fn(), write: vi.fn(), clear: vi.fn(), open: vi.fn(), loadAddon: vi.fn(), dispose: vi.fn(), focus: vi.fn(), attachCustomKeyEventHandler: vi.fn(), onData: vi.fn(() => ({ dispose: vi.fn() })), onResize: vi.fn(() => ({ dispose: vi.fn() })), options: {} as Record<string, unknown>, cols: 80, rows: 24 },
  socketOpts: null as null | { onOutput: (d: string) => void; onAttach?: () => void },
  order: [] as string[],
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class { constructor() { return h.term; } } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("./terminalSocket", () => ({
  terminalWsUrl: () => "ws://x",
  TerminalSocket: class {
    constructor(opts: typeof h.socketOpts) {
      h.socketOpts = opts;
    }
    start() {}
    stop() {}
    sendInput() {}
    sendResize() {}
    retryNow() {}
  },
}));

import { TerminalView } from "./TerminalView";

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.term.reset.mockImplementation(() => h.order.push("reset"));
  h.term.write.mockImplementation((d: string) => h.order.push(`write:${d}`));
});

describe("TerminalView", () => {
  it("clears the xterm buffer on every (re)attach, before the replayed screen is written", () => {
    render(<TerminalView terminalId="t1" />);
    const opts = h.socketOpts!;
    expect(typeof opts.onAttach).toBe("function");

    // first attach, shell output, then the socket drops and re-attaches: the hub redraws the same tmux screen
    opts.onAttach!();
    opts.onOutput("screen");
    opts.onAttach!();
    opts.onOutput("screen");
    expect(h.order).toEqual(["reset", "write:screen", "reset", "write:screen"]);
    expect(h.term.clear).not.toHaveBeenCalled();
  });
});
