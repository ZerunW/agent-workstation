import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

/** Language support by file extension; unknown extensions render as plain text. */
export function languageForPath(path: string | undefined): Extension[] {
  const ext = (path ?? "").split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "json":
    case "jsonc":
      return [json()];
    case "py":
      return [python()];
    case "css":
      return [css()];
    case "html":
    case "htm":
    case "svg":
    case "xml":
    case "vue":
      return [html()];
    case "md":
    case "markdown":
      return [markdown()];
    default:
      return [];
  }
}

/** Token colors come from the CSS variables in index.css, so light/dark/system themes just work. */
export const cssVarHighlight: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: "var(--hl-keyword)" },
    { tag: [t.string, t.regexp, t.special(t.string)], color: "var(--hl-string)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--hl-number)" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--hl-comment)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.definition(t.variableName), t.className, t.typeName], color: "var(--hl-title)" },
    { tag: [t.propertyName, t.attributeName], color: "var(--hl-attr)" },
    { tag: [t.tagName, t.standard(t.variableName), t.namespace], color: "var(--hl-built)" },
    { tag: t.heading, fontWeight: "600", color: "var(--hl-title)" },
    { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
    { tag: t.strong, fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
  ]),
);
