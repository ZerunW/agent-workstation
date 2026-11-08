import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "xs" | "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-50",
  secondary: "bg-active text-fg hover:bg-strong disabled:opacity-50",
  outline: "border border-strong bg-transparent text-fg hover:bg-hover disabled:opacity-50",
  ghost: "bg-transparent text-muted hover:bg-hover hover:text-fg disabled:opacity-40",
  danger: "bg-danger text-white hover:opacity-90 disabled:opacity-50",
};
const sizes: Record<Size, string> = {
  xs: "h-6 px-2 text-xs gap-1 rounded-md",
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "sm", loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cn("inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-colors", variants[variant], sizes[size], className)}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: "xs" | "sm" | "md";
  label: string;
}

const iconSizes = { xs: "size-6 rounded-md", sm: "size-8 rounded-lg", md: "size-9 rounded-lg" };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ active, size = "sm", label, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40",
        active && "bg-active text-fg",
        iconSizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("rounded border border-line bg-sunken px-1.5 py-px font-mono text-[10.5px] leading-4 text-muted", className)}>{children}</kbd>;
}

export function Skeleton({ className }: { className?: string }) {
  // a caller-supplied height replaces the default one (no tailwind-merge here)
  return <div className={cn("skeleton", !/(^|\s)h-/.test(className ?? "") && "h-4", className)} aria-hidden />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-muted", className)} aria-label="Loading" />;
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";
const tones: Record<Tone, string> = {
  neutral: "bg-active text-muted",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
};

export function Badge({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-medium", tones[tone], className)} {...rest} />;
}

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      {icon && <div className="mb-1 text-subtle">{icon}</div>}
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      {children && <div className="max-w-sm text-[13px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Progress({ value, tone = "accent", className }: { value: number; tone?: "accent" | "ok" | "warn" | "danger"; className?: string }) {
  const color = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-active", className)} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width] duration-300", color)} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Banner({ tone = "info", children, action, onDismiss, className, role = "status" }: { tone?: "info" | "warn" | "danger" | "ok"; children: ReactNode; action?: ReactNode; onDismiss?: () => void; className?: string; role?: string }) {
  const t = {
    info: "bg-info-soft text-fg border-info/30",
    warn: "bg-warn-soft text-fg border-warn/30",
    danger: "bg-danger-soft text-fg border-danger/30",
    ok: "bg-ok-soft text-fg border-ok/30",
  }[tone];
  const dot = { info: "bg-info", warn: "bg-warn", danger: "bg-danger", ok: "bg-ok" }[tone];
  return (
    <div role={role} className={cn("flex items-start gap-2.5 border-b px-4 py-2 text-[13px] leading-snug", t, className)}>
      <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", dot)} />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="-my-0.5 rounded px-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
