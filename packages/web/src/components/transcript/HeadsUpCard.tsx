import type { HeadsUpInput } from "@agent-workstation/protocol";
import { Copy, Ellipsis, X } from "lucide-react";
import { useEffect, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { t } from "../../i18n";
import { useHeadsUp } from "../../store/headsUp";
import { toast } from "../../store/toasts";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/overlays";
import { Button, IconButton } from "../ui/primitives";

/**
 * The agent's `heads_up` call: a short caveat under the message. Learn more shows `detail`; Knew this already tells the
 * hub (the card is gone for good, the agent stops repeating it); × hides it for this page view only.
 */
export function HeadsUpCard({ id, input }: { id: string; input: HeadsUpInput }) {
  const { text, detail } = input;
  const known = useHeadsUp((s) => s.known.some((k) => k.text === text));
  const dismissed = useHeadsUp((s) => !!s.dismissed[id]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useHeadsUp.getState().load();
  }, []);

  if (known || dismissed) return null;

  const knew = async () => {
    setBusy(true);
    try {
      await useHeadsUp.getState().markKnown(text);
    } catch (e) {
      toast.error(t("headsUp.failed", { error: e instanceof Error ? e.message : String(e) }));
      setBusy(false);
    }
  };

  return (
    <section className="relative rounded-xl bg-sunken px-4 py-3 pr-10 text-[13.5px]" aria-label={t("headsUp.title")} data-testid="heads-up">
      <IconButton label={t("app.close")} size="xs" className="absolute right-2 top-2" onClick={() => useHeadsUp.getState().dismiss(id)} data-testid="heads-up-close">
        <X className="size-3.5" />
      </IconButton>
      <div className="font-semibold">{t("headsUp.title")}</div>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-muted" data-testid="heads-up-text">
        {text}
      </p>
      {open && detail && (
        <p className="mt-2 whitespace-pre-wrap break-words text-muted" data-testid="heads-up-detail">
          {detail}
        </p>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        {detail && (
          <Button size="xs" variant="outline" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="heads-up-more">
            {t("headsUp.more")}
          </Button>
        )}
        <Button size="xs" variant="outline" loading={busy} onClick={() => void knew()} data-testid="heads-up-known">
          {t("headsUp.known")}
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={t("viz.more")} size="xs" className="data-[state=open]:bg-hover" data-testid="heads-up-menu">
              <Ellipsis className="size-4" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="start" className="min-w-[140px]">
            <MenuItem icon={<Copy className="size-3.5" />} onSelect={() => void copyText(detail ? `${text}\n\n${detail}` : text)}>
              {t("app.copy")}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </section>
  );
}
