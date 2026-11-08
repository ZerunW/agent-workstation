import type { BackgroundTask, PermissionRequest } from "@agent-workstation/protocol";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, type PermissionEntry, type SessionView } from "../../lib/session-reducer";

const mocks = vi.hoisted(() => ({ session: vi.fn(), messages: vi.fn(), subscribe: vi.fn(), release: vi.fn(), sendPermissionResponse: vi.fn() }));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, session: mocks.session, messages: mocks.messages } };
});
vi.mock("../../store/hub", () => ({
  sendPermissionResponse: mocks.sendPermissionResponse,
  backfill: vi.fn(),
  loadEarlier: vi.fn(),
  subscribeSession: (id: string) => {
    mocks.subscribe(id);
    return mocks.release;
  },
}));

import { SUBAGENTS_TOOL, parseSubagentResult, parseSubagentsResult } from "../../lib/subagent";
import { useSessions } from "../../store/sessions";
import { useSubagentFocus } from "../../store/subagentFocus";
import { OverviewTab } from "../overview/OverviewTab";
import { PermissionCard } from "./PermissionCard";
import { Transcript } from "./Transcript";

const CHILD = "22222222-2222-4222-8222-222222222222";
const CHILD2 = "33333333-3333-4333-8333-333333333333";
const CHILD3 = "44444444-4444-4444-8444-444444444444";
const batch = (id: string, agents: Record<string, unknown>[]) => ({ type: "tool_use", id, name: SUBAGENTS_TOOL, input: { agents } });
const SONNET = { task: "Read the sync engine", model: "claude-sonnet-5-5", description: "Audit the sync engine" };
const CLAUDE = { task: "Write the tests", model: "claude-haiku-5-5", description: "Write the tests" };
const OPUS = { task: "Review the diff\nand list the risks", model: "claude-opus-5-5", description: "Review the diff" };
const section = (id: string | null, text: string) => `${id ? `session: ${id}\n\n` : ""}${text}`;
const SEP = "\n--- subagent ---\n";
const answer = (text = "Two conflicts are resolved by the newer mtime.") => section(CHILD, text);

const viewWith = (messages: ReturnType<typeof userText>[], status: "idle" | "running" = "idle", permissions: PermissionEntry[] = []): SessionView => ({ ...insertMessages(emptyView(SID, session({ status })), messages), snapshotReceived: true, permissions });
const child = (id: string, seq: number, m: ReturnType<typeof userText>) => ({ ...m, seq, sessionId: id });

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({ requestId: "r1", sessionId: SID, toolName: "Bash", input: { command: "npm test" }, at: "2026-10-31T00:00:00.000Z", ...over });
const entry = (r: PermissionRequest, status: PermissionEntry["status"] = "pending"): PermissionEntry => ({ request: r, status, local: null, elsewhere: false, afterSeq: 0 });
const approval = (agents: Record<string, unknown>[], toolUseId = "a") => request({ toolName: SUBAGENTS_TOOL, input: { agents }, toolUseId });

function mount(view: SessionView, withOverview = false) {
  useSessions.setState({ sessions: { [SID]: view.session! }, views: { [SID]: view }, listLoaded: true });
  return render(
    <TestRouter>
      <Transcript view={view} />
      {withOverview && <OverviewTab sessionId={SID} />}
    </TestRouter>,
  );
}
const tasks = (list: BackgroundTask[]) => act(() => useSessions.getState().dispatch(SID, { type: "background_tasks", sessionId: SID, tasks: list }));
const runningTask = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({ taskId: CHILD, type: "workstation_subagent", description: "Audit the sync engine", subagentType: "claude:claude-sonnet-5-5", startedAt: new Date().toISOString(), ...over });
const openGroup = () => userEvent.click(within(screen.getByTestId("tool-group")).getAllByRole("button")[0]!);
const rowButton = (i: number) => within(screen.getAllByTestId("subagent-row")[i]!).getAllByRole("button")[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  useSessions.getState().reset();
  useSubagentFocus.getState().clear();
  mocks.session.mockImplementation(async (id: string) => session({ id, parentSessionId: SID, model: "claude-sonnet-5-5", status: "idle" }));
  mocks.messages.mockImplementation(async (id: string) => [
    child(id, 1, userText(1, `Task of ${id.slice(0, 2)}`)),
    child(id, 2, assistant(2, [{ type: "text", text: `Reading the conflict resolver now (${id.slice(0, 2)}).` }])),
  ]);
});
afterEach(cleanup);

