/**
 * What the usage card shows, as plain data (no DOM, unit-tested): the API-credit group with its card and notes.
 * `main.ts` only turns this into elements.
 */
import type { ApiCredits } from "@agent-workstation/protocol";
import type { UsageLimits } from "./types.js";
import { fmtResetTime, fmtUntil, fmtUsd } from "./format.js";

export interface UsageCard {
  key: string;
  label: string;
  percent: number | null;
  severity: ApiCredits["severity"];
  /** "Resets in 37m · Jan 15, 3:20 PM"; null when the hub has no reset time. */
  resetsAtMs: number | null;
  /** Shown at the right instead of the percentage ("$12.00 / $100.00"). */
  valueLabel?: string;
}

export interface UsageNote {
  tone: "notice" | "muted";
  text: string;
}

export interface UsageGroup {
  id: "api";
  title: string;
  cards: UsageCard[];
  notes: UsageNote[];
}

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The API-credit group (this period's spend against the monthly budget); notes explain a missing or failed answer. */
export function usageGroups(u: UsageLimits): UsageGroup[] {
  const a = u.api;
  if (!a) {
    return [{ id: "api", title: "API credits", cards: [], notes: [u.error ? { tone: "notice", text: `Usage data: ${u.error}` } : { tone: "muted", text: "No Anthropic API key is configured." }] }];
  }
  return [
    {
      id: "api",
      title: "API credits",
      cards: [{ key: "api|period", label: "This period", percent: a.percent, severity: a.severity, resetsAtMs: ms(a.resetsAt), valueLabel: `${fmtUsd(a.spentUsd)} / ${fmtUsd(a.limitUsd)}` }],
      notes: [],
    },
  ];
}

/** "Resets in 37m · Jan 15, 3:20 PM": the countdown and the one reset-time format every card uses (local time, date always, no seconds). */
export function resetLine(resetsAtMs: number, nowMs: number): { until: string; at: string } {
  return { until: fmtUntil(resetsAtMs, nowMs), at: fmtResetTime(resetsAtMs) };
}
