import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installBridge, makeBridge, PID, removeBridge } from "../../test/syncBridge";
import { useApp } from "../../store/app";
import { useComposer } from "../../store/composer";
import { session } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { TooltipProvider } from "../ui/overlays";
import { TopBar } from "./TopBar";

const renderBar = (s: ReturnType<typeof session> | null) =>
  render(
    <TestRouter>
      <TooltipProvider>
        <TopBar session={s} narrow={false} />
      </TooltipProvider>
    </TestRouter>,
  );

beforeEach(() => {
  useApp.setState({ mode: "code", sidebarOpen: true });
  useComposer.setState({ newIncognito: false });
});

describe("TopBar Sync tab", () => {
  const linked = (pending: number) => makeBridge({ status: { folder: "/Users/me/proj", pending } });
  const withProject = () => session({ projectId: PID });
  afterEach(removeBridge);

  it("is hidden without the AgentWorkstation.app bridge", async () => {
    renderBar(withProject());
    expect(screen.getByTestId("panel-files")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByTestId("panel-sync")).not.toBeInTheDocument();
  });

  it("is hidden when the session has no project", async () => {
    const bridge = linked(1);
    installBridge(bridge);
    renderBar(session({ projectId: null }));
    await act(async () => {});
    expect(screen.queryByTestId("panel-sync")).not.toBeInTheDocument();
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it("is hidden when the project is not linked on this Mac (status null)", async () => {
    const bridge = makeBridge({ status: null });
    installBridge(bridge);
    renderBar(withProject());
    await waitFor(() => expect(bridge.status).toHaveBeenCalledWith(PID));
    expect(screen.queryByTestId("panel-sync")).not.toBeInTheDocument();
  });

  it("shows for a linked project, with a count badge only while items are pending", async () => {
    installBridge(linked(3));
    const { unmount } = renderBar(withProject());
    expect(await screen.findByTestId("panel-sync")).toHaveAccessibleName("Sync");
    expect(screen.getByTestId("sync-badge")).toHaveTextContent("3");
    unmount();
    installBridge(linked(0));
    renderBar(withProject());
    expect(await screen.findByTestId("panel-sync")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-badge")).not.toBeInTheDocument();
  });

  it("updates the badge when AgentWorkstation.app reports a change, and is not there in Chat", async () => {
    const bridge = linked(2);
    installBridge(bridge);
    renderBar(withProject());
    expect(await screen.findByTestId("sync-badge")).toHaveTextContent("2");
    bridge.status.mockResolvedValue({ folder: "/Users/me/proj", pending: 5 });
    act(() => window.__workstationSyncChanged?.(PID));
    await waitFor(() => expect(screen.getByTestId("sync-badge")).toHaveTextContent("5"));
    act(() => useApp.setState({ mode: "chat" }));
    expect(screen.queryByTestId("panel-sync")).not.toBeInTheDocument();
  });

  it("clicking it opens the Sync panel", async () => {
    installBridge(linked(1));
    useApp.setState({ rightOpen: false, rightTab: "files" });
    renderBar(withProject());
    await userEvent.click(await screen.findByTestId("panel-sync"));
    expect(useApp.getState()).toMatchObject({ rightOpen: true, rightTab: "sync" });
  });
});

describe("TopBar incognito", () => {
  it("a new chat has the ghost toggle: off by default, a click turns the next chat incognito", async () => {
    useApp.setState({ mode: "chat" });
    renderBar(null);
    const toggle = screen.getByTestId("incognito-toggle");
    expect(toggle).toHaveAccessibleName("Incognito");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle.querySelector("svg")).not.toBeNull();
    await userEvent.click(toggle);
    expect(useComposer.getState().newIncognito).toBe(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    expect(useComposer.getState().newIncognito).toBe(false);
  });

  it("is only for new chats: not in Code mode, not on an existing session", () => {
    const first = renderBar(null);
    expect(screen.queryByTestId("incognito-toggle")).not.toBeInTheDocument();
    first.unmount();
    useApp.setState({ mode: "chat" });
    renderBar(session({ kind: "chat" }));
    expect(screen.queryByTestId("incognito-toggle")).not.toBeInTheDocument();
  });

  it("an incognito session carries a small persistent Incognito chip; a normal one has none", () => {
    useApp.setState({ mode: "chat" });
    const { unmount } = renderBar(session({ kind: "chat", incognito: true, title: "New chat" }));
    const chip = screen.getByTestId("incognito-chip");
    expect(chip).toHaveTextContent("Incognito");
    expect(chip.textContent?.trim().split(/\s+/)).toHaveLength(1); // one word, no paragraph
    unmount();
    renderBar(session({ kind: "chat", incognito: false }));
    expect(screen.queryByTestId("incognito-chip")).not.toBeInTheDocument();
  });
});