describe("parseSubagentResult", () => {
  it("splits the session line, the answer and the Files line", () => {
    expect(parseSubagentResult(`session: ${CHILD}\n\nDone.\n\nMore.\nFiles: a.ts, b/c.md`)).toEqual({ sessionId: CHILD, answer: "Done.\n\nMore.", files: ["a.ts", "b/c.md"] });
  });
  it("an error result may carry the line too, or none", () => {
    expect(parseSubagentResult(`session: ${CHILD}\n\nThe agent could not start`)).toMatchObject({ sessionId: CHILD, answer: "The agent could not start" });
    expect(parseSubagentResult("unknown backend")).toEqual({ sessionId: null, answer: "unknown backend", files: [] });
  });
});

describe("parseSubagentsResult", () => {
  it("splits sections on the separator line, in order", () => {
    const text = [section(CHILD, "First.\nFiles: a.ts"), section(null, "The agent could not start"), section(CHILD3, "Third.")].join(SEP);
    expect(parseSubagentsResult(text)).toEqual([
      { sessionId: CHILD, answer: "First.", files: ["a.ts"] },
      { sessionId: null, answer: "The agent could not start", files: [] },
      { sessionId: CHILD3, answer: "Third.", files: [] },
    ]);
  });
  it("one section without a separator", () => {
    expect(parseSubagentsResult(answer("Done."))).toEqual([{ sessionId: CHILD, answer: "Done.", files: [] }]);
  });
});

