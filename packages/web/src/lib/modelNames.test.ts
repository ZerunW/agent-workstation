import type { ModelInfo } from "@agent-workstation/protocol";
import { describe, expect, it } from "vitest";
import { canonicalModelId, deriveModelName, describeModel } from "./modelNames";

const CATALOG: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", family: "default", legacy: false },
  { value: "claude-opus-5-5", displayName: "Opus 5.5", family: "opus", legacy: false },
  { value: "claude-haiku-5-5", displayName: "Haiku 5.5", family: "haiku", legacy: false },
  { value: "claude-opus-4-8", displayName: "Opus 4.8", family: "opus", legacy: true },
];

describe("canonicalModelId", () => {
  it("drops a [1m] suffix and a dated snapshot, and lowercases", () => {
    expect(canonicalModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(canonicalModelId("Claude-Opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(canonicalModelId("claude-haiku-5-5-20251001")).toBe("claude-haiku-5-5");
  });

  it("keeps an effort-like word on an id (it is not a variant)", () => {
    expect(canonicalModelId("claude-opus-high")).toBe("claude-opus-high");
  });
});

describe("deriveModelName — from the id alone", () => {
  it("Claude ids", () => {
    expect(deriveModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(deriveModelName("claude-opus-4-8-20251101")).toBe("Opus 4.8");
    expect(deriveModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(deriveModelName("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(deriveModelName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(deriveModelName("claude-fable-5-1")).toBe("Fable 5.1");
  });

  it("aliases and unknown ids", () => {
    expect(deriveModelName("opus")).toBe("Opus");
    expect(deriveModelName("sonnet[1m]")).toBe("Sonnet");
    expect(deriveModelName("default")).toBe("Default");
    expect(deriveModelName("mystery-model-9")).toBe("mystery-model-9");
  });
});

describe("describeModel", () => {
  it("uses the catalog's display name, also for a dated or [1m] id", () => {
    expect(describeModel("claude-opus-5-5", CATALOG)).toEqual({ label: "Opus 5.5" });
    expect(describeModel("claude-haiku-5-5-20251001", CATALOG)).toEqual({ label: "Haiku 5.5" });
    expect(describeModel("claude-opus-5-5[1m]", CATALOG)).toEqual({ label: "Opus 5.5" });
    expect(describeModel("claude-opus-4-8", CATALOG)).toEqual({ label: "Opus 4.8" });
  });

  it("an alias resolves to the model it means today", () => {
    expect(describeModel("opus", CATALOG)).toEqual({ label: "Opus 5.5" });
  });

  it("falls back to a name derived from the id for a model the catalog does not list", () => {
    expect(describeModel("claude-sonnet-4-1", CATALOG)).toEqual({ label: "Sonnet 4.1" });
    expect(describeModel("claude-opus-5-5")).toEqual({ label: "Opus 5.5" }); // no catalog at all
  });

  it("never names a row after the pseudo-model 'Default (recommended)'", () => {
    expect(describeModel("default", CATALOG)).toEqual({ label: "Default" });
  });

  it("an id nobody knows keeps its own text", () => {
    expect(describeModel("mystery-model-9", CATALOG)).toEqual({ label: "mystery-model-9" });
  });
});
