import { describe, expect, it } from "vitest";
import { reconcileSeverity } from "../src/sessions/usage.js";

describe("reconcileSeverity", () => {
  it("trusts the percentage over the fallback", () => {
    expect(reconcileSeverity(2, "critical")).toBe("normal");
    expect(reconcileSeverity(50, "warning")).toBe("normal");
  });
  it("derives warning/critical from the percentage", () => {
    expect(reconcileSeverity(80, "normal")).toBe("warning");
    expect(reconcileSeverity(96, "normal")).toBe("critical");
  });
  it("the fallback only applies when the percentage is unknown", () => {
    expect(reconcileSeverity(85, "critical")).toBe("warning");
    expect(reconcileSeverity(null, "critical")).toBe("critical");
    expect(reconcileSeverity(null, "unknown")).toBe("unknown");
    expect(reconcileSeverity(Number.NaN, "unknown")).toBe("unknown");
  });
});
