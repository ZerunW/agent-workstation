import type { ModelInfo, User } from "@agent-workstation/protocol";
import type { AdminUsage } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatCost, formatTokens } from "../../lib/format";
import { t } from "../../i18n";
import { Badge, Progress, Skeleton } from "../ui/primitives";
import { LimitEditor } from "./LimitEditor";
import { ModelAllowlist } from "./ModelAllowlist";
import { Switch } from "./Switch";
import type { UserPatch } from "./useUserPatcher";

type UsageRow = AdminUsage["users"][number];

export function limitTone(used: number, limit: number | null): "accent" | "warn" | "danger" {
  if (!limit) return "accent";
  const p = (used / limit) * 100;
  return p >= 100 ? "danger" : p >= 80 ? "warn" : "accent";
}

export interface UsersTableProps {
  users: User[] | undefined;
  usage: AdminUsage | undefined;
  models: readonly ModelInfo[];
  loading?: boolean;
  onPatch: (name: string, patch: UserPatch) => void | Promise<unknown>;
}

/** Per-user admin table: weekly usage vs limit plus inline controls (limit, enabled, terminal, model allowlist). */
export function UsersTable({ users, usage, models, loading, onPatch }: UsersTableProps) {
  const byUser = new Map<string, UsageRow>((usage?.users ?? []).map((u) => [u.user, u]));
  const th = "whitespace-nowrap px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-subtle";

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[900px] border-collapse text-[13px]">
        <thead className="border-b border-line bg-sunken/60">
          <tr>
            <th className={th}>{t("admin.col.user")}</th>
            <th className={cn(th, "w-[240px]")}>{t("admin.col.weekly")}</th>
            <th className={cn(th, "text-right")}>{t("admin.col.limit")}</th>
            <th className={cn(th, "text-right")}>{t("admin.col.cost")}</th>
            <th className={cn(th, "text-right")}>{t("admin.col.sessions")}</th>
            <th className={cn(th, "text-center")}>{t("admin.col.enabled")}</th>
            <th className={cn(th, "text-center")}>{t("admin.col.terminal")}</th>
            <th className={th}>{t("admin.col.models")}</th>
          </tr>
        </thead>
        <tbody>
          {!users && loading &&
            [0, 1, 2].map((i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td colSpan={8} className="px-3 py-3">
                  <Skeleton className="h-5 w-full" />
                </td>
              </tr>
            ))}
          {users && users.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-muted">{t("admin.users.empty")}</td>
            </tr>
          )}
          {users?.map((u) => {
            const row = byUser.get(u.name);
            const used = row?.weeklyTokens ?? 0;
            const limit = u.weeklyTokenLimit;
            const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
            return (
              <tr key={u.name} className="border-b border-line last:border-0 hover:bg-hover/50" data-testid={`user-row-${u.name}`}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold uppercase text-accent">{u.name[0]}</span>
                    <span className="font-medium">{u.name}</span>
                    {u.isAdmin && <Badge tone="accent">{t("admin.badge.admin")}</Badge>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <span className="w-14 shrink-0 text-right tabular-nums">{formatTokens(used)}</span>
                    {limit ? <Progress className="min-w-[80px] flex-1" value={pct} tone={limitTone(used, limit)} /> : <span className="flex-1" />}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right">
                  <div className="flex justify-end">
                    <LimitEditor value={limit} user={u.name} onCommit={(next) => void onPatch(u.name, { weeklyTokenLimit: next })} />
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCost(row?.costUsd ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row?.sessions ?? 0}</td>
                <td className="px-3 py-2 text-center">
                  <Switch checked={u.enabled} disabled={u.isAdmin} label={t("admin.switch.enabled", { user: u.name })} onChange={(next) => void onPatch(u.name, { enabled: next })} />
                </td>
                <td className="px-3 py-2 text-center">
                  <Switch checked={u.terminalEnabled} label={t("admin.switch.terminal", { user: u.name })} onChange={(next) => void onPatch(u.name, { terminalEnabled: next })} />
                </td>
                <td className="px-3 py-1.5">
                  <ModelAllowlist user={u.name} value={u.modelAllowlist} models={models} onChange={(next) => void onPatch(u.name, { modelAllowlist: next })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
