import type { ReviewFile } from "@agent-workstation/protocol";
import { t } from "../../i18n";
import { Badge } from "../ui/primitives";

const LETTER: Record<ReviewFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", typechange: "T" };
const TONE: Record<ReviewFile["status"], "ok" | "info" | "danger" | "accent" | "warn"> = { added: "ok", modified: "info", deleted: "danger", renamed: "accent", typechange: "warn" };

/** One-letter git-style status (A/M/D/R/T) with the full word as tooltip and accessible name. */
export function StatusBadge({ status }: { status: ReviewFile["status"] }) {
  const label = t(`changes.status.${status}` as const);
  return (
    <Badge tone={TONE[status]} className="w-5 shrink-0 justify-center px-0 font-mono" title={label} aria-label={label} data-testid="status-badge" data-status={status}>
      {LETTER[status]}
    </Badge>
  );
}
