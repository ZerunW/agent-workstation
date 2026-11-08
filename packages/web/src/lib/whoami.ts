import type { WhoAmIResponse } from "@agent-workstation/protocol";
import { useApp } from "../store/app";
import { api } from "./api";

/** The hub's answer, or null when it has none (older hub, network error): the caller falls back to typing a name. */
export async function fetchWhoAmI(): Promise<WhoAmIResponse | null> {
  try {
    const who = await api.whoami();
    return who && typeof who === "object" && Array.isArray(who.users) ? who : null;
  } catch {
    return null;
  }
}

// A name we signed in with and the hub then refused is not tried again: no loop between the app and the login page.
let autoName: string | null = null;
let rejectedName: string | null = null;

/** Call when the hub refused `user`; if it came from the automatic sign-in, it is not suggested again this page load. */
export function rejectAutoSignIn(user: string | null): void {
  if (user && user === autoName) rejectedName = user;
}

/** Test hook. */
export function resetAutoSignIn(): void {
  autoName = null;
  rejectedName = null;
}

/**
 * Sign in with the name the hub suggests for this Tailscale account (stored like a typed one). `dropStored` clears the
 * stored name in the same step when there is nothing to sign in with, so the page never flashes through a stale user.
 */
export async function autoSignIn(dropStored = false): Promise<{ signedIn: boolean; who: WhoAmIResponse | null }> {
  const who = await fetchWhoAmI();
  const suggested = who?.suggested;
  if (suggested && suggested !== rejectedName) {
    autoName = suggested;
    useApp.getState().setUser(suggested);
    return { signedIn: true, who };
  }
  if (dropStored) useApp.getState().setUser(null);
  return { signedIn: false, who };
}
