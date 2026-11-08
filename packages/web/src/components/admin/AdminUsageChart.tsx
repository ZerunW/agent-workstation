import { useMemo, useState } from "react";
import { api, type UsageRange } from "../../lib/api";
import { formatTokens } from "../../lib/format";
import { useUserFetch } from "../usage/useUserFetch";
import { t } from "../../i18n";
import { Segmented } from "../usage/MyTokens";
import { StackedBars } from "../usage/StackedBars";
import { aggregateUsage, buildColumns } from "../usage/tokens";
import { Button, Skeleton } from "../ui/primitives";

/** Input + output tokens per bucket, stacked by user, across all users. */
export function AdminUsageChart() {
  const [range, setRange] = useState<UsageRange>("7d");
  const res = useUserFetch(() => api.adminUsage(range), [range], { refreshMs: 60_000 });
  const agg = useMemo(() => aggregateUsage(res.data?.buckets ?? [], (b) => b.user), [res.data]);
  const { columns, series } = useMemo(() => buildColumns(agg, "tokens", range), [agg, range]);
  const empty = !!res.data && agg.buckets.length === 0;

  return (
    <section aria-labelledby="admin-chart-h" className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="admin-chart-h" className="text-[14px] font-semibold">{t("admin.chart.title")}</h2>
        </div>
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          options={[
            { value: "today", label: t("usage.range.today") },
            { value: "7d", label: t("usage.range.7d") },
            { value: "30d", label: t("usage.range.30d") },
          ]}
        />
      </div>
      {res.loading && !res.data ? (
        <Skeleton className="h-[180px] w-full" />
      ) : res.error && !res.data ? (
        <div className="flex items-center gap-2 text-[13px] text-danger">
          {t("admin.loadFailed")}: {res.error.message}
          <Button size="xs" variant="outline" onClick={res.reload}>{t("app.retry")}</Button>
        </div>
      ) : empty ? (
        <p className="py-8 text-center text-[13px] text-muted">{t("admin.chart.empty")}</p>
      ) : (
        <StackedBars columns={columns} series={series} formatValue={formatTokens} height={180} ariaLabel={t("admin.chart.aria")} />
      )}
    </section>
  );
}
