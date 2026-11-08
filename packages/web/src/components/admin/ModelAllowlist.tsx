import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ModelInfo } from "@agent-workstation/protocol";
import { Check, ChevronDown } from "lucide-react";
import { t } from "../../i18n";
import { toggleAllowlist } from "./tokenLimit";

/** Multi-select popover for a user's model allowlist. null = every model; all checked also means null. */
export function ModelAllowlist({ user, value, models, onChange }: { user: string; value: string[] | null; models: readonly ModelInfo[]; onChange: (next: string[] | null) => void }) {
  const all = models.map((m) => m.value);
  // models in the allowlist the hub no longer reports stay visible so they can be unticked
  const extras = (value ?? []).filter((v) => !all.includes(v));
  const options = [...models.map((m) => ({ value: m.value, label: m.displayName || m.value })), ...extras.map((v) => ({ value: v, label: v }))];
  const universe = options.map((o) => o.value);
  const summary = value == null ? t("admin.models.all") : t("admin.models.n", { n: value.length });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={t("admin.models.edit", { user })}
          title={value?.join(", ") ?? t("admin.models.all")}
          className={`inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[13px] hover:bg-hover ${value == null ? "text-subtle" : "text-fg"}`}
        >
          {summary}
          <ChevronDown className="size-3.5 text-subtle" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={12} className="anim-pop z-[90] max-h-[min(60vh,420px)] min-w-[240px] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-[13px] text-fg shadow-[var(--shadow-pop)]">
          {options.length === 0 && <div className="px-2.5 py-2 text-xs text-muted">{t("admin.models.loading")}</div>}
          {options.map((o) => (
            <DropdownMenu.CheckboxItem
              key={o.value}
              checked={value == null || value.includes(o.value)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => onChange(toggleAllowlist(value, universe, o.value))}
              className="relative flex cursor-pointer select-none items-center rounded-lg py-1.5 pl-7 pr-2.5 outline-none data-[highlighted]:bg-hover"
            >
              <DropdownMenu.ItemIndicator className="absolute left-2">
                <Check className="size-3.5 text-accent" />
              </DropdownMenu.ItemIndicator>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
          {value != null && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item onSelect={() => onChange(null)} className="cursor-pointer rounded-lg px-2.5 py-1.5 outline-none data-[highlighted]:bg-hover">
                {t("admin.models.clear")}
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
