import type { Me, ModelInfo } from "@agent-workstation/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ patchPreferences: vi.fn() }));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, patchPreferences: mocks.patchPreferences } };
});

import { useApp } from "../../store/app";
import { SessionDefaultsDialog } from "./SessionDefaultsDialog";

const MODELS: ModelInfo[] = [
  { value: "claude-opus-5-5", displayName: "Opus 5.5", family: "opus", legacy: false },
  { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", family: "sonnet", legacy: false, supportedEffortLevels: ["low", "medium", "high", "xhigh"] },
  { value: "claude-fable-5-1", displayName: "Fable 5.1", family: "fable", legacy: false, supportedEffortLevels: ["low", "medium", "high", "max"] },
  { value: "claude-opus-4-8", displayName: "Opus 4.8", family: "opus", legacy: true },
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", family: "sonnet", legacy: true },
];

const me = (user: Partial<Me["user"]> = {}): Me => ({
  user: { name: "alice", createdAt: "x", isAdmin: false, enabled: true, terminalEnabled: true, weeklyTokenLimit: null, modelAllowlist: null, defaultModel: null, defaultEffort: null, ...user },
  settings: { remoteClaudeEnabled: true, diskWarnPercent: 80, diskBlockPercent: 95, defaultWeeklyTokenLimit: 0, defaultModel: "claude-opus-5-5", defaultEffort: "high" },
  disk: "ok",
  apiAvailable: true,
  protocolVersion: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ me: me(), models: MODELS, modelsLoaded: true });
});

const open = () => render(<SessionDefaultsDialog open onOpenChange={() => {}} />);

describe("Session defaults model select", () => {
  const options = (el: ParentNode) => Array.from(el.querySelectorAll("option")).map((o) => o.textContent);

  it("lists the newest models, then the older ones under More models", () => {
    open();
    const select = screen.getByTestId("defaults-model");
    expect(options(select)).toEqual(["Server default (Opus 5.5)", "Opus 5.5", "Sonnet 5.5", "Fable 5.1", "Opus 4.8", "Sonnet 4.6"]);
    const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => [g.label, options(g)]);
    expect(groups).toEqual([["More models", ["Opus 4.8", "Sonnet 4.6"]]]);
    expect(within(select).getByRole("option", { name: "Server default (Opus 5.5)" })).toBeInTheDocument();
  });

  it("without legacy models there is no More models group", () => {
    useApp.setState({ models: MODELS.filter((m) => !m.legacy) });
    open();
    expect(screen.getByTestId("defaults-model").querySelectorAll("optgroup")).toHaveLength(0);
  });

  it("a legacy default stays selectable and is listed with the newest models", () => {
    useApp.setState({ me: me({ defaultModel: "claude-sonnet-4-6" }) });
    open();
    const select = screen.getByTestId("defaults-model");
    const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => [g.label, options(g)]);
    expect(groups).toEqual([["More models", ["Opus 4.8"]]]);
    expect(options(select)).toContain("Sonnet 4.6");
    expect(select).toHaveValue("claude-sonnet-4-6");
  });

  it("choosing a model limits the effort to its levels and drops an effort it lacks; Save sends both", async () => {
    mocks.patchPreferences.mockResolvedValue(me({ defaultModel: "claude-fable-5-1", defaultEffort: "high" }).user);
    useApp.setState({ me: me({ defaultModel: "claude-sonnet-5-5", defaultEffort: "xhigh" }) });
    open();
    const effort = screen.getByTestId("defaults-effort");
    expect(Array.from(effort.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toContain("xhigh");
    expect(effort).toHaveValue("xhigh");

    await userEvent.selectOptions(screen.getByTestId("defaults-model"), "claude-fable-5-1");
    expect(Array.from(effort.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(["__server__", "low", "medium", "high", "max"]);
    expect(effort).toHaveValue("high"); // xhigh → the highest level Fable has below it

    await userEvent.click(screen.getByTestId("defaults-save"));
    expect(mocks.patchPreferences).toHaveBeenCalledWith({ defaultModel: "claude-fable-5-1", defaultEffort: "high" });
  });

  it("has no billing choice", () => {
    open();
    expect(screen.queryByTestId("defaults-billing")).not.toBeInTheDocument();
  });
});

describe("Session defaults: the default pseudo-model", () => {
  it("is not listed among the models (the server default entry already says what the default is)", () => {
    useApp.setState({ models: [{ value: "default", displayName: "Default (recommended)", family: "default", legacy: false }, ...MODELS] });
    open();
    const options = Array.from(screen.getByTestId("defaults-model").querySelectorAll("option")).map((o) => o.textContent);
    expect(options).not.toContain("Default (recommended)");
    expect(options).toContain("Opus 5.5");
  });
});
