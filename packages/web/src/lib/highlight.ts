import hljs from "highlight.js/lib/common";

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  makefile: "makefile",
  dockerfile: "dockerfile",
  lua: "lua",
  r: "r",
  pl: "perl",
  vue: "xml",
};

export function langFromPath(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  if (lower === "makefile" || lower === "dockerfile") return lower;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT_LANG[lower.slice(dot + 1)];
}

const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", js: "javascript", ts: "typescript", py: "python", yml: "yaml", html: "xml", jsonc: "json", tsx: "typescript", jsx: "javascript" };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Returns HTML (already escaped by highlight.js) for the given code. Falls back to escaped plain text. */
export function highlightToHtml(code: string, lang?: string): string {
  if (code.length > 200_000) return escapeHtml(code);
  const l = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : undefined;
  try {
    if (l && hljs.getLanguage(l)) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
    if (!l && code.length < 20_000) return hljs.highlightAuto(code).value;
  } catch {}
  return escapeHtml(code);
}
