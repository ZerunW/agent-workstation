import type { BackgroundTask } from "@agent-workstation/protocol";
import { Bot, ChevronRight, ListChecks, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { useElapsed } from "../../hooks/useElapsed";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatElapsed, relativeTime } from "../../lib/format";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { SUBAGENT_TASK_TYPE } from "../../lib/subagent";
import { useSessions } from "../../store/sessions";
import { useSubagentFocus } from "../../store/subagentFocus";
import { toast } from "../../store/toasts";
import { IconButton } from "../ui/primitives";
import { Card } from "./Card";

/** A subagent run: the description opens the run in the transcript. */
function TaskTitle({ sessionId, task }: { sessionId: string; task: BackgroundTask }) {
  const reveal = useSubagentFocus((s) => s.reveal);
  if (task.type !== SUBAGENT_TASK_TYPE) {
    return (
      <span className="min-w-0 flex-1 truncate" title={task.description}>
        {task.description}
      </span>
    );
  }
  return (
    <>
      <button type="button" onClick={() => reveal(sessionId, task.description)} className="min-w-0 flex-1 truncate text-left hover:underline" title={task.description} data-testid="overview-task-link">
        {task.description}
      </button>
    </>
  );
}

function TaskRow({ sessionId, task }: { sessionId: string; task: BackgroundTask }) {
  const offset = useApp((s) => s.serverOffsetMs);
  const start = Date.parse(task.startedAt);
  const elapsed = useElapsed(Number.isFinite(start) ? start - offset : null);
  const [stopping, setStopping] = useState(false);
  const Icon = typeIcon(task);

  const stop = async () => {
    setStopping(true);
    try {
      await api.stopTask(sessionId, task.taskId);
      // the row goes away when the hub's `background_tasks` event arrives
    } catch (e) {
      toast.error(t("overview.stopFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  };

  return (
    <li className="flex h-7 items-center gap-2" data-testid="overview-task" data-task-id={task.taskId} data-type={task.type}>
      <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
      <TaskTitle sessionId={sessionId} task={task} />
      {elapsed !== null && (
        <span className="shrink-0 tabular-nums text-subtle" data-testid="overview-task-elapsed">
          {formatElapsed(elapsed)}
        </span>
      )}
      <IconButton label={t("overview.stopTask")} size="xs" disabled={stopping} onClick={() => void stop()} data-testid="overview-task-stop">
        <Square className="size-3 fill-current" />
      </IconButton>
    </li>
  );
}

const typeIcon = (task: BackgroundTask) => (task.type.includes("bash") ? SquareTerminal : Bot);

const isFinished = (task: BackgroundTask): boolean => task.status === "completed" || task.status === "failed" || task.status === "stopped";

const endMs = (task: BackgroundTask): number => {
  const end = Date.parse(task.endedAt ?? "");
  return Number.isFinite(end) ? end : Date.parse(task.startedAt) || 0;
};

const MARKS = {
  completed: { mark: "✓", label: "overview.task.completed", tone: "text-ok" },
  failed: { mark: "✗", label: "overview.task.failed", tone: "text-danger" },
  stopped: { mark: "■", label: "overview.task.stopped", tone: "text-muted" },
} as const;

function FinishedRow({ sessionId, task }: { sessionId: string; task: BackgroundTask }) {
  const offset = useApp((s) => s.serverOffsetMs);
  const Icon = typeIcon(task);
  const status = task.status === "failed" || task.status === "stopped" ? task.status : "completed";
  const m = MARKS[status];
  const start = Date.parse(task.startedAt);
  const end = Date.parse(task.endedAt ?? "");
  return (
    <li className="flex h-7 items-center gap-2 text-muted" data-testid="overview-task-finished" data-task-id={task.taskId} data-type={task.type} data-status={status}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <TaskTitle sessionId={sessionId} task={task} />
      <span className={`shrink-0 ${m.tone}`} role="img" aria-label={t(m.label)} data-testid="overview-task-mark">
        {m.mark}
      </span>
      {Number.isFinite(start) && Number.isFinite(end) && (
        <span className="shrink-0 tabular-nums text-subtle" data-testid="overview-task-duration">
          {formatElapsed(end - start)}
        </span>
      )}
      {Number.isFinite(end) && (
        <span className="shrink-0 text-subtle" data-testid="overview-task-ended">
          {relativeTime(task.endedAt, Date.now() + offset)}
        </span>
      )}
    </li>
  );
}

/** Background shell commands and subagents of the session (`background_tasks` events); hidden when none run or ended, or the hub does not report them. */
export function TasksCard({ sessionId }: { sessionId: string | null }) {
  const tasks = useSessions((s) => (sessionId ? s.views[sessionId]?.backgroundTasks : undefined));
  const [open, setOpen] = useState(false);
  if (!sessionId || !tasks || tasks.length === 0) return null;
  const running = tasks.filter((x) => !isFinished(x));
  const finished = tasks.filter(isFinished).sort((a, b) => endMs(b) - endMs(a));
  return (
    <Card id="tasks" title={t("overview.tasks")}>
      {running.length > 0 && (
        <ul className="space-y-0.5">
          {running.map((task) => (
            <TaskRow key={task.taskId} sessionId={sessionId} task={task} />
          ))}
        </ul>
      )}
      {finished.length > 0 && (
        <div className={running.length > 0 ? "mt-1" : undefined}>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex h-7 w-full items-center gap-2 text-left text-muted hover:text-fg"
            data-testid="overview-tasks-finished"
          >
            <ListChecks className="size-3.5 shrink-0" aria-hidden />
            <span className="flex-1">{t("overview.finished", { n: finished.length })}</span>
            <ChevronRight className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")} aria-hidden />
          </button>
          {open && (
            <ul className="space-y-0.5" data-testid="overview-tasks-finished-list">
              {finished.map((task) => (
                <FinishedRow key={task.taskId} sessionId={sessionId} task={task} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
