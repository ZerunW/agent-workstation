/// <reference types="vite/client" />

interface Window {
  webkit?: { messageHandlers?: { workstation?: { postMessage(message: unknown): void } } };
  /**
   * Injected by AgentWorkstation.app: `pickFolder` opens the native folder panel; the app then loads `/?new=code&cwd=…` itself.
   * `reportAccepted` tells the app which accepts the user clicked (`sha256` = hex SHA-256 of the content, `null` for a deletion).
   */
  __workstationShell?: {
    pickFolder?: () => void;
    /** Native notification; `id` makes repeats replace each other. Opening it calls `window.__workstationOpenSession(sessionId)`. */
    notify?: (n: { id: string; title: string; body: string; sessionId: string }) => void;
    reportAccepted?: (report: { projectId: string; localCommit: string; files: Array<{ path: string; sha256: string | null }> }) => void;
    sync?: {
      /** null when this project is not linked on this Mac. */
      status(projectId: string): Promise<{ folder: string; pending: number } | null>;
      pending(projectId: string): Promise<import("@agent-workstation/protocol").SyncPendingItem[]>;
      /** Children of `dir` ("" = the linked folder's top level), folders first. */
      list(projectId: string, dir: string): Promise<import("@agent-workstation/protocol").SyncEntry[]>;
      decide(projectId: string, decisions: import("@agent-workstation/protocol").SyncDecisionInput[]): Promise<void>;
      /** Re-run rules + AI over rows that are undecided or AI-decided (under `dir`, default everything). */
      recheck(projectId: string, dir?: string): Promise<void>;
    };
  };
  /** AgentWorkstation.app calls this when pending items or decisions of a project change. */
  __workstationSyncChanged?: (projectId: string) => void;
  /** Called by AgentWorkstation.app when the user opens a notification: navigates to `/s/<id>`. */
  __workstationOpenSession?: (sessionId: string) => void;
  workstationEmbedInit?: (config: unknown) => void;
  workstationEmbed?: unknown;
}
