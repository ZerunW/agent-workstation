/**
 * Fake Agent SDK for unit tests: no Claude process is ever spawned.
 *
 * Each `query()` returns a FakeQuery. Its behavior is scripted by a
 * `Behavior` callback invoked for every user message fed to the prompt;
 * the default behavior answers like a real chat turn (init, stream deltas,
 * assistant, result) with *cumulative* modelUsage per Claude session, just
 * like the real SDK does across resumes.
 */
import { randomUUID } from "node:crypto";
import type { SdkDeps, SdkOptions, SDKMessage, SDKUserMessage, SessionMessage, HubQuery, SdkModelInfo, SlashCommand, HubToolSpec, SdkContextUsage } from "../src/sessions/sdk.js";
import { PushQueue } from "../src/sessions/pushQueue.js";

type Item = { msg: SDKMessage } | { error: Error };

export type Behavior = (q: FakeQuery, user: SDKUserMessage) => void | Promise<void>;

export interface Totals {
  input: number;
  output: number;
  cost: number;
}

export class FakeQuery implements HubQuery {
  readonly received: SDKUserMessage[] = [];
  readonly flags: Record<string, unknown>[] = [];
  readonly models: (string | undefined)[] = [];
  readonly modes: string[] = [];
  interrupted = 0;
  reloaded = 0;
  closed = false;
  readonly sessionId: string;
  private readonly out = new PushQueue<Item>();
  onInterrupt: ((q: FakeQuery) => void) | null = null;

  constructor(
    readonly options: SdkOptions,
    prompt: AsyncIterable<SDKUserMessage>,
    private readonly sdk: FakeSdk,
  ) {
    // `forkSession` resumes as a copy under a new session id (like the CLI's --fork-session).
    this.sessionId = options.forkSession ? randomUUID() : (options.resume ?? randomUUID());
    void (async () => {
      for await (const m of prompt) {
        this.received.push(m);
        try {
          await sdk.behavior(this, m);
        } catch (err) {
          this.fail(err as Error);
        }
      }
    })();
  }

  emit(msg: Record<string, unknown>): void {
    this.out.push({ msg: msg as SDKMessage });
  }

  fail(error: Error): void {
    this.out.push({ error });
  }

  /** Ends the stream as if the process exited. */
  end(): void {
    this.out.close();
  }

  // ---- helpers producing realistic SDK messages
  init(): void {
    this.emit({ type: "system", subtype: "init", session_id: this.sessionId, model: "fake-model", permissionMode: this.options.permissionMode ?? "default", cwd: this.options.cwd, tools: [], uuid: randomUUID() });
  }

