/**
 * A Transport wrapper between the HTTP transport (client side) and Playwright's MCP server:
 *   - roots: the server asks the client for workspace roots to decide where files may be read/written; the shim
 *     declares the capability on the client's behalf and answers `roots/list` itself with the user's folder, so file
 *     access is confined to `<usersRoot>/<user>` whatever the client supports;
 *   - allowlist: `tools/list` results are filtered and `tools/call` for unlisted tools is refused before it reaches
 *     Playwright (see policy.ts);
 *   - activity: every allowed `tools/call` is reported (start + finish) for idle tracking and `controlledBy`;
 *   - result check: every tool result passes `checkResult` (when set) before it goes back to the client, which may
 *     replace it (the gateway hides pages of websites the user has not allowed).
 */
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

export type Id = string | number;
type Msg = { jsonrpc: "2.0"; id?: Id; method?: string; params?: any; result?: any; error?: any };

export interface ShimOptions {
  roots(): { uri: string; name?: string }[];
  isAllowed(tool: string): boolean;
  onToolCall(tool: string, args: unknown, extra?: MessageExtraInfo, callId?: Id): void;
  onToolDone(tool: string, isError: boolean, callId?: Id): void;
  /** Looks at a tool call's result before the client sees it; resolves to the result to send (the same or a replacement). */
  checkResult?(tool: string, callId: Id, result: unknown): Promise<unknown>;
}

const isRequest = (m: Msg): boolean => typeof m.method === "string" && m.id !== undefined;
const isResponse = (m: Msg): boolean => m.method === undefined && m.id !== undefined;

export class ShimTransport implements Transport {
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly toolsList = new Set<Id>();
  private readonly toolCalls = new Map<Id, string>();

  constructor(
    private readonly inner: Transport,
    private readonly o: ShimOptions,
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    this.inner.onmessage = (m, extra) => this.fromClient(m as Msg, extra);
    this.inner.onclose = () => {
      this.abandonCalls();
      this.onclose?.();
    };
    this.inner.onerror = (e) => this.onerror?.(e);
    await this.inner.start();
  }

  async close(): Promise<void> {
    this.abandonCalls();
    await this.inner.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const m = message as Msg;
    if (isRequest(m) && m.method === "roots/list") {
      const id = m.id!;
      queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id, result: { roots: this.o.roots() } } as JSONRPCMessage));
      return;
    }
    if (isResponse(m)) {
      if (this.toolsList.delete(m.id!) && Array.isArray(m.result?.tools)) {
        message = { ...m, result: { ...m.result, tools: m.result.tools.filter((t: { name: string }) => this.o.isAllowed(t.name)) } } as JSONRPCMessage;
      }
      const tool = this.toolCalls.get(m.id!);
      if (tool !== undefined) {
        this.toolCalls.delete(m.id!);
        try {
          if (m.result !== undefined && this.o.checkResult) {
            const result = await this.o.checkResult(tool, m.id!, m.result);
            if (result !== m.result) message = { ...m, result } as JSONRPCMessage;
          }
        } finally {
          this.o.onToolDone(tool, !!m.error || !!m.result?.isError, m.id!);
        }
      }
    }
    return this.inner.send(message, options);
  }

  private fromClient(m: Msg, extra?: MessageExtraInfo): void {
    if (isRequest(m)) {
      if (m.method === "initialize") {
        const caps = m.params?.capabilities ?? {};
        m = { ...m, params: { ...m.params, capabilities: { ...caps, roots: { listChanged: false } } } };
      } else if (m.method === "tools/list") {
        this.toolsList.add(m.id!);
      } else if (m.method === "tools/call") {
        const name = String(m.params?.name ?? "");
        if (!this.o.isAllowed(name)) {
          void this.inner.send({ jsonrpc: "2.0", id: m.id!, result: { content: [{ type: "text", text: `### Error\nTool "${name}" is not available on this server.` }], isError: true } } as JSONRPCMessage, { relatedRequestId: m.id! });
          return;
        }
        this.toolCalls.set(m.id!, name);
        this.o.onToolCall(name, m.params?.arguments, extra, m.id!);
      }
    }
    this.onmessage?.(m as JSONRPCMessage, extra);
  }

  /** Tool calls still running when the session goes away count as finished (keeps the activity counter honest). */
  private abandonCalls(): void {
    for (const [id, tool] of this.toolCalls) this.o.onToolDone(tool, true, id);
    this.toolCalls.clear();
  }
}
