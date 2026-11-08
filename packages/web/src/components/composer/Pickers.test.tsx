import type { Me, ModelInfo } from "@agent-workstation/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { session, SID } from "../../test/fixtures";
import { useApp } from "../../store/app";
import { useComposer } from "../../store/composer";
import { useSessions } from "../../store/sessions";
import { TooltipProvider } from "../ui/overlays";

const patchSettings = vi.fn();
vi.mock("../../store/actions", () => ({ patchSettings: (...a: unknown[]) => patchSettings(...a) }));

import { EffortPicker, ModePicker, ModelPicker, userDefaults } from "./Pickers";

const me = (user: Partial<Me["user"]>, settings: Partial<Me["settings"]> = {}): Me => ({
  user: {
    name: "alice",
    createdAt: "2026-10-31T00:00:00.000Z",
    isAdmin: false,
    enabled: true,
    terminalEnabled: true,
    weeklyTokenLimit: null,
    modelAllowlist: null,
    defaultModel: null,
    defaultEffort: null,
    ...user,
  },
  settings: { remoteClaudeEnabled: true, diskWarnPercent: 80, diskBlockPercent: 95, defaultWeeklyTokenLimit: 0, defaultModel: "opus", defaultEffort: "high", ...settings },
  disk: "ok",
  apiAvailable: true,
  protocolVersion: 1,
});

describe("userDefaults — what the pickers show before the first send", () => {
  it("falls back to the server default (opus / high) when the user has none", () => {
    expect(userDefaults(me({}))).toEqual({ model: "opus", effort: "high" });
  });

  it("prefers the user's own defaults, field by field", () => {
    expect(userDefaults(me({ defaultModel: "sonnet" }))).toEqual({ model: "sonnet", effort: "high" });
    expect(userDefaults(me({ defaultEffort: "medium" }))).toEqual({ model: "opus", effort: "medium" });
    expect(userDefaults(me({ defaultModel: "haiku", defaultEffort: "low" }))).toEqual({ model: "haiku", effort: "low" });
  });

  it("a null server effort means the CLI default (null), and an old hub without the fields is tolerated", () => {
    expect(userDefaults(me({}, { defaultEffort: null }))).toEqual({ model: "opus", effort: null });
    const old = me({});
    delete (old.user as Partial<Me["user"]>).defaultModel;
    delete (old.user as Partial<Me["user"]>).defaultEffort;
    expect(userDefaults(old)).toEqual({ model: "opus", effort: "high" });
    expect(userDefaults(null)).toEqual({ model: undefined, effort: undefined });
  });
});

