/** Users: auto-created on first sight, each with a workspace directory. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EffortLevel, User, UserPreferencesBody } from "@agent-workstation/protocol";
import type { HubConfig } from "./config.js";
import type { Store, UserRow } from "./db/store.js";
import type { Caller, IdentityResolver } from "./identity.js";
import { isValidUsername } from "./identity.js";
import type { SettingsService } from "./settings.js";
import { badRequest, forbidden, notFound } from "./util/errors.js";
import type { Logger } from "./util/log.js";

/** A user as admins see it (GET /api/users, PATCH /api/users/:name). */
export type AdminUserView = User & { tailscaleLogin: string | null };

/** Internal accounts that clients may not claim. */
export const SYSTEM_USER = "_system";
/** `<users_root>/_global` holds admin-provided global skills; never a user. */
export const GLOBAL_USER = "_global";
export const RESERVED_USERS = new Set([SYSTEM_USER, GLOBAL_USER]);

/** Layout of a workspace root. */
export const USER_DIRS = ["inbox", "projects", ".chat", ".claude/skills"] as const;

export class UserService {
  private readonly ensured = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly config: HubConfig,
    private readonly settings: SettingsService,
    private readonly identity: IdentityResolver,
    private readonly log?: Logger,
  ) {}

  root(name: string): string {
    return join(this.config.paths.usersRoot, name);
  }

  /**
   * Validates and creates the user (row + directories) if needed. A new user gets the terminal only when they are an
   * admin (`opts.admin`, default: the username's admin flag); everyone else starts with it off.
   */
  ensure(name: string, opts: { allowReserved?: boolean; admin?: boolean } = {}): UserRow {
    if (!isValidUsername(name)) throw badRequest("user_required", "username must match [a-z0-9_-]{1,32}");
    if (RESERVED_USERS.has(name) && !opts.allowReserved) throw forbidden("reserved_user", `${name} is reserved`);
    const hidden = RESERVED_USERS.has(name);
    this.store.ensureUser(name, hidden, undefined, opts.admin ?? this.identity.isAdmin(name));
    if (!this.ensured.has(name)) {
      const root = this.root(name);
      for (const d of USER_DIRS) mkdirSync(join(root, d), { recursive: true });
      this.ensured.add(name);
    }
    return this.store.getUser(name)!;
  }

  /** Forget that the user's directories exist (after an admin deleted the user). */
  forget(name: string): void {
    this.ensured.delete(name);
  }

  get(name: string): UserRow | null {
    return this.store.getUser(name);
  }

  /** Admin flag of a username outside a request (see IdentityResolver.isAdmin). */
  isAdmin(name: string): boolean {
    return this.identity.isAdmin(name, this.store.getUser(name)?.tailscaleLogin);
  }

  /**
   * The user `caller` acts as (created if new). A Tailscale caller binds an unbound username to its login; a username
   * bound to another login is refused with 403 `user_bound`. Admin follows the caller (login or legacy username).
   */
  authorize(name: string, caller: Caller): { row: UserRow; isAdmin: boolean } {
    let row = this.ensure(name, { admin: this.identity.callerIsAdmin(caller, name) });
    if (caller.kind === "tailscale" && row.tailscaleLogin !== caller.login) {
      const bound = row.tailscaleLogin ?? this.store.bindTailscaleLogin(name, caller.login);
      if (bound !== caller.login) throw forbidden("user_bound", `the username ${name} belongs to another Tailscale account; pick a different name`);
      this.log?.info({ user: name, login: caller.login, node: caller.node }, "username bound to Tailscale login");
      row = this.store.getUser(name)!;
    }
    return { row, isAdmin: this.identity.callerIsAdmin(caller, name) };
  }

  /** Usernames a Tailscale caller may sign in as (bound to its login, enabled, not reserved), most recent first. */
  usernamesFor(caller: Caller): string[] {
    if (caller.kind !== "tailscale") return [];
    return this.store.usernamesForLogin(caller.login).filter((n) => !RESERVED_USERS.has(n));
  }

  effectiveWeeklyLimit(row: UserRow): number | null {
    if (row.weeklyLimitCustom) return row.weeklyTokenLimit;
    const d = this.settings.get().defaultWeeklyTokenLimit;
    return d > 0 ? d : null;
  }

  /** `isAdmin`: the request's admin flag when answering the user themselves (default: the username's, see isAdmin). */
  toProtocol(row: UserRow, isAdmin?: boolean): User {
    return {
      name: row.name,
      createdAt: row.createdAt,
      isAdmin: isAdmin ?? this.identity.isAdmin(row.name, row.tailscaleLogin),
      enabled: row.enabled,
      terminalEnabled: row.terminalEnabled,
      weeklyTokenLimit: this.effectiveWeeklyLimit(row),
      modelAllowlist: row.modelAllowlist,
      defaultModel: row.defaultModel,
      defaultEffort: (row.defaultEffort as EffortLevel | null) ?? null,
      memoryEnabled: row.memoryEnabled,
      ...(row.notificationsEnabled ? {} : { notificationsEnabled: false }),
      instructions: row.instructions,
    };
  }

  /**
   * What a new session starts with when the client sends no model / effort:
   * the user's own preference, else the server default (admin settings, seeded from config:
   * "opus" / "high"). A server default outside the user's allowlist falls back to the first allowed model.
   */
  newSessionDefaults(row: UserRow): { model: string; effort: EffortLevel | null } {
    const server = this.settings.get();
    let model = row.defaultModel ?? server.defaultModel;
    if (!this.modelAllowed(row, model)) model = row.modelAllowlist?.[0] ?? model;
    const effort = row.defaultEffort !== null ? (row.defaultEffort as EffortLevel) : server.defaultEffort;
    return { model, effort };
  }

  /** Self-service defaults. A model outside the user's allowlist is refused (403 model_not_allowed). */
  setPreferences(row: UserRow, p: UserPreferencesBody): User {
    if (typeof p.defaultModel === "string" && !this.modelAllowed(row, p.defaultModel)) {
      throw forbidden("model_not_allowed", `model ${p.defaultModel} is not allowed for ${row.name}`);
    }
    const updated = this.store.updateUser(row.name, { defaultModel: p.defaultModel, defaultEffort: p.defaultEffort, memoryEnabled: p.memoryEnabled, notificationsEnabled: p.notificationsEnabled, instructions: p.instructions })!;
    return this.toProtocol(updated);
  }

  /**
   * Admin view of a user: the protocol fields plus `tailscaleLogin` (the bound login, null = none). Not part of the
   * protocol's `User` schema yet (zod objects strip unknown keys, so clients ignore it); never sent to non-admins.
   */
  toAdminView(row: UserRow): AdminUserView {
    return { ...this.toProtocol(row), tailscaleLogin: row.tailscaleLogin };
  }

  list(): AdminUserView[] {
    return this.store.listUsers(false).map((r) => this.toAdminView(r));
  }

  patch(name: string, p: { enabled?: boolean; terminalEnabled?: boolean; weeklyTokenLimit?: number | null; modelAllowlist?: string[] | null }): AdminUserView {
    if (!this.store.getUser(name) || RESERVED_USERS.has(name)) throw notFound("no such user");
    const row = this.store.updateUser(name, p)!;
    return this.toAdminView(row);
  }

  modelAllowed(row: UserRow, model: string): boolean {
    if (!row.modelAllowlist) return true;
    return row.modelAllowlist.includes(model);
  }
}