describe("approval card", () => {
  const card = (agents: Record<string, unknown>[]) => render(<PermissionCard entry={entry(approval(agents))} sessionId={SID} />);

  it("one agent: 'Start a subagent?' with its row", () => {
    card([SONNET]);
    expect(screen.getByTestId("subagents-title")).toHaveTextContent("Start a subagent?");
    const rows = screen.getAllByTestId("approval-agent");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByTestId("approval-description")).toHaveTextContent("Audit the sync engine");
    expect(within(rows[0]!).getByTestId("approval-model")).toHaveTextContent("Sonnet 5.5");
  });

  it("three agents: 'Start 3 subagents?', one row each with a model chip and the task on one line", async () => {
    card([SONNET, CLAUDE, OPUS]);
    expect(screen.getByTestId("subagents-title")).toHaveTextContent("Start 3 subagents?");
    const rows = screen.getAllByTestId("approval-agent");
    expect(rows.map((r) => within(r).getByTestId("approval-description").textContent)).toEqual(["Audit the sync engine", "Write the tests", "Review the diff"]);
    expect(rows.map((r) => within(r).getByTestId("approval-model").textContent)).toEqual(["Sonnet 5.5", "Haiku 5.5", "Opus 5.5"]);
    const task = within(rows[2]!).getByTestId("approval-task");
    expect(task).toHaveAttribute("data-open", "false");
    expect(task).toHaveTextContent("Review the diff and list the risks"); // collapsed to one line
    expect(task.textContent).not.toContain("\n");
  });

  it("clicking a row expands the full task, again collapses it", async () => {
    card([SONNET, OPUS]);
    const row = screen.getAllByTestId("approval-agent")[1]!;
    await userEvent.click(within(row).getByRole("button"));
    const task = within(row).getByTestId("approval-task");
    expect(task).toHaveAttribute("data-open", "true");
    expect(task.textContent).toBe("Review the diff\nand list the risks");
    expect(within(screen.getAllByTestId("approval-agent")[0]!).getByTestId("approval-task")).toHaveAttribute("data-open", "false");
    await userEvent.click(within(row).getByRole("button"));
    expect(within(row).getByTestId("approval-task")).toHaveAttribute("data-open", "false");
  });

  it("Start allows and Don't start denies, nothing else", async () => {
    card([SONNET, CLAUDE]);
    expect(screen.getByTestId("subagents-start")).toHaveTextContent("Start");
    expect(screen.getByTestId("subagents-skip")).toHaveTextContent("Don't start");
    await userEvent.click(screen.getByTestId("subagents-start"));
    expect(mocks.sendPermissionResponse).toHaveBeenCalledTimes(1);
    expect(mocks.sendPermissionResponse).toHaveBeenLastCalledWith(SID, { requestId: "r1", behavior: "allow" });
    cleanup();

    card([SONNET, CLAUDE]);
    await userEvent.click(screen.getByTestId("subagents-skip"));
    expect(mocks.sendPermissionResponse).toHaveBeenLastCalledWith(SID, { requestId: "r1", behavior: "deny" });
  });

  it("shows each agent's paths as chips; no chips without paths", () => {
    card([{ ...SONNET, paths: ["src/web/**", "README.md"] }, CLAUDE]);
    const rows = screen.getAllByTestId("approval-agent");
    expect(within(rows[0]!).getAllByTestId("agent-path").map((c) => c.textContent)).toEqual(["src/web/**", "README.md"]);
    expect(within(rows[1]!).queryByTestId("agent-paths")).toBeNull();
  });

  it("shows at most 6 chips; +N expands the rest", async () => {
    card([{ ...SONNET, paths: ["a/**", "b/**", "c/**", "d/**", "e/**", "f/**", "g/**", "h/**"] }]);
    expect(screen.getAllByTestId("agent-path")).toHaveLength(6);
    await userEvent.click(screen.getByTestId("agent-paths-more"));
    expect(screen.getAllByTestId("agent-path").map((c) => c.textContent)).toEqual(["a/**", "b/**", "c/**", "d/**", "e/**", "f/**", "g/**", "h/**"]);
    expect(screen.queryByTestId("agent-paths-more")).toBeNull();
  });

  it("warns on both rows when patterns are identical, naming the other agent", () => {
    card([{ ...SONNET, paths: ["src/**"] }, { ...CLAUDE, paths: ["src/**"] }, { ...OPUS, paths: ["docs/**"] }]);
    const rows = screen.getAllByTestId("approval-agent");
    expect(within(rows[0]!).getByTestId("approval-overlap")).toHaveAttribute("title", "Overlaps Write the tests");
    expect(within(rows[1]!).getByTestId("approval-overlap")).toHaveAttribute("title", "Overlaps Audit the sync engine");
    expect(within(rows[2]!).queryByTestId("approval-overlap")).toBeNull();
  });

  it("warns when one pattern is a directory prefix of the other", () => {
    card([{ ...SONNET, paths: ["src"] }, { ...CLAUDE, paths: ["src/web/**/*.ts"] }]);
    expect(screen.getAllByTestId("approval-overlap")).toHaveLength(2);
  });

  it("does not warn for disjoint patterns", () => {
    card([{ ...SONNET, paths: ["src/web/**", "README.md"] }, { ...CLAUDE, paths: ["src/hub/**", "docs/*.md", "src/web2/**"] }, { ...OPUS, paths: ["src/*.ts"] }]);
    expect(screen.queryByTestId("approval-overlap")).toBeNull();
  });

  it("offers no always-allow, edit or deny-reason options", () => {
    card([SONNET, CLAUDE, OPUS]);
    expect(screen.queryByText(/always/i)).toBeNull();
    for (const id of ["perm-always", "perm-allow", "perm-deny", "perm-edit", "site-always"]) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getAllByRole("button").filter((b) => b.getAttribute("data-testid")?.startsWith("subagents-"))).toHaveLength(2);
  });

  it("after answering it waits for the hub", () => {
    render(<PermissionCard entry={{ ...entry(approval([SONNET])), local: "allow" }} sessionId={SID} />);
    expect(screen.getByText("Sending answer…")).toBeInTheDocument();
    expect(screen.queryByTestId("subagents-start")).toBeNull();
  });

  it("is the card of the pending request in the transcript, and stands in for the call", () => {
    const view = viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET, CLAUDE])])], "running", [entry(approval([SONNET, CLAUDE]))]);
    mount(view);
    expect(screen.getByTestId("subagents-card")).toBeInTheDocument();
    expect(screen.queryByTestId("permission-card")).toBeNull();
    expect(screen.queryByTestId("tool-group")).toBeNull();
  });
});

