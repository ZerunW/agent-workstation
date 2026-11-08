import type { EffortLevel, Me, ModelInfo } from "@agent-workstation/protocol";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { t, type I18nKey } from "../../i18n";
import { useApp } from "../../store/app";
import { annotateModels, clampEffort, effortOptions, findModel, splitModels } from "../../lib/models";
import { Modal } from "../ui/overlays";
import { Button } from "../ui/primitives";

/** Sentinel option value: "follow the server default" (sent to the hub as null). */
const SERVER = "__server__";

const select = "h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent disabled:opacity-50";

/**
 * Per-user defaults for new sessions (model + effort). The hub applies them whenever a session is created without
 * explicit settings, so they follow the username to every device. Radix unmounts the content when closed, so the form
 * re-reads the current values each time it opens.
 */
export function SessionDefaultsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const me = useApp((s) => s.me);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("defaults.title")} width="sm">
      {me && <DefaultsForm me={me} onClose={() => onOpenChange(false)} />}
    </Modal>
  );
}

function DefaultsForm({ me, onClose }: { me: Me; onClose: () => void }) {
  const setMe = useApp((s) => s.setMe);
  const allModels = useApp((s) => s.models);
  const allow = me.user.modelAllowlist;
  const models = useMemo(() => (allow && allow.length ? allModels.filter((m) => allow.includes(m.value)) : allModels), [allModels, allow]);
  // like the composer menu: the newest models, then the older versions in their own group
  const groups = useMemo(() => {
    const split = splitModels(models, { defaultModel: me.user.defaultModel ?? me.settings.defaultModel });
    const top = { key: "top", label: null as string | null, models: split.top };
    return split.more.length ? [top, { key: "more", label: t("composer.models.more"), models: split.more }] : [top];
  }, [models, me.user.defaultModel, me.settings.defaultModel]);

  const [model, setModel] = useState<string>(me.user.defaultModel ?? SERVER);
  const [effort, setEffort] = useState<string>(me.user.defaultEffort ?? SERVER);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  const entries = useMemo(() => annotateModels(models), [models]);
  const name = (id: string | undefined | null): string => findModel(entries, id)?.displayName ?? id ?? "";
  const effortLabel = (e: EffortLevel | null | undefined): string => (e ? t(`composer.effort.${e}` as I18nKey) : t("defaults.effort.cli"));
  const serverModel = me.settings.defaultModel;
  const serverEffort = me.settings.defaultEffort ?? null;
  const effectiveModel: ModelInfo | undefined = findModel(entries, model === SERVER ? serverModel : model);
  const efforts = effortOptions(effectiveModel) ?? [];

  // a default effort the newly chosen model lacks falls back to one it has
  const pickModel = (value: string) => {
    setModel(value);
    const fit = effort === SERVER ? effort : clampEffort(effort as EffortLevel, effortOptions(findModel(entries, value === SERVER ? serverModel : value)));
    if (fit && fit !== effort) setEffort(fit);
  };

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const user = await api.patchPreferences({
        defaultModel: model === SERVER ? null : model,
        defaultEffort: effort === SERVER ? null : (effort as EffortLevel),
      });
      setMe({ ...me, user });
      setNote({ tone: "ok", text: t("defaults.saved") });
    } catch (err) {
      setNote({ tone: "danger", text: t("defaults.failed", { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-subtle">{t("defaults.model")}</span>
        <select value={model} onChange={(e) => pickModel(e.target.value)} className={select} data-testid="defaults-model">
          <option value={SERVER}>{t("defaults.server", { value: name(serverModel) })}</option>
          {groups.map((g) => {
            const options = g.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName}
              </option>
            ));
            return g.label ? (
              <optgroup key={g.key} label={g.label}>
                {options}
              </optgroup>
            ) : (
              options
            );
          })}
        </select>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-subtle">{t("defaults.effort")}</span>
        <select value={effort} onChange={(e) => setEffort(e.target.value)} className={select} data-testid="defaults-effort">
          <option value={SERVER}>{t("defaults.server", { value: effortLabel(serverEffort) })}</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {t(`composer.effort.${e}` as I18nKey)}
            </option>
          ))}
        </select>
      </label>

      {note && (
        <p role="status" className={cn("text-xs", note.tone === "ok" ? "text-ok" : "text-danger")}>
          {note.text}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" size="md" onClick={onClose}>
          {t("app.close")}
        </Button>
        <Button type="submit" variant="primary" size="md" loading={busy} data-testid="defaults-save">
          {t("defaults.save")}
        </Button>
      </div>
    </form>
  );
}
