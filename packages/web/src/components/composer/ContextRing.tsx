import type { ContextUsage, UsageLimits } from "@agent-workstation/protocol";
import { useEffect, useRef, useState } from "react";
import { formatKTokens, formatUsd } from "../../lib/format";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { useSessions } from "../../store/sessions";
import { tokensUntilCompact, usedPercent } from "../overview/ContextCard";

export type RingTone = "accent" | "warn" | "danger";

/** Context fill: normal below 70 %, warn 70–90 %, danger from 90 %. */
export function ringTone(percent: number): RingTone {
  return percent >= 90 ? "danger" : percent >= 70 ? "warn" : "accent";
}

/** The dot on the ring shows from this share of the API budget. */
export const LIMIT_DOT_AT = 80;

const R = 7;
const CIRC = 2 * Math.PI * R;

type Api = NonNullable<UsageLimits["api"]>;

function Popover({ usage, api }: { usage: ContextUsage; api: Api | null }) {
  const until = tokensUntilCompact(usage);
  return (
    <div className="space-y-1.5">
      <div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-muted">{t("ring.context")}</span>
          <span className="tabular-nums" data-testid="ring-context">
            {t("ring.contextValue", { pct: usedPercent(usage), used: formatKTokens(usage.usedTokens), total: formatKTokens(usage.windowTokens) })}
          </span>
        </div>
        {until !== null && (
          <div className="text-right text-muted tabular-nums" data-testid="ring-until-compact">
            {t("overview.untilCompact", { n: formatKTokens(until) })}
          </div>
        )}
      </div>
      {api && (
        <div className="flex items-baseline justify-between gap-4" data-testid="ring-api">
          <span className="text-muted">{t("usage.api.title")}</span>
          <span className="tabular-nums">{t("ring.apiCredits", { spent: formatUsd(api.spentUsd), limit: formatUsd(api.limitUsd) })}</span>
        </div>
      )}
    </div>
  );
}

/** Small progress ring left of the send button: how full the session's context window is; the popover adds the API credits. */
export function ContextRing({ sessionId }: { sessionId: string | null }) {
  const session = useSessions((s) => (sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId]) : undefined));
  const usage = session?.contextUsage ?? null;
  const limits = useApp((s) => s.limits);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const open = hover || focus || pinned;

  // a tap elsewhere / Escape closes it (touch has no hover to end)
  useEffect(() => {
    if (!open) return;
    const close = () => (setHover(false), setFocus(false), setPinned(false));
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!usage) return null;
  const percent = Math.max(0, Math.min(100, (usage.usedTokens / usage.windowTokens) * 100));
  const tone = ringTone(percent);
  const api = limits?.api ?? null;
  const limitPercent = api?.percent ?? null;
  const dot = limitPercent != null && limitPercent >= LIMIT_DOT_AT;
  const label = t("ring.label", { pct: usedPercent(usage) });
  const fill = tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--accent)";

  return (
    <span
      ref={root}
      className="relative flex shrink-0"
      data-testid="context-ring-wrap"
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        data-testid="context-ring"
        data-tone={tone}
        data-percent={Math.round(percent)}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setFocus(true)}
        onBlur={() => (setFocus(false), setPinned(false))}
        className="relative flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
          <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
          <circle cx="8" cy="8" r={R} fill="none" stroke={fill} strokeWidth="2" strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - percent / 100)} data-testid="context-ring-arc" />
        </svg>
        {dot && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-warn ring-2 ring-surface" data-testid="ring-limit-dot" />}
      </button>
      {open && (
        <div
          role="tooltip"
          data-testid="context-ring-popover"
          className="anim-fade absolute bottom-full right-0 z-[100] mb-1.5 w-max min-w-[220px] max-w-[300px] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[var(--shadow-pop)]"
        >
          <Popover usage={usage} api={api} />
        </div>
      )}
    </span>
  );
}
