import { cn } from "../../lib/cn";
import { t } from "../../i18n";

export interface BarSeries {
  key: string;
  label: string;
  /** CSS custom property, e.g. "--accent" */
  colorVar: string;
}

export interface BarColumn {
  key: string;
  label: string;
  /** series key -> value */
  values: Record<string, number>;
}

export interface StackedBarsProps {
  columns: BarColumn[];
  series: BarSeries[];
  formatValue: (n: number) => string;
  ariaLabel: string;
  height?: number;
  legend?: boolean;
  className?: string;
}

export function columnTotal(col: BarColumn): number {
  let sum = 0;
  for (const v of Object.values(col.values)) sum += v;
  return sum;
}

/** Dependency-free stacked column chart (accessible: every column is a labelled list item). */
export function StackedBars({ columns, series, formatValue, ariaLabel, height = 160, legend = true, className }: StackedBarsProps) {
  const max = Math.max(1, ...columns.map(columnTotal));
  const every = Math.max(1, Math.ceil(columns.length / 6));
  return (
    <figure className={cn("m-0", className)}>
      <div className="mb-1 flex justify-between text-[11px] text-subtle">
        <span className="tabular-nums">{formatValue(max)}</span>
      </div>
      <div role="list" aria-label={ariaLabel} className="flex items-end justify-center gap-[3px] border-b border-line" style={{ height }}>
        {columns.map((col) => {
          const total = columnTotal(col);
          const details = series
            .filter((s) => (col.values[s.key] ?? 0) > 0)
            .map((s) => `${s.label}: ${formatValue(col.values[s.key]!)}`)
            .join("\n");
          const label = t("usage.bars.col", { label: col.label, value: formatValue(total) });
          return (
            <div key={col.key} role="listitem" aria-label={label} title={details ? `${label}\n${details}` : label} className="group flex h-full min-w-[3px] max-w-[96px] flex-1 flex-col justify-end hover:opacity-90">
              <div className="flex flex-col-reverse overflow-hidden rounded-t-[3px]" style={{ height: `${(total / max) * 100}%` }}>
                {series.map((s) => {
                  const v = col.values[s.key] ?? 0;
                  if (v <= 0) return null;
                  return <div key={s.key} style={{ height: `${(v / total) * 100}%`, background: `var(${s.colorVar})`, minHeight: 1 }} />;
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-center gap-[3px] text-[10.5px] text-subtle" aria-hidden>
        {columns.map((col, i) => (
          <div key={col.key} className="min-w-[3px] max-w-[96px] flex-1 overflow-visible whitespace-nowrap text-center">
            {i % every === 0 ? <span className="inline-block -translate-x-0">{col.label}</span> : null}
          </div>
        ))}
      </div>
      {legend && series.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-sm" style={{ background: `var(${s.colorVar})` }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
