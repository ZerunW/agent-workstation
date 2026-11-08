import type { HeadsUpInput } from "@agent-workstation/protocol";
import { isRecord } from "./sdk";

/** The agent's `heads_up` tool: shown as a card under the message, never as a tool row. */
export const HEADS_UP_TOOL = "mcp__workstation_turn__heads_up";
export const isHeadsUpTool = (name: string): boolean => name === HEADS_UP_TOOL;

/** The card content of a complete tool input; null when it is not a usable heads-up. */
export function parseHeadsUp(input: unknown): HeadsUpInput | null {
  if (!isRecord(input) || typeof input.text !== "string" || !input.text.trim()) return null;
  const detail = typeof input.detail === "string" && input.detail.trim() ? input.detail : undefined;
  return { text: input.text, ...(detail ? { detail } : {}) };
}
