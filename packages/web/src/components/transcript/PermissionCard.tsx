import { Ban, Check, Download, Globe, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useMemo, useState } from "react";
import { agentName } from "../../lib/agent";
import { cn } from "../../lib/cn";
import { siteHost } from "../../lib/browserSites";
import { isDownloadTool, parseDownload, splitUrl } from "../../lib/download";
import { isRecord } from "../../lib/sdk";
import type { PermissionEntry } from "../../lib/session-reducer";
import { isSubagentTool } from "../../lib/subagent";
import { DIFFABLE_TOOLS, extractEdit, toolMeta } from "../../lib/toolSummary";
import { t } from "../../i18n";
import { sendPermissionResponse } from "../../store/hub";
import { Button } from "../ui/primitives";
import { SubagentsApprovalCard } from "./SubagentsApproval";
import { CodeBlock } from "./CodeBlock";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import { NO_AUTOFILL } from "../../lib/noAutofill";

function PrettyInput({ toolName, input }: { toolName: string; input: unknown }) {
  const edit = DIFFABLE_TOOLS.has(toolName) ? extractEdit(toolName, input) : null;
  if (edit) return <DiffView spec={edit} />;
  if (isRecord(input) && toolName === "Bash" && typeof input.command === "string") {
    return (
      <div>
        {typeof input.description === "string" && input.description && <div className="mb-1 text-[13px] text-muted">{input.description}</div>}
        <CodeBlock code={input.command} lang="bash" className="!my-0" />
      </div>
    );
  }
  if (isRecord(input) && toolName === "ExitPlanMode" && typeof input.plan === "string") return <Markdown text={input.plan} className="!text-[14px]" />;
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return <CodeBlock code={json} lang="json" className="!my-0" maxHeight={240} />;
}

