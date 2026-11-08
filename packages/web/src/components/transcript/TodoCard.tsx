import { Check, Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import type { TodoStep } from "../../lib/todos";
import { t } from "../../i18n";

/** The session's latest task list, pinned under the latest assistant message (it replaces the folded TodoWrite calls). */
export function TodoCard({ todos }: { todos: TodoStep[] }) {
  if (todos.length === 0) return null;
  return (
    <section className="rounded-xl border border-line bg-surface px-3.5 py-2.5" data-testid="todo-card" aria-label={t("tx.todos")}>
      <ul className="space-y-1.5">
        {todos.map((todo, i) => {
          const done = todo.status === "completed";
          const active = todo.status === "in_progress";
          return (
            <li key={i} className={cn("flex items-start gap-2 text-[13px]", done && "text-muted")} data-testid="todo-row" data-status={todo.status}>
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center" aria-hidden>
                {done ? (
                  <span className="flex size-4 items-center justify-center rounded-full bg-ok text-white" data-testid="todo-done">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                ) : active ? (
                  <Loader2 className="size-4 animate-spin text-accent" data-testid="todo-active" />
                ) : (
                  <span className="size-4 rounded-full border border-dashed border-strong" data-testid="todo-pending" />
                )}
              </span>
              <span className="min-w-0 break-words">{active ? todo.activeForm : todo.content}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
