import { api, type AdminOverview } from "../../lib/api";
import { useUserFetch } from "../usage/useUserFetch";
import { t } from "../../i18n";
import { Button } from "../ui/primitives";
import { AdminUsageChart } from "./AdminUsageChart";
import { ApiCreditsSettings } from "./ApiCreditsSettings";
import { GlobalSettings } from "./GlobalSettings";
import { OverviewCards } from "./OverviewCards";
import { PricingSettings } from "./PricingSettings";
import { UsersTable } from "./UsersTable";
import { useUserPatcher } from "./useUserPatcher";

/** Everything on the admin page. The overview endpoint is optional: any failure just falls back to derived numbers. */
export function AdminDashboard() {
  const users = useUserFetch(() => api.users(), []);
  const usage = useUserFetch(() => api.adminUsage("7d"), [], { refreshMs: 30_000 });
  const models = useUserFetch(() => api.models().catch(() => []), []);
  const overview = useUserFetch<AdminOverview | undefined>(() => api.adminOverview().catch(() => undefined), [], { refreshMs: 15_000 });
  const patchUser = useUserPatcher(users.data, users.setData);

  return (
    <div className="space-y-5">
      <OverviewCards overview={overview.data} users={users.data} usage={usage.data} loading={users.loading || usage.loading} />

      <GlobalSettings />
      <ApiCreditsSettings />
      <PricingSettings />
      <AdminUsageChart />

      <section aria-labelledby="admin-users-h" className="space-y-2.5">
        <div>
          <h2 id="admin-users-h" className="text-[14px] font-semibold">{t("admin.users.title")}</h2>
        </div>
        {users.error && !users.data ? (
          <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft p-3 text-[13px]">
            {t("admin.loadFailed")}: {users.error.message}
            <Button size="xs" variant="outline" onClick={users.reload}>{t("app.retry")}</Button>
          </div>
        ) : (
          <UsersTable users={users.data} usage={usage.data} models={models.data ?? []} loading={users.loading} onPatch={patchUser} />
        )}
      </section>
    </div>
  );
}
