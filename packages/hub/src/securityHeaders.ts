/**
 * Security headers of the hub's HTTP responses.
 *
 * - Every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`.
 * - The web app's HTML pages (index.html, embed.html and the SPA fallback): a strict Content-Security-Policy. Checked
 *   against the built bundle: no eval / new Function, no workers or WebAssembly, no external origins (KaTeX fonts are
 *   self-hosted, one is a data: URI; uPlot and xterm draw on canvas and inject <style> elements). The only inline
 *   scripts are the pages' small theme pre-paint snippets, allowed by their SHA-256 hash, computed from the file
 *   actually served (so the policy follows web builds without a hub change).
 * - Inline file previews keep their own `Content-Security-Policy: sandbox` (set by the file routes).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const BASE_POLICY = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'", "ws:", "wss:"],
  "frame-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'self'"],
} as const;

/** SHA-256 source expressions of the inline (src-less) scripts of an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs) || !body.trim()) continue;
    const hash = `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
    if (!out.includes(hash)) out.push(hash);
  }
  return out;
}

/** The app CSP for an HTML document (its inline scripts allowed by hash). */
export function appCsp(html: string): string {
  const hashes = inlineScriptHashes(html);
  return Object.entries(BASE_POLICY)
    .map(([k, v]) => `${k} ${(k === "script-src" ? [...v, ...hashes] : [...v]).join(" ")}`)
    .join("; ");
}

const cache = new Map<string, { mtimeMs: number; size: number; csp: string }>();

/** The app CSP for an HTML file on disk (cached by mtime and size). */
export function appCspForFile(path: string): string {
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.csp;
    const csp = appCsp(readFileSync(path, "utf8"));
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, csp });
    return csp;
  } catch {
    return appCsp("");
  }
}

export const COMMON_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
} as const;
