import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { useComposer } from "../../store/composer";
import { useSessions } from "../../store/sessions";
import { session } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { TooltipProvider } from "../ui/overlays";
import { Sidebar } from "./Sidebar";

const renderSidebar = () =>
  render(
    <TestRouter initialEntries={["/"]}>
      <TooltipProvider>
        <Routes>
          <Route path="/" element={<Sidebar onNavigate={() => {}} />} />
          <Route path="/memory" element={<div data-testid="memory-route" />} />
          <Route path="/browser-sites" element={<div data-testid="sites-route" />} />
        </Routes>
      </TooltipProvider>
    </TestRouter>,
  );

beforeEach(() => {
  useSessions.getState().reset();
  useApp.setState({ user: "alice", me: { user: { name: "alice", isAdmin: true } } as never, mode: "code", limits: null });
});

const renderSidebarAt = (path = "/") =>
  render(
    <TestRouter initialEntries={[path]}>
      <TooltipProvider>
        <Routes>
          <Route path="/" element={<Sidebar onNavigate={() => {}} />} />
          <Route path="/projects" element={<div data-testid="projects-route" />} />
          <Route path="/instructions" element={<div data-testid="instructions-route" />} />
          <Route path="/skills" element={<div data-testid="skills-route" />} />
          <Route path="/memory" element={<div data-testid="memory-route" />} />
          <Route path="/usage" element={<div data-testid="usage-route" />} />
        </Routes>
      </TooltipProvider>
    </TestRouter>,
  );

