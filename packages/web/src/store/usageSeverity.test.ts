import type { UsageLimits } from "@agent-workstation/protocol";
import { describe, expect, it } from "vitest";
import { usageSeverity } from "./app";

const apiBlock = (severity: "normal" | "warning" | "critical" | "unknown"): NonNullable<UsageLimits["api"]> => ({ spentUsd: 1, limitUsd: 100, percent: 0.5, periodStart: "2026-01-01T00:00:00Z", resetsAt: "2026-02-01T00:00:00Z", severity });

describe("usageSeverity (sidebar dot)", () => {
  it("is normal without data or without an API block", () => {
    expect(usageSeverity(null)).toBe("normal");
    expect(usageSeverity({ api: null })).toBe("normal");
  });

  it("follows the API-credit severity", () => {
    expect(usageSeverity({ api: apiBlock("normal") })).toBe("normal");
    expect(usageSeverity({ api: apiBlock("warning") })).toBe("warning");
    expect(usageSeverity({ api: apiBlock("critical") })).toBe("critical");
    expect(usageSeverity({ api: apiBlock("unknown") })).toBe("normal");
  });
});
