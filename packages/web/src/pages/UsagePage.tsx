import { PageShell } from "../components/shell/PageShell";
import { UsageView } from "../components/usage/UsageView";
import { t } from "../i18n";

export default function UsagePage() {
  return (
    <PageShell title={t("usage.title")} maxWidth="max-w-3xl">
      <UsageView />
    </PageShell>
  );
}
