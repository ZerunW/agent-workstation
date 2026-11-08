import type { User } from "@agent-workstation/protocol";
import { useCallback } from "react";
import { api } from "../../lib/api";
import { t } from "../../i18n";
import { toast } from "../../store/toasts";

export type UserPatch = Partial<Pick<User, "enabled" | "terminalEnabled" | "weeklyTokenLimit" | "modelAllowlist">>;

/**
 * PATCH /api/users/:name with an optimistic update. On failure only the patched fields are rolled back
 * (so concurrent edits to other fields survive) and an error toast is shown.
 */
export function useUserPatcher(users: User[] | undefined, setUsers: (fn: (prev: User[] | undefined) => User[] | undefined) => void) {
  return useCallback(
    async (name: string, patch: UserPatch): Promise<boolean> => {
      const before = users?.find((u) => u.name === name);
      if (!before) return false;
      const keys = Object.keys(patch) as Array<keyof UserPatch>;
      setUsers((prev) => prev?.map((u) => (u.name === name ? { ...u, ...patch } : u)));
      try {
        const updated = await api.patchUser(name, patch);
        if (updated && typeof updated === "object" && "name" in updated) setUsers((prev) => prev?.map((u) => (u.name === name ? { ...u, ...updated } : u)));
        return true;
      } catch (e) {
        setUsers((prev) =>
          prev?.map((u) => {
            if (u.name !== name) return u;
            const rolled = { ...u } as Record<string, unknown>;
            for (const k of keys) rolled[k] = before[k];
            return rolled as unknown as User;
          }),
        );
        toast.error(t("admin.patchFailed", { user: name, error: e instanceof Error ? e.message : String(e) }));
        return false;
      }
    },
    [users, setUsers],
  );
}
