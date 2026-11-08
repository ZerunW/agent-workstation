import type { ModelInfo } from "@agent-workstation/protocol";
import { describe, expect, it } from "vitest";
import { annotateModels, isPseudoDefault, clampEffort, compareVersions, effortOptions, familyOf, findModel, modeUnsupported, splitModels, versionOf } from "./models";

const m = (value: string, displayName: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ value, displayName, ...extra });

/** What an older hub sends: no family / legacy anywhere. */
const OLD_HUB: ModelInfo[] = [
  m("claude-opus-4-6", "Opus 4.6"),
  m("claude-opus-5-5", "Opus 5.5"),
  m("claude-fable-5-1", "Fable 5.1"),
  m("claude-fable-5", "Fable 5"),
  m("claude-sonnet-5-5", "Sonnet 5.5"),
  m("claude-sonnet-4-6", "Sonnet 4.6"),
  m("claude-haiku-4-5", "Haiku 4.5"),
  m("claude-opus-5", "Opus 5"),
];

/** The new hub: flags set. */
const NEW_HUB: ModelInfo[] = [
  m("claude-opus-5-5", "Opus 5.5", { family: "opus", legacy: false, description: "Most capable" }),
  m("claude-fable-5-1", "Fable 5.1", { family: "fable", legacy: false }),
  m("claude-sonnet-5-5", "Sonnet 5.5", { family: "sonnet", legacy: false }),
  m("claude-haiku-5-5", "Haiku 5.5", { family: "haiku", legacy: false }),
  m("claude-haiku-4-5", "Haiku 4.5", { family: "haiku", legacy: true }),
  m("claude-opus-4-8", "Opus 4.8", { family: "opus", legacy: true }),
  m("claude-opus-4-7", "Opus 4.7", { family: "opus", legacy: true }),
];

const values = (l: readonly { value: string }[]) => l.map((x) => x.value);

describe("family / version derivation", () => {
  it("family is the hub's (lowercased), else a known word from the id or name, else the first word", () => {
    expect(familyOf({ value: "x", displayName: "X", family: "Opus" })).toBe("opus");
    expect(familyOf({ value: "claude-sonnet-4-6", displayName: "Whatever" })).toBe("sonnet");
    expect(familyOf({ value: "m1", displayName: "Haiku 4.5" })).toBe("haiku");
    expect(familyOf({ value: "mystery-1", displayName: "Mystery One" })).toBe("mystery");
  });

  it("version comes from the display name, else from the id without dates", () => {
    expect(versionOf({ value: "x", displayName: "Opus 5.5" })).toEqual([5, 5]);
    expect(versionOf({ value: "x", displayName: "Fable 5" })).toEqual([5]);
    expect(versionOf({ value: "claude-opus-4-8-20251101", displayName: "Opus" })).toEqual([4, 8]);
    expect(versionOf({ value: "opus[1m]", displayName: "Opus" })).toEqual([]);
  });

  it("compares versions numerically with missing parts as 0", () => {
    expect(compareVersions([5, 5], [5])).toBeGreaterThan(0);
    expect(compareVersions([5], [5, 0])).toBe(0);
    expect(compareVersions([4, 10], [4, 9])).toBeGreaterThan(0);
    expect(compareVersions([], [1])).toBeLessThan(0);
  });
});

