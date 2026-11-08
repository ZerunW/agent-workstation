import type { PricePeriodInfo } from "@agent-workstation/protocol";
import { useState } from "react";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useUserFetch } from "../usage/useUserFetch";
import { t } from "../../i18n";
import { toast } from "../../store/toasts";
import { Button, Skeleton } from "../ui/primitives";

const price = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `$${+n.toFixed(4)}`);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

const cacheRead = (c: PricePeriodInfo) => c.cacheReadPerMtok ?? c.inputPerMtok * c.cacheReadFactor;

/** Admin: the per-model price list behind every cost estimate, and the history of the scheduled price checks. */
export function PricingSettings() {
  const res = useUserFetch(() => api.adminPricing(), []);
  const [checking, setChecking] = useState(false);
  const p = res.data;

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.refreshAdminPricing();
      res.setData(r.pricing);
      if (r.check.outcome === "failed" || r.check.outcome === "rejected") toast.error(t("admin.pricing.checkFailed"), r.check.message ?? undefined);
    } catch (e) {
      toast.error(t("admin.pricing.checkFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const th = "px-2 py-1.5 text-left text-[11.5px] font-medium text-subtle";
  const td = "px-2 py-1.5 tabular-nums";
  return (
    <section aria-labelledby="admin-pricing-h" className="rounded-xl border border-line bg-surface px-4 pb-3" data-testid="admin-pricing">
      <div className="flex items-center justify-between pt-4">
        <h2 id="admin-pricing-h" className="text-[14px] font-semibold">{t("admin.pricing.title")}</h2>
        {p && (
          <Button size="xs" variant="outline" loading={checking} onClick={() => void check()} data-testid="pricing-check">
            {t("admin.pricing.check")}
          </Button>
        )}
      </div>
      {res.loading && !p ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : p ? (
        <>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[13px]" data-testid="pricing-table">
              <thead>
                <tr>
                  <th className={th}>{t("admin.pricing.model")}</th>
                  <th className={`${th} text-right`}>{t("admin.pricing.input")}</th>
                  <th className={`${th} text-right`}>{t("admin.pricing.output")}</th>
                  <th className={`${th} text-right`}>{t("admin.pricing.cacheRead")}</th>
                  <th className={th}>{t("admin.pricing.source")}</th>
                  <th className={th}>{t("admin.pricing.from")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {p.models.map((m) => (
                  <tr key={m.model} data-testid="pricing-row" data-model={m.model}>
                    <td className={`${td} font-medium`}>{m.model}</td>
                    <td className={`${td} text-right`}>{m.current ? price(m.current.inputPerMtok) : "—"}</td>
                    <td className={`${td} text-right`}>{m.current ? price(m.current.outputPerMtok) : "—"}</td>
                    <td className={`${td} text-right`}>{m.current ? price(cacheRead(m.current)) : "—"}</td>
                    <td className={td}>{m.current?.source ?? "—"}</td>
                    <td className={td}>{day(m.current?.from)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.checks.length > 0 && (
            <ul className="mt-2 max-h-40 divide-y divide-line overflow-y-auto border-t border-line text-[12.5px]" data-testid="pricing-checks">
              {p.checks.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-1" data-outcome={c.outcome}>
                  <span className="w-28 shrink-0 text-subtle">{formatDateTime(c.at)}</span>
                  <span className="w-20 shrink-0">{c.outcome}</span>
                  <span className="min-w-0 flex-1 truncate text-muted" title={c.message ?? undefined}>
                    {c.model}
                    {c.inputPerMtok != null && ` · ${price(c.inputPerMtok)} / ${price(c.outputPerMtok)}`}
                    {c.message && ` · ${c.message}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : res.error ? (
        <p role="alert" className="py-3 text-[13px] text-danger">{t("admin.loadFailed")}: {res.error.message}</p>
      ) : null}
    </section>
  );
}
