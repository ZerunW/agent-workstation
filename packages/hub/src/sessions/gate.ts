/**
 * Pre-send checks for POST /api/sessions/:id/messages (chat and code alike):
 *   remote disabled   → 403 remote_disabled
 *   user disabled     → 403 user_disabled
 *   weekly limit hit  → 429 weekly_limit   (rolling 7 days, input+output tokens)
 *   disk at block     → 507 disk_block
 *   API key / budget  → 503 api_unavailable (no key / budget 0) · 429 api_limit_reached (budget used up)
 */
import type { AuthedUser } from "../auth.js";
import type { Hub } from "../hub.js";
import { HttpError } from "../util/errors.js";
import { weeklyTokens } from "./usageReports.js";

export function presendCheck(hub: Hub, user: AuthedUser): void {
  if (!hub.settings.get().remoteClaudeEnabled) throw new HttpError(403, "remote_disabled", "Remote sessions are disabled by the admin.");
  const row = hub.users.get(user.name) ?? user.row;
  if (!row.enabled) throw new HttpError(403, "user_disabled", "Your account is disabled.");
  const limit = hub.users.effectiveWeeklyLimit(row);
  if (limit !== null) {
    const used = weeklyTokens(hub.store, user.name);
    if (used >= limit) throw new HttpError(429, "weekly_limit", `Weekly token limit reached (${used} / ${limit}).`, { used, limit });
  }
  if (hub.disk.level === "block") throw new HttpError(507, "disk_block", "The server's disk is almost full; pull your files back and delete them before starting new turns.");
  hub.billing.assertCanSend();
}
