import { describe, expect, it } from "vitest";
import { newCodeSessionUrl, parseNewSessionRoute, validCwd } from "./newSession";

describe("validCwd", () => {
  it("accepts workspace-relative paths", () => {
    expect(validCwd("projects/app")).toBe("projects/app");
    expect(validCwd("inbox/my proj/")).toBe("inbox/my proj");
    expect(validCwd("a..b/c")).toBe("a..b/c");
  });
  it("rejects absolute, parent, empty and long paths", () => {
    expect(validCwd("/etc")).toBeNull();
    expect(validCwd("../x")).toBeNull();
    expect(validCwd("a/../b")).toBeNull();
    expect(validCwd("a/..")).toBeNull();
    expect(validCwd("a\\..\\b")).toBeNull();
    expect(validCwd("")).toBeNull();
    expect(validCwd("/")).toBeNull();
    expect(validCwd(null)).toBeNull();
    expect(validCwd("a".repeat(300))).toBe("a".repeat(300));
    expect(validCwd("a".repeat(301))).toBeNull();
  });
});

describe("parseNewSessionRoute", () => {
  it("reads new=code with a valid cwd", () => {
    expect(parseNewSessionRoute("?new=code&cwd=projects%2Fapp")).toEqual({ cwd: "projects/app" });
    expect(parseNewSessionRoute("?new=code&cwd=projects/app")).toEqual({ cwd: "projects/app" });
  });
  it("an invalid or missing cwd is a plain new Code draft", () => {
    expect(parseNewSessionRoute("?new=code&cwd=..%2Fx")).toEqual({ cwd: "" });
    expect(parseNewSessionRoute("?new=code&cwd=%2Fetc")).toEqual({ cwd: "" });
    expect(parseNewSessionRoute(`?new=code&cwd=${"a".repeat(301)}`)).toEqual({ cwd: "" });
    expect(parseNewSessionRoute("?new=code")).toEqual({ cwd: "" });
  });
  it("is not a route for anything else", () => {
    expect(parseNewSessionRoute("")).toBeNull();
    expect(parseNewSessionRoute("?new=chat&cwd=a")).toBeNull();
    expect(parseNewSessionRoute("?cwd=a")).toBeNull();
  });
  it("newCodeSessionUrl round-trips", () => {
    const url = newCodeSessionUrl("inbox/my proj");
    expect(parseNewSessionRoute(url.slice(1))).toEqual({ cwd: "inbox/my proj" });
  });
});
