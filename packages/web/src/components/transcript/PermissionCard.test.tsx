import type { PermissionRequest } from "@agent-workstation/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../../test/fixtures";
import type { PermissionEntry } from "../../lib/session-reducer";

const sendPermissionResponse = vi.fn();
vi.mock("../../store/hub", () => ({ sendPermissionResponse: (...a: unknown[]) => sendPermissionResponse(...a) }));

import { useSessions } from "../../store/sessions";
import { PermissionCard } from "./PermissionCard";

const request: PermissionRequest = { requestId: "r1", sessionId: SID, toolName: "Bash", input: { command: "ls -la", description: "List files" }, at: "2026-10-31T00:00:00.000Z" };
const entry = (over: Partial<PermissionEntry> = {}): PermissionEntry => ({ request, status: "pending", local: null, elsewhere: false, afterSeq: 0, ...over });
const seed = () => useSessions.setState({ sessions: { [SID]: session() }, views: {}, listLoaded: true });

beforeEach(() => {
  sendPermissionResponse.mockClear();
  seed();
});

describe("PermissionCard names the session's agent", () => {
  it("asks 'Claude wants to use Bash' (header and accessible name)", () => {
    render(<PermissionCard entry={entry()} sessionId={SID} />);
    expect(screen.getByTestId("permission-title")).toHaveTextContent("Claude wants to use Bash");
    expect(screen.getByRole("group", { name: "Claude wants to use Bash" })).toBe(screen.getByTestId("permission-card"));
  });

  it("an unknown session also says Claude", () => {
    useSessions.setState({ sessions: {}, views: {} });
    render(<PermissionCard entry={entry()} sessionId={SID} />);
    expect(screen.getByTestId("permission-title")).toHaveTextContent("Claude wants to use Bash");
  });

  it("the tool's own name stays as it is (MCP tools too)", () => {
    render(<PermissionCard entry={entry({ request: { ...request, toolName: "mcp__github__create_issue", input: { title: "x" } } })} sessionId={SID} />);
    expect(screen.getByTestId("permission-title")).toHaveTextContent("Claude wants to use github · create_issue");
  });

  it("the deny reason is a plain optional field without agent explanation", async () => {
    render(<PermissionCard entry={entry()} sessionId={SID} />);
    await userEvent.click(screen.getByTestId("perm-deny"));
    expect(screen.getByPlaceholderText("Reason (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Reason (optional)")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Claude/)).toBeNull();
  });

  it("still answers through the hub", async () => {
    render(<PermissionCard entry={entry()} sessionId={SID} />);
    await userEvent.click(screen.getByTestId("perm-allow"));
    expect(sendPermissionResponse).toHaveBeenCalledWith(SID, { requestId: "r1", behavior: "allow" });
  });
});

describe("PermissionCard for a browser site", () => {
  const site: PermissionRequest = { ...request, toolName: "mcp__browser__browser_navigate", input: { url: "https://github.com/anthropics" }, browserSite: { origin: "https://github.com" } };

  it("asks about the host (full origin in the tooltip) and does not show the tool input", () => {
    render(<PermissionCard entry={entry({ request: site })} sessionId={SID} />);
    expect(screen.getByTestId("site-title")).toHaveTextContent("Use the browser on github.com?");
    expect(screen.getByRole("group", { name: "Use the browser on github.com?" })).toBeInTheDocument();
    expect(screen.getByTitle("https://github.com")).toBeInTheDocument();
    expect(screen.queryByTestId("permission-card")).toBeNull();
    expect(screen.queryByText(/anthropics/)).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow this session", "Always allow", "Deny"]);
  });

  it("keeps the port in the host", () => {
    render(<PermissionCard entry={entry({ request: { ...site, browserSite: { origin: "http://localhost:3000" } } })} sessionId={SID} />);
    expect(screen.getByTestId("site-title")).toHaveTextContent("Use the browser on localhost:3000?");
  });

  it("Allow this session allows, Always allow remembers for the user, Deny denies", async () => {
    render(<PermissionCard entry={entry({ request: site })} sessionId={SID} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow this session" }));
    expect(sendPermissionResponse).toHaveBeenLastCalledWith(SID, { requestId: "r1", behavior: "allow" });
    await userEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(sendPermissionResponse).toHaveBeenLastCalledWith(SID, { requestId: "r1", behavior: "allow", remember: "user" });
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(sendPermissionResponse).toHaveBeenLastCalledWith(SID, { requestId: "r1", behavior: "deny" });
    expect(sendPermissionResponse).toHaveBeenCalledTimes(3);
  });

  it("is operable from the keyboard", async () => {
    render(<PermissionCard entry={entry({ request: site })} sessionId={SID} />);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Allow this session" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(sendPermissionResponse).toHaveBeenCalledWith(SID, { requestId: "r1", behavior: "allow" });
  });

  it("shows 'Sending answer…' instead of the buttons once answered here", () => {
    render(<PermissionCard entry={entry({ request: site, local: "allow" })} sessionId={SID} />);
    expect(screen.getByText("Sending answer…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an answered request is one muted row: Allowed / Denied <host>", () => {
    const a = render(<PermissionCard entry={entry({ request: site, status: "allowed" })} sessionId={SID} />);
    expect(screen.getByTestId("permission-resolved")).toHaveTextContent(/^Allowed github\.com$/);
    expect(screen.getByTestId("permission-resolved")).toHaveAttribute("data-status", "allowed");
    a.unmount();
    render(<PermissionCard entry={entry({ request: site, status: "denied", elsewhere: true })} sessionId={SID} />);
    expect(screen.getByTestId("permission-resolved")).toHaveTextContent(/^Denied github\.com$/);
  });
});
