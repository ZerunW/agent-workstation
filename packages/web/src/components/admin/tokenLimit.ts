import { formatTokens } from "../../lib/format";
import { t } from "../../i18n";

export type ParsedLimit = { ok: true; value: number | null } | { ok: false };

const MAX = Number.MAX_SAFE_INTEGER;

/**
 * Parse a weekly token limit typed by an admin: "" -> unlimited (null); "500k", "1.5m", "2b", "1,500,000".
 * Anything else (negative, text, fractions of a token) is rejected.
 */
export function parseTokenLimit(input: string): ParsedLimit {
  const s = input.trim().replace(/[,_\s]/g, "");
  if (s === "") return { ok: true, value: null };
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/i.exec(s);
  if (!m) return { ok: false };
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  const value = Math.round(Number(m[1]) * mult);
  if (!Number.isFinite(value) || value > MAX) return { ok: false };
  if (!m[2] && m[1]!.includes(".")) return { ok: false };
  return { ok: true, value };
}

export function formatLimit(limit: number | null): string {
  return limit == null ? t("admin.limit.unlimited") : formatTokens(limit);
}

/** Raw editable text for a limit (digits only, so the input round-trips exactly). */
export function limitToInput(limit: number | null): string {
  return limit == null ? "" : String(limit);
}

/**
 * Toggle one model in an allowlist. `current` null means "every model"; the result is null again
 * when the selection is empty or covers every known model.
 */
export function toggleAllowlist(current: string[] | null, allModels: readonly string[], value: string): string[] | null {
  const base = new Set(current ?? allModels);
  if (base.has(value)) base.delete(value);
  else base.add(value);
  const next = [...base];
  if (next.length === 0) return null;
  if (allModels.length > 0 && allModels.every((m) => base.has(m))) return null;
  return next;
}
