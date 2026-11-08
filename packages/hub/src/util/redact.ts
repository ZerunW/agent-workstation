/**
 * Masks credential-shaped text before it is logged or stored: process output (a dying Claude process's stderr) can echo
 * what it was given. The patterns are the ones scripts/check-secrets.sh looks for, plus the hub's own proxy tokens and
 * HTTP authorization values. It is a safety net, not a guarantee: paths and other text are left as they are.
 */

/** Credential formats: the whole match is replaced. */
const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic API key
  /\bhsk-[A-Za-z0-9_-]{20,}/g, // the hub's key-proxy token
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\btskey-[A-Za-z0-9-]{20,}/g, // Tailscale key
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}/g, // Stripe live key
  /-----BEGIN ([A-Z]+ )*PRIVATE KEY-----[\s\S]*?(-----END ([A-Z]+ )*PRIVATE KEY-----|$)/g, // private key block
];

/** HTTP authorization values: the header name (and a Bearer scheme) stay, the value goes. */
const HEADER_VALUE = /\b(authorization|x-api-key)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',;]+/gi;

export const REDACTED = "[redacted]";

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of KEY_PATTERNS) out = out.replace(re, REDACTED);
  return out.replace(HEADER_VALUE, (_m, name: string, sep: string, bearer: string | undefined) => `${name}${sep}${bearer ?? ""}${REDACTED}`);
}
