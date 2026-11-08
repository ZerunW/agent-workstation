/**
 * Small helpers shared by the session runtime and its tool modules: the past-conversation tools' MCP server name, a
 * path containment check, and Claude Code's "always allow" suggestion for a Bash command.
 */
import { isAbsolute, relative, resolve } from "node:path";

/** The past-conversation tools' in-process MCP server (search/history.ts). */
export const HISTORY_SERVER = "workstation-history";

/** `path` is `dir` or inside it (lexically, after resolving both). */
export function isUnder(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Claude-style "always allow" suggestion for a Bash command (`npm test:*`), like Claude Code offers. */
export function bashSuggestion(command: string): unknown[] | undefined {
  const cmd = command.trim();
  if (!cmd || /[;&|`\n<>]|\$\(/.test(cmd)) return undefined;
  const tokens = cmd.split(/\s+/);
  const prefix = tokens.length > 1 && /^[a-z][\w.-]*$/i.test(tokens[1]!) ? `${tokens[0]} ${tokens[1]}` : tokens[0]!;
  return [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: `${prefix}:*` }] }];
}
