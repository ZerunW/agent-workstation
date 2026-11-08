import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { Check, ChevronRight, X } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Kbd } from "./primitives";

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={150}>
    {children}
  </TooltipPrimitive.Provider>
);

export function Tip({ label, shortcut, children, side = "bottom" }: { label: ReactNode; shortcut?: string; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="anim-fade z-[100] flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-[var(--shadow-pop)]"
        >
          {label}
          {shortcut && <span className="font-mono text-[10.5px] opacity-70">{shortcut}</span>}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
  hideClose?: boolean;
  className?: string;
}

export function Modal({ open, onOpenChange, title, description, children, footer, width = "md", hideClose, className }: ModalProps) {
  const w = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" }[width];
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="anim-fade fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          className={cn("anim-pop fixed left-1/2 top-[14vh] z-50 flex max-h-[76vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-xl border border-line bg-surface shadow-[var(--shadow-pop)]", w, className)}
        >
          <div className="flex items-start gap-3 px-5 pt-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-[15px] font-semibold text-fg">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-[13px] leading-relaxed text-muted">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            {!hideClose && (
              <DialogPrimitive.Close className="-mr-1.5 inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" aria-label="Close">
                <X className="size-4" />
              </DialogPrimitive.Close>
            )}
          </div>
          {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>}
          {footer && <div className="flex justify-end gap-2 px-5 pb-4 pt-2">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Raw dialog content for bespoke layouts (command palette). */
export const DialogRoot = DialogPrimitive.Root;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogOverlay = DialogPrimitive.Overlay;
export const DialogContent = DialogPrimitive.Content;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      width="sm"
      footer={
        <>
          <button type="button" className="h-8 rounded-lg px-3 text-[13px] text-muted hover:bg-hover hover:text-fg" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cn("h-8 rounded-lg px-3 text-[13px] font-medium text-white", danger ? "bg-danger hover:opacity-90" : "bg-accent hover:bg-accent-hover")}
            onClick={async () => {
              await onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------
export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ className, children, align = "start", side, ...rest }: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          "anim-pop z-[90] max-h-[min(70vh,520px,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-[13px] text-fg shadow-[var(--shadow-pop)]",
          className,
        )}
        {...rest}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({ className, icon, shortcut, danger, children, ...rest }: ComponentPropsWithoutRef<typeof DropdownMenu.Item> & { icon?: ReactNode; shortcut?: string; danger?: boolean }) {
  return (
    <DropdownMenu.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-hover",
        danger && "text-danger",
        className,
      )}
      {...rest}
    >
      {icon && <span className="flex size-4 items-center justify-center text-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </DropdownMenu.Item>
  );
}

export function MenuRadioItem({
  className,
  children,
  description,
  badge,
  shortcut,
  oneLine,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.RadioItem> & { description?: ReactNode; /** small pill after the label ("Default") */ badge?: ReactNode; /** key hint at the right edge */ shortcut?: string; /** keep the subtitle to one truncated line */ oneLine?: boolean }) {
  return (
    <DropdownMenu.RadioItem
      className={cn("relative flex cursor-pointer select-none items-start gap-2 rounded-lg py-1.5 pl-7 pr-2.5 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-hover", className)}
      {...rest}
    >
      <DropdownMenu.ItemIndicator className="absolute left-2 top-2">
        <Check className="size-3.5 text-accent" />
      </DropdownMenu.ItemIndicator>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate">{children}</span>
          {badge && <span className="shrink-0 rounded-full bg-active px-1.5 py-px text-[10.5px] font-medium leading-snug text-muted">{badge}</span>}
        </span>
        {description && <span className={cn("mt-0.5 block text-xs leading-snug text-muted", oneLine && "truncate")} data-testid={oneLine ? "menu-description" : undefined}>{description}</span>}
      </span>
      {shortcut && <Kbd className="mt-0.5 shrink-0">{shortcut}</Kbd>}
    </DropdownMenu.RadioItem>
  );
}

export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuLabel({ className, ...rest }: ComponentPropsWithoutRef<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cn("px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle", className)} {...rest} />;
}

// Submenus ("Effort ›", "More models ›"): the content is portaled so the parent's scroll container cannot clip it.
export const MenuSub = DropdownMenu.Sub;

export function MenuSubTrigger({ className, icon, value, children, ...rest }: ComponentPropsWithoutRef<typeof DropdownMenu.SubTrigger> & { icon?: ReactNode; /** current value shown before the chevron */ value?: ReactNode }) {
  return (
    <DropdownMenu.SubTrigger
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-hover data-[state=open]:bg-hover",
        className,
      )}
      {...rest}
    >
      {icon && <span className="flex size-4 items-center justify-center text-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {value && <span className="shrink-0 text-xs text-muted">{value}</span>}
      <ChevronRight className="size-3.5 shrink-0 text-subtle" />
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({ className, children, ...rest }: ComponentPropsWithoutRef<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        sideOffset={6}
        alignOffset={-5}
        collisionPadding={12}
        className={cn(
          "anim-pop z-[90] max-h-[min(70vh,520px,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-[13px] text-fg shadow-[var(--shadow-pop)]",
          className,
        )}
        {...rest}
      >
        {children}
      </DropdownMenu.SubContent>
    </DropdownMenu.Portal>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

// ---------------------------------------------------------------------------
// Tabs (underline style)
// ---------------------------------------------------------------------------
export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...rest }: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex items-center gap-0.5", className)} {...rest} />;
}

export function TabsTrigger({ className, ...rest }: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "relative inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg data-[state=active]:bg-active data-[state=active]:text-fg disabled:opacity-40",
        className,
      )}
      {...rest}
    />
  );
}

export const TabsContent = TabsPrimitive.Content;
