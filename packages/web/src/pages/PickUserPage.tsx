import { Username } from "@agent-workstation/protocol";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { WhoAmIResponse } from "@agent-workstation/protocol";
import { api, ApiError, setApiUser } from "../lib/api";
import { autoSignIn, fetchWhoAmI } from "../lib/whoami";
import { cn } from "../lib/cn";
import { t } from "../i18n";
import { useApp } from "../store/app";
import { Button } from "../components/ui/primitives";
import { NO_AUTOFILL } from "../lib/noAutofill";

/**
 * Username entry. One input box, no list: the hub never tells a browser which usernames exist. The same name typed on
 * any device opens the same workspace, sessions and history on the server; a new name creates a new workspace.
 * The page itself does not explain any of that: it asks for a name and nothing else.
 */
export default function PickUserPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const current = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // undefined: still asking the hub; null: no Tailscale identity (legacy page)
  const [who, setWho] = useState<WhoAmIResponse | null | undefined>(undefined);

  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const enter = (n: string) => {
    if (current !== n) setUser(n);
    navigate(from, { replace: true });
  };

  // Creating a user is anonymous: send no identity while on this page. Without a stored name, the Tailscale account's
  // own name signs in right away; with one (Switch user) the page only lists the choices.
  useEffect(() => {
    setApiUser(null);
    let cancelled = false;
    void (async () => {
      if (current) return fetchWhoAmI();
      const r = await autoSignIn();
      if (r.signedIn && !cancelled) navigate(from, { replace: true });
      return r.who;
    })().then((w) => {
      if (!cancelled) setWho(w);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit
  }, []);

  const tailscale = who?.tailscale ? who : null;

  const valid = Username.safeParse(name).success;

  const submit = async () => {
    if (!valid) {
      setError(t("login.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 201 = new workspace, 200/409 = existing one: both mean "that name is yours now".
      await api.createUser(name);
      enter(name);
    } catch (err) {
      if (err instanceof ApiError && err.code === "user_bound") setError(t("login.taken"));
      else if (err instanceof ApiError && err.status === 409) enter(name);
      else setError(err instanceof Error ? err.message : t("app.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full overflow-y-auto bg-bg px-4 py-10">
      <div className="m-auto w-full max-w-md">
        {tailscale?.tailscale && (
          <p className="mb-4 truncate text-xs text-muted" data-testid="login-tailscale">
            {tailscale.tailscale.login} · {tailscale.tailscale.node}
          </p>
        )}
        <div className="mb-8 flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-10 shrink-0" data-testid="login-logo" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("login.title")}</h1>
            <p className="text-[13px] text-muted">{t("app.name")}</p>
          </div>
        </div>
        {who !== undefined && tailscale && tailscale.users.length > 0 && (
          <div className="mb-6 space-y-2" data-testid="login-users">
            {tailscale.users.map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => enter(u)}
                data-testid="login-user"
                className="group flex h-11 w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 text-left transition-colors hover:border-strong hover:bg-hover"
              >
                <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold uppercase text-accent">{u[0]}</span>
                <span className="flex-1 truncate text-sm font-medium">{u}</span>
                <ArrowRight className="size-4 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        )}
        {who !== undefined && (
        <div>
          <label htmlFor="workstation-name" className="mb-2 block text-[11px] font-semibold uppercase tracking-wide text-subtle">
            {tailscale && tailscale.users.length > 0 ? t("login.newName") : t("login.label")}
          </label>
          <div className="flex gap-2">
            <input {...NO_AUTOFILL}
              id="workstation-name"
              name="workstation-name"
              data-testid="login-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value.toLowerCase());
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name && !busy) void submit();
              }}
              aria-invalid={!!error}
              maxLength={32}
              autoFocus={!tailscale?.users.length}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={cn("h-11 min-w-0 flex-1 rounded-lg border bg-surface px-3 text-sm outline-none focus:border-accent", error ? "border-danger" : "border-line")}
            />
            <Button type="button" onClick={() => void submit()} variant="primary" size="md" loading={busy} disabled={!name} data-testid="login-continue">
              {t("login.continue")}
            </Button>
          </div>
          {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        </div>
        )}

        {who !== undefined && !tailscale && current && (
          <div className="mt-8 border-t border-line pt-5">
            <button
              type="button"
              onClick={() => enter(current)}
              data-testid="login-continue-current"
              className="group flex h-11 w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 text-left transition-colors hover:border-strong hover:bg-hover"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold uppercase text-accent">{current[0]}</span>
              <span className="flex-1 truncate text-sm font-medium">{t("login.continueAs", { user: current })}</span>
              <ArrowRight className="size-4 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          </div>
        )}

        <p className="mt-8 text-center text-xs">
          <Link to="/readme" data-testid="login-docs" className="text-subtle underline-offset-2 hover:text-fg hover:underline">
            {t("readme.link")}
          </Link>
        </p>
      </div>
    </div>
  );
}
