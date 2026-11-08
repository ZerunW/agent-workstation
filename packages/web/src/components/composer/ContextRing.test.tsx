import type { ContextUsage, UsageLimits } from "@agent-workstation/protocol";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../../test/fixtures";
import { TooltipProvider } from "../ui/overlays";

vi.mock("../../store/actions", () => ({
  sendMessage: vi.fn(),
  stopSession: vi.fn(),
  createSession: vi.fn(),
  patchSettings: vi.fn(),
}));

import { handleServerEvent } from "../../store/hub";
import { useApp } from "../../store/app";
import { useComposer } from "../../store/composer";
import { useSessions } from "../../store/sessions";
import { Composer } from "./Composer";
import { ringTone } from "./ContextRing";

const usage = (usedTokens: number, over: Partial<ContextUsage> = {}): ContextUsage => ({ usedTokens, windowTokens: 1_000_000, model: null, breakdown: null, updatedAt: "2026-11-01T12:00:00.000Z", ...over });
const credits = (percent: number, spentUsd = 12): NonNullable<UsageLimits["api"]> => ({ spentUsd, limitUsd: 100, percent, periodStart: "2026-01-01T00:00:00.000Z", resetsAt: "2026-02-01T00:00:00.000Z", severity: "normal" });
const limits = (api: UsageLimits["api"] = credits(12)): UsageLimits => ({ api });
const API_LIMITS = limits();

function setup(o: { usage?: ContextUsage | null; session?: Parameters<typeof session>[0]; limits?: UsageLimits | null } = {}) {
  useApp.setState({
    mode: "chat",
    me: {
      user: { name: "alice", enabled: true, modelAllowlist: null, defaultModel: null, defaultEffort: null },
      settings: { remoteClaudeEnabled: true, defaultModel: "claude-opus-5-5", defaultEffort: "high" },
      disk: "ok",
      apiAvailable: true,
    } as never,
    models: [],
    modelsLoaded: true,
    disk: null,
    sendBlock: null,
    limits: o.limits === undefined ? API_LIMITS : o.limits,
  });
  useComposer.setState({ drafts: {}, newSettings: {}, newCwd: "", newIncognito: false });
  useSessions.setState({
    sessions: { [SID]: session({ kind: "chat", ...(o.usage === null ? {} : { contextUsage: o.usage ?? usage(123_000) }), ...o.session }) },
    views: {},
    listLoaded: true,
  });
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Composer sessionId={SID} hidePickers />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const ring = () => screen.getByTestId("context-ring");
const hover = () => userEvent.hover(ring());

beforeEach(() => localStorage.clear());

describe("ringTone", () => {
  it("normal below 70, warn 70–90, danger from 90", () => {
    expect([0, 69.9].map(ringTone)).toEqual(["accent", "accent"]);
    expect([70, 89.9].map(ringTone)).toEqual(["warn", "warn"]);
    expect([90, 100].map(ringTone)).toEqual(["danger", "danger"]);
  });
});

describe("Composer: usage ring", () => {
  it("is hidden until the session has a contextUsage, and for a new session", () => {
    const a = setup({ usage: null });
    expect(screen.queryByTestId("context-ring")).not.toBeInTheDocument();
    a.unmount();
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Composer sessionId={null} />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("context-ring")).not.toBeInTheDocument();
  });

  it("sits left of the send button and shows the percent and colour", () => {
    setup({ usage: usage(123_000) });
    expect(ring().compareDocumentPosition(screen.getByTestId("composer-send")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ring()).toHaveAttribute("data-percent", "12");
    expect(ring()).toHaveAttribute("data-tone", "accent");
    expect(ring()).toHaveAccessibleName("Context 12% used");
  });

  it.each([
    [690_000, "accent"],
    [700_000, "warn"],
    [899_000, "warn"],
    [900_000, "danger"],
  ])("%i of 1M tokens is %s", (used, tone) => {
    setup({ usage: usage(used) });
    expect(ring()).toHaveAttribute("data-tone", tone);
  });

  it("the arc is filled by the share used", () => {
    setup({ usage: usage(500_000) });
    const arc = screen.getByTestId("context-ring-arc");
    const c = Number(arc.getAttribute("stroke-dasharray"));
    expect(Number(arc.getAttribute("stroke-dashoffset"))).toBeCloseTo(c / 2);
    expect(arc.getAttribute("stroke")).toBe("var(--accent)");
  });

  it("popover: context, tokens until auto-compact and the API credits", async () => {
    setup({ usage: usage(123_000, { breakdown: [{ key: "messages", label: "Messages", tokens: 123_000 }, { key: "autocompact_buffer", label: "Buffer", tokens: 45_000 }] }) });
    expect(screen.queryByTestId("context-ring-popover")).not.toBeInTheDocument();
    await hover();
    expect(screen.getByTestId("context-ring-popover")).toBeInTheDocument();
    expect(screen.getByTestId("ring-context")).toHaveTextContent("12% · 123k / 1M tokens");
    expect(screen.getByTestId("ring-until-compact")).toHaveTextContent("832k until auto-compact");
    expect(screen.getByTestId("ring-api")).toHaveTextContent("API credits$12.00 of $100.00");
    await userEvent.unhover(ring());
    expect(screen.queryByTestId("context-ring-popover")).not.toBeInTheDocument();
  });

  it("omits the until-compact line when the breakdown has no buffer, and the API credits when the hub has none", async () => {
    setup({ limits: null });
    await hover();
    expect(screen.getByTestId("ring-context")).toBeInTheDocument();
    expect(screen.queryByTestId("ring-until-compact")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ring-api")).not.toBeInTheDocument();
  });

  it("opens on tap/click and on focus, closes on Escape", async () => {
    setup();
    await userEvent.click(ring());
    expect(screen.getByTestId("context-ring-popover")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("context-ring-popover")).not.toBeInTheDocument();
    act(() => ring().blur());
    act(() => ring().focus());
    expect(screen.getByTestId("context-ring-popover")).toBeInTheDocument();
    act(() => ring().blur());
    expect(screen.queryByTestId("context-ring-popover")).not.toBeInTheDocument();
  });

  it("the limit dot shows from 80 % of the API budget", () => {
    const a = setup({ limits: limits(credits(79, 158)) });
    expect(screen.queryByTestId("ring-limit-dot")).not.toBeInTheDocument();
    a.unmount();
    setup({ limits: limits(credits(80, 160)) });
    expect(screen.getByTestId("ring-limit-dot")).toBeInTheDocument();
  });

  it("updates live on context_usage and usage_limits events", async () => {
    setup({ usage: null });
    expect(screen.queryByTestId("context-ring")).not.toBeInTheDocument();
    act(() => handleServerEvent({ type: "context_usage", sessionId: SID, usage: usage(300_000) }));
    expect(ring()).toHaveAttribute("data-percent", "30");
    act(() => handleServerEvent({ type: "context_usage", sessionId: SID, usage: usage(950_000) }));
    expect(ring()).toHaveAttribute("data-percent", "95");
    expect(ring()).toHaveAttribute("data-tone", "danger");
    expect(screen.queryByTestId("ring-limit-dot")).not.toBeInTheDocument();
    await hover();
    act(() => handleServerEvent({ type: "usage_limits", limits: limits(credits(85, 85)) }));
    expect(screen.getByTestId("ring-limit-dot")).toBeInTheDocument();
    expect(screen.getByTestId("ring-api")).toHaveTextContent("$85.00 of $100.00");
  });
});
