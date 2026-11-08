import type { AdminSettings } from "@agent-workstation/protocol";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useUserFetch } from "../usage/useUserFetch";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { toast } from "../../store/toasts";
import { Button, Skeleton } from "../ui/primitives";

export type ApiCreditsInput = { ok: true; limit: number; day: number; limitOk: true; dayOk: true } | { ok: false; limitOk: boolean; dayOk: boolean };

/** Monthly limit: USD, 0 or more, at most two decimals. Reset day: a whole day of the month, 1–28. */
export function parseApiCredits(limit: string, day: string): ApiCreditsInput {
  const l = limit.trim();
  const d = day.trim();
  const limitOk = /^\d{1,9}(\.\d{1,2})?$/.test(l);
  const dayOk = /^\d{1,2}$/.test(d) && Number(d) >= 1 && Number(d) <= 28;
  return limitOk && dayOk ? { ok: true, limit: Number(l), day: Number(d), limitOk: true, dayOk: true } : { ok: false, limitOk, dayOk };
}

/** Service reserve: USD, 0 up to the hub's cap of 1,000,000, at most two decimals. */
export function parseReserve(reserve: string): number | null {
  const r = reserve.trim();
  return /^\d{1,7}(\.\d{1,2})?$/.test(r) && Number(r) <= 1_000_000 ? Number(r) : null;
}

const num = "h-8 rounded-lg border bg-surface px-2 text-right text-[13px] tabular-nums outline-none focus:border-accent";

/** Admin: the monthly API-credit budget (USD) and the day of the month it resets. */
export function ApiCreditsSettings() {
  const res = useUserFetch(() => api.adminSettings(), []);
  const s = res.data;
  const [limit, setLimit] = useState("");
  const [day, setDay] = useState("");
  const [serviceReserve, setServiceReserve] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!s) return;
    setLimit(String(s.apiMonthlyLimitUsd ?? 200));
    setDay(String(s.apiResetDay ?? 1));
    setServiceReserve(String(s.serviceReserveUsd ?? 2));
  }, [s]);

  const parsed = parseApiCredits(limit, day);
  const serviceUsd = parseReserve(serviceReserve);
  const serviceChanged = !!s && serviceUsd !== null && serviceUsd !== (s.serviceReserveUsd ?? 2);
  const dirty = !!s && parsed.ok && serviceUsd !== null && (parsed.limit !== (s.apiMonthlyLimitUsd ?? 200) || parsed.day !== (s.apiResetDay ?? 1) || serviceChanged);

  const save = async () => {
    if (!s || !parsed.ok || serviceUsd === null) return;
    const patch: Partial<AdminSettings> = { apiMonthlyLimitUsd: parsed.limit, apiResetDay: parsed.day };
    if (serviceChanged) patch.serviceReserveUsd = serviceUsd;
    setSaving(true);
    try {
      const updated = await api.patchAdminSettings(patch);
      const merged: AdminSettings = { ...s, ...patch, ...(updated ?? {}) };
      res.setData(merged);
      const { me, setMe } = useApp.getState();
      if (me) setMe({ ...me, settings: merged });
      toast.success(t("admin.api.saved"));
    } catch (e) {
      toast.error(t("admin.global.saveFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="admin-api-h" className="rounded-xl border border-line bg-surface px-4" data-testid="admin-api-credits">
      <h2 id="admin-api-h" className="pt-4 text-[14px] font-semibold">{t("admin.api.title")}</h2>
      {res.loading && !s ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : s ? (
        <div className="divide-y divide-line">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-[200px] flex-1">
              <div className="text-[13px] font-medium">{t("admin.api.limit")}</div>
            </div>
            <input inputMode="decimal" aria-label={t("admin.api.limit")} value={limit} onChange={(e) => setLimit(e.target.value)} aria-invalid={!parsed.limitOk} data-testid="api-limit" className={`${num} w-28 ${parsed.limitOk ? "border-line" : "border-danger"}`} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-[200px] flex-1 text-[13px] font-medium">{t("admin.api.day")}</div>
            <input inputMode="numeric" aria-label={t("admin.api.day")} value={day} onChange={(e) => setDay(e.target.value)} aria-invalid={!parsed.dayOk} data-testid="api-day" className={`${num} w-20 ${parsed.dayOk ? "border-line" : "border-danger"}`} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-[200px] flex-1 text-[13px] font-medium">{t("admin.api.serviceReserve")}</div>
            <input inputMode="decimal" aria-label={t("admin.api.serviceReserve")} value={serviceReserve} onChange={(e) => setServiceReserve(e.target.value)} aria-invalid={serviceUsd === null} data-testid="api-service-reserve" className={`${num} w-28 ${serviceUsd !== null ? "border-line" : "border-danger"}`} />
          </div>
          {!parsed.ok && <p role="alert" className="py-2 text-xs text-danger">{t("admin.api.invalid")}</p>}
          {serviceUsd === null && <p role="alert" className="py-2 text-xs text-danger">{t("admin.api.serviceReserveInvalid")}</p>}
          <div className="flex justify-end py-3">
            <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()} data-testid="api-save">
              {t("admin.api.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