// ---------------------------------------------------------------------------
// the model menu
// ---------------------------------------------------------------------------
const MODELS: ModelInfo[] = [
  { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable", family: "opus", legacy: false, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
  { value: "claude-fable-5-1", displayName: "Fable 5.1", family: "fable", legacy: false },
  { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", family: "sonnet", legacy: false },
  { value: "claude-haiku-5-5", displayName: "Haiku 5.5", family: "haiku", legacy: false, supportsEffort: false, supportsAutoMode: false },
  { value: "claude-haiku-4-5", displayName: "Haiku 4.5", family: "haiku", legacy: true },
  { value: "claude-opus-4-8", displayName: "Opus 4.8", family: "opus", legacy: true },
  { value: "claude-opus-4-7", displayName: "Opus 4.7", family: "opus", legacy: true },
];

function setup(
  opts: {
    sessionId?: string | null;
    models?: ModelInfo[];
    session?: Parameters<typeof session>[0];
    defaultModel?: string;
    allow?: string[] | null;
    newSettings?: Record<string, unknown>;
    settings?: Partial<Me["settings"]>;
  } = {},
) {
  const sessionId = opts.sessionId === undefined ? null : opts.sessionId;
  const m: Me = me({ modelAllowlist: opts.allow ?? null }, { defaultModel: opts.defaultModel ?? "claude-opus-5-5", defaultEffort: "high", ...opts.settings });
  useApp.setState({ me: m, models: opts.models ?? MODELS, modelsLoaded: true, sendBlock: null, limits: null });
  useComposer.setState({ newSettings: opts.newSettings ?? {}, drafts: {} });
  useSessions.setState({ sessions: sessionId ? { [SID]: session(opts.session) } : {}, views: {}, listLoaded: true });
  return render(
    <TooltipProvider>
      <ModelPicker sessionId={sessionId} />
      <ModePicker sessionId={sessionId} />
      <EffortPicker sessionId={sessionId} kind="code" />
    </TooltipProvider>,
  );
}
const openMenu = async () => {
  await userEvent.click(screen.getByTestId("model-picker"));
  return screen.findByTestId("model-menu");
};
const optionNames = (root: HTMLElement) => within(root).queryAllByRole("menuitemradio").map((el) => el.getAttribute("data-model"));

describe("ModelPicker menu", () => {
  beforeEach(() => patchSettings.mockClear());

  it("top level: the newest model of each family with the Default badge, then Effort and More models", async () => {
    setup();
    const menu = await openMenu();
    expect(optionNames(menu)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    const opus = within(menu).getByRole("menuitemradio", { name: /Opus 5\.5/ });
    expect(opus).toHaveAttribute("aria-checked", "true");
    expect(opus).toHaveTextContent("Default");
    expect(opus).toHaveTextContent("Most capable"); // subtitle from `description`
    expect(within(menu).getAllByText("Default")).toHaveLength(1);
    expect(within(menu).getByTestId("model-menu-effort")).toHaveTextContent(/Effort\s*High/);
    expect(within(menu).getByTestId("model-menu-more")).toHaveTextContent("More models");
    expect(within(menu).queryByTestId("model-menu-billing")).not.toBeInTheDocument();
    // number shortcuts for the top-level items
    expect(within(menu).getByRole("menuitemradio", { name: /Haiku 5\.5/ })).toHaveTextContent("4");
    // legacy versions are not at the top level
    expect(within(menu).queryByText("Opus 4.8")).not.toBeInTheDocument();
  });

  it("has no section labels", async () => {
    setup();
    const menu = await openMenu();
    expect(within(menu).queryByText("Claude")).not.toBeInTheDocument();
  });

  it("the live hub list (explicit flags, `default` hidden) shows Effort and More models", async () => {
    const mk = (value: string, legacy: boolean, family: string): ModelInfo => ({ value, displayName: value, legacy, family });
    const live: ModelInfo[] = [
      mk("default", false, "default"),
      mk("opus", false, "opus"),
      mk("fable", false, "fable"),
      mk("sonnet", false, "sonnet"),
      mk("haiku", false, "haiku"),
      mk("claude-haiku-4-5-20251001", true, "haiku"),
      mk("claude-sonnet-5", true, "sonnet"),
      mk("claude-opus-5", true, "opus"),
      mk("claude-fable-5", true, "fable"),
      mk("claude-opus-4-8", true, "opus"),
      mk("claude-opus-4-7", true, "opus"),
      mk("claude-opus-4-6", true, "opus"),
      mk("claude-sonnet-4-6", true, "sonnet"),
    ];
    setup({ models: live, defaultModel: "opus" });
    const menu = await openMenu();
    expect(optionNames(menu)).toEqual(["opus", "fable", "sonnet", "haiku"]);
    expect(within(menu).getByTestId("model-menu-effort")).toBeInTheDocument();
    await userEvent.click(within(menu).getByTestId("model-menu-more"));
    expect(optionNames(await screen.findByTestId("model-menu-more-list"))).toEqual(live.filter((m) => m.legacy).map((m) => m.value));
  });

  it("More models lists the legacy versions and picking one sets the model", async () => {
    setup();
    const menu = await openMenu();
    await userEvent.click(within(menu).getByTestId("model-menu-more"));
    const more = await screen.findByTestId("model-menu-more-list");
    expect(optionNames(more)).toEqual(["claude-haiku-4-5", "claude-opus-4-8", "claude-opus-4-7"]);
    await userEvent.click(within(more).getByRole("menuitemradio", { name: "Opus 4.8" }));
    expect(useComposer.getState().newSettings.model).toBe("claude-opus-4-8");
  });

  it("pins the session's current model and the user's default to the top level even when they are legacy", async () => {
    setup({ sessionId: SID, session: { model: "claude-opus-4-8" }, defaultModel: "claude-haiku-4-5" });
    const menu = await openMenu();
    expect(optionNames(menu)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5", "claude-opus-4-8"]);
    expect(within(menu).getByRole("menuitemradio", { name: /Opus 4\.8/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /Haiku 4\.5/ })).toHaveTextContent("Default");
    await userEvent.click(within(menu).getByTestId("model-menu-more"));
    expect(optionNames(await screen.findByTestId("model-menu-more-list"))).toEqual(["claude-opus-4-7"]);
  });

  it("resolves an alias default ('opus') to the newest Opus for the badge", async () => {
    setup({ defaultModel: "opus" });
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitemradio", { name: /Opus 5\.5/ })).toHaveTextContent("Default");
  });

  it("a hub without legacy/family flags falls back to the derived newest-per-family", async () => {
    const old = MODELS.map(({ family: _f, legacy: _l, ...rest }) => rest).filter((m) => m.value !== "claude-haiku-5-5");
    setup({ models: old });
    const menu = await openMenu();
    expect(optionNames(menu)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-4-5"]);
    await userEvent.click(within(menu).getByTestId("model-menu-more"));
    expect(optionNames(await screen.findByTestId("model-menu-more-list"))).toEqual(["claude-opus-4-8", "claude-opus-4-7"]);
  });

  it("keys 1–9 pick a top-level model and close the menu", async () => {
    setup({ sessionId: SID, session: { model: "claude-opus-5-5" } });
    await openMenu();
    await userEvent.keyboard("3");
    expect(patchSettings).toHaveBeenCalledWith(SID, { model: "claude-sonnet-5-5" });
    expect(screen.queryByTestId("model-menu")).not.toBeInTheDocument();
  });

  it("choosing a model of an existing session patches it; choosing the current one does nothing", async () => {
    setup({ sessionId: SID, session: { model: "claude-opus-5-5" } });
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Opus 5\.5/ }));
    expect(patchSettings).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByTestId("model-picker"));
    await userEvent.click(within(await screen.findByTestId("model-menu")).getByRole("menuitemradio", { name: /Fable 5\.1/ }));
    expect(patchSettings).toHaveBeenCalledWith(SID, { model: "claude-fable-5-1" });
  });

  it("a new session that moves to a model without Auto keeps a valid mode (auto → default) and effort", async () => {
    setup({ newSettings: { effort: "xhigh", permissionMode: "auto" } });
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Haiku 5\.5/ }));
    expect(useComposer.getState().newSettings).toMatchObject({ model: "claude-haiku-5-5", permissionMode: "default" });
  });

  it("the Effort submenu changes the effort and the composer's own effort chip still works", async () => {
    setup({ sessionId: SID, session: { model: "claude-opus-5-5", effort: "high" } });
    const menu = await openMenu();
    await userEvent.click(within(menu).getByTestId("model-menu-effort"));
    const items = await screen.findAllByRole("menuitemradio", { name: /^(Default|Low|Medium|High|Extra high|Max)$/ });
    expect(items.map((i) => i.textContent)).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
    await userEvent.click(items.find((i) => i.textContent === "Low")!);
    expect(patchSettings).toHaveBeenCalledWith(SID, { effort: "low" });
    // the chip is still there
    expect(screen.getByTestId("effort-picker")).toHaveAttribute("aria-label", expect.stringContaining("Effort"));
  });

  it("the Effort entry is disabled for a model without an effort setting", async () => {
    setup({ sessionId: SID, session: { model: "claude-haiku-5-5" } });
    const menu = await openMenu();
    expect(within(menu).getByTestId("model-menu-effort")).toHaveAttribute("aria-disabled", "true");
  });

  it("Auto mode is greyed out for a model that lacks it", async () => {
    setup({ sessionId: SID, session: { kind: "code", model: "claude-haiku-5-5" } });
    await userEvent.click(screen.getByTestId("mode-picker"));
    const auto = await screen.findByRole("menuitemradio", { name: /^Auto/ });
    expect(auto).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitemradio", { name: /Plan mode/ })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("a model outside the user's allowlist is not offered", async () => {
    setup({ allow: ["claude-opus-5-5", "claude-opus-4-8"] });
    const menu = await openMenu();
    expect(optionNames(menu)).toEqual(["claude-opus-5-5"]);
    await userEvent.click(within(menu).getByTestId("model-menu-more"));
    expect(optionNames(await screen.findByTestId("model-menu-more-list"))).toEqual(["claude-opus-4-8"]);
  });
});
