/**
 * read_workstation_docs: offered to every session that is not a research subagent (chat and code, in-process MCP
 * server `workstation_docs`, pre-approved), returns the page's Markdown, and the guide names it only where it is
 * registered.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadmeDocName } from "@agent-workstation/protocol";
import { DOCS_SERVER, DOCS_TOOL, docsTool } from "../src/sessions/docs.js";
import { DOCS_GUIDANCE, workstationGuide, type GuideContext } from "../src/sessions/guide.js";
import { msgBody, runtimeFixture, tempDir, until, type RuntimeFixture } from "./helpers.js";

const PAGES: Record<ReadmeDocName, string> = { features: "# Features\n\nBrowser, synced projects.", "getting-started": "# Getting started\n\nInstall the Mac app." };
const docs = async (doc: ReadmeDocName) => PAGES[doc];
const TOOL = `mcp__${DOCS_SERVER}__${DOCS_TOOL}`;

let fx: RuntimeFixture | null = null;
const cleanups: (() => void)[] = [];
afterEach(() => {
  fx?.cleanup();
  fx = null;
  for (const c of cleanups.splice(0)) c();
});

describe("read_workstation_docs tool", () => {
  it("returns the page's Markdown; unknown and missing pages are errors", async () => {
    const tool = docsTool(async (doc) => (doc === "features" ? PAGES.features : null));
    expect(tool.name).toBe("read_workstation_docs");
    expect(await tool.handler({ doc: "features" })).toBe(PAGES.features);
    expect(await tool.handler({ doc: "getting-started" })).toMatchObject({ isError: true });
    expect(await tool.handler({ doc: "../../etc/passwd" })).toMatchObject({ isError: true });
  });
});

describe("read_workstation_docs in Claude sessions", () => {
  const spawned = async (kind: "chat" | "code", parent?: string) => {
    const f = fx!;
    f.store.ensureUser("alice");
    const id = parent
      ? f.sessions.create({ user: "alice", kind, cwd: kind === "chat" ? ".chat" : "", model: "sonnet", permissionMode: "default", effort: null, parentSessionId: parent }).id
      : f.newSession(kind);
    await f.sessions.send(id, msgBody("how does Agent Workstation sync projects?"));
    await until(() => f.sdk.queries.length > 0 && f.sdk.last.options);
    return f.sdk.last.options;
  };

  it("chat and code: the workstation_docs server, pre-approved, and the guide bullet", async () => {
    fx = runtimeFixture({ docs });
    for (const kind of ["chat", "code"] as const) {
      const o = await spawned(kind);
      expect(Object.keys(o.mcpServers ?? {})).toContain(DOCS_SERVER);
      expect(o.allowedTools).toContain(TOOL);
      const tools = fx.sdk.mcpServers.get(DOCS_SERVER)!;
      expect(tools.map((t) => t.name)).toEqual([DOCS_TOOL]);
      expect(await tools[0]!.handler({ doc: "getting-started" })).toBe(PAGES["getting-started"]);
      const prompt = kind === "chat" ? String(o.systemPrompt) : (o.systemPrompt as { append: string }).append;
      expect(prompt).toContain(DOCS_GUIDANCE);
    }
  });

  it("not for research subagents (a code subagent keeps it); none without the dep", async () => {
    fx = runtimeFixture({ docs });
    const parent = fx.newSession("chat");
    const research = await spawned("chat", parent);
    expect(Object.keys(research.mcpServers ?? {})).not.toContain(DOCS_SERVER);
    expect(String(research.systemPrompt)).not.toContain("read_workstation_docs");
    const codeParent = fx.newSession("code");
    const codeChild = await spawned("code", codeParent);
    expect(Object.keys(codeChild.mcpServers ?? {})).toContain(DOCS_SERVER);
    fx.cleanup();

    fx = runtimeFixture();
    const plain = await spawned("code");
    expect(Object.keys(plain.mcpServers ?? {})).not.toContain(DOCS_SERVER);
    expect((plain.systemPrompt as { append: string }).append).not.toContain("read_workstation_docs");
  });
});

describe("guide: Agent Workstation's docs", () => {
  const ctx = (o: Partial<GuideContext> = {}): GuideContext => ({
    kind: "code",
    memory: false,
    history: false,
    incognito: false,
    browser: false,
    readAttachments: false,
    agentAccount: true,
    memoryGiB: 8,
    cwdAbs: "/srv/agent-workstation/users/alice",
    cwdRel: "",
    subagents: true,
    docs: true,
    now: new Date(2026, 10, 1, 12),
    ...o,
  });

  it("tells every session with the tool to read the docs first when the user asks how Agent Workstation works or hits a problem", () => {
    expect(DOCS_GUIDANCE).toContain("how Agent Workstation works");
    expect(DOCS_GUIDANCE).toContain("problem");
    expect(DOCS_GUIDANCE).toContain("`read_workstation_docs`");
    for (const kind of ["chat", "code"] as const) expect(workstationGuide(ctx({ kind }))).toContain(`- Docs: ${DOCS_GUIDANCE}`);
  });

  it("never named without the tool or in a research subagent", () => {
    expect(workstationGuide(ctx({ docs: false }))).not.toContain("read_workstation_docs");
    expect(workstationGuide(ctx({ kind: "chat", subagent: true, subagents: false }))).not.toContain("read_workstation_docs");
    expect(workstationGuide(ctx({ kind: "code", subagent: true, subagents: false }))).toContain("read_workstation_docs");
  });

  it("stays within the guide's length budget with everything on", () => {
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    const all = { memory: true, history: true, browser: true, projectName: "workstation", cwdAbs: "/srv/agent-workstation/users/alice/projects/workstation", cwdRel: "projects/workstation" };
    expect(words(workstationGuide(ctx({ ...all })))).toBeLessThanOrEqual(1000);
  });
});