describe("subagent groups", () => {
  it("done: '<n> subagents'", () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET, CLAUDE, OPUS])]), toolResult(3, "a", [section(CHILD, "a"), section(CHILD2, "b"), section(CHILD3, "c")].join(SEP))]));
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("3 subagents");
    expect(screen.getByTestId("tool-group")).toHaveAttribute("data-state", "done");
    expect(screen.queryByTestId("tool-group-running")).toBeNull();
    expect(screen.queryByTestId("tool-group-failed")).toBeNull();
  });

  it("one agent reads '1 subagent'", () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET])]), toolResult(3, "a", answer())]));
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("1 subagent");
  });

  it("live: a spinner and 'Running…'", async () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET, CLAUDE])])], "running"));
    const group = screen.getByTestId("tool-group");
    expect(group).toHaveAttribute("data-state", "running");
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("2 subagents");
    expect(screen.getByTestId("tool-group-running")).toHaveTextContent("Running…");
    expect(within(group).getAllByLabelText("Running…").length).toBeGreaterThan(0);
    await openGroup();
    expect(screen.getAllByTestId("subagent-row")).toHaveLength(2);
    for (const row of screen.getAllByTestId("subagent-row")) expect(row).toHaveAttribute("data-state", "live");
    expect(screen.getAllByTestId("subagent-running")[0]).toHaveTextContent("Running…");
  });

  it("declined: 'Subagents not started', no failure mark, the approval row is not repeated", async () => {
    const perm = entry(approval([SONNET, CLAUDE]), "denied");
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET, CLAUDE])]), toolResult(3, "a", "The user doesn't want to proceed with this tool use.", true)], "idle", [perm]));
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Subagents not started");
    expect(screen.getByTestId("tool-group")).toHaveAttribute("data-state", "done");
    expect(screen.queryByTestId("tool-group-failed")).toBeNull();
    await openGroup();
    expect(screen.queryByTestId("permission-resolved")).toBeNull();
    const rows = screen.getAllByTestId("subagent-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-state", "skipped");
    expect(screen.queryByTestId("subagent-transcript")).toBeNull();
  });

  it("an error before any child existed also reads 'not started' and shows its text once", async () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET, CLAUDE])]), toolResult(3, "a", "Too many agents are already running", true)]));
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("Subagents not started");
    await openGroup();
    expect(screen.getAllByTestId("subagent-row")).toHaveLength(2);
    expect(screen.getByTestId("subagents-error")).toHaveTextContent("Too many agents are already running");
    expect(mocks.messages).not.toHaveBeenCalled();
  });

  it("a section without a session line failed; the others are done", async () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET, CLAUDE])]), toolResult(3, "a", [section(CHILD, "Fine."), section(null, "The agent could not start")].join(SEP))]));
    expect(screen.getByTestId("tool-group-text")).toHaveTextContent("2 subagents");
    await openGroup();
    const rows = screen.getAllByTestId("subagent-row");
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["done", "failed"]);
    await userEvent.click(rowButton(1));
    expect(screen.getByTestId("subagent-answer")).toHaveTextContent("The agent could not start");
    expect(screen.queryByTestId("subagent-transcript")).toBeNull();
    expect(mocks.messages).not.toHaveBeenCalled();
  });
});

