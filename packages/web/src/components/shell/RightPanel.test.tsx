import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../../test/fixtures";
import { entry, installBridge, makeBridge, PID, removeBridge } from "../../test/syncBridge";

vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, health: vi.fn().mockResolvedValue({ ok: true }), filesTree: vi.fn().mockResolvedValue([]) } };
});

import { useApp } from "../../store/app";
import { useSessions } from "../../store/sessions";
import { RightPanel } from "./RightPanel";
import { TestRouter } from "../../test/router";

beforeEach(() => {
  localStorage.clear();
  useSessions.getState().reset();
  useSessions.getState().setSessions([session()]);
  useApp.setState({ me: { user: { name: "alice" }, settings: {} } as never, models: [], rightOpen: true, rightTab: "overview" });
});

const tabNames = () => screen.getAllByRole("tab").map((t) => t.getAttribute("title"));

describe("RightPanel: wide screens (the top bar holds the tab buttons)", () => {
  it("names only the open tab, with no second row of tabs", () => {
    useApp.setState({ mode: "code", rightTab: "history" });
    render(
      <TestRouter>
        <RightPanel sessionId={SID} overlay={false} />
      </TestRouter>,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("right-panel-title")).toHaveTextContent("History");
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("names Files when Sync was open but is not available, and Overview in Chat", () => {
    useApp.setState({ mode: "code", rightTab: "sync" });
    const first = render(<RightPanel sessionId={SID} overlay={false} />);
    expect(screen.getByTestId("right-panel-title")).toHaveTextContent("Files");
    first.unmount();
    useApp.setState({ mode: "chat", rightTab: "terminal" });
    render(<RightPanel sessionId={SID} overlay={false} />);
    expect(screen.getByTestId("right-panel-title")).toHaveTextContent("Overview");
  });
});

describe("RightPanel: narrow screens (overlay, the panel holds the tabs)", () => {
  it("Code: Overview is the first tab, followed by the others", () => {
    useApp.setState({ mode: "code" });
    render(<RightPanel sessionId={SID} overlay />);
    expect(tabNames()).toEqual(["Overview", "Files", "Changes", "History", "Terminal", "Browser"]);
    expect(screen.getByRole("tab", { name: /overview/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument();
  });

  describe("Sync tab", () => {
    afterEach(removeBridge);
    const link = (over: Partial<ReturnType<typeof session>> = {}, pending = 2) => {
      const bridge = makeBridge({ status: { folder: "/Users/me/proj", pending }, tree: { "": [entry({ path: "a.txt", decision: "sync", effective: "sync" })] } });
      installBridge(bridge);
      useSessions.getState().setSessions([session(over)]);
      useApp.setState({ mode: "code" });
      return bridge;
    };

    it("comes last, with a badge, for a session of a project linked on this Mac", async () => {
      link({ projectId: PID });
      render(<RightPanel sessionId={SID} overlay />);
      await waitFor(() => expect(tabNames()).toEqual(["Overview", "Files", "Changes", "History", "Terminal", "Browser", "Sync"]));
      expect(screen.getByTestId("sync-tab-badge")).toHaveTextContent("2");
    });

    it("is absent without the bridge, without a projectId and when status is null", async () => {
      useApp.setState({ mode: "code" });
      useSessions.getState().setSessions([session({ projectId: PID })]);
      const first = render(<RightPanel sessionId={SID} overlay />);
      await act(async () => {});
      expect(tabNames()).not.toContain("Sync");
      first.unmount();
      const bridge = link({ projectId: null });
      const second = render(<RightPanel sessionId={SID} overlay />);
      await act(async () => {});
      expect(tabNames()).not.toContain("Sync");
      expect(bridge.status).not.toHaveBeenCalled();
      second.unmount();
      installBridge(makeBridge({ status: null }));
      useSessions.getState().setSessions([session({ projectId: PID })]);
      render(<RightPanel sessionId={SID} overlay />);
      await act(async () => {});
      expect(tabNames()).not.toContain("Sync");
    });

    it("opens the tab: pending items and the tree of the linked folder", async () => {
      link({ projectId: PID });
      render(<RightPanel sessionId={SID} overlay />);
      await userEvent.click(await screen.findByRole("tab", { name: /sync/i }));
      expect(useApp.getState().rightTab).toBe("sync");
      expect(await screen.findByTestId("sync-tab")).toBeVisible();
      expect(await screen.findByText("a.txt")).toBeInTheDocument();
    });

    it("falls back to Files when Sync was the open tab but is not available", async () => {
      useApp.setState({ mode: "code", rightTab: "sync" });
      render(<RightPanel sessionId={SID} overlay />);
      await act(async () => {});
      expect(screen.getByRole("tab", { name: /files/i })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByTestId("sync-tab")).toBeNull();
    });
  });

  it("Chat: only the Overview, whatever tab Code last had open", () => {
    useApp.setState({ mode: "chat", rightTab: "terminal" });
    render(<RightPanel sessionId={SID} overlay />);
    expect(tabNames()).toEqual(["Overview"]);
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("files-tab")).toBeNull();
  });
});
