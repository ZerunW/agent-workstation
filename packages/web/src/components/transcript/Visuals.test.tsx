import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, type SessionView } from "../../lib/session-reducer";
import { useComposer } from "../../store/composer";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (code: string) => {
    if (/BAD/.test(code)) throw new Error("Parse error on line 2:\nA --> BAD\n----^\nExpecting 'SEMI', got 'EOF'");
    return { diagramType: "flowchart" };
  }),
  render: vi.fn(async (id: string, code: string) => ({ svg: `<svg id="${id}" viewBox="0 0 10 10"><text>${code.split("\n")[0]}</text></svg>` })),
}));
vi.mock("mermaid", () => ({ default: mermaidMock }));
vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<typeof import("../../lib/api")>()), saveBlob }));
const clipboard = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../lib/clipboard", () => ({ copyText: clipboard }));

import { Markdown } from "./Markdown";
import { StreamingTail } from "./Items";
import { Transcript } from "./Transcript";
import { HtmlFrame, VisualFigure } from "./Visuals";

beforeEach(() => {
  vi.clearAllMocks();
  useComposer.setState({ drafts: {} });
  document.documentElement.removeAttribute("data-theme");
});

const FLOW = "flowchart TD\n  A --> B";
const md = (code: string, lang = "mermaid") => "Before\n\n```" + lang + "\n" + code + "\n```\n\nAfter";

