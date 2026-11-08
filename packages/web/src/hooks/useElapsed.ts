import { useNow } from "../components/usage/useNow";

/** Milliseconds since `startedAt` (epoch ms), re-rendering the caller every second. null while the start is unknown. */
export function useElapsed(startedAt: number | null): number | null {
  useNow(1000); // the tick is only a re-render trigger; the value is read fresh so it is never a second stale
  return startedAt == null ? null : Math.max(0, Date.now() - startedAt);
}
