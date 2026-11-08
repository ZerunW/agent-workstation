/**
 * Cache of `supportedModels()` / `supportedCommands()`.
 * Filled from the first live process of a session and persisted in kv so the
 * UI has a model list right after a hub restart. Until then `FALLBACK_MODELS`
 * (the aliases the CLI always accepts) is what GET /api/models serves.
 */
import type { CommandInfo, EffortLevel, ModelInfo } from "@agent-workstation/protocol";
import type { Store } from "../db/store.js";
import type { Logger } from "../util/log.js";
import { annotateModels, modelFamily } from "./models.js";
import type { HubQuery, SdkModelInfo, SlashCommand } from "./sdk.js";

/** CLI-only commands the SDK cannot run (interactive TUI, auth, process control). */
export const COMMAND_DENYLIST = new Set([
  "login",
  "logout",
  "resume",
  "plugin",
  "plugins",
  "terminal-setup",
  "ide",
  "vim",
  "doctor",
  "exit",
  "quit",
  "theme",
  "install-github-app",
  "upgrade",
  "bug",
  "feedback",
  "mobile",
  "desktop",
  "heapdump",
  "keybindings",
  "statusline",
  "remote-control",
]);

/** The model aliases the CLI always accepts: served until a live process has reported the real list. */
export const FALLBACK_MODELS: readonly ModelInfo[] = [
  { value: "opus", displayName: "Opus", family: "opus" },
  { value: "sonnet", displayName: "Sonnet", family: "sonnet" },
  { value: "haiku", displayName: "Haiku", family: "haiku" },
];

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** A model as the protocol describes it, with its `family` (`legacy` is set over the whole list by `annotateModels`). */
export function toModelInfo(m: SdkModelInfo): ModelInfo {
  const levels = (m.supportedEffortLevels ?? []).filter((l): l is EffortLevel => (EFFORTS as readonly string[]).includes(l));
  const info: ModelInfo = {
    value: m.value,
    displayName: m.displayName,
    ...(m.description ? { description: m.description } : {}),
    ...(m.supportsEffort !== undefined ? { supportsEffort: m.supportsEffort } : {}),
    ...(m.supportedEffortLevels ? { supportedEffortLevels: levels } : {}),
    ...(m.supportsAutoMode !== undefined ? { supportsAutoMode: m.supportsAutoMode } : {}),
  };
  return { ...info, family: modelFamily(info) };
}

export function toCommandInfos(cmds: SlashCommand[]): CommandInfo[] {
  const out: CommandInfo[] = [];
  const seen = new Set<string>();
  for (const c of cmds) {
    const name = c.name.replace(/^\//, "");
    if (!name || COMMAND_DENYLIST.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: c.description ?? "",
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      // Claude Code marks its own commands (and bundled skills) `builtin: true`; the flag is
      // absent for user/project skills and custom commands (verified with 2.1.316).
      ...(c.builtin !== true ? { isSkill: true } : {}),
    });
  }
  return out;
}

const KV_MODELS = "catalog_models";
const KV_COMMANDS = "catalog_commands";

export class Catalog {
  private models: ModelInfo[] | null;
  private commands: CommandInfo[] | null;
  private refreshedAt = 0;
  private readonly perSession = new Map<string, CommandInfo[]>();
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
  ) {
    this.models = store.kvGet<ModelInfo[]>(KV_MODELS);
    this.commands = store.kvGet<CommandInfo[]>(KV_COMMANDS);
  }

  /** The models, each with `family` and `legacy`. */
  getModels(): ModelInfo[] | null {
    return this.models ? annotateModels(this.models) : null;
  }

  getCommands(sessionId?: string): CommandInfo[] | null {
    return (sessionId ? this.perSession.get(sessionId) : undefined) ?? this.commands;
  }

  /** The list a live process of this session reported (null before its first spawn). */
  sessionCommands(sessionId: string): CommandInfo[] | null {
    return this.perSession.get(sessionId) ?? null;
  }

  /** True when the cache is empty or older than `maxAgeMs`. */
  needsRefresh(maxAgeMs = 60 * 60_000): boolean {
    return !this.models || Date.now() - this.refreshedAt > maxAgeMs;
  }

  /** Pulls models and commands from a live query. Errors are logged, never thrown. */
  refreshFrom(q: HubQuery, opts: { sessionId?: string; global?: boolean } = {}): Promise<void> {
    if (opts.global !== false && this.inflight) return this.inflight;
    const run = (async () => {
      const [models, commands] = await Promise.allSettled([q.supportedModels(), q.supportedCommands()]);
      if (opts.global !== false) {
        if (models.status === "fulfilled" && models.value.length) {
          this.models = models.value.map(toModelInfo);
          this.store.kvSet(KV_MODELS, this.models);
        }
        if (commands.status === "fulfilled") {
          this.commands = toCommandInfos(commands.value);
          this.store.kvSet(KV_COMMANDS, this.commands);
        }
        this.refreshedAt = Date.now();
      }
      if (opts.sessionId && commands.status === "fulfilled") this.perSession.set(opts.sessionId, toCommandInfos(commands.value));
      for (const r of [models, commands]) if (r.status === "rejected") this.log.warn({ err: String(r.reason) }, "catalog refresh partially failed");
    })().catch((err) => this.log.warn({ err: String(err) }, "catalog refresh failed"));
    if (opts.global !== false) {
      this.inflight = run.finally(() => (this.inflight = null));
      return this.inflight;
    }
    return run;
  }

  setSessionCommands(sessionId: string, cmds: SlashCommand[]): void {
    this.perSession.set(sessionId, toCommandInfos(cmds));
  }

  forgetSession(sessionId: string): void {
    this.perSession.delete(sessionId);
  }
}
