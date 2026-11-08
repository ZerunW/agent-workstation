/**
 * Model list helpers: a model's family and version, and the `legacy` flag (anything but the newest version of its
 * family; the user's default, the server default and the `default` alias are never legacy). Pure functions.
 */
import type { EffortLevel, ModelInfo } from "@agent-workstation/protocol";

/** The model the hub's own helpers use (search ranking, summaries, the download check, the price check). */
export const HELPER_MODEL = "claude-haiku-5-5";

/** The model id usage is recorded under (the id itself) and the effort, when known. */
export function canonicalUsageModel(model: string, effort: EffortLevel | string | null = null): { model: string; effort: string | null } {
  return { model, effort: effort ?? null };
}

/**
 * What people should see for a recorded model id: the catalog's display name when the id is listed, else a name built
 * from the id ("claude-haiku-4-5-20251001" → "Haiku 4.5", "claude-opus-5-5[1m]" → "Opus 5.5"); unknown ids are
 * returned unchanged.
 */
export function modelDisplayName(id: string, catalog: readonly Pick<ModelInfo, "value" | "displayName">[] | null = null): string {
  const exact = catalog?.find((m) => m.value === id);
  if (exact) return exact.displayName;
  const bare = id.toLowerCase().replace(/\[.*\]$/, "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const tokens = bare.split(/[-_.]/);
  const family = tokens.find((t) => KNOWN_FAMILIES.includes(t));
  if (!family) return id;
  const version = tokens.filter((t) => /^\d{1,3}$/.test(t));
  return `${family[0]!.toUpperCase()}${family.slice(1)}${version.length ? ` ${version.join(".")}` : ""}`;
}

const KNOWN_FAMILIES = ["opus", "fable", "sonnet", "haiku"];

/** An id without its `[1m]` suffix and `-YYYYMMDD` date, lower-cased. */
function bareModelId(id: string): string {
  return id.toLowerCase().replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
}

/**
 * Whether an API request for `requested` (the id the CLI sends, e.g. "claude-opus-5-5" or a dated id) falls under
 * one of the allowlist entries (catalog values: ids, or a family alias such as "opus" that stands for the family).
 */
export function modelMatchesAllowlist(allowlist: readonly string[], requested: string): boolean {
  const want = bareModelId(requested);
  return allowlist.some((entry) => {
    const have = bareModelId(entry);
    if (have === want) return true;
    return KNOWN_FAMILIES.includes(have) && familyFrom(want) === have;
  });
}

function familyFrom(text: string): string | null {
  const lower = text.toLowerCase();
  return KNOWN_FAMILIES.find((f) => lower.includes(f)) ?? null;
}

/** Family of a model: a known family word in the id, display name or (for aliases such as `default`) the description. */
export function modelFamily(m: Pick<ModelInfo, "value" | "displayName" | "description" | "family">): string {
  if (m.family) return m.family.toLowerCase();
  const f = familyFrom(m.value) ?? familyFrom(m.displayName) ?? (m.description ? familyFrom(m.description) : null);
  if (f) return f;
  const word = /[a-z]+/i.exec(m.displayName)?.[0] ?? /[a-z]+/i.exec(m.value)?.[0];
  return word ? word.toLowerCase() : "other";
}

/** Numeric version ("Opus 5.5" → [5, 5], "claude-opus-4-8" → [4, 8], `default` → from its description); [] when none. */
export function modelVersion(m: Pick<ModelInfo, "value" | "displayName" | "description">): number[] {
  const fromName = /\d+(?:\.\d+)*/.exec(m.displayName)?.[0];
  if (fromName) return fromName.split(".").map(Number);
  const tokens = m.value.replace(/\[.*\]$/, "").split(/[-_.:/]/);
  const fromId = tokens.filter((t) => /^\d{1,3}$/.test(t)).map(Number);
  if (fromId.length) return fromId;
  const fromDesc = m.description ? /\b\d+(?:\.\d+)+\b|\b\d+\b/.exec(m.description)?.[0] : undefined;
  return fromDesc ? fromDesc.split(".").map(Number) : [];
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Tags every model with `family` and `legacy`. A model is legacy when another model of the same family has a higher
 * version; ties are all newest. `keep` (the user's default, the server default) and the `default` alias are never
 * legacy. Order is kept.
 */
export function annotateModels(models: readonly ModelInfo[], keep: readonly (string | null | undefined)[] = []): ModelInfo[] {
  const base = models.map((m) => ({ m, family: modelFamily(m), version: modelVersion(m) }));
  const newest = new Map<string, number[]>();
  for (const x of base) {
    const cur = newest.get(x.family);
    if (!cur || compareVersions(x.version, cur) > 0) newest.set(x.family, x.version);
  }
  const kept = new Set(keep.filter((k): k is string => !!k));
  return base.map(({ m, family, version }) => ({
    ...m,
    family,
    legacy: m.value === "default" || kept.has(m.value) ? false : compareVersions(version, newest.get(family) ?? []) < 0,
  }));
}
