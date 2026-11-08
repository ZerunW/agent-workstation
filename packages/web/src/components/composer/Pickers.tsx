import type { EffortLevel, Me, ModelInfo, PermissionMode, SessionKind } from "@agent-workstation/protocol";
import { Brain, ChevronDown, Cpu, ShieldCheck } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { annotateModels, clampEffort, effortOptions, findModel, modeUnsupported, splitModels, type ModelEntry } from "../../lib/models";
import { t, type I18nKey } from "../../i18n";
import { useApp } from "../../store/app";
import { useComposer } from "../../store/composer";
import { patchSettings } from "../../store/actions";
import { useSessions } from "../../store/sessions";
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, Tip } from "../ui/overlays";

export { effortOptions };

export interface EffectiveSettings {
  model: string | undefined;
  permissionMode: PermissionMode | undefined;
  effort: EffortLevel | null | undefined;
}

type SettingsPatch = { model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | null };

export interface SettingsView extends EffectiveSettings {
  set: (patch: SettingsPatch) => void;
  modelInfo: ModelEntry | undefined;
  /** Models the user may pick (allowlist applied). */
  models: ModelInfo[];
  /** The effective default model for new sessions (user preference, else the server's). */
  defaultModel: string | undefined;
}

/** Reads from the live session, or from the "new session" defaults before the first send. */
export function useSettings(sessionId: string | null): SettingsView {
  const session = useSessions((s) => (sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId]) : undefined));
  const newSettings = useComposer((s) => s.newSettings);
  const setNewSettings = useComposer((s) => s.setNewSettings);
  const allModels = useApp((s) => s.models);
  const me = useApp((s) => s.me);
  const allow = me?.user.modelAllowlist;
  const models = useMemo(() => (allow && allow.length ? allModels.filter((m) => allow.includes(m.value)) : allModels), [allModels, allow]);
  const entries = useMemo(() => annotateModels(models), [models]);
  // Before the first send the pickers show what the hub will actually use: the user's own default, else the server's.
  const defaults = userDefaults(me);
  const model = session?.model ?? newSettings.model ?? defaults.model;
  const modelInfo = findModel(entries, model);
  const effort = session ? session.effort : newSettings.effort !== undefined ? newSettings.effort : defaults.effort;
  const permissionMode = session?.permissionMode ?? newSettings.permissionMode;

  const set = (patch: SettingsPatch) => {
    const next = { ...patch };
    if (patch.model !== undefined) {
      const target = findModel(entries, patch.model);
      // a level the new model lacks falls back to one it has
      if (patch.effort === undefined && target) {
        const fit = clampEffort(effort, effortOptions(target));
        if (fit !== effort && fit !== undefined) next.effort = fit;
      }
      // a new session cannot keep a mode the new model lacks
      if (!sessionId && patch.permissionMode === undefined && target && permissionMode && modeUnsupported(permissionMode, target)) next.permissionMode = "default";
    }
    if (sessionId) void patchSettings(sessionId, next);
    else setNewSettings(next);
  };

  return { model, permissionMode, effort, modelInfo, models, defaultModel: defaults.model, set };
}

/** Resolution the hub applies when a session is created without model / effort: user preference → server default. */
export function userDefaults(me: Me | null | undefined): { model: string | undefined; effort: EffortLevel | null | undefined } {
  if (!me) return { model: undefined, effort: undefined };
  return {
    model: me.user.defaultModel ?? me.settings.defaultModel,
    effort: me.user.defaultEffort ?? me.settings.defaultEffort ?? null,
  };
}

const pill = "inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 data-[state=open]:bg-active data-[state=open]:text-fg";

