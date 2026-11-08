/**
 * Anti-tearing holds: the project lock is held from PreToolUse to PostToolUse
 * of every Write/Edit/MultiEdit/NotebookEdit that targets a file inside a
 * project, so Mac pushes, review reads and accepts never observe a half-written
 * tool result (they simply wait).
 *
 * A hold must never outlive its tool:
 *   - PostToolUse / PostToolUseFailure / PermissionDenied release it;
 *   - while canUseTool waits for the user, the hold is suspended (released and
 *     re-acquired only if the user allows), so an unanswered prompt cannot
 *     block the project for minutes;
 *   - every turn end (`result`) and process end releases all holds of the session;
 *   - `autoReleaseMs` (10 min) is the last resort, and PreToolUse gives up
 *     waiting after `acquireTimeoutMs` (the tool then runs without a hold).
 */
import { acquireLock, type LockHandle } from "@agent-workstation/sync-core";
import type { Logger } from "../util/log.js";
import { errorMessage } from "../util/errors.js";

interface HoldEntry {
  hold: LockHandle;
  projectId: string;
  sessionId: string;
}

export interface ToolHoldsOptions {
  log: Logger;
  autoReleaseMs?: number;
  acquireTimeoutMs?: number;
}

export class ToolHolds {
  private readonly byTool = new Map<string, HoldEntry>();

  constructor(private readonly opts: ToolHoldsOptions) {}

  /** PreToolUse: waits for the project lock (bounded) and keeps it for `toolUseId`. */
  async acquire(toolUseId: string, sessionId: string, projectId: string): Promise<boolean> {
    if (this.byTool.has(toolUseId)) return true;
    try {
      const hold = await acquireLock(projectId, {
        autoReleaseMs: this.opts.autoReleaseMs ?? 10 * 60_000,
        timeoutMs: this.opts.acquireTimeoutMs ?? 90_000,
      });
      this.byTool.set(toolUseId, { hold, projectId, sessionId });
      return true;
    } catch (err) {
      this.opts.log.warn({ toolUseId, projectId, err: errorMessage(err) }, "could not take the project lock before a write tool; running without a hold");
      return false;
    }
  }

  /** PostToolUse (and failure / denial): releases the hold of one tool call. */
  release(toolUseId: string | undefined): void {
    if (!toolUseId) return;
    const e = this.byTool.get(toolUseId);
    if (!e) return;
    this.byTool.delete(toolUseId);
    e.hold.release();
  }

  /**
   * Releases the hold while a permission prompt is pending. Returns a function
   * that re-acquires it (call it only when the user allowed the tool), or null
   * when the tool holds nothing.
   */
  suspend(toolUseId: string | undefined): (() => Promise<void>) | null {
    if (!toolUseId) return null;
    const e = this.byTool.get(toolUseId);
    if (!e) return null;
    this.release(toolUseId);
    return async () => {
      await this.acquire(toolUseId, e.sessionId, e.projectId);
    };
  }

  /** Turn end / process end: nothing of this session can still be mid-write. */
  releaseSession(sessionId: string): number {
    let n = 0;
    for (const [id, e] of [...this.byTool]) {
      if (e.sessionId !== sessionId) continue;
      this.byTool.delete(id);
      e.hold.release();
      n++;
    }
    return n;
  }

  releaseProject(projectId: string): void {
    for (const [id, e] of [...this.byTool]) {
      if (e.projectId !== projectId) continue;
      this.byTool.delete(id);
      e.hold.release();
    }
  }

  get size(): number {
    return this.byTool.size;
  }

  heldBy(toolUseId: string): boolean {
    return this.byTool.has(toolUseId);
  }
}
