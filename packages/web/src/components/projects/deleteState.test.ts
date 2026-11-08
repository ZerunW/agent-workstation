import { describe, expect, it } from "vitest";
import { canConfirmDelete, hasRemaining } from "./deleteState";

const base = { projectName: "demo-app", typed: "demo-app", pending: 0, undownloaded: 0, discard: false };

describe("canConfirmDelete", () => {
  it("needs the exact project name", () => {
    expect(canConfirmDelete(base)).toBe(true);
    expect(canConfirmDelete({ ...base, typed: " demo-app " })).toBe(true); // surrounding spaces are forgiven
    for (const typed of ["", "demo", "Demo-App", "demo-app2"]) expect(canConfirmDelete({ ...base, typed })).toBe(false);
  });
  it("also needs the discard box whenever pending changes or undownloaded files exist", () => {
    expect(canConfirmDelete({ ...base, pending: 2 })).toBe(false);
    expect(canConfirmDelete({ ...base, undownloaded: 1 })).toBe(false);
    expect(canConfirmDelete({ ...base, pending: 2, undownloaded: 1, discard: true })).toBe(true);
    expect(canConfirmDelete({ ...base, pending: 2, discard: true, typed: "nope" })).toBe(false);
  });
  it("hasRemaining is true when either count is positive", () => {
    expect(hasRemaining(0, 0)).toBe(false);
    expect(hasRemaining(1, 0)).toBe(true);
    expect(hasRemaining(0, 4)).toBe(true);
  });
});
