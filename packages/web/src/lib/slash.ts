import type { CommandInfo } from "@agent-workstation/protocol";
import { fuzzyMatch } from "./fuzzy";

export interface SlashMatch {
  command: CommandInfo;
  score: number;
  /** indexes into command.name that matched */
  nameIndexes: number[];
}

/**
 * Filter + rank slash commands for the palette. `query` is the text after the leading "/" (no spaces).
 * Name matches outrank description matches; skills sort after built-ins on equal score.
 */
export function filterCommands(commands: readonly CommandInfo[], query: string, limit = 50): SlashMatch[] {
  const q = query.trim().replace(/^\//, "");
  const out: SlashMatch[] = [];
  for (const command of commands) {
    const name = command.name.replace(/^\//, "");
    if (!q) {
      out.push({ command, score: command.isSkill ? 0 : 1, nameIndexes: [] });
      continue;
    }
    const byName = fuzzyMatch(q, name);
    if (byName) {
      out.push({ command, score: 1000 + byName.score + (command.isSkill ? 0 : 5), nameIndexes: byName.indexes });
      continue;
    }
    const desc = command.description ?? "";
    if (desc && desc.toLowerCase().includes(q.toLowerCase())) out.push({ command, score: 100 - desc.toLowerCase().indexOf(q.toLowerCase()) * 0.1, nameIndexes: [] });
  }
  out.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
  return out.slice(0, limit);
}

/** Detects an active `/command` token at the very start of the composer text. */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith("/")) return null;
  const head = text.slice(0, caret);
  if (/\s/.test(head)) return null; // caret already past the command name
  return head.slice(1);
}

export function insertCommand(command: CommandInfo): string {
  const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
  return `${name} `;
}

/** Detects an `@path` mention under the caret; returns the token and its [start,end). */
export function mentionAtCaret(text: string, caret: number): { query: string; start: number; end: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const start = before.length - m[2]!.length - 1;
  return { query: m[2]!, start, end: caret };
}
