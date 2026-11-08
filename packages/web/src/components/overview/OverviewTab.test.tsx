import type { BackgroundTask, ContextUsage } from "@agent-workstation/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SID, session } from "../../test/fixtures";

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  stopTask: vi.fn(),
  sendMessage: vi.fn(),
  sessionOutputs: vi.fn(),
  setSessionNotify: vi.fn(),
}));

vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, health: mocks.health, stopTask: mocks.stopTask, sessionOutputs: mocks.sessionOutputs, setSessionNotify: mocks.setSessionNotify } };
});
vi.mock("../../store/actions", async (orig) => {
  const actual = await orig<typeof import("../../store/actions")>();
  return { ...actual, sendMessage: mocks.sendMessage };
});

import { handleServerEvent } from "../../store/hub";
import { useApp } from "../../store/app";
import { useChanged } from "../../store/changed";
import { useOutputs } from "../../store/outputs";
import { useSessions } from "../../store/sessions";
import { useToasts } from "../../store/toasts";
import { contextSegments, tokensUntilCompact } from "./ContextCard";
import { sessionOutputs } from "./OutputsCard";
import { OverviewTab } from "./OverviewTab";

const usage = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  usedTokens: 262_700,
  windowTokens: 1_000_000,
  model: "claude-opus-5-5",
  breakdown: [
    { key: "system_prompt", label: "System prompt", tokens: 8_500 },
    { key: "system_tools", label: "System tools", tokens: 14_200 },
    { key: "skills", label: "Skills", tokens: 3_000 },
    { key: "memory", label: "Memory", tokens: 1_000 },
    { key: "messages", label: "Messages", tokens: 236_000 },
    { key: "autocompact_buffer", label: "Autocompact buffer", tokens: 33_000 },
  ],
  updatedAt: "2026-10-31T12:00:00.000Z",
  ...over,
});

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({ taskId: "t1", type: "local_bash", description: "npm run dev", startedAt: new Date().toISOString(), ...over });

const put = (over: Parameters<typeof session>[0] = {}) => {
  useSessions.getState().reset();
  useSessions.getState().setSessions([session(over)]);
};
const fileEvent = (path: string, at: string, kind: "add" | "change" | "unlink" | "addDir" = "add", sessionId: string | null = SID) => useChanged.getState().record({ path, kind, at, sessionId });
const renderTab = () => render(<OverviewTab sessionId={SID} />);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useChanged.getState().clear();
  useToasts.setState({ toasts: [] });
  useApp.setState({
    me: { user: { name: "alice", modelAllowlist: null, defaultModel: null, defaultEffort: null }, settings: { remoteClaudeEnabled: true }, disk: "ok", apiAvailable: true } as never,
    models: [{ value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", family: "sonnet", legacy: false }],
    modelsLoaded: true,
    limits: null,
    serverOffsetMs: 0,
  });
  put();
  useOutputs.setState({ bySession: {} });
  mocks.sessionOutputs.mockResolvedValue([]);
  mocks.health.mockResolvedValue({ ok: true, hostname: "workstation-server" });
  mocks.stopTask.mockResolvedValue(undefined);
  mocks.sendMessage.mockResolvedValue({ ok: true, uuid: "u" });
});

afterEach(() => vi.useRealTimers());

