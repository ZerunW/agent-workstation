/**
 * The version of Claude Code as the agent account runs it: `claude --version` through AgentExec (the wrapper allows
 * exactly that bare flag), once at start and every 6 hours. A failed run is null. Served in `GET /api/health`
 * `agents` for the status page. Without `[agents] run_as` there is no agent account to ask and it stays null.
 */
import type { AgentExec, AgentMode } from "./agentExec.js";
import type { Logger } from "../util/log.js";
import { redactSecrets } from "../util/redact.js";

export interface AgentVersions {
  claude: string | null;
}

export const AGENT_VERSION_INTERVAL_MS = 6 * 3600_000;
const RUN_TIMEOUT_MS = 15_000;

export class AgentVersionService {
  private versions: AgentVersions = { claude: null };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: { exec: Pick<AgentExec, "run" | "cfg"> | undefined; log?: Logger | undefined; intervalMs?: number },
  ) {}

  current(): AgentVersions {
    return { ...this.versions };
  }

  /** Reads the versions now and again every 6 hours. */
  start(): void {
    if (this.timer || !this.deps.exec) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.deps.intervalMs ?? AGENT_VERSION_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<AgentVersions> {
    this.versions = { claude: await this.read("claude") };
    return this.current();
  }

  private async read(mode: Extract<AgentMode, "claude">): Promise<string | null> {
    const exec = this.deps.exec;
    if (!exec) return null;
    const r = await exec.run(mode, { cwd: exec.cfg.workRoot, args: ["--version"] }, RUN_TIMEOUT_MS);
    if (r.error !== null || r.code !== 0) {
      this.deps.log?.debug({ mode, code: r.code, err: redactSecrets(r.error ?? r.stderr.trim()).slice(0, 200) }, "could not read the agent version");
      return null;
    }
    const line = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    return line ? line.slice(0, 100) : null;
  }
}
