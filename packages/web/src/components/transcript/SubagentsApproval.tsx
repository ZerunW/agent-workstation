import { Check, ChevronRight, ShieldAlert, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import type { PermissionEntry } from "../../lib/session-reducer";
import { overlapsOf, subagentCalls, type SubagentCall } from "../../lib/subagent";
import { t } from "../../i18n";
import { sendPermissionResponse } from "../../store/hub";
import { Button } from "../ui/primitives";
import { AgentIcon, ModelChip, PathChips } from "./SubagentCard";

/** One agent of the proposed batch: the task shows as one line, a click opens it in full. */
function AgentRow({ call, overlaps }: { call: SubagentCall; overlaps: string[] }) {
  const [open, setOpen] = useState(false);
  const warn = overlaps.length ? t("sub.overlap", { name: overlaps.join(", ") }) : "";
  return (
    <li data-testid="approval-agent">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover">
        <span className="mt-0.5">
          <AgentIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium" data-testid="approval-description">
              {call.description}
            </span>
            <ModelChip model={call.model} data-testid="approval-model" />
            {warn && (
              <span title={warn} className="shrink-0" data-testid="approval-overlap">
                <TriangleAlert className="size-3.5 text-warn" aria-label={warn} />
              </span>
            )}
          </span>
          <span className={cn("mt-0.5 block text-[12px] text-muted", open ? "whitespace-pre-wrap break-words" : "truncate")} data-testid="approval-task" data-open={open}>
            {open ? call.task : call.task.replace(/\s+/g, " ").trim()}
          </span>
        </span>
        <ChevronRight className={cn("mt-1 size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      <PathChips paths={call.paths} className="pb-1 pl-[34px] pr-1.5" />
    </li>
  );
}

/** "Start 3 subagents?": the batch of a `run_subagents` request, approved once (Start / Don't start, never "always"). */
export function SubagentsApprovalCard({ entry, sessionId }: { entry: PermissionEntry; sessionId: string }) {
  const { request } = entry;
  const calls = subagentCalls(request.input);
  const title = calls.length === 1 ? t("sub.start.one") : t("sub.start.many", { n: calls.length });
  const overlaps = overlapsOf(calls);
  const answered = entry.local != null; // sent, waiting for the hub's permission_resolved
  const respond = (behavior: "allow" | "deny") => sendPermissionResponse(sessionId, { requestId: request.requestId, behavior });
  return (
    <div className="overflow-hidden rounded-xl border border-warn/50 bg-surface shadow-sm" role="group" aria-label={title} data-testid="subagents-card">
      <div className="flex items-center gap-2 border-b border-line bg-warn-soft px-3.5 py-2">
        <ShieldAlert className="size-4 text-warn" />
        <span className="text-[13px] font-medium" data-testid="subagents-title">
          {title}
        </span>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <ul className="space-y-0.5" data-testid="approval-agents">
          {calls.map((call, i) => (
            <AgentRow key={i} call={call} overlaps={overlaps[i]!} />
          ))}
        </ul>
        {answered ? (
          <div className="text-[13px] text-muted">{t("perm.sending")}</div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Check className="size-3.5" />} onClick={() => respond("allow")} data-testid="subagents-start">
              {t("sub.start")}
            </Button>
            <Button variant="ghost" onClick={() => respond("deny")} data-testid="subagents-skip">
              {t("sub.skip")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
