import { afterEach, describe, expect, it, vi } from "vitest";
import { installEmbedApi, post, readEmbedConfig, type EmbedApi } from "./bridge";

const loc = (search: string) => ({ location: { search } as Location });

describe("embed config", () => {
  it("reads window.workstationEmbedConfig", () => {
    const cfg = readEmbedConfig({ ...loc(""), workstationEmbedConfig: { hubUrl: "http://hub:9000/", user: "alice", mode: "transcript", sessionId: "s1", theme: "dark" } });
    expect(cfg).toMatchObject({ hubUrl: "http://hub:9000", user: "alice", mode: "transcript", sessionId: "s1", theme: "dark" });
  });
  it("falls back to query parameters for browser testing", () => {
    const cfg = readEmbedConfig(loc("?hubUrl=http://x&user=a&mode=diff&projectId=p&path=src/a.ts"));
    expect(cfg).toMatchObject({ mode: "diff", projectId: "p", path: "src/a.ts" });
  });
  it("returns null when user or mode are missing/invalid", () => {
    expect(readEmbedConfig(loc("?user=a"))).toBeNull();
    expect(readEmbedConfig(loc("?user=a&mode=nope"))).toBeNull();
  });
});

describe("host messaging", () => {
  afterEach(() => {
    delete window.webkit;
    vi.restoreAllMocks();
  });
  it("posts through webkit.messageHandlers.workstation when present", () => {
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { workstation: { postMessage } } };
    post({ type: "ready", mode: "transcript" });
    expect(postMessage).toHaveBeenCalledWith({ type: "ready", mode: "transcript" });
  });
  it("falls back to console.debug in a plain browser", () => {
    const dbg = vi.spyOn(console, "debug").mockImplementation(() => {});
    post({ type: "open_external", url: "https://example.com" });
    expect(dbg).toHaveBeenCalled();
  });
  it("installs and removes window.workstationEmbed", () => {
    const api = { setTheme: vi.fn() } as unknown as EmbedApi;
    const off = installEmbedApi(api);
    expect((window as any).workstationEmbed).toBe(api);
    off();
    expect((window as any).workstationEmbed).toBeUndefined();
  });
});
