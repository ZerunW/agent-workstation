import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

expect.extend(jestDomMatchers); // setup.ts registers jest-dom on a different vitest copy, so register the matchers here

const mocks = vi.hoisted(() => ({ terminals: vi.fn(), createTerminal: vi.fn(), deleteTerminal: vi.fn() }));

vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, terminals: mocks.terminals, createTerminal: mocks.createTerminal, deleteTerminal: mocks.deleteTerminal } };
});
vi.mock("./TerminalView", () => ({
  TerminalView: ({ terminalId, active }: { terminalId: string; active?: boolean }) => <div data-testid={`tv-${terminalId}`} data-active={String(!!active)} />,
}));

import type { TerminalInfo } from "../../lib/api";
import { useApp } from "../../store/app";
import { useToasts } from "../../store/toasts";
import { TerminalTab } from "./TerminalTab";

const info = (id: string): TerminalInfo => ({ id, cwd: "", createdAt: "2026-10-31T00:00:00Z", tmuxSession: `term-${id}` });
const setMe = (terminalEnabled: boolean) => useApp.setState({ me: { user: { name: "u", terminalEnabled, isAdmin: false } } as never, meError: null });

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  setMe(true);
  mocks.deleteTerminal.mockResolvedValue(undefined);
});

describe("TerminalTab", () => {
  it("restores existing terminals as tabs without creating a new one", async () => {
    mocks.terminals.mockResolvedValue([info("a"), info("b")]);
    render(<TerminalTab active />);
    expect(await screen.findByTestId("tv-a")).toBeInTheDocument();
    expect(screen.getByTestId("tv-b")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Terminal 1", "Terminal 2"]);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    // only the first tab is active, and only while the panel tab itself is active
    expect(screen.getByTestId("tv-a").dataset.active).toBe("true");
    expect(screen.getByTestId("tv-b").dataset.active).toBe("false");
  });

  it("passes active=false down while the Terminal panel tab is hidden", async () => {
    mocks.terminals.mockResolvedValue([info("a")]);
    const { rerender } = render(<TerminalTab active />);
    await screen.findByTestId("tv-a");
    rerender(<TerminalTab active={false} />);
    expect(screen.getByTestId("tv-a").dataset.active).toBe("false");
  });

  it("opens one terminal when the server has none", async () => {
    mocks.terminals.mockResolvedValue([]);
    mocks.createTerminal.mockResolvedValue(info("new1"));
    render(<TerminalTab active />);
    expect(await screen.findByTestId("tv-new1")).toBeInTheDocument();
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("+ creates another tab and selects it; closing deletes on the server", async () => {
    mocks.terminals.mockResolvedValue([info("a")]);
    mocks.createTerminal.mockResolvedValue(info("b"));
    render(<TerminalTab active />);
    await screen.findByTestId("tv-a");
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await screen.findByTestId("tv-b");
    expect(screen.getByTestId("tv-b").dataset.active).toBe("true");
    expect(screen.getByTestId("tv-a").dataset.active).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Close terminal Terminal 2" }));
    await waitFor(() => expect(screen.queryByTestId("tv-b")).not.toBeInTheDocument());
    expect(mocks.deleteTerminal).toHaveBeenCalledWith("b");
    expect(screen.getByTestId("tv-a").dataset.active).toBe("true");
  });

  it("keeps the tab when the server refuses to delete it", async () => {
    mocks.terminals.mockResolvedValue([info("a")]);
    mocks.deleteTerminal.mockRejectedValue(new Error("nope"));
    render(<TerminalTab active />);
    await screen.findByTestId("tv-a");
    fireEvent.click(screen.getByRole("button", { name: "Close terminal Terminal 1" }));
    await waitFor(() => expect(useToasts.getState().toasts.length).toBe(1));
    expect(screen.getByTestId("tv-a")).toBeInTheDocument();
  });

  it("explains and makes no requests when an admin disabled the terminal", async () => {
    setMe(false);
    render(<TerminalTab active />);
    expect(await screen.findByText("Terminal is turned off")).toBeInTheDocument();
    expect(mocks.terminals).not.toHaveBeenCalled();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it("shows an error with retry when listing fails", async () => {
    mocks.terminals.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([info("a")]);
    render(<TerminalTab active />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("tv-a")).toBeInTheDocument();
  });
});
