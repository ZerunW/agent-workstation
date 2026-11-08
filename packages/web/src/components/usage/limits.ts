import type { UsageLimits } from "@agent-workstation/protocol";
import { formatCountdown, formatPercent, formatResetTime } from "../../lib/format";
import { t } from "../../i18n";

type ApiCredits = NonNullable<UsageLimits["api"]>;

/** A budget as the bar card shows it. */
export interface LimitRow {
  kind: string;
  label: string;
  percent: number | null;
  resetsAt: string | null;
  severity: ApiCredits["severity"];
}
export type Severity = LimitRow["severity"];
export type BarTone = "accent" | "warn" | "danger" | "muted";

/** Server severity, upgraded by the percentage when the server says nothing alarming. */
export function effectiveSeverity(row: Pick<LimitRow, "severity" | "percent">): Severity {
  const p = row.percent;
  if (row.severity === "critical") return "critical";
  if (p != null) {
    if (p >= 100) return "critical";
    if (p >= 80 && row.severity !== "warning") return "warning";
  }
  return row.severity;
}

export function severityTone(sev: Severity): BarTone {
  switch (sev) {
    case "critical":
      return "danger";
    case "warning":
      return "warn";
    case "unknown":
      return "muted";
    default:
      return "accent";
  }
}

export function percentLabel(percent: number | null | undefined): string {
  return percent == null || !Number.isFinite(percent) ? t("usage.percentNA") : formatPercent(percent);
}

/** Bar fill width 0..100; tiny non-zero values stay visible. */
export function barWidth(percent: number | null | undefined): number {
  if (percent == null || !Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(100, Math.max(1.5, percent));
}

export function resetLabels(resetsAt: string | null | undefined, now = Date.now()): { countdown: string; absolute: string } | null {
  if (!resetsAt || Number.isNaN(Date.parse(resetsAt))) return null;
  return { countdown: t("usage.resetsIn", { when: formatCountdown(resetsAt, now) }), absolute: formatResetTime(resetsAt) };
}

/** The API-credit period as a bar row. */
export function apiLimitRow(api: ApiCredits): LimitRow {
  return { kind: "api", label: t("usage.api.period"), percent: api.percent, resetsAt: api.resetsAt, severity: api.severity };
}
