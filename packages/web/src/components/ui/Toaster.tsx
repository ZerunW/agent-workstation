import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useToasts, type Toast } from "../../store/toasts";
import { cn } from "../../lib/cn";
import { Progress, Spinner } from "./primitives";

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const Icon = toast.tone === "error" ? AlertCircle : toast.tone === "success" ? CheckCircle2 : Info;
  return (
    <div role={toast.tone === "error" ? "alert" : "status"} className="anim-pop pointer-events-auto flex w-80 items-start gap-2.5 rounded-xl border border-line bg-surface p-3 text-[13px] shadow-[var(--shadow-pop)]">
      <div className="mt-0.5 shrink-0">
        {toast.tone === "progress" ? <Spinner className="size-4" /> : <Icon className={cn("size-4", toast.tone === "error" ? "text-danger" : toast.tone === "success" ? "text-ok" : "text-info")} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium text-fg">{toast.title}</div>
        {toast.description && <div className="mt-0.5 break-words text-xs text-muted">{toast.description}</div>}
        {toast.tone === "progress" && typeof toast.progress === "number" && <Progress className="mt-2" value={toast.progress * 100} />}
        {toast.action && (
          <button type="button" onClick={toast.action.onClick} className="mt-1.5 text-xs font-medium text-accent hover:underline">
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" onClick={() => dismiss(toast.id)} className="-mr-1 -mt-1 rounded p-1 text-subtle hover:bg-hover hover:text-fg" aria-label="Dismiss">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[120] flex flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
