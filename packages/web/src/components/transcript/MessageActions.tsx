import type { Session, SessionKind } from "@agent-workstation/protocol";
import { GitFork, Pencil, Pin, PinOff, RotateCcw, Square, Undo2, Volume2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import { formatMessageTime, relativeTime } from "../../lib/format";
import { speakMarkdown, speechSupported, stopIfSpeaking, stopSpeaking, stripMarkdown, useSpeaking } from "../../lib/speech";
import type { TranscriptItem } from "../../lib/transcript";
import { t } from "../../i18n";
import { forkSession, rewindSession, setPinned } from "../../store/actions";
import { useApp } from "../../store/app";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/overlays";
import { CopyButton } from "./CodeBlock";

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>;

/** What the action rows of a transcript need to know about their session. */
export interface MessageCtx {
  sessionId: string;
  kind: SessionKind;
  /** A subagent's child session: no Rewind, no Fork. */
  child: boolean;
  /** The session's folder is a synced project (Rewind can restore its files too). */
  inProject: boolean;
  /** uuids of the pinned messages. */
  pinned: ReadonlySet<string>;
}
export const MessageCtxContext = createContext<MessageCtx | null>(null);
export const useMessageCtx = () => useContext(MessageCtxContext);

// one shared clock for every relative time on the page
const clock = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
let clockNow = Date.now();
const subscribeClock = (fn: () => void) => {
  clock.add(fn);
  if (!clockTimer)
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clock.forEach((f) => f());
    }, 30_000);
  return () => {
    clock.delete(fn);
    if (clock.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
};

/** "2m ago"; the tooltip has the full date and time ("Jan 15, 2026, 9:00 AM"). */
export function MessageTime({ at }: { at: string }) {
  const offset = useApp((s) => s.serverOffsetMs);
  useSyncExternalStore(subscribeClock, () => clockNow);
  return (
    <time dateTime={at} title={formatMessageTime(at)} className="cursor-default whitespace-nowrap px-1 text-[11.5px] tabular-nums" data-testid="message-time">
      {relativeTime(at, Date.now() + (offset || 0))}
    </time>
  );
}

/** Muted icons under a message: on hover of the message (always on touch screens), or while one of them has focus. */
const SHOWN_ON_HOVER = "opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100";

/** `always`: visible without hover (the latest finished turn). */
function ActionRow({ children, mark, className, always }: { children: ReactNode; mark?: ReactNode; className?: string; always?: boolean }) {
  return (
    <div className={cn("mt-1 flex min-h-6 items-center gap-1 text-subtle", className)} data-testid="message-actions" data-always={always ? "true" : undefined}>
      <div className={cn("flex items-center gap-0.5", !always && SHOWN_ON_HOVER)}>{children}</div>
      {mark}
    </div>
  );
}

function ActionButton({ label, onClick, disabled, children, testId }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="inline-flex size-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

const ICON = "size-3.5";

function RewindAction({ ctx, messageUuid }: { ctx: MessageCtx; messageUuid: string }) {
  const [open, setOpen] = useState(false);
  const run = (files: boolean) => {
    setOpen(false);
    void rewindSession(ctx.sessionId, { messageUuid, ...(files ? { files: true } : {}) });
  };
  return (
    <>
      <ActionButton label={t("tx.rewind")} onClick={() => setOpen(true)}>
        <Undo2 className={ICON} />
      </ActionButton>
      {open && (
        <Modal
          open
          onOpenChange={setOpen}
          title={t("tx.rewind.confirm")}
          width="sm"
          hideClose
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("app.cancel")}
              </Button>
              {ctx.inProject && (
                <Button variant="outline" onClick={() => run(true)}>
                  {t("tx.rewind.code")}
                </Button>
              )}
              <Button variant="primary" onClick={() => run(false)}>
                {t("tx.rewind")}
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

function ForkButton({ sessionId, messageUuid, onOpen }: { sessionId: string; messageUuid: string; onOpen: (s: Session) => void }) {
  return (
    <ActionButton
      label={t("tx.fork")}
      onClick={() =>
        void forkSession(sessionId, messageUuid).then((s) => {
          if (s) onOpen(s);
        })
      }
    >
      <GitFork className={ICON} />
    </ActionButton>
  );
}

function RoutedFork(props: { sessionId: string; messageUuid: string }) {
  const navigate = useNavigate();
  return (
    <ForkButton
      {...props}
      onOpen={(s) => {
        useApp.getState().setMode(s.kind);
        navigate(`/s/${s.id}`);
      }}
    />
  );
}

/** Fork opens the new session; without a router around (a bare transcript) there is nowhere to go, the session just exists. */
function ForkAction(props: { sessionId: string; messageUuid: string }) {
  return useInRouterContext() ? <RoutedFork {...props} /> : <ForkButton {...props} onOpen={() => {}} />;
}

function ReadAloud({ id, markdown }: { id: string; markdown: string }) {
  const speaking = useSpeaking(id);
  const speakable = useMemo(() => stripMarkdown(markdown).length > 0, [markdown]);
  useEffect(() => () => stopIfSpeaking(id), [id]);
  if (!speechSupported() || !speakable) return null;
  return (
    <ActionButton label={speaking ? t("tx.stopReading") : t("tx.readAloud")} onClick={() => (speaking ? stopSpeaking() : void speakMarkdown(id, markdown))} testId="read-aloud">
      {speaking ? <Square className={cn(ICON, "fill-current")} /> : <Volume2 className={ICON} />}
    </ActionButton>
  );
}

/** Under a user message. Code: ✓✓ · time · Copy · Rewind · Fork. Chat: time · Retry · Edit · Copy. */
export function UserActions({ item, onEdit }: { item: Item<"user">; onEdit?: () => void }) {
  const ctx = useMessageCtx();
  if (!ctx) return null;
  if (ctx.kind === "chat") {
    return (
      <ActionRow>
        <MessageTime at={item.at} />
        <ActionButton label={t("tx.retry")} onClick={() => void rewindSession(ctx.sessionId, { messageUuid: item.uuid, resend: {} })}>
          <RotateCcw className={ICON} />
        </ActionButton>
        {onEdit && (
          <ActionButton label={t("tx.edit")} onClick={onEdit}>
            <Pencil className={ICON} />
          </ActionButton>
        )}
        <CopyButton text={item.text} />
      </ActionRow>
    );
  }
  return (
    <ActionRow>
      <span className="px-0.5 text-[11px] tracking-[-0.15em]" title={t("tx.delivered")} role="img" aria-label={t("tx.delivered")} data-testid="delivered">
        ✓✓
      </span>
      <MessageTime at={item.at} />
      <CopyButton text={item.text} />
      {!ctx.child && <RewindAction ctx={ctx} messageUuid={item.uuid} />}
      {!ctx.child && <ForkAction sessionId={ctx.sessionId} messageUuid={item.uuid} />}
    </ActionRow>
  );
}

/** Under the final text of a turn. Code: Copy · Fork · Pin/Unpin · Read aloud · time. Chat: Copy · Read aloud · Retry · time. */
export function AssistantActions({ item, userUuid, latest }: { item: Item<"assistant">; userUuid: string | null; latest?: boolean }) {
  const ctx = useMessageCtx();
  if (!ctx || !item.finalText) return null;
  const pins = item.uuids.filter((u) => ctx.pinned.has(u));
  const pinned = pins.length > 0;
  if (ctx.kind === "chat") {
    return (
      <ActionRow always={latest}>
        <CopyButton text={item.finalText} />
        <ReadAloud id={`${ctx.sessionId}:${item.key}`} markdown={item.finalText} />
        {userUuid && (
          <ActionButton label={t("tx.retry")} onClick={() => void rewindSession(ctx.sessionId, { messageUuid: userUuid, resend: {} })}>
            <RotateCcw className={ICON} />
          </ActionButton>
        )}
        <MessageTime at={item.at} />
      </ActionRow>
    );
  }
  return (
    <ActionRow always={latest} mark={pinned ? <Pin className="size-3 shrink-0 fill-current text-muted" role="img" aria-label={t("tx.pinned")} data-testid="pin-mark" /> : undefined}>
      <CopyButton text={item.finalText} />
      {!ctx.child && <ForkAction sessionId={ctx.sessionId} messageUuid={item.uuid} />}
      <ActionButton
        label={pinned ? t("tx.unpin") : t("tx.pin")}
        onClick={() => {
          if (pinned) for (const u of pins) void setPinned(ctx.sessionId, u, false);
          else void setPinned(ctx.sessionId, item.uuid, true);
        }}
      >
        {pinned ? <PinOff className={ICON} /> : <Pin className={ICON} />}
      </ActionButton>
      <ReadAloud id={`${ctx.sessionId}:${item.key}`} markdown={item.finalText} />
      <MessageTime at={item.at} />
    </ActionRow>
  );
}
