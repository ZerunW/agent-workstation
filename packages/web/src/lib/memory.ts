import { isRecord } from "./sdk";

/** The hub's in-process memory tools (Chat sessions): Claude calls them on its own or when asked. */
export const REMEMBER_TOOL = "mcp__workstation-memory__remember";
export const FORGET_TOOL = "mcp__workstation-memory__forget";

export type MemoryToolKind = "remember" | "forget";

export function memoryToolKind(name: string): MemoryToolKind | null {
  return name === REMEMBER_TOOL ? "remember" : name === FORGET_TOOL ? "forget" : null;
}

/** The memory text a call carries (`{ text }` for both tools); "" while the input is still streaming. */
export function memoryToolText(input: unknown): string {
  return isRecord(input) && typeof input.text === "string" ? input.text.trim() : "";
}
