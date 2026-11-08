import type { ModelInfo } from "@agent-workstation/protocol";
import { annotateModels, findModel, isPseudoDefault, type ModelEntry } from "./models";

/**
 * Names for the model ids that usage rows carry (`claude-opus-5-5`, `claude-haiku-5-5-20251001`, an alias such as
 * `opus`): the hub's catalog display name when it knows the model, else one derived from the id ("Opus 5.5").
 */
export interface ModelName {
  label: string;
}

/** The id without what does not name a model: a `[1m]` context suffix or a dated snapshot. */
export function canonicalModelId(raw: string): string {
  let id = raw.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  id = id.replace(/-\d{8}$/, "");
  return id;
}

const cap = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);

/** A readable name from the id alone, for models the catalog does not list (retired versions, aliases). */
export function deriveModelName(raw: string): string {
  const id = canonicalModelId(raw);
  let m = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id);
  if (m) return `${cap(m[1]!)} ${m[2]!.replace(/-/g, ".")}`;
  m = /^claude-(\d+(?:-\d+)*)-([a-z]+)$/.exec(id); // the old naming: claude-3-5-sonnet
  if (m) return `${cap(m[2]!)} ${m[1]!.replace(/-/g, ".")}`;
  if (/^(?:opus|sonnet|haiku|fable|default)$/.test(id)) return cap(id);
  return raw.trim();
}

const entriesCache = new WeakMap<readonly ModelInfo[], ModelEntry[]>();
const entriesOf = (catalog: readonly ModelInfo[]): ModelEntry[] => {
  let e = entriesCache.get(catalog);
  if (!e) entriesCache.set(catalog, (e = annotateModels(catalog)));
  return e;
};

/** Display name for a usage row's model id. */
export function describeModel(raw: string, catalog: readonly ModelInfo[] = []): ModelName {
  const id = canonicalModelId(raw);
  const entries = entriesOf(catalog);
  const hit = entries.find((m) => m.value.toLowerCase() === id) ?? findModel(entries, id);
  if (hit && !isPseudoDefault(hit)) return { label: hit.displayName };
  return { label: deriveModelName(raw) };
}
