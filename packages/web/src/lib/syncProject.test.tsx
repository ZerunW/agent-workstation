import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useComposer } from "../store/composer";
import { useProjects } from "../store/projects";
import { useSyncProjectId } from "./sync";

const P = { id: "11111111-1111-4111-8111-111111111111", user: "alice", name: "sample-app", path: "projects/sample-app", createdAt: "2026-11-01T00:00:00Z", localCommit: null };

describe("useSyncProjectId for a new Code draft", () => {
  beforeEach(() => {
    useProjects.setState({ list: [P as never], status: "ready" });
  });
  it("finds the project the draft's folder lies in", () => {
    useComposer.setState({ newCwd: "projects/sample-app/src" });
    expect(renderHook(() => useSyncProjectId(null)).result.current).toBe(P.id);
    useComposer.setState({ newCwd: "projects/sample-app" });
    expect(renderHook(() => useSyncProjectId(null)).result.current).toBe(P.id);
  });
  it("null outside any project or for a prefix-only match", () => {
    useComposer.setState({ newCwd: "projects/sample-app2" });
    expect(renderHook(() => useSyncProjectId(null)).result.current).toBeNull();
    useComposer.setState({ newCwd: "" });
    expect(renderHook(() => useSyncProjectId(null)).result.current).toBeNull();
  });
});
