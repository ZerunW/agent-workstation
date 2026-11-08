import DOMPurify from "dompurify";
import { isRecord } from "./sdk";

/**
 * `show_visual` — the hub's inline-visual tool, input `{ title, svg?, html? }`. The MCP prefix is the hub's business
 * (`mcp__workstation-visual__show_visual`), so only the suffix counts.
 */
export function isVisualTool(name: string): boolean {
  return /(^|__)show_visual$/.test(name);
}

export interface VisualInput {
  title: string;
  svg?: string;
  html?: string;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Tolerant of half-streamed input: every field optional. */
export function parseVisual(input: unknown): VisualInput {
  const o = isRecord(input) ? input : {};
  return { title: typeof o.title === "string" ? o.title.trim() : "", svg: text(o.svg), html: text(o.html) };
}

// ---------------------------------------------------------------------------
// SVG sanitising
// ---------------------------------------------------------------------------
/** Elements that never survive: scripts, HTML islands, global stylesheets and href-retargeting animation. */
const FORBID_TAGS = ["script", "foreignObject", "style", "iframe", "object", "embed", "animate", "set", "handler", "listener", "link", "meta", "base"];
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

let purify: ReturnType<typeof DOMPurify> | null = null;

function instance(): ReturnType<typeof DOMPurify> {
  if (purify) return purify;
  const p = DOMPurify(window);
  p.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName.toLowerCase();
    if (name === "href" || name === "xlink:href") {
      const v = data.attrValue.trim();
      // only in-document fragment references (gradients, markers, <use>) and inline raster images
      if (!(v.startsWith("#") || (node.nodeName.toLowerCase() === "image" && SAFE_DATA_IMAGE.test(v)))) data.keepAttr = false;
    }
    if (name === "style") {
      // no layout escapes, no url() loads
      data.attrValue = data.attrValue.replace(/(?:^|;)\s*(?:position|z-index)\s*:[^;]*/gi, "").replace(/url\(\s*(?!["']?#)[^)]*\)/gi, "none");
    }
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    // a top-level <svg> without viewBox but with a numeric size gets one, so it can scale to its container
    if (node.nodeName.toLowerCase() !== "svg" || node.parentElement?.closest("svg") || node.hasAttribute("viewBox")) return;
    const w = parseFloat(node.getAttribute("width") ?? "");
    const h = parseFloat(node.getAttribute("height") ?? "");
    if (w > 0 && h > 0) node.setAttribute("viewBox", `0 0 ${w} ${h}`);
  });
  purify = p;
  return p;
}

/** SVG markup safe to inline: no script, event handlers, foreignObject, <style>, external references or `javascript:` hrefs. */
export function sanitizeSvg(svg: string): string {
  if (typeof window === "undefined" || !/<svg[\s>]/i.test(svg)) return "";
  const clean = instance().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS,
    FORBID_ATTR: ["srcdoc", "formaction"],
    ADD_ATTR: ["xlink:href"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
  });
  return /<svg[\s>]/i.test(clean) ? clean : "";
}

// ---------------------------------------------------------------------------
// Theme tokens (shared by the HTML iframe, SVG export and mermaid)
// ---------------------------------------------------------------------------
export const THEME_TOKENS = ["bg", "surface", "sunken", "hover", "fg", "fg-muted", "fg-subtle", "line", "line-strong", "accent", "accent-soft", "ok", "ok-soft", "warn", "warn-soft", "danger", "danger-soft", "info", "info-soft", "code-bg"] as const;

const FALLBACK: Record<string, string> = { bg: "#f7f8fa", surface: "#ffffff", fg: "#16191d", "fg-muted": "#5b6270", line: "#d9d8d4", accent: "#0f766e" };

/** The current value of an app colour token (`--fg`), resolved from the document; "" when unknown. */
export function tokenValue(name: string): string {
  if (typeof document === "undefined") return FALLBACK[name] ?? "";
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return v || FALLBACK[name] || "";
}

/** `:root { --bg: …; … }` with the tokens as they are right now, for documents that cannot inherit them (iframe srcdoc, exports). */
export function themeCss(): string {
  return `:root{${THEME_TOKENS.map((n) => `--${n}:${tokenValue(n)}`).join(";")}}`;
}

/** Marker on every message between an HTML visual's frame and the app. */
export const VISUAL_MSG = "workstation-visual";

/** The hub route that serves CDN libraries for visuals (fetched and cached by the server). */
export const VISUAL_CDN_PATH = "/api/visual-cdn/";
const CDN_URL = /(?:https?:)?\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//gi;

/**
 * Points a visual's CDN URLs at the hub (`https://cdn.jsdelivr.net/npm/x` → `<origin>/api/visual-cdn/cdn.jsdelivr.net/npm/x`):
 * the person's device then loads libraries only from the server and never contacts a CDN.
 */
export function rewriteVisualCdn(html: string, origin: string): string {
  return html.replace(CDN_URL, (_m, host: string) => `${origin}${VISUAL_CDN_PATH}${host.toLowerCase()}/`);
}

/** The frame's policy: inline scripts plus libraries from the hub's CDN route only; no network requests, no external images or fonts. */
export function visualCsp(origin: string): string {
  return `default-src 'none'; script-src 'unsafe-inline' ${origin}${VISUAL_CDN_PATH}; style-src 'unsafe-inline' ${origin}${VISUAL_CDN_PATH}; img-src data: blob:; font-src data: ${origin}${VISUAL_CDN_PATH}; connect-src 'none'; form-action 'none'`;
}

/** The theme `<style>` content: the app colour tokens as they are right now, plus the colour scheme. */
export function visualThemeCss(dark: boolean): string {
  return `${themeCss()}html{color-scheme:${dark ? "dark" : "light"}}`;
}

/**
 * Runs inside the frame (opaque origin, scripts only): reports the full content height, exposes `window.sendPrompt(text)`
 * and applies theme updates posted by the app, trusting only messages whose source is the parent window.
 * The height is the largest of the document / body scroll heights and the body's bounding box plus its bottom margin;
 * it is re-measured on load, once fonts are ready, on ResizeObserver of html / body and (throttled) on DOM mutations.
 * The document scroll height only counts when it exceeds the viewport, so a frame that grew too tall can shrink again.
 */
export const VISUAL_BOOTSTRAP = `(function(){var S="${VISUAL_MSG}",P=window.parent;function post(m){m.source=S;try{P.postMessage(m,"*")}catch(e){}}
window.sendPrompt=function(t){if(typeof t==="string"&&t.trim())post({type:"prompt",text:t})};
var last=-1;
function measure(){var d=document.documentElement,b=document.body,h=Math.ceil(d.getBoundingClientRect().height)||0;
if(d.scrollHeight>(window.innerHeight||0))h=Math.max(h,d.scrollHeight);
if(b){h=Math.max(h,b.scrollHeight||0);var r=b.getBoundingClientRect(),mb=0;try{mb=parseFloat(getComputedStyle(b).marginBottom)||0}catch(e){}h=Math.max(h,Math.ceil(r.bottom+(window.pageYOffset||0)+mb))}
h=Math.ceil(h);if(h!==last){last=h;post({type:"height",height:h})}}
var timer=0;function later(){if(timer)return;timer=setTimeout(function(){timer=0;measure()},80)}
if(typeof ResizeObserver==="function"){var ro=new ResizeObserver(measure);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}
if(typeof MutationObserver==="function"){new MutationObserver(later).observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true})}
window.addEventListener("load",measure);document.addEventListener("DOMContentLoaded",measure);
if(document.fonts&&document.fonts.ready&&document.fonts.ready.then)document.fonts.ready.then(measure);
window.addEventListener("message",function(e){var d=e.data;if(e.source!==P||!d||d.source!==S||d.type!=="theme"||typeof d.css!=="string")return;var st=document.getElementById("workstation-theme");if(st)st.textContent=d.css});
})();`;

/** The sandboxed document for an HTML visual: CSP, theme variables, transparent page, app text colour, height / prompt bootstrap. */
export function visualSrcdoc(html: string, dark: boolean, origin: string = typeof window === "undefined" ? "" : window.location.origin): string {
  const base = `html,body{margin:0;background:transparent;color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}body{padding:4px}*{box-sizing:border-box}`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${visualCsp(origin)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="workstation-theme">${visualThemeCss(dark)}</style><style>${base}</style><script>${VISUAL_BOOTSTRAP}</script></head><body>${rewriteVisualCdn(html, origin)}</body></html>`;
}

// ---------------------------------------------------------------------------
// Export (SVG file / PNG raster)
// ---------------------------------------------------------------------------
/** Resolve `var(--token)` and `currentColor` to concrete colours so the markup stands alone outside the app. */
export function resolveSvgVars(markup: string, color: string): string {
  return markup
    .replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, name: string, fallback?: string) => tokenValue(name) || fallback?.trim() || color)
    .replace(/currentColor/gi, color);
}

export interface SvgExport {
  /** Standalone SVG markup (xmlns, size, resolved colours). */
  markup: string;
  width: number;
  height: number;
}

/** A standalone copy of a rendered inline SVG, or null when it is not an SVG element. */
export function exportSvg(el: Element | null): SvgExport | null {
  if (!el || el.nodeName.toLowerCase() !== "svg") return null;
  const color = tokenValue("fg") || "#16191d";
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  // the stylesheet default (`text` without a fill uses the text colour) does not travel with the file
  clone.querySelectorAll("text,tspan").forEach((n) => {
    if (!n.hasAttribute("fill") && !/fill\s*:/.test(n.getAttribute("style") ?? "")) n.setAttribute("fill", color);
  });
  const vb = (clone.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  let width = parseFloat(clone.getAttribute("width") ?? "");
  let height = parseFloat(clone.getAttribute("height") ?? "");
  if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) {
    if (!(width > 0) || /%$/.test(clone.getAttribute("width") ?? "")) width = vb[2]!;
    if (!(height > 0) || /%$/.test(clone.getAttribute("height") ?? "")) height = vb[3]!;
  }
  if (!(width > 0)) width = 800;
  if (!(height > 0)) height = 450;
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("class");
  return { markup: resolveSvgVars(new XMLSerializer().serializeToString(clone), color), width, height };
}

export function svgBlob(markup: string): Blob {
  return new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
}

/** Rasterise standalone SVG markup on a canvas (2x, over the app background). */
export function svgToPng(exp: SvgExport, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(exp.width * scale);
      canvas.height = Math.round(exp.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas unavailable"));
      ctx.fillStyle = tokenValue("surface") || "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png");
    };
    img.onerror = () => reject(new Error("SVG could not be rasterised"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exp.markup)}`;
  });
}

/** A filesystem-safe name from a visual's title. */
export function visualFilename(title: string, ext: string): string {
  const base = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${base || "visual"}.${ext}`;
}