describe("rows and their children", () => {
  const twoDone = () => mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET, CLAUDE, OPUS])]), toolResult(3, "a", [section(CHILD, "Answer one.\nFiles: src/sync.ts, notes.md"), section(CHILD2, "Answer two."), section(CHILD3, "Answer three.")].join(SEP))]));

  it("each row has its agent's icon, description and model chip", async () => {
    twoDone();
    await openGroup();
    const rows = screen.getAllByTestId("subagent-row");
    expect(rows.map((r) => within(r).getByTestId("subagent-label").textContent)).toEqual(["Audit the sync engine", "Write the tests", "Review the diff"]);
    expect(rows.map((r) => within(r).getByTestId("subagent-model").textContent)).toEqual(["Sonnet 5.5", "Haiku 5.5", "Opus 5.5"]);
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["done", "done", "done"]);
    expect(screen.queryByTestId("subagent-transcript")).toBeNull();
    expect(mocks.messages).not.toHaveBeenCalled();
  });

  it("an opened row shows its paths as chips", async () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [{ ...SONNET, paths: ["src/sync/**", "notes.md"] }, CLAUDE])]), toolResult(3, "a", [section(CHILD, "One."), section(CHILD2, "Two.")].join(SEP))]));
    await openGroup();
    expect(screen.queryByTestId("agent-paths")).toBeNull(); // collapsed rows show none
    await userEvent.click(rowButton(0));
    expect(within(screen.getAllByTestId("subagent-row")[0]!).getAllByTestId("agent-path").map((c) => c.textContent)).toEqual(["src/sync/**", "notes.md"]);
    await userEvent.click(rowButton(1));
    expect(within(screen.getAllByTestId("subagent-row")[1]!).queryByTestId("agent-paths")).toBeNull();
  });

  it("rows map to the children of their result sections, in order", async () => {
    twoDone();
    await openGroup();
    await userEvent.click(rowButton(1));
    let tx = await screen.findByTestId("subagent-transcript");
    expect(tx).toHaveAttribute("data-session", CHILD2);
    expect(await within(tx).findByText("Reading the conflict resolver now (33).")).toBeInTheDocument();
    expect(screen.getByTestId("subagent-answer")).toHaveTextContent("Answer two.");
    expect(mocks.messages).toHaveBeenCalledTimes(1);
    expect(mocks.messages).toHaveBeenCalledWith(CHILD2, 0, 500);
    expect(mocks.subscribe).toHaveBeenCalledWith(CHILD2);

    await userEvent.click(rowButton(0));
    const txs = screen.getAllByTestId("subagent-transcript");
    expect(txs.map((x) => x.getAttribute("data-session"))).toEqual([CHILD, CHILD2]);
    tx = txs[0]!;
    expect(await within(tx).findByText("Reading the conflict resolver now (22).")).toBeInTheDocument();
    const ans = within(screen.getAllByTestId("subagent-row")[0]!).getByTestId("subagent-answer");
    expect(ans).toHaveTextContent("Answer one.");
    expect(ans).not.toHaveTextContent("session:");
    expect(within(screen.getAllByTestId("subagent-row")[0]!).getByTestId("subagent-files")).toHaveTextContent("src/sync.ts, notes.md");
    // the answer sits under the transcript; read-only: no composer or permission card inside
    expect(tx.compareDocumentPosition(ans) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tx).queryByRole("textbox")).toBeNull();
    expect(within(tx).queryByTestId("permission-card")).toBeNull();
  });

  it("while running each row finds its child from the task with the same description", async () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [{ ...SONNET, model: undefined }, CLAUDE])])], "running"));
    tasks([runningTask({ taskId: CHILD2, description: "Write the tests", subagentType: "claude:claude-haiku-5-5" }), runningTask(), runningTask({ taskId: "other", description: "Something else" })]);
    await openGroup();
    await userEvent.click(rowButton(1));
    await userEvent.click(rowButton(0));
    const txs = screen.getAllByTestId("subagent-transcript");
    expect(txs.map((x) => x.getAttribute("data-session"))).toEqual([CHILD, CHILD2]);
    expect(mocks.subscribe).toHaveBeenCalledWith(CHILD);
    expect(mocks.subscribe).toHaveBeenCalledWith(CHILD2);
    // no model in the call: the task's subagent type names it
    expect(within(screen.getAllByTestId("subagent-row")[0]!).getByTestId("subagent-model")).toHaveTextContent("Sonnet 5.5");
    expect(screen.queryByTestId("subagent-answer")).toBeNull();

    // the child streams on: a new message shows up without reopening
    act(() => useSessions.getState().dispatch(CHILD2, { type: "message", sessionId: CHILD2, message: child(CHILD2, 3, assistant(3, [{ type: "text", text: "Found two conflict paths." }])) }));
    expect(await within(txs[1]!).findByText("Found two conflict paths.")).toBeInTheDocument();
  });

  it("agents sharing a description take the tasks in order; one not yet started has no child", async () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [CLAUDE, { ...CLAUDE, task: "Other half" }, { ...CLAUDE, task: "Queued" }])])], "running"));
    tasks([runningTask({ taskId: CHILD, description: "Write the tests" }), runningTask({ taskId: CHILD2, description: "Write the tests" })]);
    await openGroup();
    for (const i of [0, 1, 2]) await userEvent.click(rowButton(i));
    const rows = screen.getAllByTestId("subagent-row");
    expect(rows.map((r) => r.getAttribute("data-session"))).toEqual([CHILD, CHILD2, CHILD2]);
  });

  it("once the result is in, the task no longer stands in for a child", async () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [SONNET])]), toolResult(3, "a", section(null, "The agent could not start"))]));
    tasks([runningTask()]);
    await openGroup();
    await userEvent.click(rowButton(0));
    expect(screen.queryByTestId("subagent-transcript")).toBeNull();
  });
});

