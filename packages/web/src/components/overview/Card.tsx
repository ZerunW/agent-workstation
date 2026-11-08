import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { safeStorage, STORAGE_KEYS } from "../../lib/storage";

export type CardId = "environment" | "context" | "outputs" | "pinned" | "tasks";

const readCollapsed = (): Record<string, boolean> => safeStorage.getJSON<Record<string, boolean>>(STORAGE_KEYS.overviewCollapsed, {});

/** One collapsible card of the Overview tab; its collapsed state is remembered per card in localStorage. */
export function Card({ id, title, children }: { id: CardId; title: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed()[id] === true);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    // re-read: the other cards write to the same map
    safeStorage.setJSON(STORAGE_KEYS.overviewCollapsed, { ...readCollapsed(), [id]: next });
  };
  return (
    <section className="rounded-lg border border-line bg-surface" data-testid={`overview-${id}`} data-collapsed={collapsed}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        data-testid={`overview-${id}-toggle`}
        className="flex h-8 w-full items-center justify-between gap-2 px-3 text-left text-[12px] font-semibold text-muted hover:text-fg"
      >
        {title}
        <ChevronDown className={cn("size-3.5 transition-transform", collapsed && "-rotate-90")} aria-hidden />
      </button>
      {!collapsed && <div className="px-3 pb-3 text-[12.5px]">{children}</div>}
    </section>
  );
}
