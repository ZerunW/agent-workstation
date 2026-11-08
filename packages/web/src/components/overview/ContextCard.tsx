import type { ContextUsage } from "@agent-workstation/protocol";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { formatKTokens, formatPercent } from "../../lib/format";
import { t } from "../../i18n";
import { sendMessage } from "../../store/actions";
import { useSessions } from "../../store/sessions";
import { Button } from "../ui/primitives";
import { Card } from "./Card";

/** Segment colours by breakdown key (theme tokens, so both themes work); unknown keys cycle through the extras. */
const COLORS: Record<string, string> = {
  system_prompt: "var(--info)",
  system_tools: "var(--hl-attr)",
  mcp_tools: "var(--hl-built)",
  skills: "var(--warn)",
  memory: "var(--ok)",
  messages: "var(--accent)",
  autocompact_buffer: "var(--line-strong)",
};
const EXTRA = ["var(--hl-keyword)", "var(--hl-number)", "var(--hl-title)", "var(--danger)"];
const FREE = "var(--active)";
const USED = "var(--accent)";

interface Segment {
  key: string;
  label: string;
  tokens: number;
  color: string;
}

/** What the bar and rows show: the breakdown categories (or one "Used" row when only totals are known) plus free space. */
export function contextSegments(usage: ContextUsage): { segments: Segment[]; freeTokens: number } {
  let extra = 0;
  const segments: Segment[] = usage.breakdown
    ? usage.breakdown.map((b) => ({ key: b.key, label: b.label, tokens: b.tokens, color: COLORS[b.key] ?? EXTRA[extra++ % EXTRA.length]! }))
    : [{ key: "used", label: t("context.usedRow"), tokens: usage.usedTokens, color: USED }];
  const filled = segments.reduce((sum, s) => sum + s.tokens, 0);
  return { segments, freeTokens: Math.max(0, usage.windowTokens - filled) };
}

/** "26%", or "<1%" for a window that is almost empty. */
export function usedPercent(usage: ContextUsage): string {
  const p = (usage.usedTokens / usage.windowTokens) * 100;
  return usage.usedTokens > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/** Tokens left before auto-compact kicks in (window − used − buffer); null when the breakdown has no autocompact buffer. */
export function tokensUntilCompact(usage: ContextUsage): number | null {
  const buffer = usage.breakdown?.find((b) => b.key === "autocompact_buffer");
  return buffer ? Math.max(0, usage.windowTokens - usage.usedTokens - buffer.tokens) : null;
}

function Row({ color, label, tokens, window, outlined, dataKey }: { color: string; label: string; tokens: number; window: number; outlined?: boolean; dataKey: string }) {
  return (
    <li className="flex items-center gap-2" data-testid="context-row" data-key={dataKey}>
      <span className={cn("size-2.5 shrink-0 rounded-[3px]", outlined && "border border-line")} style={{ background: color }} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="tabular-nums text-muted">{formatKTokens(tokens)}</span>
      <span className="w-12 text-right tabular-nums text-subtle">{formatPercent((tokens / window) * 100)}</span>
    </li>
  );
}

function Usage({ usage, sessionId }: { usage: ContextUsage; sessionId: string }) {
  const [compacting, setCompacting] = useState(false);
  const { segments, freeTokens } = contextSegments(usage);
  const w = usage.windowTokens;
  const until = tokensUntilCompact(usage);
  const compact = async () => {
    setCompacting(true);
    try {
      await sendMessage(sessionId, "/compact");
    } finally {
      setCompacting(false);
    }
  };
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{t("context.used", { pct: usedPercent(usage) })}</span>
        <span className="tabular-nums text-muted">
          {formatKTokens(usage.usedTokens)} / {formatKTokens(w)}
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full" style={{ background: FREE }} role="img" aria-label={t("context.used", { pct: usedPercent(usage) })} data-testid="context-bar">
        {segments.map((s) => (
          <span key={s.key} data-key={s.key} style={{ width: `${Math.round(Math.min(100, (s.tokens / w) * 100) * 100) / 100}%`, background: s.color }} />
        ))}
      </div>
      <ul className="space-y-1">
        {segments.map((s) => (
          <Row key={s.key} color={s.color} label={s.label} tokens={s.tokens} window={w} dataKey={s.key} />
        ))}
        <Row color={FREE} outlined label={t("context.free")} tokens={freeTokens} window={w} dataKey="free" />
      </ul>
      <div className="flex items-center justify-between gap-2">
        <span className="text-subtle" data-testid="context-until-compact">
          {until !== null && t("overview.untilCompact", { n: formatKTokens(until) })}
        </span>
        <Button size="xs" variant="outline" loading={compacting} onClick={() => void compact()} data-testid="context-compact">
          {t("overview.compact")}
        </Button>
      </div>
    </div>
  );
}

/** Context-window usage of the session; hidden until the hub has reported some (`Session.contextUsage`, refreshed at turn end). */
export function ContextCard({ sessionId }: { sessionId: string | null }) {
  const usage = useSessions((s) => (sessionId ? (s.sessions[sessionId]?.contextUsage ?? s.views[sessionId]?.session?.contextUsage ?? null) : null));
  if (!sessionId || !usage) return null;
  return (
    <Card id="context" title={t("context.title")}>
      <Usage usage={usage} sessionId={sessionId} />
    </Card>
  );
}
