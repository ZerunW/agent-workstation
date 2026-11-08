import { Pin } from "lucide-react";
import { useMemo } from "react";
import { pinnedEntries, scrollToMessage } from "../../lib/pins";
import { t } from "../../i18n";
import { useSessions } from "../../store/sessions";
import { Card } from "./Card";

/** The messages pinned in a Code session (first line of each); a click scrolls the transcript to the message. Hidden when none. */
export function PinnedCard({ sessionId }: { sessionId: string | null }) {
  const pinned = useSessions((s) => (sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId])?.pinnedMessages : undefined));
  const messages = useSessions((s) => (sessionId && pinned?.length ? s.views[sessionId]?.messages : undefined));
  const entries = useMemo(() => (messages ? pinnedEntries(messages, pinned) : []), [messages, pinned]);
  if (entries.length === 0) return null;
  return (
    <Card id="pinned" title={t("overview.pinned")}>
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.uuid}>
            <button type="button" onClick={() => scrollToMessage(e.uuid)} title={e.line} className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-left hover:bg-hover" data-testid="overview-pinned-item" data-uuid={e.uuid}>
              <Pin className="size-3.5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{e.line}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
