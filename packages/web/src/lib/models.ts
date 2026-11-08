import type { EffortLevel, ModelInfo, PermissionMode } from "@agent-workstation/protocol";

/**
 * Model list logic shared by the composer menu and the Session defaults dialog.
 *
 * The hub marks older versions with `ModelInfo.legacy` and tags every model with `family`. A hub that predates those
 * fields is handled here: family and version are read from the id and the display name, and the newest version of each
 * family is the only non-legacy one.
 */

export type ModelEntry = ModelInfo & { family: string; legacy: boolean };

const KNOWN_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/** Family of a model: the hub's `family`, else a known family word in the id / display name, else the first word. */
export function familyOf(m: Pick<ModelInfo, "family" | "value" | "displayName">): string {
  if (m.family) return m.family.toLowerCase();
  for (const hay of [m.value, m.displayName]) {
    const lower = hay.toLowerCase();
    for (const f of KNOWN_FAMILIES) if (lower.includes(f)) return f;
  }
  const word = /[a-z]+/i.exec(m.displayName)?.[0] ?? /[a-z]+/i.exec(m.value)?.[0];
  return word ? word.toLowerCase() : "other";
}

/** Numeric version of a model ("Opus 5.5" → [5, 5], "claude-opus-4-8-20251101" → [4, 8]); [] when it has none. */
export function versionOf(m: Pick<ModelInfo, "value" | "displayName">): number[] {
  const fromName = /\d+(?:\.\d+)*/.exec(m.displayName)?.[0];
  if (fromName) return fromName.split(".").map(Number);
  // ids: numeric tokens of at most 3 digits (dates such as 20251101 are not versions)
  const tokens = m.value.replace(/\[.*\]$/, "").split(/[-_.:/]/);
  return tokens.filter((tok) => /^\d{1,3}$/.test(tok)).map(Number);
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Tag every model with family and `legacy`. A boolean `legacy` from the hub wins; otherwise a model is legacy
 * when another model of its family has a higher version (ties are all "newest"). An unversioned entry (a
 * family alias such as "sonnet") is never derived legacy: it always means the newest. List order is kept.
 */
export function annotateModels(models: readonly ModelInfo[]): ModelEntry[] {
  const newest = new Map<string, number[]>();
  const base = models.map((m) => ({ m, family: familyOf(m), version: versionOf(m) }));
  for (const x of base) {
    const cur = newest.get(x.family);
    if (!cur || compareVersions(x.version, cur) > 0) newest.set(x.family, x.version);
  }
  return base.map(({ m, family, version }) => ({
    ...m,
    family,
    legacy: typeof m.legacy === "boolean" ? m.legacy : version.length > 0 && compareVersions(version, newest.get(family) ?? []) < 0,
  }));
}

/**
 * The entry a stored model value refers to: exact id, then display name, then a family alias ("opus", "sonnet[1m]")
 * which means the newest non-legacy model of that family.
 */
export function findModel(entries: readonly ModelEntry[], value: string | null | undefined): ModelEntry | undefined {
  if (!value) return undefined;
  const exact = entries.find((m) => m.value === value);
  if (exact) return exact;
  const lower = value.toLowerCase();
  const named = entries.find((m) => m.displayName.toLowerCase() === lower);
  if (named) return named;
  const alias = lower.replace(/\[.*\]$/, "");
  return entries.find((m) => m.family === alias && !m.legacy) ?? entries.find((m) => m.family === alias);
}

export interface ModelSplit {
  /** Newest of each family, plus the current and default model whatever their age. */
  top: ModelEntry[];
  /** Everything else (legacy versions). */
  more: ModelEntry[];
  /** `value` of the effective default model when it is in the list. */
  defaultValue: string | null;
  /** `value` of the current model when it is in the list (a stored alias resolves to its model). */
  currentValue: string | null;
}

/** The SDK's pseudo-model ("Default (recommended)"): the menu's "Default" badge already marks the effective default. */
export const isPseudoDefault = (m: Pick<ModelInfo, "value">): boolean => m.value === "default";

/** Split the models into the menu's top level and its "More models" submenu. */
export function splitModels(models: readonly ModelInfo[], o: { current?: string | null; defaultModel?: string | null } = {}): ModelSplit {
  const annotated = annotateModels(models);
  // the pseudo-model is never listed (a stored "default" still names itself on the picker through `findModel`)
  const all = annotated.filter((m) => !isPseudoDefault(m));
  const current = findModel(all, o.current);
  const def = findModel(all, o.defaultModel);
  const top: ModelEntry[] = [];
  const more: ModelEntry[] = [];
  for (const m of all) (!m.legacy || m === current || m === def ? top : more).push(m);
  return { top, more, defaultValue: def?.value ?? null, currentValue: current?.value ?? null };
}

// ---------------------------------------------------------------------------
// effort / permission mode per model
// ---------------------------------------------------------------------------

const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Effort levels a model accepts; null = the model has no effort setting. */
export function effortOptions(model: ModelInfo | undefined): EffortLevel[] | null {
  if (!model) return EFFORT_ORDER;
  if (model.supportsEffort === false) return null;
  if (model.supportedEffortLevels && model.supportedEffortLevels.length) return model.supportedEffortLevels;
  return model.supportsEffort ? EFFORT_ORDER : model.supportedEffortLevels ? null : EFFORT_ORDER;
}

/**
 * Keep an effort valid after a model switch: a level the new model lacks drops to the highest one it has below it
 * (xhigh → high), or to the lowest it has. Unchanged when the model lists no levels or the effort is unset.
 */
export function clampEffort(effort: EffortLevel | null | undefined, levels: readonly EffortLevel[] | null): EffortLevel | null | undefined {
  if (!effort || !levels || levels.length === 0 || levels.includes(effort)) return effort;
  const rank = EFFORT_ORDER.indexOf(effort);
  const below = levels.filter((l) => EFFORT_ORDER.indexOf(l) < rank).sort((a, b) => EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a));
  return below[0] ?? [...levels].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0];
}

/** Whether a model cannot run a permission mode (only `auto` depends on the model). */
export function modeUnsupported(mode: PermissionMode, model: ModelInfo | undefined): boolean {
  return mode === "auto" && model?.supportsAutoMode === false;
}
