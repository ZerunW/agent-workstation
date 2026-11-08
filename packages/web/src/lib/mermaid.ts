import { tokenValue } from "./visual";

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
let seq = 0;
let applied = "";

/** The mermaid bundle, fetched on first use (a separate chunk, never part of the app's entry). */
export function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Mermaid's "base" theme driven by the app's colour tokens, so diagrams follow light/dark and the accent. */
export function mermaidThemeVariables(): Record<string, string> {
  const fg = tokenValue("fg");
  const surface = tokenValue("surface");
  const line = tokenValue("fg-muted");
  const accent = tokenValue("accent");
  const soft = tokenValue("accent-soft") || surface;
  return {
    fontFamily: FONT,
    background: "transparent",
    primaryColor: soft,
    primaryTextColor: fg,
    primaryBorderColor: accent,
    secondaryColor: tokenValue("info-soft") || surface,
    secondaryTextColor: fg,
    secondaryBorderColor: tokenValue("info") || line,
    tertiaryColor: tokenValue("sunken") || surface,
    tertiaryTextColor: fg,
    tertiaryBorderColor: line,
    lineColor: line,
    textColor: fg,
    mainBkg: surface,
    nodeBorder: accent,
    nodeTextColor: fg,
    clusterBkg: tokenValue("sunken") || surface,
    clusterBorder: tokenValue("line-strong") || line,
    edgeLabelBackground: surface,
    titleColor: fg,
    noteBkgColor: tokenValue("warn-soft") || surface,
    noteTextColor: fg,
    noteBorderColor: tokenValue("warn") || line,
    actorBkg: surface,
    actorBorder: accent,
    actorTextColor: fg,
    actorLineColor: line,
    signalColor: fg,
    signalTextColor: fg,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: line,
    labelTextColor: fg,
    loopTextColor: fg,
    activationBkgColor: soft,
    activationBorderColor: accent,
  };
}

/**
 * Render diagram source to SVG markup. Throws the mermaid parse error (its first line is the message) on invalid source.
 * `strict` security level (mermaid sanitises its own output and ignores directives that would loosen it) and plain
 * SVG labels (no `<foreignObject>` HTML), so the result needs nothing the app's CSP forbids.
 */
export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const vars = mermaidThemeVariables();
  const key = JSON.stringify(vars);
  if (key !== applied) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: vars,
      fontFamily: FONT,
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      maxTextSize: 50_000,
    });
    applied = key;
  }
  const id = `workstation-mmd-${++seq}`;
  try {
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    return svg;
  } finally {
    // a failed render leaves its scratch/error element in <body>
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** A mermaid error on one line: "Parse error on line 3: Expecting …, got 'EOF'" (its message spans several, with a caret diagram). */
export function mermaidErrorLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  let line = lines[0] ?? "Invalid diagram";
  if (lines.length > 1 && /^Parse error/i.test(line)) line = `${line.replace(/:$/, "")}: ${lines[lines.length - 1]}`;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
