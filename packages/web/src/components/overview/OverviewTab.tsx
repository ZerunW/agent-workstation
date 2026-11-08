import { ContextCard } from "./ContextCard";
import { EnvironmentCard } from "./EnvironmentCard";
import { OutputsCard } from "./OutputsCard";
import { PinnedCard } from "./PinnedCard";
import { TasksCard } from "./TasksCard";

/** The session overview: collapsible cards in a fixed order (cards without data hide themselves). */
export function OverviewTab({ sessionId }: { sessionId: string | null }) {
  return (
    <div className="h-full space-y-2 overflow-y-auto p-2" data-testid="overview-tab">
      <EnvironmentCard sessionId={sessionId} />
      <ContextCard sessionId={sessionId} />
      <OutputsCard sessionId={sessionId} />
      <PinnedCard sessionId={sessionId} />
      <TasksCard sessionId={sessionId} />
    </div>
  );
}
