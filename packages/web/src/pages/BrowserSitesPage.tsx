import { Globe, X } from "lucide-react";
import { api, isUnavailable } from "../lib/api";
import { siteHost } from "../lib/browserSites";
import { relativeTime } from "../lib/format";
import { useFetch } from "../hooks/useFetch";
import { t } from "../i18n";
import { toast } from "../store/toasts";
import { PageShell } from "../components/shell/PageShell";
import { Button, EmptyState, IconButton, Skeleton } from "../components/ui/primitives";

/** The websites the user always allows the server browser on: host, last used, remove. */
export default function BrowserSitesPage() {
  const sites = useFetch(() => api.browserSites(), []);
  // an older hub has no route: nothing is stored there, so nothing is listed
  const failed = !!sites.error && !sites.data && !isUnavailable(sites.error);
  const list = sites.data ?? [];

  const remove = async (origin: string) => {
    try {
      await api.removeBrowserSite(origin);
      sites.setData((prev) => (prev ?? []).filter((s) => s.origin !== origin));
    } catch (e) {
      toast.error(t("sites.remove.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  return (
    <PageShell title={t("sites.title")} maxWidth="max-w-3xl">
      {sites.loading && !sites.data && !sites.error ? (
        <div className="space-y-2" aria-busy>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : failed ? (
        <EmptyState icon={<Globe className="size-6" />} title={t("sites.loadFailed")} action={<Button onClick={sites.reload}>{t("app.retry")}</Button>}>
          {sites.error?.message}
        </EmptyState>
      ) : list.length === 0 ? (
        <div data-testid="browser-sites-empty">
          <EmptyState icon={<Globe className="size-6" />} title={t("sites.empty")} />
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="browser-sites-list">
          {list.map((s) => {
            const host = siteHost(s.origin);
            return (
              <li key={s.origin} className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 last:border-0" data-testid="browser-site" data-origin={s.origin}>
                <Globe className="size-4 shrink-0 text-subtle" />
                <span className="min-w-0 flex-1 truncate text-[14px]" title={s.origin} data-testid="browser-site-host">
                  {host}
                </span>
                <span className="shrink-0 text-[11.5px] text-subtle" title={s.lastUsedAt ?? undefined} data-testid="browser-site-used">
                  {relativeTime(s.lastUsedAt) || "—"}
                </span>
                <IconButton label={t("sites.remove", { host })} size="xs" onClick={() => void remove(s.origin)} className="hover:text-danger" data-testid="browser-site-remove">
                  <X className="size-3.5" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
