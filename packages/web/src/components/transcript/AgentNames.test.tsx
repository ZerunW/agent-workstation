import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, session, SID, stored, userText } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { agentName } from "../../lib/agent";
import { buildTranscript } from "../../lib/transcript";
import { emptyView, insertMessages, type SessionView } from "../../lib/session-reducer";

vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));
vi.mock("../../store/actions", () => ({ patchSettings: vi.fn() }));

import { useSessions } from "../../store/sessions";
import { Transcript } from "./Transcript";

const died = (seq: number, error: string) => stored(seq, "system", { type: "system", subtype: "hub_process_died", error });
const viewOf = (messages: ReturnType<typeof userText>[]): SessionView => ({ ...insertMessages(emptyView(SID, session({})), messages), snapshotReceived: true });
const renderTx = (view: SessionView) =>
  render(
    <TestRouter>
      <Transcript view={view} />
    </TestRouter>,
  );

beforeEach(() => useSessions.setState({ sessions: {}, views: {}, listLoaded: true }));

describe("agentName", () => {
  it("is Claude", () => {
    expect(agentName()).toBe("Claude");
  });
});

describe("transcript copy names the session's agent", () => {
  it("'process stopped' says Claude", () => {
    renderTx(viewOf([userText(1, "go"), died(2, "boom")]));
    expect(screen.getByTestId("hub-notice")).toHaveTextContent("Claude's process stopped unexpectedly (boom)");
  });

  it("buildTranscript defaults to Claude and takes the agent from its caller", () => {
    const messages = [died(2, "x")];
    expect(buildTranscript(messages).items[0]).toMatchObject({ text: expect.stringContaining("Claude's process") });
    expect(buildTranscript(messages, { agent: "Agent" }).items[0]).toMatchObject({ text: expect.stringContaining("Agent's process") });
  });

  it("an authentication error points at the API key", () => {
    const err = assistant(2, [{ type: "text", text: "Invalid key" }], { error: "authentication_failed" });
    renderTx(viewOf([userText(1, "go"), err]));
    expect(screen.getByTestId("assistant-error")).toHaveTextContent("Authentication failed: check the API key on the server");
  });

  it("a server error names the agent, and unrelated errors are unchanged", () => {
    const a = renderTx(viewOf([userText(1, "go"), assistant(2, [{ type: "text", text: "" }], { error: "server_error" })]));
    expect(screen.getByTestId("assistant-error")).toHaveTextContent("Claude API server error");
    a.unmount();
    renderTx(viewOf([userText(1, "go"), assistant(2, [{ type: "text", text: "" }], { error: "billing_error" })]));
    expect(screen.getByTestId("assistant-error")).toHaveTextContent("Billing error");
  });
});

describe("permission cards inside the transcript", () => {
  const request = { requestId: "r1", sessionId: SID, toolName: "Bash", input: { command: "ls" }, at: "2026-10-31T00:00:00.000Z" };
  const withPermission = (): SessionView => ({ ...viewOf([userText(1, "list files")]), permissions: [{ request, status: "pending", local: null, elsewhere: false, afterSeq: 1 }] });

  it("a Code session asks 'Claude wants to use Bash'", () => {
    renderTx(withPermission());
    expect(screen.getByTestId("permission-title")).toHaveTextContent("Claude wants to use Bash");
  });
});
