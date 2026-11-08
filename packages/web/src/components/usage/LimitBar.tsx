import { cn } from "../../lib/cn";
import { t } from "../../i18n";
import { Badge } from "../ui/primitives";
import { barWidth, effectiveSeverity, percentLabel, resetLabels, severityTone, type BarTone, type LimitRow } from "./limits";

const FILL: Record<BarTone, string> = { accent: "bg-accent", warn: "bg-warn", danger: "bg-danger", muted: "bg-subtle" };
const TEXT: Record<BarTone, string> = { accent: "text-fg", warn: "text-warn", danger: "text-danger", muted: "text-subtle" };

export interface LimitBarProps {
  title: string;
  /** null renders the "no data yet" placeholder */
  row: LimitRow | null;
  now?: number;
  /** Even tighter (status page, small windows). */
  compact?: boolean;
  /** Shown at the right instead of the percentage ("$12.00 / $100.00" on the API-credits card). */
  valueLabel?: string;
}

/** One limit as a short card: title left, percentage right, the bar, then one meta line ("Resets in 37m · Jan 15, 03:20 PM"). */
export function LimitBar({ title, row, now = Date.now(), compact, valueLabel }: LimitBarProps) {
  const sev = row ? effectiveSeverity(row) : "unknown";
  const tone = severityTone(sev);
  const percent = row?.percent ?? null;
  const reset = resetLabels(row?.resetsAt, now);
  const valueText = percent == null ? t("usage.percentNA") : t("usage.percentUsed", { percent: percentLabel(percent) });

  return (
    <div className={cn("rounded-xl border border-line bg-surface", compact ? "px-3 py-2" : "px-3.5 py-2.5")} data-testid="limit-bar" data-severity={sev}>
      <div className="flex items-baseline gap-3">
        <div className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{title}</div>
        <div className={cn("shrink-0 text-[15px] font-semibold tabular-nums", TEXT[tone])} data-testid="limit-percent">
          {valueLabel ?? percentLabel(percent)}
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent == null ? undefined : Math.round(percent)}
        aria-valuetext={valueText}
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-active"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-500", FILL[tone])} style={{ width: `${barWidth(percent)}%` }} />
      </div>
      <div className="mt-1.5 flex items-center gap-x-2 text-xs text-muted">
        {row ? (
          reset ? (
            <span className="min-w-0 truncate">
              <span className="font-medium tabular-nums text-fg/80" data-testid="limit-countdown">{reset.countdown}</span>
              <span className="text-subtle"> · {reset.absolute}</span>
            </span>
          ) : (
            <span className="text-subtle">{t("usage.resetsUnknown")}</span>
          )
        ) : (
          <span className="text-subtle">{t("usage.noRow")}</span>
        )}
        {row && sev !== "normal" && (
          <Badge tone={sev === "critical" ? "danger" : sev === "warning" ? "warn" : "neutral"} className="ml-auto shrink-0">
            {t(`usage.severity.${sev}` as const)}
          </Badge>
        )}
      </div>
    </div>
  );
}
