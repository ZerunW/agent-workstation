/**
 * Default ignore patterns written to `<gitDir>/info/exclude` (gitignore syntax).
 * Directory patterns carry a trailing slash so that a *file* called `build`
 * (a common script name) is still synced. Callers append their own patterns;
 * a negation such as `!build/` re-includes a default.
 *
 * In-tree `.gitignore` files are honoured too unless the caller opens the repo with `honorGitignore: false`. The hub
 * opens every project with `defaultExcludes: false` and `honorGitignore: false`: there the only patterns are `.git` and
 * the paths the person unchecked on the Mac (PUT /api/projects/:id/excludes).
 */
export const defaultExcludes: readonly string[] = Object.freeze([
  ".git",
  "node_modules/",
  "build/",
  "dist/",
  ".DS_Store",
  "__pycache__/",
  ".venv/",
  "target/",
]);

/**
 * `withDefaults: false` (the hub, where the person's unchecked paths are the only rules): `.git` and `extra` only.
 */
export function renderExcludeFile(extra: readonly string[] = [], withDefaults = true): string {
  const lines = [
    "# Managed by @agent-workstation/sync-core — rewritten every time the project is opened.",
    "# Paths matching these patterns are invisible to sync and review.",
    ...(withDefaults ? defaultExcludes : [".git"]),
  ];
  const custom = extra.map((p) => p.replace(/[\r\n]/g, "")).filter((p) => p.trim() !== "");
  if (custom.length > 0) lines.push("# caller-supplied", ...custom);
  return lines.join("\n") + "\n";
}

/**
 * `<gitDir>/info/attributes` has the highest precedence of all attribute
 * sources. We switch off every content conversion so that blob bytes are always
 * identical to file bytes — otherwise an in-tree `.gitattributes` with
 * `text=auto`/`eol=crlf`/`filter=lfs` would make the sha256 the Mac computes
 * differ from what the hub stores, and manifest reconciliation would loop.
 */
export const ATTRIBUTES_FILE = [
  "# Managed by @agent-workstation/sync-core: blob bytes == file bytes, always.",
  "* -text -filter -ident -working-tree-encoding",
  "",
].join("\n");
