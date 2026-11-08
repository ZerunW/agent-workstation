import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "./api";
import { projectNameFromCwd, resolveSessionProject, shortCommit } from "./projects";

const project = (name: string, id: string): ProjectInfo => ({ id, user: "alice", name, path: `projects/${name}`, createdAt: "2026-10-31T00:00:00Z", localCommit: null, pendingFiles: 0, sizeBytes: 0, origin: null });
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const list = [project("demo-app", ID_A), project("notes", ID_B)];

describe("projectNameFromCwd", () => {
  it("reads the project folder from projects/<name>[/...]", () => {
    expect(projectNameFromCwd("projects/demo-app")).toBe("demo-app");
    expect(projectNameFromCwd("projects/demo-app/src/lib")).toBe("demo-app");
    expect(projectNameFromCwd("/projects/notes")).toBe("notes");
  });
  it("is null outside projects", () => {
    for (const cwd of ["", ".chat", "docs", "projects", "projects/", "other/projects/x"]) expect(projectNameFromCwd(cwd)).toBeNull();
  });
});

describe("resolveSessionProject", () => {
  it("prefers Session.projectId and takes the name from the project list", () => {
    expect(resolveSessionProject({ cwd: "somewhere/else", projectId: ID_B }, list)).toEqual({ id: ID_B, name: "notes" });
  });
  it("falls back to matching the cwd against project names when projectId is missing or null", () => {
    expect(resolveSessionProject({ cwd: "projects/demo-app/src" }, list)).toEqual({ id: ID_A, name: "demo-app" });
    expect(resolveSessionProject({ cwd: "projects/demo-app", projectId: null }, list)).toEqual({ id: ID_A, name: "demo-app" });
  });
  it("knows the name but not the id when the project list has not heard of the project", () => {
    expect(resolveSessionProject({ cwd: "projects/ghost" }, list)).toEqual({ id: null, name: "ghost" });
    expect(resolveSessionProject({ cwd: "projects/ghost" }, [])).toEqual({ id: null, name: "ghost" });
  });
  it("keeps an unknown projectId usable (the review routes only need the id)", () => {
    expect(resolveSessionProject({ cwd: "projects/ghost", projectId: ID_A }, [])).toEqual({ id: ID_A, name: "ghost" });
    expect(resolveSessionProject({ cwd: "", projectId: ID_A }, [])).toEqual({ id: ID_A, name: ID_A.slice(0, 8) });
  });
  it("is null for sessions outside every project", () => {
    expect(resolveSessionProject({ cwd: "" }, list)).toBeNull();
    expect(resolveSessionProject({ cwd: "docs", projectId: null }, list)).toBeNull();
  });
});

describe("shortCommit", () => {
  it("shortens hashes and dashes out null", () => {
    expect(shortCommit("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
    expect(shortCommit(null)).toBe("—");
  });
});