describe("Sidebar", () => {
  it("starts with a vertical list like the Claude app: New, Search, Projects — nothing else yet", () => {
    renderSidebar();
    const top = screen.getByRole("navigation", { name: "Main" });
    const items = Array.from(top.querySelectorAll("a, button")).filter((el) => !el.matches('[data-testid="nav-new-in"]'));
    expect(items.map((el) => el.getAttribute("data-testid"))).toEqual(["nav-new", "nav-search", "nav-projects"]);
    expect(within(top).getByTestId("nav-new")).toHaveTextContent(/New\s*⌘N/);
    expect(within(top).getByTestId("nav-search")).toHaveTextContent(/Search\s*⌘K/);
    expect(within(top).getByTestId("nav-projects")).toHaveTextContent("Projects");
    expect(screen.queryByTestId("nav-customize")).not.toBeInTheDocument();
    // every entry has its icon; Artifacts and Scheduled are not here (no placeholders)
    for (const el of items) expect(el.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("Artifacts")).not.toBeInTheDocument();
    expect(screen.queryByText("Scheduled")).not.toBeInTheDocument();
  });

  it("the top list sits above the session list, the footer below it", () => {
    renderSidebar();
    const top = screen.getByTestId("sidebar-top");
    const list = screen.getByRole("navigation", { name: "Session list" });
    const footer = screen.getByTestId("sidebar-footer");
    expect(top.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the old inline filter input is gone (Search replaces it)
    expect(screen.queryByPlaceholderText("Search sessions")).not.toBeInTheDocument();
  });

  it("New starts a new session (focus requested, project folder kept), Search opens the dialog, Projects navigates", async () => {
    useApp.setState({ searchOpen: false });
    const focusTick = useComposer.getState().focusTick;
    renderSidebarAt();
    await userEvent.click(screen.getByTestId("nav-new"));
    expect(useComposer.getState().focusTick).toBe(focusTick + 1);

    await userEvent.click(screen.getByTestId("nav-search"));
    expect(useApp.getState().searchOpen).toBe(true);

    await userEvent.click(screen.getByTestId("nav-projects"));
    expect(await screen.findByTestId("projects-route")).toBeInTheDocument();
  });

  it("the gear menu holds every setting: defaults, Instructions, Memory, Skills, Browser sites, Docs, Switch user", async () => {
    renderSidebarAt();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Notifications", "Session defaults…", "Instructions…", "Memory…", "Skills…", "Browser sites…", "Docs", "Switch user"]);
    await userEvent.click(screen.getByTestId("menu-instructions"));
    expect(await screen.findByTestId("instructions-route")).toBeInTheDocument();
  });

  it("Skills in the gear menu opens its page", async () => {
    renderSidebarAt();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByTestId("menu-skills"));
    expect(await screen.findByTestId("skills-route")).toBeInTheDocument();
  });

  it("New is named for the mode (accessible name) while the row just says New", () => {
    useApp.setState({ mode: "chat" });
    renderSidebar();
    expect(screen.getByRole("button", { name: "New chat" })).toHaveTextContent("New");
    cleanup();
    useApp.setState({ mode: "code" });
    renderSidebar();
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();
  });

  it("only Code mode has the 'new session in…' menu", () => {
    useApp.setState({ mode: "chat" });
    renderSidebar();
    expect(screen.queryByTestId("nav-new-in")).not.toBeInTheDocument();
    cleanup();
    useApp.setState({ mode: "code" });
    renderSidebar();
    expect(screen.getByTestId("nav-new-in")).toBeInTheDocument();
  });

  it("the footer keeps Usage, Admin (admins only) and the settings gear — Projects and Skills moved to the top / Customize", () => {
    renderSidebar();
    const footer = screen.getByTestId("sidebar-footer");
    const labels = Array.from(footer.querySelectorAll("a, button")).map((el) => el.textContent?.trim() || el.getAttribute("aria-label"));
    expect(labels).toEqual(["Usage", "Admin", "Settings"]);
    expect(within(footer).queryByText("Projects")).not.toBeInTheDocument();
    expect(within(footer).queryByText("Skills")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nav-skills")).not.toBeInTheDocument();
    cleanup();
    useApp.setState({ me: { user: { name: "alice", isAdmin: false } } as never });
    renderSidebar();
    expect(screen.queryByTestId("nav-admin")).not.toBeInTheDocument();
  });

  it("the user menu keeps only Switch user: Memory… and Session defaults… are not duplicated there", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Signed in as" }));
    expect(await screen.findByRole("menuitem", { name: "Switch user" })).toBeInTheDocument();
    expect(screen.queryByTestId("menu-memory")).not.toBeInTheDocument();
    expect(screen.queryByTestId("menu-session-defaults")).not.toBeInTheDocument();
  });

  it("Memory… and Session defaults… stay in the settings (gear) menu", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const item = await screen.findByTestId("menu-memory");
    expect(item).toHaveTextContent("Memory…");
    expect(screen.getByTestId("menu-session-defaults")).toHaveTextContent("Session defaults…");
    await userEvent.click(item);
    expect(await screen.findByTestId("memory-route")).toBeInTheDocument();
  });

  it("Browser sites… sits after Skills… in the settings menu and opens its page", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const item = await screen.findByTestId("menu-browser-sites");
    expect(item).toHaveTextContent("Browser sites…");
    expect(screen.getAllByRole("menuitem").map((el) => el.getAttribute("data-testid")).filter(Boolean).slice(-3, -1)).toEqual(["menu-skills", "menu-browser-sites"]);
    await userEvent.click(item);
    expect(await screen.findByTestId("sites-route")).toBeInTheDocument();
  });

  it("Docs sits last in the settings menu, before Switch user, and opens /readme in the app", async () => {
    render(
      <TestRouter initialEntries={["/"]}>
        <TooltipProvider>
          <Routes>
            <Route path="/" element={<Sidebar onNavigate={() => {}} />} />
            <Route path="/readme/*" element={<div data-testid="readme-route" />} />
          </Routes>
        </TooltipProvider>
      </TestRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const item = await screen.findByTestId("menu-docs");
    expect(item).toHaveTextContent("Docs");
    const items = screen.getAllByRole("menuitem");
    expect(items[items.length - 2]).toBe(item);
    expect(items[items.length - 1]).toHaveTextContent("Switch user");
    await userEvent.click(item);
    expect(await screen.findByTestId("readme-route")).toBeInTheDocument();
  });

  describe("Notifications toggle in the gear menu", () => {
    const open = async () => {
      renderSidebar();
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      return screen.findByTestId("menu-notifications");
    };

    it("is on unless notificationsEnabled is false", async () => {
      const item = await open();
      expect(item).toHaveTextContent("Notifications");
      expect(screen.getByTestId("menu-notifications-switch")).toHaveAttribute("aria-checked", "true");
      cleanup();
      useApp.setState({ me: { user: { name: "alice", isAdmin: true, notificationsEnabled: false } } as never });
      await open();
      expect(screen.getByTestId("menu-notifications-switch")).toHaveAttribute("aria-checked", "false");
    });

    it("PATCHes the preference, updates `me` and keeps the menu open", async () => {
      const patch = vi.spyOn(api, "patchPreferences").mockImplementation(async (b) => ({ name: "alice", isAdmin: true, ...b }) as never);
      const item = await open();
      await userEvent.click(item);
      expect(patch).toHaveBeenLastCalledWith({ notificationsEnabled: false });
      await waitFor(() => expect(useApp.getState().me?.user.notificationsEnabled).toBe(false));
      expect(screen.getByTestId("menu-notifications-switch")).toHaveAttribute("aria-checked", "false");
      await userEvent.click(screen.getByTestId("menu-notifications"));
      expect(patch).toHaveBeenLastCalledWith({ notificationsEnabled: true });
      await waitFor(() => expect(screen.getByTestId("menu-notifications-switch")).toHaveAttribute("aria-checked", "true"));
      patch.mockRestore();
    });

    it("reverts when the PATCH fails", async () => {
      const patch = vi.spyOn(api, "patchPreferences").mockRejectedValue(new Error("nope"));
      await userEvent.click(await open());
      await waitFor(() => expect(patch).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId("menu-notifications-switch")).toHaveAttribute("aria-checked", "true"));
      patch.mockRestore();
    });
  });

  it("Session defaults… in the gear menu opens the dialog", async () => {
    useApp.setState({
      me: { user: { name: "alice", isAdmin: true, modelAllowlist: null, defaultModel: null, defaultEffort: null }, settings: { defaultModel: "opus", defaultEffort: "high" }, disk: "ok", apiAvailable: true, protocolVersion: 1 } as never,
      models: [],
    });
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByTestId("menu-session-defaults"));
    expect(await screen.findByRole("dialog", { name: "Session defaults" })).toBeInTheDocument();
  });

  it("never lists an incognito chat, even right after it was created in this tab", () => {
    useApp.setState({ mode: "chat" });
    useSessions.setState({
      listLoaded: true,
      views: {},
      sessions: {
        a: session({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "chat", title: "Normal chat" }),
        b: session({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "chat", title: "Secret chat", incognito: true }),
      },
    });
    renderSidebar();
    expect(screen.getByRole("link", { name: /Normal chat/ })).toBeInTheDocument();
    expect(screen.queryByText("Secret chat")).not.toBeInTheDocument();
  });

  it("the session menu stays anchored: its button stays laid out while the menu is open", async () => {
    useApp.setState({ mode: "chat" });
    useSessions.setState({
      listLoaded: true,
      views: {},
      sessions: { a: session({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "chat", title: "Menu chat" }) },
    });
    renderSidebar();
    const button = screen.getByRole("button", { name: "Session menu" });
    const holder = button.parentElement!;
    expect(holder).toHaveClass("hidden");
    await userEvent.click(button);
    expect(await screen.findByRole("menuitem", { name: /delete session/i })).toBeInTheDocument();
    // Focus and the pointer are in the menu now: hover/focus-within no longer apply, the holder must still show.
    expect(holder).toHaveClass("block");
    expect(holder).not.toHaveClass("hidden");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(holder).toHaveClass("hidden"));
  });

  it("never lists a subagent's session, even when the store knows it", () => {
    const parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    useSessions.setState({
      listLoaded: true,
      views: {},
      sessions: {
        a: session({ id: parent, title: "Parent session" }),
        b: session({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Audit the sync engine", parentSessionId: parent }),
      },
    });
    renderSidebar();
    expect(screen.getByRole("link", { name: /Parent session/ })).toBeInTheDocument();
    expect(screen.queryByText("Audit the sync engine")).not.toBeInTheDocument();
  });

  it("the usage dot follows the API-credit severity", () => {
    const api = (severity: "normal" | "warning" | "critical") => ({ spentUsd: 95, limitUsd: 100, percent: 95, periodStart: "2026-01-01T00:00:00Z", resetsAt: "2026-02-01T00:00:00Z", severity });
    useApp.setState({ limits: { api: api("critical") } });
    renderSidebar();
    expect(screen.getByTestId("usage-dot")).toHaveAttribute("aria-label", "critical");
  });

  it("no usage dot while the API credits are fine", () => {
    useApp.setState({ limits: { api: { spentUsd: 5, limitUsd: 100, percent: 2.5, periodStart: "2026-01-01T00:00:00Z", resetsAt: "2026-02-01T00:00:00Z", severity: "normal" } } });
    renderSidebar();
    expect(screen.queryByTestId("usage-dot")).not.toBeInTheDocument();
  });
});
