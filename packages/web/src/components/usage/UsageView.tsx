import { useEffect } from "react";
import { api } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { useUserFetch } from "./useUserFetch";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { Button, Skeleton } from "../ui/primitives";
import { LimitBar } from "./LimitBar";
import { MyTokens } from "./MyTokens";
import { apiLimitRow } from "./limits";
import { useNow } from "./useNow";

export interface UsageViewProps {
  /** Tighter paddings and smaller charts (status page, small windows). */
  compact?: boolean;
}

/**
 * API credits + "my tokens". Self-contained: needs only the API user to be set
 * (works inside the shell, the /usage page, the status page or a native window).
 */
export function UsageView({ compact = false }: UsageViewProps) {
  const live = useApp((s) => s.limits);
  const fetched = useUserFetch(() => api.usageLimits(), [], { refreshMs: 60_000 });
  const now = useNow(30_000);

  // The shared store (also fed by the websocket) is the live copy; each REST answer replaces it.
  useEffect(() => {
    if (fetched.data && useApp.getState().limits !== fetched.data) useApp.getState().setLimits(fetched.data);
  }, [fetched.data]);

  const limits = live ?? fetched.data;
  const apiUsage = limits?.api ?? null;
  const gap = compact ? "space-y-3" : "space-y-4";

  return (
    <div className={gap}>
      <section aria-labelledby="usage-api-h" className="space-y-2" data-testid="api-usage">
        <h2 id="usage-api-h" className="text-[15px] font-semibold">{t("usage.api.title")}</h2>
        {!limits && fetched.loading ? (
          <Skeleton className="h-[74px] w-full" aria-busy />
        ) : !limits && fetched.error ? (
          <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft p-3 text-[13px]">
            {t("usage.loadFailed")}: {fetched.error.message}
            <Button size="xs" variant="outline" onClick={fetched.reload}>{t("app.retry")}</Button>
          </div>
        ) : apiUsage ? (
          <LimitBar title={t("usage.api.period")} row={apiLimitRow(apiUsage)} valueLabel={t("usage.api.spent", { spent: formatUsd(apiUsage.spentUsd), limit: formatUsd(apiUsage.limitUsd) })} now={now} compact={compact} />
        ) : (
          <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[13px] text-muted" data-testid="api-none">{t("usage.api.none")}</p>
        )}
      </section>

      <MyTokens compact={compact} />
    </div>
  );
}
