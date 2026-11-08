/** MCP layer without a browser: tool policy vs the installed @playwright/mcp, the transport shim, gateway HTTP rules. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserManager, BROWSER_TOOL_POLICY, classifyBrowserTool, stripMcpPrefix } from "../src/index.js";
import { ShimTransport } from "../src/mcp/shim.js";
import { loadPlaywright } from "../src/playwright.js";
import { fakeBrowserWorld, flush } from "./fakes.js";

describe("tool policy", () => {
  it("classifies read vs act, strips client prefixes, refines browser_tabs", () => {
    expect(classifyBrowserTool("browser_navigate")).toBe("read");
    expect(classifyBrowserTool("mcp__browser__browser_snapshot")).toBe("read");
    expect(classifyBrowserTool("mcp__browser__browser_click")).toBe("act");
    expect(classifyBrowserTool("browser_file_upload")).toBe("act");
    expect(classifyBrowserTool("browser_evaluate")).toBe("act");
    expect(classifyBrowserTool("browser_tabs", { action: "select", index: 1 })).toBe("read");
    expect(classifyBrowserTool("browser_tabs", { action: "close" })).toBe("act");
    expect(classifyBrowserTool("browser_run_code_unsafe")).toBeNull();
    expect(classifyBrowserTool("browser_cookie_list")).toBeNull();
    expect(classifyBrowserTool("mcp__browser_tools__browser_hover")).toBe("act");
    expect(classifyBrowserTool("constructor")).toBeNull();
    expect(stripMcpPrefix("browser/browser_type")).toBe("browser_type");
  });

  it("matches the tools the installed @playwright/mcp actually offers", async () => {
    const pw = loadPlaywright();
    const server = await pw.createConnection({ capabilities: ["vision", "pdf"], webmcp: false }, async () => {
      throw new Error("no browser in this test");
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const offered = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    // every classified tool exists upstream (catches renames on upgrade)
    for (const name of Object.keys(BROWSER_TOOL_POLICY)) expect(offered, name).toContain(name);
    // what upstream offers but agents do not get: only the RCE tool
    expect(offered.filter((n) => !(n in BROWSER_TOOL_POLICY))).toEqual(["browser_run_code_unsafe"]);
  });
});

class FakeInner implements Transport {
  onmessage?: (m: JSONRPCMessage, extra?: any) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  sent: JSONRPCMessage[] = [];
  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  async send(m: JSONRPCMessage): Promise<void> {
    this.sent.push(m);
  }
  fromClient(m: object): void {
    this.onmessage?.(m as JSONRPCMessage);
  }
}

describe("ShimTransport", () => {
  function setup() {
    const inner = new FakeInner();
    const calls: string[] = [];
    const shim = new ShimTransport(inner, {
      roots: () => [{ uri: "file:///srv/users/alice", name: "alice" }],
      isAllowed: (t) => t !== "browser_run_code_unsafe" && t !== "hidden_tool",
      onToolCall: (t) => calls.push(`start ${t}`),
      onToolDone: (t, err) => calls.push(`done ${t}${err ? " error" : ""}`),
    });
    const toServer: any[] = [];
    shim.onmessage = (m) => toServer.push(m);
    return { inner, shim, calls, toServer };
  }

  it("declares roots for the client and answers roots/list with the user's folder", async () => {
    const { inner, shim, toServer } = setup();
    await shim.start();
    inner.fromClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    expect(toServer[0].params.capabilities.roots).toEqual({ listChanged: false });
    await shim.send({ jsonrpc: "2.0", id: 99, method: "roots/list" } as JSONRPCMessage);
    await flush(1);
    expect(inner.sent).toHaveLength(0); // never reaches the client
    expect(toServer[1]).toEqual({ jsonrpc: "2.0", id: 99, result: { roots: [{ uri: "file:///srv/users/alice", name: "alice" }] } });
  });

  it("filters tools/list, refuses unlisted tools, reports allowed calls", async () => {
    const { inner, shim, calls, toServer } = setup();
    await shim.start();
    inner.fromClient({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await shim.send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "browser_click" }, { name: "browser_run_code_unsafe" }, { name: "hidden_tool" }] } } as JSONRPCMessage);
    expect((inner.sent[0] as any).result.tools.map((t: any) => t.name)).toEqual(["browser_click"]);

    inner.fromClient({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_run_code_unsafe", arguments: { code: "x" } } });
    expect(toServer.find((m) => m.id === 3)).toBeUndefined(); // Playwright never sees it
    expect((inner.sent[1] as any).result).toMatchObject({ isError: true });

    inner.fromClient({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_click", arguments: {} } });
    expect(calls).toEqual(["start browser_click"]);
    await shim.send({ jsonrpc: "2.0", id: 4, result: { content: [], isError: true } } as JSONRPCMessage);
    expect(calls).toEqual(["start browser_click", "done browser_click error"]);
  });

  it("counts calls still running at close as finished", async () => {
    const { inner, shim, calls } = setup();
    await shim.start();
    inner.fromClient({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "browser_navigate", arguments: {} } });
    await shim.close();
    expect(calls).toEqual(["start browser_navigate", "done browser_navigate error"]);
  });
});

describe("gateway HTTP", () => {
  let root: string;
  let mgr: BrowserManager;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "workstation-browser-gw-"));
    mkdirSync(join(root, "alice"));
    mkdirSync(join(root, "bob"));
    const world = fakeBrowserWorld();
    mgr = new BrowserManager({ usersRoot: root }, { launcher: world.launcher, connectCdp: world.connect, resolveExecutable: () => ({ path: "/x", flavor: "headless-shell", source: "config" }) });
    await mgr.start();
  });
  afterAll(async () => {
    await mgr.close();
    rmSync(root, { recursive: true, force: true });
  });

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const post = (url: string, headers: Record<string, string>, body: unknown) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

  it("requires the user's own bearer token", async () => {
    const a = mgr.mcpEndpoint("alice");
    const b = mgr.mcpEndpoint("bob");
    expect((await post(a.url, {}, init)).status).toBe(401);
    expect((await post(a.url, { Authorization: b.headers.Authorization! }, init)).status).toBe(401);
    expect((await post(a.url.replace("/alice", "/nobody"), a.headers, init)).status).toBe(401);
    expect((await post(a.url.replace("/mcp/alice", "/other"), a.headers, init)).status).toBe(404);
  });

  it("rejects foreign Host headers (DNS rebinding) and non-initialize requests without a session", async () => {
    const a = mgr.mcpEndpoint("alice");
    const u = new URL(a.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(u.port), path: u.pathname, method: "POST", headers: { ...a.headers, Host: `evil.test:${u.port}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify(init));
    });
    expect(status).toBe(403);
    expect((await post(a.url, a.headers, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(400);
  });

  it("opens a session per user and refuses that session id on another user's path", async () => {
    const a = mgr.mcpEndpoint("alice");
    const b = mgr.mcpEndpoint("bob");
    const r = await post(a.url, a.headers, init);
    expect(r.status).toBe(200);
    const sid = r.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    expect(mgr.mcpSessionCount("alice")).toBe(1);
    const cross = await post(b.url, { ...b.headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(cross.status).toBe(404);
    const del = await fetch(a.url, { method: "DELETE", headers: { ...a.headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } });
    expect(del.status).toBe(200);
    await flush();
    expect(mgr.mcpSessionCount("alice")).toBe(0);
  });
});
