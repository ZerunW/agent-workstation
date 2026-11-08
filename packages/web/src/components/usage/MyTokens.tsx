import { useMemo, useState } from "react";
import type { ModelInfo } from "@agent-workstation/protocol";
import { api, type UsageRange } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatCost, formatTokens } from "../../lib/format";
import { describeModel } from "../../lib/modelNames";
import { useUserFetch } from "./useUserFetch";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { Button, Skeleton } from "../ui/primitives";
import { StackedBars } from "./StackedBars";
import { aggregateUsage, buildColumns, metricFormatter, type BarMetric } from "./tokens";

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-active p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn("h-7 rounded-md px-2.5 text-xs font-medium transition-colors", o.value === value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Weekly token limit progress (80% warn, 100% danger). `limit` null = unlimited. */
export function WeeklyLimitBar({ used, limit }: { used: number; limit: number | null }) {
  const pct = limit && limit > 0 ? (used / limit) * 100 : null;
  const tone = pct == null ? "bg-accent" : pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-accent";
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5" data-testid="weekly-limit">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium">{t("usage.weeklyTokens")}</span>
        <span className="text-xs tabular-nums text-muted">
          {limit != null ? t("usage.weeklyLimit", { used: formatTokens(used), limit: formatTokens(limit) }) : t("usage.weeklyUnlimited", { used: formatTokens(used) })}
        </span>
      </div>
      {pct != null && (
        <div
          role="progressbar"
          aria-label={t("usage.weeklyTokens")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(pct))}
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-active"
        >
          <div className={cn("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 1.5 : 0, pct))}%` }} />
        </div>
      )}
      {pct != null && pct >= 100 ? (
        <p className="mt-2 text-xs text-danger">{t("usage.weeklyReached")}</p>
      ) : pct != null && pct >= 80 ? (
        <p className="mt-2 text-xs text-warn">{t("usage.weeklyWarn", { percent: `${Math.round(pct)}%` })}</p>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-sunken px-3 py-2">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** The model catalog for display names: the shell's copy, else one fetch (a bare usage window has none); ids derive names when it fails. */
function useModelCatalog(): readonly ModelInfo[] {
  const stored = useApp((s) => s.models);
  const loaded = useApp((s) => s.modelsLoaded);
  const fetched = useUserFetch(() => Promise.resolve().then(() => api.models()).catch(() => [] as ModelInfo[]), [], { enabled: stored.length === 0 && !loaded });
  return stored.length > 0 ? stored : (fetched.data ?? stored);
}

/** "My tokens": range picker, weekly limit progress, totals, stacked bars by model. */
export function MyTokens({ compact }: { compact?: boolean }) {
  const [range, setRange] = useState<UsageRange>("7d");
  const [metric, setMetric] = useState<BarMetric>("tokens");
  const res = useUserFetch(() => api.usageMe(range), [range], { refreshMs: 60_000 });
  const catalog = useModelCatalog();
  // rows are grouped by the model's display name: dated snapshots fold into one row each
  const agg = useMemo(() => aggregateUsage(res.data?.buckets ?? [], (r) => describeModel(r.model, catalog).label), [res.data, catalog]);

  const { columns, series } = useMemo(() => buildColumns(agg, metric, range), [agg, metric, range]);
  const empty = !!res.data && agg.buckets.length === 0;
  const fmt = metricFormatter(metric);

  return (
    <section aria-labelledby="usage-mine-h" className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="usage-mine-h" className="text-[14px] font-semibold">{t("usage.mine.title")}</h3>
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
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-[160px] w-full" />
        </div>
      ) : res.error && !res.data ? (
        <div className="flex items-center gap-2 text-[13px] text-danger">
          {t("usage.loadFailed")}: {res.error.message}
          <Button size="xs" variant="outline" onClick={res.reload}>{t("app.retry")}</Button>
        </div>
      ) : res.data ? (
        <div className="space-y-4">
          <WeeklyLimitBar used={res.data.weeklyTokens} limit={res.data.weeklyLimit} />
          {empty ? (
            <p className="py-6 text-center text-[13px] text-muted">{t("usage.mine.empty")}</p>
          ) : (
            <>
              <div className={cn("grid gap-2", compact ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6")}>
                <Stat label={t("usage.total.input")} value={formatTokens(agg.totals.input)} />
                <Stat label={t("usage.total.output")} value={formatTokens(agg.totals.output)} />
                <Stat label={t("usage.total.cacheRead")} value={formatTokens(agg.totals.cacheRead)} />
                <Stat label={t("usage.total.cacheWrite")} value={formatTokens(agg.totals.cacheWrite)} />
                <Stat label={t("usage.total.cost")} value={formatCost(agg.totals.cost)} />
                <Stat label={t("usage.total.turns")} value={String(agg.totals.turns)} />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">{t("usage.byModel")}</h4>
                  <Segmented
                    label="Metric"
                    value={metric}
                    onChange={setMetric}
                    options={[
                      { value: "tokens", label: t("usage.metric.tokens") },
                      { value: "cost", label: t("usage.metric.cost") },
                    ]}
                  />
                </div>
                <StackedBars columns={columns} series={series} formatValue={fmt} height={compact ? 110 : 160} ariaLabel={t("usage.bars.aria", { metric: t(metric === "tokens" ? "usage.metric.tokens" : "usage.metric.cost").toLowerCase() })} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-left text-xs">
                  <thead className="text-subtle">
                    <tr>
                      <th className="py-1 pr-3 font-medium">{t("usage.byModel")}</th>
                      <th className="px-2 py-1 text-right font-medium">{t("usage.total.input")}</th>
                      <th className="px-2 py-1 text-right font-medium">{t("usage.total.output")}</th>
                      <th className="px-2 py-1 text-right font-medium">{t("usage.total.cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agg.groups.map((g) => (
                      <tr key={g.key} className="border-t border-line" data-testid="model-row">
                        <td className="max-w-[220px] truncate py-1.5 pr-3 font-medium">{g.key}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatTokens(g.input)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatTokens(g.output)}</td>
                        {/* the hub stores a list-price estimate for every turn */}
                        <td className="px-2 py-1.5 text-right tabular-nums" data-testid="model-cost">{formatCost(g.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