describe("annotateModels — legacy flag", () => {
  it("derives legacy from the versions when the hub sends no flags: only the newest per family stays on top", () => {
    const a = annotateModels(OLD_HUB);
    expect(a.filter((x) => !x.legacy).map((x) => x.value)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-4-5"]);
  });

  it("a flag from the hub wins over the derivation, per model", () => {
    const a = annotateModels([m("claude-opus-5-5", "Opus 5.5", { legacy: true }), m("claude-opus-4-6", "Opus 4.6", { legacy: false })]);
    expect(a.map((x) => x.legacy)).toEqual([true, false]);
    // a model without a flag next to flagged ones is judged against the whole family
    const b = annotateModels([m("claude-opus-5-5", "Opus 5.5", { legacy: false }), m("claude-opus-4-6", "Opus 4.6")]);
    expect(b.map((x) => x.legacy)).toEqual([false, true]);
  });

  it("an unversioned family alias always means the newest", () => {
    const a = annotateModels([m("claude-opus-5-5", "Opus 5.5"), m("opus", "Opus"), m("sonnet", "Sonnet"), m("haiku", "Haiku")]);
    expect(a.find((x) => x.value === "opus")?.legacy).toBe(false); // an unversioned family alias always means the newest
    expect(a.find((x) => x.value === "sonnet")?.legacy).toBe(false);
  });
});

describe("findModel", () => {
  const entries = annotateModels(OLD_HUB);
  it("matches by id, then by display name, then a family alias to the newest of the family", () => {
    expect(findModel(entries, "claude-opus-4-6")?.displayName).toBe("Opus 4.6");
    expect(findModel(entries, "sonnet 4.6")?.value).toBe("claude-sonnet-4-6");
    expect(findModel(entries, "opus")?.value).toBe("claude-opus-5-5");
    expect(findModel(entries, "sonnet[1m]")?.value).toBe("claude-sonnet-5-5");
    expect(findModel(entries, "nope")).toBeUndefined();
    expect(findModel(entries, undefined)).toBeUndefined();
  });
});

describe("splitModels — top level vs More models", () => {
  it("top = newest of each family, More = the legacy versions, both in hub order", () => {
    const s = splitModels(NEW_HUB, { current: "claude-opus-5-5", defaultModel: "claude-opus-5-5" });
    expect(values(s.top)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(values(s.more)).toEqual(["claude-haiku-4-5", "claude-opus-4-8", "claude-opus-4-7"]);
    expect(s.defaultValue).toBe("claude-opus-5-5");
    expect(s.currentValue).toBe("claude-opus-5-5");
  });

  it("pins the session's current model and the user's default to the top level even when they are legacy", () => {
    const s = splitModels(NEW_HUB, { current: "claude-opus-4-8", defaultModel: "claude-haiku-4-5" });
    expect(values(s.top)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5", "claude-opus-4-8"]);
    expect(values(s.more)).toEqual(["claude-opus-4-7"]);
    expect(s.defaultValue).toBe("claude-haiku-4-5");
  });

  it("resolves an alias default ('opus') to the newest model, so the Default badge lands on Opus 5.5", () => {
    const s = splitModels(OLD_HUB, { defaultModel: "opus" });
    expect(s.defaultValue).toBe("claude-opus-5-5");
    expect(s.top.map((x) => x.displayName)).toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"]);
    expect(s.more.map((x) => x.displayName)).toEqual(["Opus 4.6", "Fable 5", "Sonnet 4.6", "Opus 5"]);
  });

  it("an unknown current model is simply not in the list (the picker shows its raw id)", () => {
    const s = splitModels(NEW_HUB, { current: "claude-retired-1" });
    expect(s.currentValue).toBeNull();
    expect(s.top).toHaveLength(4);
  });
});

describe("effort and mode per model", () => {
  it("effortOptions: all levels when unknown, none when unsupported, the model's own list otherwise", () => {
    expect(effortOptions(undefined)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortOptions(m("h", "Haiku", { supportsEffort: false }))).toBeNull();
    expect(effortOptions(m("g", "Fable", { supportedEffortLevels: ["low", "medium", "high"] }))).toEqual(["low", "medium", "high"]);
    expect(effortOptions(m("s", "S", { supportsEffort: true }))).toHaveLength(5);
  });

  it("clampEffort drops an unavailable level to the highest one below it, else the lowest", () => {
    const levels = ["low", "medium", "high"] as const;
    expect(clampEffort("xhigh", levels)).toBe("high");
    expect(clampEffort("max", levels)).toBe("high");
    expect(clampEffort("medium", levels)).toBe("medium");
    expect(clampEffort("low", ["medium", "high"])).toBe("medium");
    expect(clampEffort(null, levels)).toBeNull();
    expect(clampEffort(undefined, levels)).toBeUndefined();
    expect(clampEffort("max", null)).toBe("max");
  });

  it("auto mode is unavailable only for a model that says so", () => {
    expect(modeUnsupported("auto", m("h", "H", { supportsAutoMode: false }))).toBe(true);
    expect(modeUnsupported("auto", m("o", "O"))).toBe(false);
    expect(modeUnsupported("auto", undefined)).toBe(false);
    expect(modeUnsupported("plan", m("h", "H", { supportsAutoMode: false }))).toBe(false);
  });
});

describe("the default pseudo-model", () => {
  const pseudo = m("default", "Default (recommended)", { family: "default", legacy: false, description: "Opus 5.5 with 1M context" });

  it("is never offered: not at the top level and not under More models", () => {
    const split = splitModels([pseudo, ...NEW_HUB]);
    expect(values(split.top)).not.toContain("default");
    expect(values(split.more)).not.toContain("default");
    expect(values(split.top)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(isPseudoDefault(pseudo)).toBe(true);
    expect(isPseudoDefault(NEW_HUB[0]!)).toBe(false);
  });

  it("does not disturb the effective default: an alias still resolves to the newest model", () => {
    const split = splitModels([pseudo, ...NEW_HUB], { defaultModel: "opus" });
    expect(split.defaultValue).toBe("claude-opus-5-5");
    expect(splitModels([pseudo, ...NEW_HUB], { current: "default" }).currentValue).toBeNull();
  });

  it("is still known to findModel, so a stored value keeps a name on the picker", () => {
    expect(findModel(annotateModels([pseudo, ...NEW_HUB]), "default")?.displayName).toBe("Default (recommended)");
  });
});