describe("Overview tasks card", () => {
  it("a subagent task's link opens the matching expanded row", async () => {
    mount(viewWith([userText(1, "go"), assistant(2, [batch("a", [CLAUDE, SONNET])])], "running"), true);
    tasks([runningTask(), { taskId: "bash1", type: "local_bash", description: "npm run dev", startedAt: new Date().toISOString() }]);

    const rows = screen.getAllByTestId("overview-task");
    const sub = rows.find((r) => r.getAttribute("data-type") === "workstation_subagent")!;
    expect(screen.queryByTestId("subagent-row")).toBeNull();

    await userEvent.click(within(sub).getByTestId("overview-task-link"));
    expect(screen.getByTestId("tool-group")).toHaveAttribute("data-open", "true");
    const open = (await screen.findAllByTestId("subagent-row")).filter((r) => within(r).getAllByRole("button")[0]!.getAttribute("aria-expanded") === "true");
    expect(open).toHaveLength(1);
    expect(open[0]).toHaveAttribute("data-description", "Audit the sync engine");
    expect(await screen.findByTestId("subagent-transcript")).toHaveAttribute("data-session", CHILD);
    expect(useSubagentFocus.getState().focus).toBeNull();
  });
});

describe("forwarded permission cards", () => {
  const forwarded = (over: Partial<PermissionRequest> = {}): PermissionRequest => request({ subagent: { sessionId: CHILD, description: "Audit the sync engine" }, ...over });

  it("is labelled from request.subagent and answers on the parent session", async () => {
    useSessions.setState({ sessions: { [SID]: session() }, views: {}, listLoaded: true });
    render(<PermissionCard entry={entry(forwarded())} sessionId={SID} />);
    expect(screen.getByTestId("permission-subagent")).toHaveTextContent("Claude subagent · Audit the sync engine");
    expect(screen.getByTestId("permission-title")).toHaveTextContent("Claude wants to use Bash");
    await userEvent.click(screen.getByTestId("perm-allow"));
    expect(mocks.sendPermissionResponse).toHaveBeenCalledWith(SID, { requestId: "r1", behavior: "allow" });
  });

  it("a plain request has no subagent label", () => {
    useSessions.setState({ sessions: { [SID]: session() }, views: {}, listLoaded: true });
    render(<PermissionCard entry={entry(request())} sessionId={SID} />);
    expect(screen.queryByTestId("permission-subagent")).toBeNull();
  });

  it("shows in the parent's transcript as a pending card", () => {
    mount(viewWith([userText(1, "go")], "running", [entry(forwarded())]));
    expect(screen.getByTestId("permission-subagent")).toHaveTextContent("Claude subagent · Audit the sync engine");
  });
});
