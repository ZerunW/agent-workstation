import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import type { BrowserState } from "@agent-workstation/protocol";

expect.extend(jestDomMatchers);

const mocks = vi.hoisted(() => ({ browser: vi.fn(), start: vi.fn(), stop: vi.fn(), view: vi.fn(), input: vi.fn() }));

vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, browser: mocks.browser, startBrowser: mocks.start, stopBrowser: mocks.stop } };
});
vi.mock("../../store/hub", () => ({ sendBrowserView: mocks.view, sendBrowserInput: mocks.input }));

import { useBrowser } from "../../store/browser";
import { useToasts } from "../../store/toasts";
import { BrowserTab } from "./BrowserTab";

const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  running: true,
  url: "https://example.com/",
  title: "Example",
  controlledBy: "agent",
  sessionId: null,
  viewers: 1,
  viewport: { width: 1280, height: 800 },
  ...over,
});
const STOPPED = state({ running: false, url: null, title: null, controlledBy: null });

function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Render and let the initial GET /api/browser settle inside act. */
async function mount(active = true) {
  const r = render(<BrowserTab active={active} />);
  await act(async () => {});
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  useBrowser.getState().reset();
  useToasts.setState({ toasts: [] });
  mocks.browser.mockResolvedValue(state());
  setVisibility("visible");
});

describe("BrowserTab view lifecycle", () => {
  it("switches the view on when the tab shows, off when it is hidden, and off on unmount", async () => {
    const { rerender, unmount } = await mount();
    expect(mocks.view).toHaveBeenLastCalledWith(true, expect.any(Number));
    expect(mocks.view).toHaveBeenCalledTimes(1);
    await act(async () => rerender(<BrowserTab active={false} />));
    expect(mocks.view).toHaveBeenLastCalledWith(false);
    await act(async () => rerender(<BrowserTab active />));
    expect(mocks.view).toHaveBeenLastCalledWith(true, expect.any(Number));
    expect(mocks.view).toHaveBeenCalledTimes(3);
    unmount();
    expect(mocks.view).toHaveBeenLastCalledWith(false);
    expect(mocks.view).toHaveBeenCalledTimes(4);
  });

  it("never turns the view on while another panel tab is showing", async () => {
    await mount(false);
    expect(mocks.view).not.toHaveBeenCalled();
    expect(mocks.browser).not.toHaveBeenCalled();
  });

  it("follows page visibility", async () => {
    await mount();
    expect(mocks.view).toHaveBeenLastCalledWith(true, expect.any(Number));
    act(() => setVisibility("hidden"));
    expect(mocks.view).toHaveBeenLastCalledWith(false);
    act(() => setVisibility("visible"));
    expect(mocks.view).toHaveBeenLastCalledWith(true, expect.any(Number));
    expect(mocks.view).toHaveBeenCalledTimes(3);
  });

  it("loads the current state when it opens", async () => {
    await mount();
    await waitFor(() => expect(screen.getByLabelText("Address")).toHaveValue("https://example.com/"));
  });
});

describe("BrowserTab empty state", () => {
  it("says Not running with a Start button that starts the browser", async () => {
    mocks.browser.mockResolvedValue(STOPPED);
    mocks.start.mockResolvedValue(state());
    await mount();
    expect(await screen.findByText("Not running")).toBeInTheDocument();
    expect(screen.getByLabelText("Back")).toBeDisabled();
    expect(screen.getByLabelText("Address")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Not running")).toBeNull());
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });

  it("toasts when starting fails and stays stopped", async () => {
    mocks.browser.mockResolvedValue(STOPPED);
    mocks.start.mockRejectedValue(new Error("no chromium"));
    await mount();
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Start" })));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.title === "Couldn't start the browser")).toBe(true));
    expect(screen.getByText("Not running")).toBeInTheDocument();
  });

  it("Stop stops a running browser", async () => {
    mocks.stop.mockResolvedValue(STOPPED);
    await mount();
    fireEvent.click(await screen.findByLabelText("Stop"));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Not running")).toBeInTheDocument();
  });
});

describe("BrowserTab top bar", () => {
  it("shows who is driving, following pushed state", async () => {
    await mount();
    expect(await screen.findByTestId("browser-control")).toHaveTextContent("Agent");
    act(() => useBrowser.getState().setState(state({ controlledBy: "user" })));
    expect(screen.getByTestId("browser-control")).toHaveTextContent("You");
    act(() => useBrowser.getState().setState(state({ controlledBy: null })));
    expect(screen.queryByTestId("browser-control")).toBeNull();
  });

  it("back / forward / reload send history inputs", async () => {
    await mount();
    await screen.findByLabelText("Address");
    fireEvent.click(screen.getByLabelText("Back"));
    fireEvent.click(screen.getByLabelText("Forward"));
    fireEvent.click(screen.getByLabelText("Reload"));
    expect(mocks.input.mock.calls.map((c) => c[0])).toEqual([
      { kind: "history", action: "back" },
      { kind: "history", action: "forward" },
      { kind: "history", action: "reload" },
    ]);
  });

  it("Enter in the address bar navigates (https:// assumed); an invalid address sends nothing", async () => {
    await mount();
    const input = await screen.findByLabelText("Address");
    await waitFor(() => expect(input).toHaveValue("https://example.com/"));
    fireEvent.change(input, { target: { value: "openai.com/docs" } });
    fireEvent.submit(input.closest("form")!);
    expect(mocks.input).toHaveBeenCalledWith({ kind: "navigate", url: "https://openai.com/docs" });

    mocks.input.mockClear();
    fireEvent.change(input, { target: { value: "not a url" } });
    fireEvent.submit(input.closest("form")!);
    expect(mocks.input).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps what is being typed when the page navigates meanwhile, and follows state.url otherwise", async () => {
    await mount();
    const input = await screen.findByLabelText("Address");
    await waitFor(() => expect(input).toHaveValue("https://example.com/"));
    act(() => useBrowser.getState().setState(state({ url: "https://b.test/" })));
    expect(input).toHaveValue("https://b.test/");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "c.te" } });
    act(() => useBrowser.getState().setState(state({ url: "https://d.test/" })));
    expect(input).toHaveValue("c.te");
    fireEvent.blur(input);
    expect(input).toHaveValue("https://d.test/");
  });
});
