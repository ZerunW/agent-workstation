import type { User } from "@agent-workstation/protocol";
import { Activity, Cpu, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { AdminOverview, AdminUsage } from "../../lib/api";
import { t } from "../../i18n";
import { Skeleton } from "../ui/primitives";

export interface OverviewValues {
  users: number | null;
  /** live count when the hub reports it, otherwise the 7-day session total from usage */
  sessions: { value: number | null; live: boolean };
  processes: { value: number | null; max: number | null; queued: number | null };
}

/** Merge GET /api/admin/overview (protocol AdminOverview) with data we already have; falls back when it is unavailable. */
export function deriveOverview(overview: AdminOverview | undefined, users: User[] | undefined, usage: AdminUsage | undefined): OverviewValues {
  const total = usage ? usage.users.reduce((n, u) => n + u.sessions, 0) : null;
  if (!overview) return { users: users ? users.length : null, sessions: { value: total, live: false }, processes: { value: null, max: null, queued: null } };
  const working = overview.processes.filter((p) => p.status === "running" || p.status === "requires_action").length;
  return {
    users: overview.users.length,
    sessions: { value: working, live: true },
    processes: { value: overview.pool.active, max: overview.pool.max, queued: overview.pool.queued },
  };
}

function Card({ icon, label, value, sub, loading }: { icon: ReactNode; label: string; value: string; sub?: string; loading: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-3 sm:p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted sm:gap-2">
        <span className="text-subtle">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      {loading ? <Skeleton className="mt-2 h-8 w-16" /> : <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>}
      {sub && !loading && <div className="mt-0.5 text-xs text-subtle">{sub}</div>}
    </div>
  );
}

export function OverviewCards({ overview, users, usage, loading }: { overview: AdminOverview | undefined; users: User[] | undefined; usage: AdminUsage | undefined; loading: boolean }) {
  const v = deriveOverview(overview, users, usage);
  const fmt = (n: number | null) => (n == null ? "—" : String(n));
  const procSub = [v.processes.max != null && v.processes.value != null ? t("admin.overview.processesOf", { n: v.processes.value, max: v.processes.max }) : null, v.processes.queued ? t("admin.overview.queued", { n: v.processes.queued }) : null].filter(Boolean).join(" · ");
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3" data-testid="overview-cards">
      <Card icon={<Users className="size-3.5" />} label={t("admin.overview.users")} value={fmt(v.users)} loading={loading && v.users == null} />
      <Card icon={<Activity className="size-3.5" />} label={v.sessions.live ? t("admin.overview.activeSessions") : t("admin.overview.sessions")} value={fmt(v.sessions.value)} loading={loading && v.sessions.value == null} />
      <Card icon={<Cpu className="size-3.5" />} label={t("admin.overview.processes")} value={fmt(v.processes.value)} sub={procSub || undefined} loading={loading && !overview && v.processes.value == null} />
    </div>
  );
}
