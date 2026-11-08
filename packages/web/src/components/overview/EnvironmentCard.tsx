import { Bell, Cpu, Folder, Server } from "lucide-react";
import type { ReactNode } from "react";
import { useFetch } from "../../hooks/useFetch";
import { api, getApiBase } from "../../lib/api";
import { basename, dirname } from "../../lib/format";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { setSessionNotify } from "../../store/actions";
import { useSessions } from "../../store/sessions";
import { Switch } from "../admin/Switch";
import { useSettings } from "../composer/Pickers";
import { Card } from "./Card";

/** The hub host of this page (or of the embed's API base), used until / unless the server reports its host name. */
function hubHost(): string {
  try {
    return new URL(getApiBase() || window.location.origin).hostname;
  } catch {
    return window.location.hostname;
  }
}

function Row({ icon, label, testId, children }: { icon: ReactNode; label: string; testId: string; children: ReactNode }) {
  return (
    <li className="flex h-6 items-center gap-2" data-testid={testId} title={label}>
      <span className="shrink-0 text-muted" aria-hidden>
        {icon}
      </span>
      {children}
    </li>
  );
}

/** Machine (the server's host name), working directory (Code only) and model of the session. */
export function EnvironmentCard({ sessionId }: { sessionId: string | null }) {
  const { data: health } = useFetch(() => api.health(), []);
  const session = useSessions((s) => (sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId]) : undefined));
  const { model, modelInfo } = useSettings(sessionId);
  const globalOn = useApp((s) => s.me?.user.notificationsEnabled !== false);
  const host = health?.hostname || hubHost();

  const cwd = session?.kind === "code" ? session.cwd.replace(/^\.?\/+|\/+$/g, "") : null;
  const parent = cwd ? dirname(cwd) : "";
  const modelLabel = modelInfo?.displayName ?? model;

  return (
    <Card id="environment" title={t("overview.environment")}>
      <ul className="space-y-0.5">
        <Row icon={<Server className="size-3.5" />} label={t("overview.machine")} testId="overview-machine">
          <span className="min-w-0 truncate" title={host}>
            {host}
          </span>
        </Row>
        {cwd !== null && (
          <Row icon={<Folder className="size-3.5" />} label={t("overview.folder")} testId="overview-folder">
            <span className="min-w-0 truncate" title={cwd || undefined}>
              {cwd ? basename(cwd) : t("sidebar.workspace")}
              {parent && <span className="text-subtle"> · {parent}</span>}
            </span>
          </Row>
        )}
        {modelLabel && (
          <Row icon={<Cpu className="size-3.5" />} label={t("overview.model")} testId="overview-model">
            <span className="min-w-0 truncate">{modelLabel}</span>
          </Row>
        )}
        {session && sessionId && (
          <Row icon={<Bell className="size-3.5" />} label={t("overview.notifications")} testId="overview-notifications">
            <span className="min-w-0 flex-1 truncate">{t("overview.notifications")}</span>
            <Switch testId="overview-notify" checked={globalOn && session.notify !== false} disabled={!globalOn} onChange={(v) => void setSessionNotify(sessionId, v)} label={t("overview.notifications")} />
          </Row>
        )}
      </ul>
    </Card>
  );
}