  streamText(messageId: string, text: string, opts: { usage?: Record<string, number>; parent?: string | null; model?: string } = {}): void {
    const message: Record<string, unknown> = { id: messageId };
    if (opts.model) message.model = opts.model;
    if (opts.usage) message.usage = opts.usage;
    this.emit({ type: "stream_event", event: { type: "message_start", message }, parent_tool_use_id: opts.parent ?? null, uuid: randomUUID(), session_id: this.sessionId });
    this.emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null, uuid: randomUUID(), session_id: this.sessionId });
    for (const part of text.match(/.{1,3}/gs) ?? []) {
      this.emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } }, parent_tool_use_id: opts.parent ?? null, uuid: randomUUID(), session_id: this.sessionId });
    }
  }

  /** `message_delta` with the message's cumulative output tokens (what the API sends before message_stop). */
  messageDelta(outputTokens: number, parent: string | null = null): void {
    this.emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } }, parent_tool_use_id: parent, uuid: randomUUID(), session_id: this.sessionId });
  }

  assistant(messageId: string, text: string, extra: Record<string, unknown> = {}): string {
    const uuid = randomUUID();
    this.emit({ type: "assistant", message: { id: messageId, role: "assistant", model: "fake-model", content: [{ type: "text", text }] }, parent_tool_use_id: null, uuid, session_id: this.sessionId, ...extra });
    return uuid;
  }

  stop(messageId: string, parent: string | null = null): void {
    this.emit({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: parent, uuid: randomUUID(), session_id: this.sessionId, _mid: messageId });
  }

  /** Adds `add` to this Claude session's cumulative totals and emits a result with the totals. */
  result(add: Totals = { input: 10, output: 5, cost: 0.01 }, extra: Record<string, unknown> = {}): void {
    const cur = this.sdk.totals.get(this.sessionId) ?? { input: 0, output: 0, cost: 0 };
    const next = { input: cur.input + add.input, output: cur.output + add.output, cost: cur.cost + add.cost };
    this.sdk.totals.set(this.sessionId, next);
    this.emitResultWithTotals(next, extra);
  }

  emitResultWithTotals(t: Totals, extra: Record<string, unknown> = {}): void {
    this.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 42,
      duration_api_ms: 40,
      num_turns: 1,
      result: "ok",
      stop_reason: "end_turn",
      total_cost_usd: t.cost,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { "fake-model": { inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: t.cost, webSearchRequests: 0, contextWindow: 200_000, maxOutputTokens: 32_000 } },
      permission_denials: [],
      uuid: randomUUID(),
      session_id: this.sessionId,
      ...extra,
    });
  }

  /** A full normal turn. */
  reply(text: string, add?: Totals): void {
    const mid = `msg_${randomUUID().slice(0, 8)}`;
    this.init();
    this.streamText(mid, text);
    this.assistant(mid, text);
    this.stop(mid);
    this.result(add);
  }

  // ---- HubQuery
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    const it = this.out[Symbol.asyncIterator]();
    return {
      next: async () => {
        const r = await it.next();
        if (r.done) return { value: undefined as never, done: true };
        if ("error" in r.value) throw r.value.error;
        return { value: r.value.msg, done: false };
      },
    };
  }

  async interrupt(): Promise<unknown> {
    this.interrupted++;
    this.onInterrupt?.(this);
    return undefined;
  }

  readonly stoppedTasks: string[] = [];
  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
  }

  async setModel(model?: string): Promise<void> {
    this.models.push(model);
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    this.flags.push(settings);
  }

  async supportedModels(): Promise<SdkModelInfo[]> {
    return [
      { value: "default", displayName: "Default", description: "d", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
      { value: "haiku", displayName: "Haiku", description: "h" },
    ];
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    return [
      { name: "compact", description: "Compact", argumentHint: "", builtin: true },
      { name: "login", description: "Login", argumentHint: "", builtin: true },
      { name: "my-skill", description: "A skill", argumentHint: "[x]" },
    ];
  }

  async reloadSkills(): Promise<unknown> {
    this.reloaded++;
    return { skills: [] };
  }

  contextUsageCalls = 0;
  /** Answers with `FakeSdk.contextUsage`; rejects (like a CLI without the control request) when it is unset. */
  async getContextUsage(): Promise<SdkContextUsage> {
    this.contextUsageCalls++;
    if (!this.sdk.contextUsage) throw new Error("get_context_usage not supported");
    return this.sdk.contextUsage;
  }

  /** Runs the hub's in-process hooks for `event` like the CLI does (matchers are not evaluated here); returns their outputs. */
  async runHooks(event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionDenied", toolName: string, toolInput: Record<string, unknown>, toolUseId: string): Promise<unknown[]> {
    const matchers = (this.options.hooks as Record<string, { hooks: ((i: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>)[] }[]> | undefined)?.[event] ?? [];
    const input = { hook_event_name: event, tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId, tool_response: {}, error: "x", reason: "x", session_id: this.sessionId, transcript_path: "/dev/null", cwd: this.options.cwd };
    const outs: unknown[] = [];
    for (const m of matchers) for (const h of m.hooks) outs.push(await h(input, toolUseId, { signal: new AbortController().signal }));
    return outs;
  }

  close(): void {
    this.closed = true;
    this.out.close();
  }

  /** Calls the hub's canUseTool like the CLI does. */
  askPermission(toolName: string, input: Record<string, unknown>, signal = new AbortController().signal) {
    const canUseTool = this.options.canUseTool;
    if (!canUseTool) throw new Error("no canUseTool");
    return canUseTool(toolName, input, { signal, toolUseID: `toolu_${randomUUID().slice(0, 6)}`, requestId: randomUUID() });
  }
}

export class FakeSdk implements SdkDeps {
  readonly queries: FakeQuery[] = [];
  readonly transcripts = new Map<string, SessionMessage[]>();
  readonly totals = new Map<string, Totals>();
  /** What `getContextUsage()` answers (null = the request fails). */
  contextUsage: SdkContextUsage | null = null;
  behavior: Behavior = (q, m) => {
    const text = typeof m.message.content === "string" ? m.message.content : "attachment";
    q.reply(`echo: ${text}`);
  };

  query = (params: { prompt: AsyncIterable<SDKUserMessage>; options: SdkOptions }): HubQuery => {
    const q = new FakeQuery(params.options, params.prompt, this);
    this.queries.push(q);
    return q;
  };

  getSessionMessages = async (id: string): Promise<SessionMessage[]> => this.transcripts.get(id) ?? [];

  /** In-process tool servers the runtime registered (name → tools), so tests can invoke the handlers directly. */
  readonly mcpServers = new Map<string, HubToolSpec[]>();
  createMcpServer = (name: string, tools: HubToolSpec[]): NonNullable<SdkOptions["mcpServers"]>[string] => {
    this.mcpServers.set(name, tools);
    return { type: "sdk", name, instance: {} as never } as NonNullable<SdkOptions["mcpServers"]>[string];
  };

  get last(): FakeQuery {
    const q = this.queries[this.queries.length - 1];
    if (!q) throw new Error("no query spawned");
    return q;
  }
}
