/**
 * Hub-side "always allow" rules. They live in SQLite (permissions_rules) so
 * they survive process respawns, unlike the CLI's in-process session rules.
 *
 * A rule is (toolName, ruleContent | null):
 *   - null content            → any input for that tool
 *   - Bash "npm test:*"       → command starts with "npm test"
 *   - Bash "git status"       → exact command
 *   - file tools "src/**"     → glob on file_path / path / notebook_path
 *                               (matched against the absolute path and the path relative to cwd)
 *   - WebFetch "domain:x.com" → URL host is x.com or a subdomain
 */
import { isAbsolute, relative } from "node:path";

export interface RuleSpec {
  toolName: string;
  ruleContent: string | null;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function ruleMatches(rule: RuleSpec, toolName: string, input: Record<string, unknown>, cwd: string): boolean {
  if (rule.toolName !== toolName) return false;
  const content = rule.ruleContent?.trim();
  if (!content) return true;

  if (toolName === "Bash") {
    const cmd = str(input.command)?.trim();
    if (cmd == null) return false;
    // Never auto-allow compound commands via a prefix rule; ask instead.
    if (/[;&|`\n]|\$\(/.test(cmd) && cmd !== content) return false;
    if (content.endsWith(":*")) {
      const prefix = content.slice(0, -2).trim();
      return cmd === prefix || cmd.startsWith(prefix + " ");
    }
    if (content.endsWith("*")) return cmd.startsWith(content.slice(0, -1));
    return cmd === content;
  }

  if (content.startsWith("domain:")) {
    const url = str(input.url);
    if (!url) return false;
    try {
      const host = new URL(url).hostname;
      const d = content.slice("domain:".length).trim();
      return host === d || host.endsWith("." + d);
    } catch {
      return false;
    }
  }

  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (path) {
    const re = globToRegExp(content.startsWith("//") ? content.slice(1) : content);
    if (re.test(path)) return true;
    if (isAbsolute(path)) {
      const rel = relative(cwd, path);
      if (!rel.startsWith("..") && re.test(rel)) return true;
    }
    return false;
  }

  return false;
}

/**
 * Rules to store when the user answers "allow + remember". Uses the SDK's
 * own `addRules` suggestions when present (e.g. Bash(npm test:*)); otherwise
 * allows the whole tool.
 */
export function rulesFromSuggestions(toolName: string, suggestions: unknown[] | undefined): RuleSpec[] {
  const out: RuleSpec[] = [];
  for (const s of suggestions ?? []) {
    if (!s || typeof s !== "object") continue;
    const sug = s as { type?: unknown; behavior?: unknown; rules?: unknown };
    if (sug.type !== "addRules" || sug.behavior !== "allow" || !Array.isArray(sug.rules)) continue;
    for (const r of sug.rules) {
      if (!r || typeof r !== "object") continue;
      const rv = r as { toolName?: unknown; ruleContent?: unknown };
      if (typeof rv.toolName !== "string") continue;
      out.push({ toolName: rv.toolName, ruleContent: typeof rv.ruleContent === "string" ? rv.ruleContent : null });
    }
  }
  if (out.length === 0) out.push({ toolName, ruleContent: null });
  return out;
}
