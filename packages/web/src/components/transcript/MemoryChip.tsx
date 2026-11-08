import { BookMarked, Check, CircleAlert, Loader2 } from "lucide-react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import type { MemoryToolKind } from "../../lib/memory";
import { t } from "../../i18n";

export type MemoryChipState = "streaming" | "pending" | "done" | "failed";

interface ChipProps {
  kind: MemoryToolKind;
  /** The memory text; for a `failed` chip the tool's answer instead ("Memory is turned off…", "No memory matches…"). */
  text: string;
  state: MemoryChipState;
}

function Pill({ kind, text, state, onOpen }: ChipProps & { onOpen?: () => void }) {
  const label =
    state === "streaming"
      ? t(kind === "remember" ? "memory.chip.saving" : "memory.chip.removing")
      : state === "failed"
        ? t(kind === "remember" ? "memory.chip.notSaved" : "memory.chip.notRemoved")
        : t(kind === "remember" ? "memory.chip.saved" : "memory.chip.removed");
  const Icon = state === "streaming" ? Loader2 : BookMarked;
  const className = cn(
    "flex w-fit max-w-full items-center gap-1.5 rounded-full border border-line bg-surface/60 py-1 pl-2.5 pr-3 text-left text-[12.5px] text-muted",
    state === "failed" && "border-danger/40 text-muted",
    onOpen && "hover:bg-hover hover:text-fg",
  );
  const body = (
    <>
      <Icon className={cn("size-3.5 shrink-0", state === "streaming" && "animate-spin")} />
      <span className="min-w-0 truncate">
        <span className="font-medium">{label}</span>
        {state !== "streaming" && text && ` · ${text}`}
      </span>
      {state === "done" && <Check className="size-3.5 shrink-0 text-ok" aria-hidden />}
      {state === "failed" && <CircleAlert className="size-3.5 shrink-0 text-danger" aria-hidden />}
    </>
  );
  const attrs = { "data-testid": "memory-chip", "data-kind": kind, "data-state": state, title: text || undefined } as const;
  return onOpen ? (
    <button type="button" onClick={onOpen} aria-label={`${label}${text ? ` · ${text}` : ""}. ${t("memory.chip.open")}`} className={className} {...attrs}>
      {body}
    </button>
  ) : (
    <div className={className} {...attrs}>
      {body}
    </div>
  );
}

function LinkedPill(props: ChipProps) {
  const navigate = useNavigate();
  return <Pill {...props} onOpen={() => navigate("/memory")} />;
}

/**
 * Inline stand-in for the `remember` / `forget` tool cards: "Memory saved · <text>" with a check once the result is in.
 * Opens the Memory page when the transcript runs inside a router (the embed and bare tests render it as a plain chip).
 */
export function MemoryChip(props: ChipProps) {
  const inRouter = useInRouterContext();
  return inRouter ? <LinkedPill {...props} /> : <Pill {...props} />;
}
