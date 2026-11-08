import type { ServerEvent, Session, StoredMessage } from "@agent-workstation/protocol";

export const SID = "11111111-1111-4111-8111-111111111111";

export function stored(seq: number, kind: StoredMessage["kind"], payload: unknown, uuid = `u-${seq}`): StoredMessage {
  return { seq, sessionId: SID, uuid, kind, payload, at: new Date(1_700_000_000_000 + seq * 1000).toISOString() };
}

export const userText = (seq: number, text: string, uuid?: string) =>
  stored(seq, "user", { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null }, uuid);

export const assistant = (seq: number, content: unknown[], extra: Record<string, unknown> = {}) =>
  stored(seq, "assistant", { type: "assistant", message: { id: `msg_${seq}`, role: "assistant", model: "claude-sonnet-5-5", content }, parent_tool_use_id: null, ...extra });

export const toolResult = (seq: number, toolUseId: string, content: unknown, isError = false) =>
  stored(seq, "user", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] }, parent_tool_use_id: null });

export const resultMsg = (seq: number, extra: Record<string, unknown> = {}) =>
  stored(seq, "result", { type: "result", subtype: "success", is_error: false, duration_ms: 12_300, total_cost_usd: 0.0123, num_turns: 3, result: "done", ...extra });

export function session(over: Partial<Session> = {}): Session {
  return {
    id: SID,
    user: "alice",
    kind: "code",
    title: "Test session",
    cwd: "",
    model: "claude-sonnet-5-5",
    permissionMode: "default",
    effort: null,
    status: "idle",
    queuePosition: null,
    claudeSessionId: null,
    createdAt: "2026-10-31T00:00:00.000Z",
    lastActiveAt: "2026-10-31T00:00:00.000Z",
    lastSeq: 0,
    costUsd: 0,
    ...over,
  };
}

export const snapshotEvent = (
  s: Session,
  partial: Partial<Extract<ServerEvent, { type: "snapshot" }>["snapshot"]["partial"]> = {},
  pending: Extract<ServerEvent, { type: "snapshot" }>["snapshot"]["pendingPermission"] = null,
  turnStartedAt?: string | null,
): ServerEvent => ({
  type: "snapshot",
  sessionId: s.id,
  snapshot: { session: s, partial: { messageId: null, text: "", thinking: "", currentTool: null, ...partial }, ...(turnStartedAt !== undefined ? { turnStartedAt } : {}), pendingPermission: pending },
});

export const usageDelta = (turnOutputTokens: number, outputTokens = turnOutputTokens): ServerEvent => ({ type: "delta", sessionId: SID, delta: { part: "usage", messageId: "m", outputTokens, turnOutputTokens } });