describe("Environment card", () => {
  it("shows the server's hostname, the folder (name · parent) and the model", async () => {
    put({ cwd: "projects/demo-app" });
    renderTab();
    await waitFor(() => expect(screen.getByTestId("overview-machine")).toHaveTextContent("workstation-server"));
    expect(screen.getByTestId("overview-folder")).toHaveTextContent("demo-app · projects");
    expect(screen.getByTestId("overview-model")).toHaveTextContent("Sonnet 5.5");
    expect(screen.queryByTestId("overview-api-mark")).toBeNull();
  });

  describe("Notifications row", () => {
    const sw = () => screen.getByTestId("overview-notify");

    it("is on when notify is absent or true, off when false", () => {
      renderTab();
      expect(screen.getByTestId("overview-notifications")).toHaveTextContent("Notifications");
      expect(sw()).toHaveAttribute("aria-checked", "true");
      expect(sw()).not.toBeDisabled();
      put({ notify: false });
      cleanupAndRender();
      expect(sw()).toHaveAttribute("aria-checked", "false");
      expect(sw()).not.toBeDisabled();
    });

    it("shows off and disabled while the global switch is off", () => {
      useApp.setState({ me: { ...useApp.getState().me!, user: { ...useApp.getState().me!.user, notificationsEnabled: false } } });
      renderTab();
      expect(sw()).toHaveAttribute("aria-checked", "false");
      expect(sw()).toBeDisabled();
    });

    it("PATCHes notify, flips at once and keeps the hub's answer", async () => {
      mocks.setSessionNotify.mockImplementation(async (_id: string, notify: boolean) => session({ notify }));
      renderTab();
      fireEvent.click(sw());
      expect(sw()).toHaveAttribute("aria-checked", "false");
      expect(mocks.setSessionNotify).toHaveBeenLastCalledWith(SID, false);
      await waitFor(() => expect(useSessions.getState().sessions[SID]?.notify).toBe(false));
      fireEvent.click(sw());
      expect(mocks.setSessionNotify).toHaveBeenLastCalledWith(SID, true);
      expect(sw()).toHaveAttribute("aria-checked", "true");
    });

    it("reverts and tells the user when the PATCH fails", async () => {
      mocks.setSessionNotify.mockRejectedValue(new Error("boom"));
      renderTab();
      fireEvent.click(sw());
      expect(sw()).toHaveAttribute("aria-checked", "false");
      await waitFor(() => expect(sw()).toHaveAttribute("aria-checked", "true"));
      expect(useToasts.getState().toasts.some((x) => x.title.includes("boom"))).toBe(true);
    });
  });

  it("falls back to the hub host from the URL without a hostname (older hub or failed request)", async () => {
    mocks.health.mockResolvedValue({ ok: true });
    renderTab();
    await waitFor(() => expect(mocks.health).toHaveBeenCalled());
    expect(screen.getByTestId("overview-machine")).toHaveTextContent(window.location.hostname);
    mocks.health.mockRejectedValue(new Error("down"));
    renderTab();
    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(2));
    expect(screen.getAllByTestId("overview-machine")[1]).toHaveTextContent(window.location.hostname);
  });

  it("names the workspace root 'Workspace', and has no folder row for Chat", () => {
    renderTab();
    expect(screen.getByTestId("overview-folder")).toHaveTextContent("Workspace");
    put({ kind: "chat", cwd: ".chat" });
    cleanupAndRender();
    expect(screen.queryByTestId("overview-folder")).toBeNull();
  });
});

function cleanupAndRender() {
  document.body.innerHTML = "";
  return renderTab();
}

