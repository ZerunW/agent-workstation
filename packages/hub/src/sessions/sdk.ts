/**
 * The slice of the Claude Agent SDK the hub depends on. The real SDK is
 * injected in production; tests inject a fake so no Claude process spawns.
 */
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  ModelInfo as SdkModelInfo,
  Options as SdkOptions,
  PermissionMode as SdkPermissionMode,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

export type { SDKMessage, SDKUserMessage, SessionMessage, SlashCommand, SdkModelInfo, SdkOptions };
export type SdkContextUsage = SDKControlGetContextUsageResponse;

export type SdkEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Subset of the SDK's `Query` used by the hub. The real Query satisfies it structurally. */
export interface HubQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: SdkEffort | null }): Promise<void>;
  supportedModels(): Promise<SdkModelInfo[]>;
  supportedCommands(): Promise<SlashCommand[]>;
  /** Rescan skill directories (after the hub created/changed/deleted a skill). Optional so fakes may omit it. */
  reloadSkills?(): Promise<unknown>;
  /** The data behind `/context` (control request: no model turn, nothing in the transcript). Optional so fakes may omit it. */
  getContextUsage?(opts?: { detail?: "summary" | "full" }): Promise<SdkContextUsage>;
  /** Stop one background task by id. Optional so fakes may omit it. */
  stopTask?(taskId: string): Promise<void>;
  close(): void;
}

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: SdkOptions }) => HubQuery;

/**
 * What a hub tool handler returns: the tool result text, or the text plus `isError: true` when the call did
 * nothing (it becomes the MCP CallToolResult's `isError`, so clients can tell a no-op from a success).
 */
export type HubToolResult = string | { text: string; isError?: boolean };

/** The MCP CallToolResult for a handler's result (`isError` only when set). */
export function toCallToolResult(r: HubToolResult): { content: { type: "text"; text: string }[]; isError?: true } {
  const { text, isError } = typeof r === "string" ? { text: r, isError: false } : r;
  return { content: [{ type: "text", text }], ...(isError ? { isError: true as const } : {}) };
}

/** A tool the hub offers Claude in-process (no subprocess). */
export interface HubToolSpec {
  name: string;
  description: string;
  /** zod raw shape (zod v4, the SDK's own) describing the input object. */
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<HubToolResult>;
}

export interface SdkDeps {
  query: QueryFn;
  getSessionMessages(sessionId: string): Promise<SessionMessage[]>;
  /** Builds an in-process MCP server config for `Options.mcpServers` (tools named `mcp__<server>__<tool>`). */
  createMcpServer(name: string, tools: HubToolSpec[]): NonNullable<SdkOptions["mcpServers"]>[string];
}

/** Loads the real SDK lazily so tests and tooling never import it. */
export async function loadRealSdk(): Promise<SdkDeps> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: (params) => sdk.query(params) as unknown as HubQuery,
    getSessionMessages: (id) => sdk.getSessionMessages(id),
    createMcpServer: (name, tools) =>
      sdk.createSdkMcpServer({
        name,
        tools: tools.map((t) =>
          sdk.tool(t.name, t.description, t.schema as Parameters<typeof sdk.tool>[2], async (args) => toCallToolResult(await t.handler(args as Record<string, unknown>))),
        ),
      }),
  };
}

/**
 * Resolves the Claude Code executable:
 *   1. `paths.claude_bin` when it is an existing absolute path or a name found on PATH;
 *   2. otherwise undefined → the SDK uses the native binary bundled with it.
 */
export function resolveClaudeExecutable(claudeBin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!claudeBin) return undefined;
  if (isAbsolute(claudeBin)) return existsSync(claudeBin) ? claudeBin : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, claudeBin);
    if (existsSync(p)) return p;
  }
  return undefined;
}
