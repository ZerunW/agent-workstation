/**
 * Checks the hub makes before it listens: configuration that would leave it unusable or exposed (errors, the hub
 * refuses to start) and deployment gaps worth a log line (warnings).
 */
import { execFile } from "node:child_process";
import { isProductionEnv, type HubConfig } from "./config.js";
import type { Logger } from "./util/log.js";

export const FIREWALL_UNIT = "workstation-agent-firewall.service";

export interface StartupReport {
  errors: string[];
  warnings: string[];
}

export interface StartupEnv {
  env?: NodeJS.ProcessEnv;
  /** Whether the agent firewall unit is active (tests; default: `systemctl is-active`). */
  firewallActive?: () => Promise<boolean>;
}

/** `systemctl is-active` of the firewall unit; false when systemd cannot be asked. */
export function firewallUnitActive(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", "--quiet", FIREWALL_UNIT], { timeout: 5000 }, (err) => resolve(!err));
  });
}

/** Log line and admin notice text when the firewall unit is not active. */
export function firewallInactiveMessage(runAs: string): string {
  return `${FIREWALL_UNIT} is not active: ${runAs}, the account Claude Code and terminals run as, is not kept away from the other ports on this server. Start it with: sudo systemctl enable --now ${FIREWALL_UNIT}`;
}

export async function startupChecks(config: HubConfig, opts: StartupEnv = {}): Promise<StartupReport> {
  const env = opts.env ?? process.env;
  const report: StartupReport = { errors: [], warnings: [] };
  if (config.auth.tailscaleIdentity && config.auth.adminLogins.length === 0) {
    report.errors.push(
      "[auth] tailscale_identity is on but admin_logins is empty, so nobody would be an admin. Set admin_logins to your Tailscale login (for example admin_logins = [\"you@example.com\"]) in the configuration file, or turn tailscale_identity off.",
    );
  }
  if (config.agents.runAs) {
    if (!(await (opts.firewallActive ?? firewallUnitActive)())) report.warnings.push(firewallInactiveMessage(config.agents.runAs));
    // The public user API is on Unix sockets only (identity.ts): a TCP listener would be reachable by the agent account.
    if (config.server.listen === "tcp" && isProductionEnv(env)) {
      report.errors.push(
        "[server] listen = \"tcp\" with [agents] run_as set in production would put the user API on a port the agent account can reach. Remove it (the default in production is \"unix\"); \"tcp\" is for development machines only.",
      );
    }
  } else if (isProductionEnv(env)) {
    report.warnings.push("[agents] run_as is empty: Claude Code and terminals run as the hub's own account and can read its data, configuration and API key. Set run_as to a separate unprivileged account (deploy/install.sh does this).");
  }
  return report;
}

export const FIREWALL_WATCH_INTERVAL_MS = 10 * 60_000;

/**
 * Checks every 10 minutes that the agent firewall unit is still active while agents run as a separate account: a
 * stopped unit would otherwise go unnoticed. An inactive unit is logged and told to admins every time; an info notice
 * follows when it is back. Nothing is gated and nothing is changed on the machine.
 */
export class FirewallWatch {
  private timer: NodeJS.Timeout | null = null;
  private wasInactive = false;

  constructor(
    private readonly deps: {
      runAs: string;
      active: () => Promise<boolean>;
      onInactive: (message: string) => void;
      onActive: (message: string) => void;
      log?: Logger | undefined;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs ?? FIREWALL_WATCH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check; a check that throws counts as inactive. */
  async check(): Promise<void> {
    const active = await this.deps.active().catch(() => false);
    if (!active) {
      const message = firewallInactiveMessage(this.deps.runAs);
      this.wasInactive = true;
      this.deps.log?.warn(message);
      this.deps.onInactive(message);
    } else if (this.wasInactive) {
      this.wasInactive = false;
      const message = `${FIREWALL_UNIT} is active again.`;
      this.deps.log?.info(message);
      this.deps.onActive(message);
    }
  }
}