function EffortItems({ effort, options, onChange }: { effort: EffortLevel | null | undefined; options: EffortLevel[]; onChange: (e: EffortLevel | null) => void }) {
  return (
    <MenuRadioGroup value={effort ?? "default"} onValueChange={(v) => onChange(v === "default" ? null : (v as EffortLevel))}>
      <MenuRadioItem value="default">{t("composer.effort.default")}</MenuRadioItem>
      {options.map((e) => (
        <MenuRadioItem key={e} value={e}>
          {t(`composer.effort.${e}` as I18nKey)}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/**
 * The model menu of the Claude apps: the newest model of each family (plus the session's current and the user's default
 * one), then "Effort ›" and "More models ›" submenus. Keys 1–9 pick a top-level model.
 */
export function ModelPicker({ sessionId }: { sessionId: string | null }) {
  const { model, models, modelInfo, effort, defaultModel, set } = useSettings(sessionId);
  const loaded = useApp((s) => s.modelsLoaded);
  const [open, setOpen] = useState(false);
  const split = useMemo(() => splitModels(models, { current: model, defaultModel }), [models, model, defaultModel]);
  const shown = split.top;
  const label = modelInfo?.displayName ?? model ?? (loaded ? t("composer.model") : t("composer.models.loading"));
  const efforts = effortOptions(modelInfo);
  const effortLabel = effort ? t(`composer.effort.${effort}` as I18nKey) : t("composer.effort.default");

  const choose = (value: string) => {
    if (value === split.currentValue) return;
    set({ model: value });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
    if (!e.currentTarget.contains(e.target as Node)) return; // keys typed inside a submenu belong to it
    const target = shown[Number(e.key) - 1];
    if (!target) return;
    e.preventDefault();
    choose(target.value);
    setOpen(false);
  };

  const item = (m: ModelEntry, index?: number) => (
    <MenuRadioItem
      key={m.value}
      value={m.value}
      description={m.description?.trim() || undefined}
      oneLine
      badge={m.value === split.defaultValue ? t("composer.models.default") : undefined}
      shortcut={index !== undefined && index < 9 ? String(index + 1) : undefined}
      data-testid="model-option"
      data-model={m.value}
    >
      {m.displayName}
    </MenuRadioItem>
  );

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tip label={t("composer.model")} side="top">
        <MenuTrigger asChild>
          <button type="button" className={pill} aria-label={`${t("composer.model")}: ${label}`} data-testid="model-picker">
            <Cpu className="size-3.5 shrink-0" />
            <span className="truncate @max-[30rem]:hidden">{label}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" className="w-72" onKeyDown={onKeyDown} data-testid="model-menu">
        {models.length === 0 && <div className="px-3 py-2 text-xs text-muted">{t("composer.models.loading")}</div>}
        <MenuRadioGroup value={split.currentValue ?? model ?? ""} onValueChange={choose}>
          {split.top.map((m, i) => item(m, i))}
        </MenuRadioGroup>
        {models.length > 0 && <MenuSeparator />}
        {models.length > 0 && (
          <MenuSub>
            <MenuSubTrigger disabled={!efforts} value={efforts ? effortLabel : "–"} title={efforts ? undefined : t("composer.effort.unsupported")} data-testid="model-menu-effort">
              {t("composer.effort")}
            </MenuSubTrigger>
            <MenuSubContent className="w-48">
              {efforts && <EffortItems effort={effort} options={efforts} onChange={(e) => set({ effort: e })} />}
            </MenuSubContent>
          </MenuSub>
        )}
        {split.more.length > 0 && (
          <MenuSub>
            <MenuSubTrigger data-testid="model-menu-more">{t("composer.models.more")}</MenuSubTrigger>
            <MenuSubContent className="w-64" data-testid="model-menu-more-list">
              <MenuRadioGroup value={split.currentValue ?? model ?? ""} onValueChange={choose}>
                {split.more.map((m) => item(m))}
              </MenuRadioGroup>
            </MenuSubContent>
          </MenuSub>
        )}
      </MenuContent>
    </Menu>
  );
}

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

export function ModePicker({ sessionId }: { sessionId: string | null }) {
  const { permissionMode, modelInfo, set } = useSettings(sessionId);
  const mode = permissionMode ?? "default";
  const labelKey = `composer.mode.${mode}` as I18nKey;
  return (
    <Menu>
      <Tip label={t("composer.mode")} side="top">
        <MenuTrigger asChild>
          <button type="button" className={cn(pill, mode === "bypassPermissions" && "text-danger hover:text-danger")} aria-label={`${t("composer.mode")}: ${t(labelKey)}`} data-testid="mode-picker">
            <ShieldCheck className="size-3.5 shrink-0" />
            <span className="truncate @max-[30rem]:hidden">{t(labelKey)}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" className="w-72">
        <MenuLabel>{t("composer.mode")}</MenuLabel>
        <MenuRadioGroup value={mode} onValueChange={(v) => set({ permissionMode: v as PermissionMode })}>
          {MODES.map((m) => (
            <MenuRadioItem key={m} value={m} disabled={modeUnsupported(m, modelInfo)}>
              {t(`composer.mode.${m}` as I18nKey)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export function EffortPicker({ sessionId, kind: _kind }: { sessionId: string | null; kind: SessionKind }) {
  const { effort, modelInfo, set } = useSettings(sessionId);
  const options = effortOptions(modelInfo);
  const label = effort ? t(`composer.effort.${effort}` as I18nKey) : t("composer.effort.default");
  if (!options)
    return (
      <Tip label={t("composer.effort.unsupported")} side="top">
        <span className={cn(pill, "cursor-not-allowed opacity-50 hover:bg-transparent")} aria-disabled="true" data-testid="effort-picker-disabled">
          <Brain className="size-3.5" />
          <span className="@max-[30rem]:hidden">{t("composer.effort")}</span>
        </span>
      </Tip>
    );
  return (
    <Menu>
      <Tip label={t("composer.effort")} side="top">
        <MenuTrigger asChild>
          <button type="button" className={pill} aria-label={`${t("composer.effort")}: ${label}`} data-testid="effort-picker">
            <Brain className="size-3.5 shrink-0" />
            <span className="truncate @max-[30rem]:hidden">{label}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" className="w-48">
        <MenuLabel>{t("composer.effort")}</MenuLabel>
        <EffortItems effort={effort} options={options} onChange={(e) => set({ effort: e })} />
      </MenuContent>
    </Menu>
  );
}

