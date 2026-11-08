import type { AdminSettings } from "@agent-workstation/protocol";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useUserFetch } from "../usage/useUserFetch";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { toast } from "../../store/toasts";
import { Button, Skeleton } from "../ui/primitives";
import { Switch } from "./Switch";
import { limitToInput, parseTokenLimit } from "./tokenLimit";

const pctOk = (s: string) => /^\d{1,3}$/.test(s.trim()) && Number(s) >= 1 && Number(s) <= 100;

/** Disk thresholds: both whole percentages in 1..100 with warn strictly below block. */
export function validateDisk(warn: string, block: string): boolean {
  return pctOk(warn) && pctOk(block) && Number(warn) < Number(block);
}

function mirror(next: AdminSettings) {
  const { me, setMe } = useApp.getState();
  if (me) setMe({ ...me, settings: next });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-[200px] flex-1">
        <div className="text-[13px] font-medium">{label}</div>
      </div>
      {children}
    </div>
  );
}

export function GlobalSettings() {
  const res = useUserFetch(() => api.adminSettings(), []);
  const s = res.data;
  const [warn, setWarn] = useState("");
  const [block, setBlock] = useState("");
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!s) return;
    setWarn(String(s.diskWarnPercent));
    setBlock(String(s.diskBlockPercent));
    setLimit(limitToInput(s.defaultWeeklyTokenLimit));
  }, [s]);

  const parsedLimit = parseTokenLimit(limit);
  const diskValid = validateDisk(warn, block);
  const limitValid = parsedLimit.ok;
  const dirty = !!s && (Number(warn) !== s.diskWarnPercent || Number(block) !== s.diskBlockPercent || (parsedLimit.ok && (parsedLimit.value ?? 0) !== s.defaultWeeklyTokenLimit));

  const toggleRemote = async (next: boolean) => {
    if (!s) return;
    const prev = s;
    res.setData({ ...s, remoteClaudeEnabled: next });
    try {
      const updated = await api.patchAdminSettings({ remoteClaudeEnabled: next });
      const merged: AdminSettings = { ...prev, ...(updated ?? { remoteClaudeEnabled: next }) };
      res.setData(merged);
      mirror(merged);
    } catch (e) {
      res.setData(prev);
      toast.error(t("admin.global.saveFailed"), e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!s || !diskValid || !parsedLimit.ok) return;
    const patch: Partial<AdminSettings> = {};
    if (Number(warn) !== s.diskWarnPercent) patch.diskWarnPercent = Number(warn);
    if (Number(block) !== s.diskBlockPercent) patch.diskBlockPercent = Number(block);
    const nextLimit = parsedLimit.value ?? 0;
    if (nextLimit !== s.defaultWeeklyTokenLimit) patch.defaultWeeklyTokenLimit = nextLimit;
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const updated = await api.patchAdminSettings(patch);
      const merged: AdminSettings = { ...s, ...patch, ...(updated ?? {}) };
      res.setData(merged);
      mirror(merged);
      toast.success(t("admin.global.saved"));
    } catch (e) {
      toast.error(t("admin.global.saveFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const numInput = "h-8 w-20 rounded-lg border bg-surface px-2 text-right text-[13px] tabular-nums outline-none focus:border-accent";

  return (
    <section aria-labelledby="admin-global-h" className="rounded-xl border border-line bg-surface px-4">
      <h2 id="admin-global-h" className="pt-4 text-[14px] font-semibold">{t("admin.global.title")}</h2>
      {res.loading && !s ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : res.error && !s ? (
        <div className="flex items-center gap-2 py-4 text-[13px] text-danger">
          {t("admin.loadFailed")}: {res.error.message}
          <Button size="xs" variant="outline" onClick={res.reload}>{t("app.retry")}</Button>
        </div>
      ) : s ? (
        <div className="divide-y divide-line">
          <Field label={t("admin.global.remote")}>
            <Switch checked={s.remoteClaudeEnabled} label={t("admin.global.remote")} onChange={(v) => void toggleRemote(v)} />
          </Field>
          <Field label={t("admin.global.disk")}>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-muted">
                {t("admin.global.warn")}
                <input inputMode="numeric" aria-label={t("admin.global.warn")} value={warn} onChange={(e) => setWarn(e.target.value)} aria-invalid={!diskValid} className={`${numInput} ${diskValid ? "border-line" : "border-danger"}`} />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                {t("admin.global.block")}
                <input inputMode="numeric" aria-label={t("admin.global.block")} value={block} onChange={(e) => setBlock(e.target.value)} aria-invalid={!diskValid} className={`${numInput} ${diskValid ? "border-line" : "border-danger"}`} />
              </label>
            </div>
          </Field>
          {!diskValid && <p role="alert" className="py-2 text-xs text-danger">{t("admin.global.diskInvalid")}</p>}
          <Field label={t("admin.global.defaultLimit")}>
            <input inputMode="numeric" aria-label={t("admin.global.defaultLimit")} value={limit} onChange={(e) => setLimit(e.target.value)} aria-invalid={!limitValid} placeholder="0" className={`${numInput} w-32 ${limitValid ? "border-line" : "border-danger"}`} />
          </Field>
          {!limitValid && <p role="alert" className="py-2 text-xs text-danger">{t("admin.limit.invalid")}</p>}
          <div className="flex justify-end py-3">
            <Button variant="primary" disabled={!dirty || !diskValid || !limitValid} loading={saving} onClick={() => void save()}>
              {t("admin.global.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