/** A resolved browser-site question: "Allowed github.com" / "Denied github.com". */
function BrowserSiteRow({ entry, origin }: { entry: PermissionEntry; origin: string }) {
  const host = siteHost(origin);
  const label = t(entry.status === "allowed" ? "perm.site.allowed" : entry.status === "denied" ? "perm.site.denied" : entry.status === "cancelled" ? "perm.site.cancelled" : "perm.site.elsewhere", { host });
  const Icon = entry.status === "allowed" ? Globe : entry.status === "denied" ? ShieldX : Ban;
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 text-[12.5px] text-muted" data-testid="permission-resolved" data-status={entry.status} title={origin}>
      <Icon className={cn("size-3.5 shrink-0", entry.status === "allowed" ? "text-ok" : entry.status === "denied" ? "text-danger" : "text-subtle")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

/** A resolved permission request as one muted row (it lives inside a tool group). */
export function PermissionRow({ entry }: { entry: PermissionEntry }) {
  if (entry.request.browserSite) return <BrowserSiteRow entry={entry} origin={entry.request.browserSite.origin} />;
  const meta = toolMeta(entry.request.toolName, entry.request.input);
  const label =
    entry.status === "cancelled"
      ? t("perm.cancelled")
      : entry.status === "allowed"
        ? entry.elsewhere
          ? t("perm.elsewhereAllowed")
          : t("perm.allowed")
        : entry.status === "denied"
          ? entry.elsewhere
            ? t("perm.elsewhereDenied")
            : t("perm.denied")
          : t("perm.elsewhere");
  const Icon = entry.status === "allowed" ? ShieldCheck : entry.status === "denied" ? ShieldX : Ban;
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 text-[12.5px] text-muted" data-testid="permission-resolved" data-status={entry.status}>
      <Icon className={cn("size-3.5 shrink-0", entry.status === "allowed" ? "text-ok" : entry.status === "denied" ? "text-danger" : "text-subtle")} />
      <span className="shrink-0 font-medium text-fg">{meta.label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{meta.summary}</span>
      <span className="shrink-0 text-[11.5px]">{label}</span>
    </div>
  );
}

/** "Use the browser on <host>?": Allow this session / Always allow (kept in Browser sites) / Deny. */
function BrowserSiteCard({ entry, sessionId, origin }: { entry: PermissionEntry; sessionId: string; origin: string }) {
  const { request } = entry;
  const host = siteHost(origin);
  const title = t("perm.site.title", { host });
  const answered = entry.local != null; // sent, waiting for the hub's permission_resolved
  const respond = (behavior: "allow" | "deny", remember?: "user") => sendPermissionResponse(sessionId, { requestId: request.requestId, behavior, ...(remember ? { remember } : {}) });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warn/50 bg-surface px-3.5 py-2 shadow-sm" role="group" aria-label={title} data-testid="site-card">
      <div className="flex min-w-0 flex-1 items-center gap-2" title={origin}>
        <Globe className="size-4 shrink-0 text-warn" />
        <span className="min-w-0 truncate text-[13px] font-medium" data-testid="site-title">
          {title}
        </span>
      </div>
      {answered ? (
        <div className="text-[13px] text-muted">{t("perm.sending")}</div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Check className="size-3.5" />} onClick={() => respond("allow")} data-testid="site-session">
            {t("perm.site.session")}
          </Button>
          <Button variant="outline" onClick={() => respond("allow", "user")} data-testid="site-always">
            {t("perm.site.always")}
          </Button>
          <Button variant="ghost" onClick={() => respond("deny")} data-testid="site-deny">
            {t("perm.deny")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Download from <host>?": the full URL (query set apart), the safety check's reason, Download / Don't download. */
function DownloadCard({ entry, sessionId, host }: { entry: PermissionEntry; sessionId: string; host: string }) {
  const { request } = entry;
  const { url, reason } = parseDownload(request.input);
  const { base, rest } = splitUrl(url);
  const title = t("perm.download.title", { host });
  const answered = entry.local != null; // sent, waiting for the hub's permission_resolved
  const respond = (behavior: "allow" | "deny") => sendPermissionResponse(sessionId, { requestId: request.requestId, behavior });
  return (
    <div className="overflow-hidden rounded-xl border border-warn/50 bg-surface shadow-sm" role="group" aria-label={title} data-testid="download-card">
      <div className="flex items-center gap-2 border-b border-line bg-warn-soft px-3.5 py-2">
        <Download className="size-4 text-warn" />
        <span className="min-w-0 truncate text-[13px] font-medium" data-testid="download-title">
          {title}
        </span>
      </div>
      <div className="space-y-2 px-3.5 py-3">
        <div className="break-all font-mono text-[12.5px] leading-snug" data-testid="download-url">
          {base}
          {rest && (
            <span className="text-warn" data-testid="download-query">
              {rest}
            </span>
          )}
        </div>
        {reason && (
          <div className="text-[13px] text-muted" data-testid="download-reason">
            {reason}
          </div>
        )}
        {answered ? (
          <div className="text-[13px] text-muted">{t("perm.sending")}</div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Check className="size-3.5" />} onClick={() => respond("allow")} data-testid="download-allow">
              {t("perm.download.allow")}
            </Button>
            <Button variant="outline" onClick={() => respond("deny")} data-testid="download-deny">
              {t("perm.download.deny")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function PermissionCard({ entry, sessionId, agent }: { entry: PermissionEntry; sessionId: string; /** The session's agent name; read from the store when the caller does not know it. */ agent?: string }) {
  const site = entry.request.browserSite;
  if (entry.status !== "pending") return <PermissionRow entry={entry} />;
  if (site) return <BrowserSiteCard entry={entry} sessionId={sessionId} origin={site.origin} />;
  if (isSubagentTool(entry.request.toolName)) return <SubagentsApprovalCard entry={entry} sessionId={sessionId} />;
  if (isDownloadTool(entry.request.toolName)) {
    const { host } = parseDownload(entry.request.input);
    if (host) return <DownloadCard entry={entry} sessionId={sessionId} host={host} />;
  }
  return <ToolPermissionCard entry={entry} sessionId={sessionId} agent={agent} />;
}

function ToolPermissionCard({ entry, sessionId, agent: agentProp }: { entry: PermissionEntry; sessionId: string; agent?: string }) {
  const { request } = entry;
  // a forwarded request comes from a child session; the parent shows it
  const sub = request.subagent;
  const agent = agentProp ?? agentName();
  const meta = toolMeta(request.toolName, request.input);
  const [editing, setEditing] = useState(false);
  const [denying, setDenying] = useState(false);
  const initialJson = useMemo(() => {
    try {
      return JSON.stringify(request.input ?? {}, null, 2);
    } catch {
      return "{}";
    }
  }, [request.input]);
  const [json, setJson] = useState(initialJson);
  const [reason, setReason] = useState("");

  const parsed = useMemo(() => {
    if (!editing) return { ok: true as const, value: undefined as unknown };
    try {
      return { ok: true as const, value: JSON.parse(json) as unknown };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [editing, json]);

  if (entry.status !== "pending") return <PermissionRow entry={entry} />;

  const answered = entry.local != null; // sent, waiting for the hub's permission_resolved
  const respond = (behavior: "allow" | "deny", extra: { updatedInput?: unknown; message?: string; remember?: "session" | "user" } = {}) =>
    sendPermissionResponse(sessionId, { requestId: request.requestId, behavior, ...extra });

  return (
    <div className="overflow-hidden rounded-xl border border-warn/50 bg-surface shadow-sm" role="group" aria-label={t("perm.title", { agent, tool: meta.label })} data-testid="permission-card">
      <div className="flex items-center gap-2 border-b border-line bg-warn-soft px-3.5 py-2">
        <ShieldAlert className="size-4 text-warn" />
        <span className="text-[13px] font-medium" data-testid="permission-title">{t("perm.title", { agent, tool: meta.label })}</span>
        {sub && (
          <span className="min-w-0 flex-1 truncate text-right text-[12px] text-muted" data-testid="permission-subagent">
            {t("perm.subagent", { who: agent, description: sub.description })}
          </span>
        )}
      </div>
      <div className="space-y-3 px-3.5 py-3">
        {editing ? (
          <div>
            <textarea {...NO_AUTOFILL}
              id={`perm-json-${request.requestId}`}
              aria-label={t("perm.allowEdits")}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              spellCheck={false}
              rows={Math.min(14, Math.max(4, json.split("\n").length))}
              className={cn("w-full rounded-lg border bg-code px-3 py-2 font-mono text-[12.5px] outline-none focus:border-accent", parsed.ok ? "border-line" : "border-danger")}
            />
            {!parsed.ok && <div className="mt-1 text-xs text-danger">{t("perm.invalidJson", { error: parsed.error })}</div>}
          </div>
        ) : (
          <PrettyInput toolName={request.toolName} input={request.input} />
        )}

        {denying && (
          <input {...NO_AUTOFILL}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && respond("deny", { message: reason.trim() || undefined })}
            placeholder={t("perm.denyReason", { agent })}
            aria-label={t("perm.denyReason", { agent })}
            className="h-9 w-full rounded-lg border border-line bg-bg px-3 text-[13px] outline-none focus:border-accent"
          />
        )}

        {answered ? (
          <div className="text-[13px] text-muted">{t("perm.sending")}</div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {!editing && !denying && (
              <Button variant="primary" icon={<Check className="size-3.5" />} onClick={() => respond("allow")} data-testid="perm-allow">
                {t("perm.allow")}
              </Button>
            )}
            {editing ? (
              <>
                <Button variant="primary" disabled={!parsed.ok} onClick={() => parsed.ok && respond("allow", { updatedInput: parsed.value })} data-testid="perm-apply-edits">
                  {t("perm.applyEdits")}
                </Button>
                <Button variant="ghost" onClick={() => (setEditing(false), setJson(initialJson))}>
                  {t("app.cancel")}
                </Button>
              </>
            ) : denying ? (
              <>
                <Button variant="danger" onClick={() => respond("deny", { message: reason.trim() || undefined })} data-testid="perm-confirm-deny">
                  {t("perm.confirmDeny")}
                </Button>
                <Button variant="ghost" onClick={() => setDenying(false)}>
                  {t("app.cancel")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setEditing(true)} data-testid="perm-edit">
                  {t("perm.allowEdits")}
                </Button>
                <Button variant="outline" onClick={() => setDenying(true)} data-testid="perm-deny">
                  {t("perm.deny")}
                </Button>
                <Button variant="ghost" onClick={() => respond("allow", { remember: "session" })} data-testid="perm-always">
                  {t("perm.always")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