describe("mermaid fenced blocks", () => {
  it("renders a diagram (lazy mermaid, strict, theme from the app tokens) and keeps the prose around it", async () => {
    render(<Markdown text={md(FLOW)} />);
    const block = screen.getByTestId("mermaid-block");
    expect(block).toHaveAttribute("data-state", "loading");
    expect(within(block).getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(block).toHaveAttribute("data-state", "ok"));
    expect(screen.getByTestId("mermaid-diagram").querySelector("svg")).not.toBeNull();
    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false, theme: "base", htmlLabels: false }));
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.stringMatching(/^workstation-mmd-/), FLOW);
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("toggles between diagram and source; copy copies the source", async () => {
    render(<Markdown text={md(FLOW)} />);
    await waitFor(() => expect(screen.getByTestId("mermaid-block")).toHaveAttribute("data-state", "ok"));
    const block = screen.getByTestId("mermaid-block");
    expect(block).toHaveAttribute("data-view", "diagram");
    await userEvent.click(screen.getByTestId("mermaid-toggle"));
    expect(block).toHaveAttribute("data-view", "source");
    expect(screen.queryByTestId("mermaid-diagram")).not.toBeInTheDocument();
    expect(block.querySelector("code")?.textContent).toBe(FLOW);
    await userEvent.click(screen.getByTestId("mermaid-toggle"));
    expect(screen.getByTestId("mermaid-diagram")).toBeInTheDocument();
    await userEvent.click(within(block).getByRole("button", { name: "Copy code" }));
    expect(clipboard).toHaveBeenCalledWith(FLOW);
  });

  it("falls back to the code block with a one-line error on a parse error", async () => {
    render(<Markdown text={md("flowchart TD\n A --> BAD")} />);
    const block = screen.getByTestId("mermaid-block");
    await waitFor(() => expect(block).toHaveAttribute("data-state", "error"));
    expect(screen.getByTestId("mermaid-error").textContent).toBe("Parse error on line 2: Expecting 'SEMI', got 'EOF'");
    expect(block).toHaveAttribute("data-view", "source");
    expect(block.querySelector("code")?.textContent).toBe("flowchart TD\n A --> BAD");
    expect(screen.queryByTestId("mermaid-toggle")).not.toBeInTheDocument();
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("other languages stay plain code blocks and never load mermaid", async () => {
    render(<Markdown text={md("graph TD", "text")} />);
    expect(screen.queryByTestId("mermaid-block")).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(mermaidMock.parse).not.toHaveBeenCalled();
  });

  it("re-renders when the source changes (streaming) after it settles", async () => {
    const { rerender } = render(<Markdown text={md("flowchart TD\n A --> B")} />);
    await waitFor(() => expect(screen.getByTestId("mermaid-block")).toHaveAttribute("data-state", "ok"));
    rerender(<Markdown text={md("flowchart TD\n A --> B\n B --> C")} />);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
  });
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="var(--accent-soft)"/><text x="5" y="20">Hello</text><script>alert(1)</script><rect width="1" height="1" onload="alert(2)"/><foreignObject><div>x</div></foreignObject><a href="javascript:alert(3)"><text>j</text></a></svg>';

describe("show_visual figure", () => {
  it("renders a sanitised inline SVG bare: no border, background, padding or title chip", () => {
    render(<VisualFigure title="Request flow" svg={SVG} />);
    const fig = screen.getByTestId("visual-figure");
    expect(fig).toHaveAttribute("data-kind", "svg");
    // the title is the accessible label only
    expect(fig).toHaveAccessibleName("Request flow");
    expect(fig.querySelector("figcaption")).toBeNull();
    expect(screen.queryByTestId("visual-title")).toBeNull();
    expect(fig).not.toHaveTextContent("Request flow");
    for (const el of [fig, screen.getByTestId("visual-body"), screen.getByTestId("visual-body").firstElementChild!]) {
      expect(el.className).not.toMatch(/\bborder\b|\bbg-|\bp-\d|\brounded/);
    }
    const svg = screen.getByTestId("visual-body").querySelector("svg")!;
    expect(svg).not.toBeNull();
    expect(svg.querySelector("text")?.textContent).toBe("Hello");
    expect(svg.innerHTML).toContain("var(--accent-soft)");
    for (const bad of ["script", "onload", "foreignObject", "javascript:"]) expect(fig.innerHTML, bad).not.toContain(bad);
    expect(fig.querySelector("iframe")).toBeNull();
  });

  it("the menu button sits top-right and shows on hover / focus only", () => {
    render(<VisualFigure title="T" svg={SVG} />);
    const btn = screen.getByRole("button", { name: "More" });
    const cls = btn.className.split(/\s+/);
    for (const c of ["absolute", "right-1", "top-1", "opacity-0", "group-hover/viz:opacity-100", "group-focus-within/viz:opacity-100", "focus-visible:opacity-100", "data-[state=open]:opacity-100"]) expect(cls, c).toContain(c);
    expect(screen.getByTestId("visual-figure").className).toContain("group/viz");
    // reachable by keyboard
    btn.focus();
    expect(btn).toHaveFocus();
  });

  it("menu offers Download SVG / Download PNG / Open larger / Copy source", async () => {
    render(<VisualFigure title="T" svg={SVG} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Download SVG" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download PNG" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open larger" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy source" }));
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect((clipboard.mock.calls[0] as unknown[])[0]).toContain("<svg");
  });

  it("Download SVG saves standalone, sanitised markup named after the title", async () => {
    render(<VisualFigure title="Request Flow" svg={SVG} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Download SVG" }));
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0] as unknown as [Blob, string];
    expect(name).toBe("request-flow.svg");
    expect(blob.type).toContain("image/svg+xml");
    const text = await blob.text();
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(text).toContain('width="100"');
    expect(text).not.toContain("var(--");
    expect(text).not.toContain("script");
  });

  it("Download PNG rasterises the SVG on a canvas", async () => {
    const draw = vi.fn();
    const fillRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw, fillRect, fillStyle: "" } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb) {
      cb(new Blob(["png"], { type: "image/png" }));
    });
    const Orig = globalThis.Image;
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    (globalThis as unknown as { Image: unknown }).Image = FakeImage;
    try {
      render(<VisualFigure title="Plot" svg={SVG} />);
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Download PNG" }));
      await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
      expect((saveBlob.mock.calls[0] as unknown[])[1]).toBe("plot.png");
      expect(draw).toHaveBeenCalled();
      expect(fillRect).toHaveBeenCalledWith(0, 0, 200, 100); // 2x of the 100x50 viewBox
    } finally {
      globalThis.Image = Orig;
      vi.restoreAllMocks();
    }
  });

  it("Open larger shows the visual in a dialog", async () => {
    render(<VisualFigure title="Big" svg={SVG} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open larger" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("heading", { name: "Big" })).toBeInTheDocument();
    expect(dlg.querySelector("svg text")?.textContent).toBe("Hello");
    await userEvent.click(within(dlg).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("an HTML visual is a sandboxed iframe: scripts only, a CSP in the document", () => {
    document.documentElement.style.setProperty("--fg", "#abcdef");
    render(<VisualFigure title="Cards" html={'<div class="c" onclick="x()">Hi</div><script>1</script>'} />);
    const frame = screen.getByTestId("visual-frame") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const sb = frame.getAttribute("sandbox") ?? "";
    for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"]) expect(sb).not.toContain(flag);
    const doc = frame.getAttribute("srcdoc") ?? "";
    const o = window.location.origin;
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${o}/api/visual-cdn/; style-src 'unsafe-inline' ${o}/api/visual-cdn/; img-src data: blob:; font-src data: ${o}/api/visual-cdn/; connect-src 'none'; form-action 'none'">`);
    expect(doc).toContain("--fg:#abcdef");
    expect(doc).toContain("window.sendPrompt");
    expect(doc).toContain("ResizeObserver");
    expect(doc).toContain("Hi");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByTestId("visual-figure")).toHaveAttribute("data-kind", "html");
    // bare: the frame sits directly in the figure, no card around it, no title chip
    const fig = screen.getByTestId("visual-figure");
    expect(fig.querySelector("figcaption")).toBeNull();
    expect(screen.getByTestId("visual-body").className).toBe("");
    expect(frame.className).not.toMatch(/\bborder-line\b|\bbg-surface|\brounded/);
    expect(frame.className).toContain("w-full");
    // html visuals are not exportable: only "Open larger"
    document.documentElement.style.removeProperty("--fg");
  });

  it("HTML menu has Open larger only, and its dialog frame is sandboxed too", async () => {
    render(<VisualFigure title="Cards" html="<p>x</p>" />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Download SVG" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open larger" }));
    const dlg = await screen.findByRole("dialog");
    const big = dlg.querySelector("iframe")!;
    expect(big.getAttribute("sandbox")).toBe("allow-scripts");
    expect(big.getAttribute("srcdoc")).toContain("Content-Security-Policy");
  });

  it("the frame has a default height and a keyboard / pointer resize handle", () => {
    render(<VisualFigure title="Cards" html="<p>x</p>" />);
    const frame = screen.getByTestId("visual-frame");
    expect(frame.style.height).toBe("320px");
    const grip = screen.getByTestId("visual-grip");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(frame.style.height).toBe("360px");
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(frame.style.height).toBe("280px");
    // jsdom has no PointerEvent: MouseEvents with the pointer type names carry clientY
    const ptr = (type: string, clientY: number) => fireEvent(grip, new MouseEvent(type, { bubbles: true, clientY }));
    ptr("pointerdown", 100);
    ptr("pointermove", 160);
    expect(frame.style.height).toBe("340px");
    ptr("pointerup", 160);
    ptr("pointermove", 400);
    expect(frame.style.height).toBe("340px");
  });

  describe("frame messages", () => {
    const post = (data: unknown, source: MessageEventSource | null) => act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
    const fromFrame = (frame: HTMLIFrameElement, data: Record<string, unknown>) => post({ source: "workstation-visual", ...data }, frame.contentWindow);

    it("a height message resizes the frame to fit, capped at 1600px", () => {
      render(<VisualFigure title="Cards" html="<p>x</p>" sessionId={SID} />);
      const frame = screen.getByTestId("visual-frame") as HTMLIFrameElement;
      // a few px of slack on top of the reported content height
      fromFrame(frame, { type: "height", height: 512.2 });
      expect(frame.style.height).toBe("517px");
      fromFrame(frame, { type: "height", height: 90 });
      expect(frame.style.height).toBe("94px");
      fromFrame(frame, { type: "height", height: 1598 });
      expect(frame.style.height).toBe("1600px");
      fromFrame(frame, { type: "height", height: 9000 });
      expect(frame.style.height).toBe("1600px");
    });

    it("ignores malformed height values", () => {
      render(<VisualFigure title="Cards" html="<p>x</p>" sessionId={SID} />);
      const frame = screen.getByTestId("visual-frame") as HTMLIFrameElement;
      for (const height of ["400", -5, NaN, Infinity, null]) fromFrame(frame, { type: "height", height });
      expect(frame.style.height).toBe("320px");
    });

    it("messages from any other source are ignored", () => {
      render(<VisualFigure title="Cards" html="<p>x</p>" sessionId={SID} />);
      const frame = screen.getByTestId("visual-frame") as HTMLIFrameElement;
      const height = { source: "workstation-visual", type: "height", height: 700 };
      const prompt = { source: "workstation-visual", type: "prompt", text: "do it" };
      for (const src of [window, null, window.parent, document.createElement("iframe").contentWindow]) {
        post(height, src as MessageEventSource | null);
        post(prompt, src as MessageEventSource | null);
      }
      expect(frame.style.height).toBe("320px");
      expect(useComposer.getState().drafts[SID]).toBeUndefined();
    });

    it("messages without the visual marker are ignored", () => {
      render(<VisualFigure title="Cards" html="<p>x</p>" sessionId={SID} />);
      const frame = screen.getByTestId("visual-frame") as HTMLIFrameElement;
      post({ type: "height", height: 700 }, frame.contentWindow);
      post("height", frame.contentWindow);
      post(null, frame.contentWindow);
      expect(frame.style.height).toBe("320px");
    });

    it("sendPrompt puts the text into the session composer and never sends it", () => {
      useComposer.getState().clear(SID);
      const fetched = vi.fn();
      vi.stubGlobal("fetch", fetched);
      render(<VisualFigure title="Cards" html="<p>x</p>" sessionId={SID} />);
      fromFrame(screen.getByTestId("visual-frame") as HTMLIFrameElement, { type: "prompt", text: "Explain the second step" });
      expect(useComposer.getState().drafts[SID]?.text).toBe("Explain the second step");
      expect(fetched).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("sendPrompt keeps what the user already typed and ignores empty text", () => {
      useComposer.getState().setText(SID, "Draft:");
      render(<VisualFigure title="Cards" html="<p>x</p>" sessionId={SID} />);
      const frame = screen.getByTestId("visual-frame") as HTMLIFrameElement;
      fromFrame(frame, { type: "prompt", text: "  " });
      fromFrame(frame, { type: "prompt", text: 42 });
      expect(useComposer.getState().drafts[SID]?.text).toBe("Draft:");
      fromFrame(frame, { type: "prompt", text: "more" });
      expect(useComposer.getState().drafts[SID]?.text).toBe("Draft: more");
    });

    it("the larger view is the same frame: its own sandbox, and a prompt fills the composer and closes it", async () => {
      useComposer.getState().clear(SID);
      render(<VisualFigure title="Cards" html="<p>x</p>" sessionId={SID} />);
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Open larger" }));
      const dlg = await screen.findByRole("dialog");
      const big = dlg.querySelector("iframe") as HTMLIFrameElement;
      // the inline frame does not answer for the large one
      fromFrame(big, { type: "prompt", text: "from large" });
      expect(useComposer.getState().drafts[SID]?.text).toBe("from large");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });

  it("a theme change is posted to the frame; the document is not reloaded", async () => {
    render(<HtmlFrame html="<p>x</p>" title="t" />);
    const frame = screen.getByTestId("visual-frame") as HTMLIFrameElement;
    const before = frame.getAttribute("srcdoc");
    expect(before).toContain("color-scheme:light");
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: post } });
    document.documentElement.style.setProperty("--fg", "#123456");
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [msg, target] = post.mock.calls.at(-1)!;
    expect(target).toBe("*");
    expect(msg).toMatchObject({ source: "workstation-visual", type: "theme", dark: true });
    expect(msg.css).toContain("--fg:#123456");
    expect(msg.css).toContain("color-scheme:dark");
    expect(frame.getAttribute("srcdoc")).toBe(before);
    document.documentElement.style.removeProperty("--fg");
  });

  it("shows a skeleton with the title while streaming", () => {
    render(<VisualFigure title="Arch" streaming />);
    const fig = screen.getByTestId("visual-figure");
    expect(fig).toHaveAttribute("data-state", "streaming");
    expect(fig).toHaveAccessibleName("Arch");
    expect(fig.querySelector("figcaption")).toBeNull();
    expect(within(fig).getByRole("status")).toBeInTheDocument();
    expect(fig.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("an unusable payload shows a one-line error and no menu", () => {
    render(<VisualFigure title="X" svg="<script>alert(1)</script>" />);
    expect(screen.getByTestId("visual-figure")).toHaveAttribute("data-kind", "invalid");
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid visual");
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });
});

describe("transcript integration", () => {
  const viewWith = (messages: ReturnType<typeof userText>[], status: "idle" | "running" = "idle"): SessionView => ({ ...insertMessages(emptyView(SID, session({ status, kind: "chat" })), messages), snapshotReceived: true });
  const call = (name: string, input: unknown, id = "v1") => assistant(2, [{ type: "tool_use", id, name, input }]);

  it("show_visual (any MCP prefix) is a figure, not a tool card", () => {
    render(
      <TestRouter>
        <Transcript view={viewWith([userText(1, "draw"), call("mcp__workstation-visual__show_visual", { title: "Flow", svg: SVG }), toolResult(3, "v1", "ok")])} />
      </TestRouter>,
    );
    expect(screen.getByTestId("visual-figure")).toHaveAccessibleName("Flow");
    expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument();
  });

  it("a call still awaiting its result is a figure", () => {
    render(
      <TestRouter>
        <Transcript view={viewWith([userText(1, "draw"), call("mcp__workstation-visual__show_visual", { title: "G", svg: SVG })], "running")} />
      </TestRouter>,
    );
    expect(screen.getByTestId("visual-figure")).toHaveAccessibleName("G");
  });

  it("a failed call falls back to the ordinary tool card", async () => {
    render(
      <TestRouter>
        <Transcript view={viewWith([userText(1, "draw"), call("mcp__workstation-visual__show_visual", { title: "Flow", svg: SVG }), toolResult(3, "v1", "boom", true)])} />
      </TestRouter>,
    );
    expect(screen.queryByTestId("visual-figure")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-group-failed")).toHaveTextContent("1");
    await userEvent.click(screen.getByTestId("tool-group").querySelector("button")!);
    expect(screen.getByTestId("tool-card")).toBeInTheDocument();
  });

  it("streaming show_visual shows the skeleton with the title typed so far", () => {
    render(<StreamingTail blocks={[{ type: "tool_use", toolUseId: "v1", toolName: "mcp__workstation-visual__show_visual", partialJson: '{"title":"Pipeline","svg":"<svg viewBox=\\"0 0 1' }]} />);
    const fig = screen.getByTestId("visual-figure");
    expect(fig).toHaveAttribute("data-state", "streaming");
    expect(fig).toHaveAccessibleName("Pipeline");
    expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument();
  });

  it("assistant markdown with a mermaid fence renders the diagram in the transcript", async () => {
    render(
      <TestRouter>
        <Transcript view={viewWith([userText(1, "draw"), assistant(2, [{ type: "text", text: md(FLOW) }])])} />
      </TestRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("mermaid-block")).toHaveAttribute("data-state", "ok"));
  });
});
