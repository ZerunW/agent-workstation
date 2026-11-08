/**
 * `show_visual`: a diagram or small visual the model shows the user inline (Chat and Code sessions, incognito included). The hub stores nothing extra: the tool_use input (`title` plus `svg` or `html`) is the visual,
 * and clients render it from the stored message. `html` may be interactive: the web runs it in a sandboxed iframe
 * (scripts allowed, opaque origin, no network, scripts only inline or from cdnjs / jsDelivr, images data:/blob: only). It is offered through the in-process MCP server
 * `workstation-visual` (pre-approved).
 */
import { z } from "zod";
import type { HubToolResult, HubToolSpec } from "./sdk.js";

export const VISUAL_SERVER = "workstation-visual";
export const VISUAL_TOOL = "show_visual";
export const MAX_VISUAL_TITLE = 120;
export const MAX_VISUAL_BYTES = 200 * 1024;

/** When and how to draw: part of the Agent Workstation guide (guide.ts), re-exported for the tool's callers and tests. */
export { VISUAL_GUIDANCE } from "./guide.js";

const schema = {
  title: z.string().describe(`A short title for the visual (at most ${MAX_VISUAL_TITLE} characters).`),
  svg: z.string().optional().describe("A self-contained <svg> element: static, preferred for diagrams. At most 200 KB. Give exactly one of svg or html."),
  html: z
    .string()
    .optional()
    .describe(
      "A self-contained HTML fragment, for interactive visuals (sliders, tabs, live charts) or when SVG does not fit. Scripts allowed (inline, or from cdnjs.cloudflare.com / cdn.jsdelivr.net); no network requests, no external images or fonts. At most 200 KB. Give exactly one of svg or html.",
    ),
};

/** The tool's description: what clients do with svg and html (the web runs html in a sandboxed iframe). */
export const VISUAL_TOOL_DESCRIPTION =
  "Show the user a visual inline in the conversation: a title plus either a self-contained SVG (static; preferred for diagrams) or an HTML fragment, which may be interactive (sliders, tabs, live charts). " +
  "HTML runs in a sandboxed frame: scripts are allowed, inline or from cdnjs.cloudflare.com or cdn.jsdelivr.net; it has no network access (no fetch or other requests) and no external images or fonts (use data: URIs or inline SVG). " +
  "The theme's CSS variables var(--fg), var(--muted), var(--line), var(--accent), var(--surface) and var(--bg) are injected: use them for every colour so it works in light and dark mode, var(--accent) sparingly for the one thing to notice. About 680 px wide; the height grows to fit the content. " +
  "The app shows the visual bare in the text, like a figure: flat (no shadows or gradients), transparent background, no outer frame or border box; 1–1.5 px strokes; system sans-serif at 12–14 px; " +
  "the heading, labels and short captions inside the graphic; side-by-side panels when comparing; a margin so nothing is clipped; text never overlapping lines. " +
  "In HTML, sendPrompt(text) puts text into the user's message box (the user decides whether to send it). At most 200 KB.";

const fail = (text: string): HubToolResult => ({ text, isError: true });

/** Validates a show_visual call: a title of at most 120 characters and exactly one of svg / html of at most 200 KB. */
export function checkVisual(args: Record<string, unknown>): HubToolResult {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return fail("Not shown: a title is required.");
  if ([...title].length > MAX_VISUAL_TITLE) return fail(`Not shown: the title is longer than ${MAX_VISUAL_TITLE} characters.`);
  const has = (k: "svg" | "html") => typeof args[k] === "string" && (args[k] as string).trim() !== "";
  if (has("svg") === has("html")) return fail("Not shown: give exactly one of svg or html.");
  const body = (has("svg") ? args.svg : args.html) as string;
  if (Buffer.byteLength(body, "utf8") > MAX_VISUAL_BYTES) return fail(`Not shown: the ${has("svg") ? "svg" : "html"} is larger than 200 KB; simplify it.`);
  return "Shown to the user.";
}

export function visualTool(): HubToolSpec {
  return {
    name: VISUAL_TOOL,
    description: VISUAL_TOOL_DESCRIPTION,
    schema,
    handler: async (args) => checkVisual(args),
  };
}