describe("Context card", () => {
  it("renders the usage line, the stacked bar and one row per category plus free space", () => {
    put({ contextUsage: usage() });
    renderTab();
    const card = screen.getByTestId("overview-context");
    expect(card).toHaveTextContent("26% used");
    expect(card).toHaveTextContent("262.7k / 1M");
    const rows = within(card).getAllByTestId("context-row");
    expect(rows.map((r) => r.dataset.key)).toEqual(["system_prompt", "system_tools", "skills", "memory", "messages", "autocompact_buffer", "free"]);
    expect(rows[4]).toHaveTextContent("Messages");
    expect(rows[4]).toHaveTextContent("236k");
    expect(rows[4]).toHaveTextContent("24%");
    expect(rows[6]).toHaveTextContent("Free space");
    expect(rows[6]).toHaveTextContent("704.3k");
    const segs = Array.from(screen.getByTestId("context-bar").children) as HTMLElement[];
    expect(segs).toHaveLength(6);
    expect(new Set(segs.map((s) => s.style.background)).size).toBe(6);
  });

  it("computes the auto-compact headroom from the buffer: window − used − buffer", () => {
    put({ contextUsage: usage() });
    renderTab();
    expect(screen.getByTestId("context-until-compact")).toHaveTextContent("704.3k until auto-compact");
    expect(tokensUntilCompact(usage())).toBe(704_300);
    expect(tokensUntilCompact(usage({ usedTokens: 990_000 }))).toBe(0);
    expect(tokensUntilCompact(usage({ breakdown: null }))).toBeNull();
    expect(tokensUntilCompact(usage({ breakdown: [{ key: "messages", label: "Messages", tokens: 5 }] }))).toBeNull();
  });

  it("without a breakdown: one Used row, no auto-compact line; <1% for a nearly empty window", () => {
    put({ contextUsage: usage({ breakdown: null, usedTokens: 3_000 }) });
    renderTab();
    const card = screen.getByTestId("overview-context");
    expect(card).toHaveTextContent("<1% used");
    expect(card).toHaveTextContent("3k / 1M");
    expect(within(card).getAllByTestId("context-row").map((r) => r.dataset.key)).toEqual(["used", "free"]);
    expect(screen.getByTestId("context-until-compact")).toBeEmptyDOMElement();
  });

  it("follows a context_usage event", () => {
    put({ contextUsage: usage() });
    renderTab();
    act(() => handleServerEvent({ type: "context_usage", sessionId: SID, usage: usage({ usedTokens: 500_000 }) }));
    expect(screen.getByTestId("overview-context")).toHaveTextContent("50% used");
    expect(screen.getByTestId("context-until-compact")).toHaveTextContent("467k until auto-compact");
  });

  it("Compact session sends /compact to the session", async () => {
    put({ contextUsage: usage() });
    renderTab();
    fireEvent.click(screen.getByTestId("context-compact"));
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith(SID, "/compact"));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("is hidden without usage (null / absent)", () => {
    put({ contextUsage: null });
    renderTab();
    expect(screen.queryByTestId("overview-context")).toBeNull();
    put();
    cleanupAndRender();
    expect(screen.queryByTestId("overview-context")).toBeNull();
  });

  it("contextSegments never reports negative free space", () => {
    expect(contextSegments(usage({ usedTokens: 120, windowTokens: 100, breakdown: [{ key: "messages", label: "Messages", tokens: 120 }] })).freeTokens).toBe(0);
  });
});

describe("Outputs card", () => {
  it("is hidden when nothing changed, and for other sessions' or deleted files and folders", () => {
    renderTab();
    expect(screen.queryByTestId("overview-outputs")).toBeNull();
    act(() => {
      fileEvent("a.txt", "2026-10-31T10:00:00Z", "add", "22222222-2222-4222-8222-222222222222");
      fileEvent("gone.txt", "2026-10-31T10:00:01Z", "unlink");
      fileEvent("dir", "2026-10-31T10:00:02Z", "addDir");
    });
    expect(screen.queryByTestId("overview-outputs")).toBeNull();
  });

  it("lists changed files newest first, five at a time, then Show more", () => {
    renderTab();
    act(() => {
      for (let i = 1; i <= 7; i++) fileEvent(`out/f${i}.md`, `2026-10-31T10:00:0${i}Z`, i === 2 ? "change" : "add");
    });
    const card = screen.getByTestId("overview-outputs");
    expect(within(card).getAllByTestId("overview-output").map((r) => r.textContent)).toEqual(["f7.md", "f6.md", "f5.md", "f4.md", "f3.md"]);
    fireEvent.click(screen.getByTestId("overview-outputs-more"));
    expect(within(card).getAllByTestId("overview-output").map((r) => r.dataset.path)).toEqual(["out/f7.md", "out/f6.md", "out/f5.md", "out/f4.md", "out/f3.md", "out/f2.md", "out/f1.md"]);
    expect(screen.queryByTestId("overview-outputs-more")).toBeNull();
  });

  it("no Show more for five or fewer", () => {
    renderTab();
    act(() => {
      for (let i = 1; i <= 5; i++) fileEvent(`f${i}.md`, `2026-10-31T10:00:0${i}Z`);
    });
    expect(screen.getAllByTestId("overview-output")).toHaveLength(5);
    expect(screen.queryByTestId("overview-outputs-more")).toBeNull();
  });

  it("a click opens the file in the Files tab preview", () => {
    renderTab();
    act(() => fileEvent("out/report.md", "2026-10-31T10:00:00Z"));
    useApp.setState({ rightOpen: false, rightTab: "overview", openFileRequest: null });
    fireEvent.click(screen.getByTestId("overview-output"));
    const s = useApp.getState();
    expect(s.rightOpen).toBe(true);
    expect(s.rightTab).toBe("files");
    expect(s.openFileRequest).toBe("out/report.md");
  });

  it("only counts files under a Code session's folder, and is hidden for Chat", () => {
    put({ cwd: "projects/demo" });
    renderTab();
    act(() => {
      fileEvent("projects/demo/a.ts", "2026-10-31T10:00:00Z");
      fileEvent("projects/other/b.ts", "2026-10-31T10:00:01Z");
    });
    expect(screen.getAllByTestId("overview-output").map((r) => r.dataset.path)).toEqual(["projects/demo/a.ts"]);
    put({ kind: "chat", cwd: ".chat" });
    cleanupAndRender();
    expect(screen.queryByTestId("overview-outputs")).toBeNull();
  });

  describe("from the hub (survives a reload)", () => {
    const rec = (path: string, at: string, missing = false) => ({ path, tool: "Write", turn: 1, at, missing });

    it("renders the recorded outputs on a fresh page, newest first", async () => {
      mocks.sessionOutputs.mockResolvedValue([rec("out/b.md", "2026-10-31T11:00:00Z"), rec("a.txt", "2026-10-31T10:00:00Z")]);
      renderTab();
      await waitFor(() => expect(screen.getAllByTestId("overview-output")).toHaveLength(2));
      expect(mocks.sessionOutputs).toHaveBeenCalledWith(SID);
      expect(screen.getAllByTestId("overview-output").map((r) => r.dataset.path)).toEqual(["out/b.md", "a.txt"]);
    });

    it("merges a live file_event on top: new paths first, unlink marks missing", async () => {
      mocks.sessionOutputs.mockResolvedValue([rec("out/b.md", "2026-10-31T11:00:00Z"), rec("a.txt", "2026-10-31T10:00:00Z")]);
      renderTab();
      await waitFor(() => expect(screen.getAllByTestId("overview-output")).toHaveLength(2));
      act(() => {
        fileEvent("new.md", "2026-10-31T12:00:00Z");
        fileEvent("a.txt", "2026-10-31T12:00:01Z", "unlink");
        fileEvent("never-recorded.md", "2026-10-31T12:00:02Z", "unlink");
      });
      const rows = screen.getAllByTestId("overview-output");
      expect(rows.map((r) => r.dataset.path)).toEqual(["a.txt", "new.md", "out/b.md"]);
      expect(rows.map((r) => r.dataset.missing)).toEqual(["true", undefined, undefined]);
    });

    it("shows missing files struck through and not clickable", async () => {
      mocks.sessionOutputs.mockResolvedValue([rec("gone.md", "2026-10-31T11:00:00Z", true), rec("here.md", "2026-10-31T10:00:00Z")]);
      renderTab();
      await waitFor(() => expect(screen.getAllByTestId("overview-output")).toHaveLength(2));
      const [gone, here] = screen.getAllByTestId("overview-output");
      expect(gone!.className).toContain("line-through");
      expect(gone!.tagName).not.toBe("BUTTON");
      useApp.setState({ rightOpen: false, rightTab: "overview", openFileRequest: null });
      fireEvent.click(gone!);
      expect(useApp.getState().openFileRequest).toBeNull();
      fireEvent.click(here!);
      expect(useApp.getState().openFileRequest).toBe("here.md");
    });

    it("does not ask the hub for a Chat session", () => {
      put({ kind: "chat", cwd: ".chat" });
      renderTab();
      expect(mocks.sessionOutputs).not.toHaveBeenCalled();
    });
  });

  it("sessionOutputs sorts by time, newest first", () => {
    const at = (s: string) => ({ kind: "add" as const, at: s, sessionId: SID });
    expect(sessionOutputs({ a: at("2026-10-31T10:00:00Z"), b: at("2026-10-31T11:00:00Z") }, "").map((o) => o.path)).toEqual(["b", "a"]);
  });
});

describe("Background tasks card", () => {
  const setTasks = (tasks: BackgroundTask[]) => act(() => handleServerEvent({ type: "background_tasks", sessionId: SID, tasks }));

  it("is hidden when the hub reports nothing (older hub) or an empty list", () => {
    renderTab();
    expect(screen.queryByTestId("overview-tasks")).toBeNull();
    setTasks([]);
    expect(screen.queryByTestId("overview-tasks")).toBeNull();
  });

  it("renders one row per task: icon by type, description, elapsed time", () => {
    renderTab();
    setTasks([task({ description: "npm run dev" }), task({ taskId: "t2", type: "local_agent", description: "Explore the repo", startedAt: new Date(Date.now() - 125_000).toISOString() })]);
    const rows = screen.getAllByTestId("overview-task");
    expect(rows.map((r) => r.dataset.taskId)).toEqual(["t1", "t2"]);
    expect(rows[0]!.querySelector("svg")).toHaveClass("lucide-square-terminal");
    expect(rows[1]!.querySelector("svg")).toHaveClass("lucide-bot");
    expect(rows[0]).toHaveTextContent("npm run dev");
    expect(rows[1]).toHaveTextContent("Explore the repo");
    expect(within(rows[1]!).getByTestId("overview-task-elapsed")).toHaveTextContent("2m 5s");
  });

  it("the elapsed time ticks", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    renderTab();
    setTasks([task({ startedAt: "2026-10-31T11:59:30Z" })]);
    expect(screen.getByTestId("overview-task-elapsed")).toHaveTextContent("30s");
    act(() => vi.advanceTimersByTime(35_000));
    expect(screen.getByTestId("overview-task-elapsed")).toHaveTextContent("1m 5s");
  });

  it("stop calls the route; the row leaves when the next background_tasks event arrives", async () => {
    renderTab();
    setTasks([task(), task({ taskId: "t2", description: "tail -f log" })]);
    fireEvent.click(within(screen.getAllByTestId("overview-task")[0]!).getByTestId("overview-task-stop"));
    await waitFor(() => expect(mocks.stopTask).toHaveBeenCalledWith(SID, "t1"));
    expect(screen.getAllByTestId("overview-task")).toHaveLength(2);
    setTasks([task({ taskId: "t2", description: "tail -f log" })]);
    expect(screen.getAllByTestId("overview-task").map((r) => r.dataset.taskId)).toEqual(["t2"]);
    setTasks([]);
    expect(screen.queryByTestId("overview-tasks")).toBeNull();
  });

  it("a failed stop shows a toast and keeps the row", async () => {
    mocks.stopTask.mockRejectedValue(new Error("nope"));
    renderTab();
    setTasks([task()]);
    fireEvent.click(screen.getByTestId("overview-task-stop"));
    await waitFor(() => expect(useToasts.getState().toasts.length).toBe(1));
    expect(screen.getByTestId("overview-task")).toBeInTheDocument();
  });

  describe("finished tasks", () => {
    const NOW = Date.parse("2026-10-31T12:00:00Z");
    const ended = (over: Partial<BackgroundTask>): BackgroundTask =>
      task({ status: "completed", startedAt: "2026-10-31T11:00:00Z", endedAt: "2026-10-31T11:02:05Z", ...over });

    it("splits running rows from finished ones: one 'N finished' row, collapsed", () => {
      renderTab();
      setTasks([task({ taskId: "r1" }), task({ taskId: "r2", status: "running" }), ended({ taskId: "f1" }), ended({ taskId: "f2", status: "failed" })]);
      expect(screen.getAllByTestId("overview-task").map((r) => r.dataset.taskId)).toEqual(["r1", "r2"]);
      expect(screen.getByTestId("overview-tasks-finished")).toHaveTextContent("2 finished");
      expect(screen.queryByTestId("overview-task-finished")).toBeNull();
    });

    it("shows the card when only finished tasks exist", () => {
      renderTab();
      setTasks([ended({ taskId: "f1" })]);
      expect(screen.getByTestId("overview-tasks")).toBeInTheDocument();
      expect(screen.queryByTestId("overview-task")).toBeNull();
      expect(screen.getByTestId("overview-tasks-finished")).toHaveTextContent("1 finished");
    });

    it("has no finished row while everything runs", () => {
      renderTab();
      setTasks([task()]);
      expect(screen.queryByTestId("overview-tasks-finished")).toBeNull();
    });

    it("expands newest first with icon, description, status mark, duration and relative end time", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      renderTab();
      setTasks([
        ended({ taskId: "old", description: "old build", endedAt: "2026-10-31T09:00:30Z", startedAt: "2026-10-31T09:00:00Z" }),
        ended({ taskId: "new", type: "local_agent", description: "Explore the repo", status: "failed", startedAt: "2026-10-31T11:00:00Z", endedAt: "2026-10-31T11:55:00Z" }),
        ended({ taskId: "mid", description: "tail -f log", status: "stopped", startedAt: "2026-10-31T10:00:00Z", endedAt: "2026-10-31T10:00:07Z" }),
      ]);
      fireEvent.click(screen.getByTestId("overview-tasks-finished"));
      const rows = screen.getAllByTestId("overview-task-finished");
      expect(rows.map((r) => r.dataset.taskId)).toEqual(["new", "mid", "old"]);
      expect(rows[0]!.querySelector("svg")).toHaveClass("lucide-bot");
      expect(rows[1]!.querySelector("svg")).toHaveClass("lucide-square-terminal");
      expect(rows[0]).toHaveTextContent("Explore the repo");
      expect(within(rows[0]!).getByTestId("overview-task-mark")).toHaveTextContent("✗");
      expect(within(rows[1]!).getByTestId("overview-task-mark")).toHaveTextContent("■");
      expect(within(rows[2]!).getByTestId("overview-task-mark")).toHaveTextContent("✓");
      expect(within(rows[0]!).getByTestId("overview-task-duration")).toHaveTextContent("55m 0s");
      expect(within(rows[1]!).getByTestId("overview-task-duration")).toHaveTextContent("7s");
      expect(within(rows[2]!).getByTestId("overview-task-duration")).toHaveTextContent("30s");
      expect(within(rows[0]!).getByTestId("overview-task-ended")).toHaveTextContent("5m ago");
      expect(within(rows[2]!).getByTestId("overview-task-ended")).toHaveTextContent("3h ago");
      fireEvent.click(screen.getByTestId("overview-tasks-finished"));
      expect(screen.queryByTestId("overview-task-finished")).toBeNull();
    });
  });

  it("starts from the snapshot's list", () => {
    renderTab();
    act(() => handleServerEvent({ type: "snapshot", sessionId: SID, snapshot: { session: session(), partial: { messageId: null, text: "", thinking: "", currentTool: null }, pendingPermission: null, backgroundTasks: [task()] } }));
    expect(screen.getAllByTestId("overview-task")).toHaveLength(1);
  });
});

