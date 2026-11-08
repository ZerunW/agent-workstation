import { AdminDashboard } from "../components/admin/AdminDashboard";
import { PageShell } from "../components/shell/PageShell";
import { t } from "../i18n";

export default function AdminPage() {
  return (
    <PageShell title={t("admin.title")} maxWidth="max-w-6xl">
      <AdminDashboard />
    </PageShell>
  );
}
