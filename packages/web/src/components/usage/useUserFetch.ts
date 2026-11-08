import { getApiUser, setApiUser } from "../../lib/api";
import { useFetch, type FetchState } from "../../hooks/useFetch";
import { useApp } from "../../store/app";

/**
 * Make sure the API user header is set before a request goes out. Child effects run before the shell connects
 * the hub (hard reload) and React StrictMode's dev remount clears the user between mounts, so pages that
 * fetch on mount must not rely on the shell having set it. Idempotent.
 */
export function ensureApiUser(): void {
  const user = useApp.getState().user;
  if (user && getApiUser() !== user) setApiUser(user);
}

/** Drop-in `useFetch` that calls `ensureApiUser()` right before every request. */
export function useUserFetch<T>(fn: () => Promise<T>, deps: readonly unknown[], opts: { refreshMs?: number; enabled?: boolean } = {}): FetchState<T> {
  return useFetch(
    () => {
      ensureApiUser();
      return fn();
    },
    deps,
    opts,
  );
}
