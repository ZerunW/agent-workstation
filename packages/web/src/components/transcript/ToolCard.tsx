import { Bot, Check, ChevronRight, FilePen, FileSearch, FileText, Globe, ListChecks, ListTodo, Loader2, Pencil, Puzzle, Search, SquareTerminal, Wrench, X } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { isRecord } from "../../lib/sdk";
import { DIFFABLE_TOOLS, extractEdit, toolMeta, type ToolIcon } from "../../lib/toolSummary";
import type { ToolItem } from "../../lib/transcript";
import { t } from "../../i18n";
import { CodeBlock, CopyButton } from "./CodeBlock";
import { DiffView } from "./DiffView";
import { useChildItems, useExpanded, useOpenOnFind } from "./host";
import { Markdown } from "./Markdown";

const ICONS: Record<ToolIcon, typeof Wrench> = {
  bash: SquareTerminal,
  read: FileText,
  edit: Pencil,
  write: FilePen,
  grep: Search,
  glob: FileSearch,
  web: Globe,
  task: Bot,
  todo: ListTodo,
  plan: ListChecks,
  mcp: Puzzle,
  other: Wrench,
};

const MAX_OUTPUT_LINES = 60;

function Output({ text, error }: { text: string; error: boolean }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const clipped = !all && lines.length > MAX_OUTPUT_LINES;
  const shown = clipped ? lines.slice(0, MAX_OUTPUT_LINES).join("\n") : text;
  return (
    <div className="group/out relative">
      <pre className={cn("max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed", error && "border-danger/40 text-danger")}>{shown}</pre>
      <CopyButton text={text} className="absolute right-1.5 top-1.5 bg-surface/80 opacity-0 group-hover/out:opacity-100" />
      {clipped && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 text-xs text-accent hover:underline">
          {t("tx.tool.showMore", { n: lines.length - MAX_OUTPUT_LINES })}
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-subtle">{title}</div>
      {children}
    </div>
  );
}

interface Todo {
  content?: string;
  activeForm?: string;
  status?: string;
}

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="space-y-1" data-testid="todo-list">
      {todos.map((todo, i) => {
        const done = todo.status === "completed";
        const active = todo.status === "in_progress";
        return (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", done ? "border-ok bg-ok text-white" : active ? "border-accent" : "border-strong")}>
              {done ? <Check className="size-3" /> : active ? <span className="size-1.5 rounded-full bg-accent" /> : null}
            </span>
            <span className={cn(done && "text-muted line-through")}>{active && todo.activeForm ? todo.activeForm : todo.content}</span>
          </li>
        );
      })}
    </ul>
  );
}

export interface ToolCardProps {
  tool: Pick<ToolItem, "toolUseId" | "name" | "input"> & Partial<Pick<ToolItem, "result" | "children">>;
  /** Waiting for a result and the turn is still running. */
  running?: boolean;
  /** Streaming input: show a live summary from partial JSON. */
  streaming?: boolean;
}

/** One row of an expanded tool group: icon, name, one-line summary and ✓ / ✗; the detail opens on click. `tool.input` is the parsed (partial, while streaming) input. */
export const ToolCard = memo(function ToolCard({ tool, running, streaming }: ToolCardProps) {
  const input = tool.input;
  const meta = toolMeta(tool.name, input);
  const edit = DIFFABLE_TOOLS.has(tool.name) ? extractEdit(tool.name, input) : null;
  const isTodo = tool.name === "TodoWrite" && isRecord(input) && Array.isArray(input.todos);
  const isPlan = tool.name === "ExitPlanMode" && isRecord(input) && typeof input.plan === "string";
  const [open, setOpen] = useExpanded(`row:${tool.toolUseId}`);
  useOpenOnFind(() => `${tool.name}\n${JSON.stringify(input) ?? ""}\n${tool.result?.text ?? ""}`, setOpen);
  const renderChildren = useChildItems();
  const Icon = ICONS[meta.icon];
  const result = tool.result;
  const pending = !result && (running || streaming);
  const failed = result?.isError;
  const childItems = tool.children ?? [];

  const status = pending ? (
    <Loader2 className="size-3.5 animate-spin text-muted" aria-label={t("tx.tool.running")} />
  ) : failed ? (
    <X className="size-3.5 text-danger" aria-label={t("tx.tool.error")} />
  ) : result ? (
    <Check className="size-3.5 text-ok" />
  ) : null;

  const inputJson = useMemo(() => {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }, [input]);

  const isBash = tool.name === "Bash" && isRecord(input) && typeof input.command === "string";

  return (
    <div className="text-[12.5px]" data-testid="tool-card" data-tool={tool.name}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted hover:bg-hover hover:text-fg">
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-fg">{meta.label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{meta.summary}</span>
        {status}
        <ChevronRight className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mb-1 ml-5 mt-1 max-h-80 space-y-2.5 overflow-y-auto pr-1 text-[12px]">
          {isTodo ? (
            <Section title={t("tx.todos")}>
              <TodoList todos={(input as { todos: Todo[] }).todos} />
            </Section>
          ) : isPlan ? (
            <Section title={t("tx.plan")}>
              <Markdown text={(input as { plan: string }).plan} className="!text-[14px]" />
            </Section>
          ) : edit ? (
            <DiffView spec={edit} />
          ) : isBash ? (
            <Section title={t("tx.tool.input")}>
              <CodeBlock code={String((input as { command: string }).command)} lang="bash" className="!my-0" />
            </Section>
          ) : (
            <Section title={t("tx.tool.input")}>
              <CodeBlock code={inputJson} lang="json" className="!my-0" maxHeight={260} />
            </Section>
          )}

          {!isTodo && !isPlan && (
            <Section title={failed ? t("tx.tool.error") : t("tx.tool.output")}>
              {result ? (
                <>
                  {result.text ? <Output text={result.text} error={!!failed} /> : result.images.length === 0 ? <div className="text-xs text-subtle">{t("tx.tool.noOutput")}</div> : null}
                  {result.images.map((src, i) => (
                    <img key={i} src={src} alt="" className="mt-2 max-h-80 max-w-full rounded-md border border-line" />
                  ))}
                </>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-subtle">{pending ? <><Loader2 className="size-3 animate-spin" />{t("tx.tool.running")}</> : t("tx.tool.noOutput")}</div>
              )}
            </Section>
          )}

          {childItems.length > 0 && (
            <details className="rounded-md border border-line px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted">{t("tx.tool.subagent", { n: childItems.length })}</summary>
              <div className="mt-3 space-y-3">{renderChildren(childItems)}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
});