describe("collapsing", () => {
  it("collapses a card from its header and remembers it per card", () => {
    put({ cwd: "projects/demo", contextUsage: usage() });
    const { unmount } = renderTab();
    expect(screen.getByTestId("overview-environment-toggle")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByTestId("overview-environment-toggle"));
    expect(screen.getByTestId("overview-environment-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("overview-machine")).toBeNull();
    expect(JSON.parse(localStorage.getItem("workstation.overviewCollapsed")!)).toEqual({ environment: true });
    // the other card is untouched
    expect(screen.getByTestId("context-bar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("overview-context-toggle"));
    expect(JSON.parse(localStorage.getItem("workstation.overviewCollapsed")!)).toEqual({ environment: true, context: true });

    unmount();
    renderTab();
    expect(screen.getByTestId("overview-environment-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("overview-context-toggle")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByTestId("overview-environment-toggle"));
    expect(screen.getByTestId("overview-machine")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("workstation.overviewCollapsed")!)).toEqual({ environment: false, context: true });
  });
});

describe("order", () => {
  it("environment, context, outputs, background tasks", () => {
    put({ contextUsage: usage() });
    renderTab();
    act(() => {
      fileEvent("a.txt", "2026-10-31T10:00:00Z");
      handleServerEvent({ type: "background_tasks", sessionId: SID, tasks: [task()] });
    });
    const ids = Array.from(screen.getByTestId("overview-tab").children).map((c) => (c as HTMLElement).dataset.testid);
    expect(ids).toEqual(["overview-environment", "overview-context", "overview-outputs", "overview-tasks"]);
  });
});
