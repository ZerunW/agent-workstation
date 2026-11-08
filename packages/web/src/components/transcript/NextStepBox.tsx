import type { NextStep } from "@agent-workstation/protocol";
import { useState } from "react";
import { sendMessage } from "../../store/actions";
import { Button } from "../ui/primitives";

/** The agent's end-of-turn box: recap, and when it leaves a decision the question with its answer buttons (a button sends its label). */
export function NextStepBox({ sessionId, step }: { sessionId: string; step: NextStep }) {
  // a new box (another `at`) starts enabled again
  const [sentFor, setSentFor] = useState<string | null>(null);
  const sent = sentFor === step.at;
  const actions = step.actions ?? [];
  return (
    <section className="rounded-xl border border-line bg-surface px-4 py-3 text-[13.5px]" data-testid="next-step">
      <p className="whitespace-pre-wrap break-words text-muted" data-testid="next-step-recap">
        {step.recap}
      </p>
      {step.ask && (
        <p className="mt-2.5 font-semibold" data-testid="next-step-ask">
          {step.ask}
        </p>
      )}
      {actions.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2" data-testid="next-step-actions">
          {actions.map((a, i) => (
            <Button
              key={`${i}:${a.label}`}
              variant={i === 0 ? "primary" : "outline"}
              disabled={sent}
              data-testid="next-step-action"
              onClick={() => {
                setSentFor(step.at);
                void sendMessage(sessionId, a.label);
              }}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
