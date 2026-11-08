import type { CommandInfo, FileEntry } from "@agent-workstation/protocol";
import { ArrowUp, Folder, FolderOpen, Paperclip, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { cancelUpload, ingestFiles, retryUpload } from "../../lib/attachments";
import { cn } from "../../lib/cn";
import { loadCommands } from "../../lib/commands";
import { basename } from "../../lib/format";
import { isBusyStatus } from "../../lib/session-reducer";
import { filterCommands, insertCommand, mentionAtCaret, slashQuery, type SlashMatch } from "../../lib/slash";
import { t, type I18nKey } from "../../i18n";
import { useApp } from "../../store/app";
import { getDraft, getUploads, useComposer } from "../../store/composer";
import { createSession, sendMessage, stopSession } from "../../store/actions";
import { useSessions } from "../../store/sessions";
import { FileCard } from "../ui/FileCard";
import { IconButton } from "../ui/primitives";
import { Tip } from "../ui/overlays";
import { filterMentions, loadMentionIndex, mentionInsertText } from "./mentions";
import { MentionPalette, SlashPalette } from "./Palettes";
import { ContextRing } from "./ContextRing";
import { EffortPicker, ModePicker, ModelPicker } from "./Pickers";
import { NO_AUTOFILL } from "../../lib/noAutofill";

export interface ComposerBlock {
  code: string;
  message?: string;
  /** Local (derived from live state) blocks cannot be retried by the user; response blocks can. */
  retryable: boolean;
  /** Local block the user can re-check after fixing it on the server (API credits on the server): Retry reloads the account state. */
  recheck?: boolean;
}

/** Why sending is currently impossible, if it is. Mirrors the hub's 403/429/503/507 codes. */
export function useComposerBlock(): ComposerBlock | null {
  const me = useApp((s) => s.me);
  const disk = useApp((s) => s.disk);
  const sendBlock = useApp((s) => s.sendBlock);
  if (me && !me.user.enabled) return { code: "user_disabled", retryable: false };
  if (me && me.settings.remoteClaudeEnabled === false) return { code: "remote_disabled", retryable: false };
  // no API key, or a budget of 0, on the server
  if (me && me.apiAvailable === false) return { code: "api_unavailable", retryable: false, recheck: true };
  if (disk?.level === "block" || me?.disk === "block") return { code: "disk_block", retryable: false };
  if (sendBlock) return { code: sendBlock.code, message: sendBlock.message, retryable: true };
  return null;
}

/** Re-read the account (an API key may have been added on the server since the page loaded). */
async function recheckAccount(): Promise<void> {
  try {
    const me = await api.me();
    const app = useApp.getState();
    app.setMe(me);
    if (me.apiAvailable === true && app.sendBlock?.code === "api_unavailable") app.setSendBlock(null);
  } catch {
    /* still blocked: the notice stays */
  }
}

function BlockNotice({ block }: { block: ComposerBlock }) {
  const setSendBlock = useApp((s) => s.setSendBlock);
  const key = `composer.disabled.${block.code}` as I18nKey;
  const known = t(key) !== key;
  const text = known ? t(key) : t("composer.disabled.generic", { error: block.message ?? block.code });
  return (
    <div role="alert" className="mb-2 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] leading-snug" data-testid="composer-blocked" data-code={block.code}>
      <span className="min-w-0 flex-1">{text}</span>
      {block.recheck && (
        <button type="button" className="shrink-0 font-medium text-accent hover:underline" onClick={() => void recheckAccount()} data-testid="composer-recheck">
          {t("app.retry")}
        </button>
      )}
      {block.retryable && (
        <button type="button" className="shrink-0 font-medium text-accent hover:underline" onClick={() => setSendBlock(null)}>
          {t("app.retry")}
        </button>
      )}
    </div>
  );
}

/** The Code session's working directory (read-only): last path segment, the full path in the tooltip. */
function CwdChip({ cwd }: { cwd: string }) {
  const path = cwd.replace(/^\.?\/+|\/+$/g, "");
  const root = path === "" || path === ".";
  return (
    <Tip label={root ? t("sidebar.workspace") : path} side="top">
      <span className="flex h-8 min-w-0 shrink items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted" data-testid="composer-cwd" tabIndex={0}>
        <Folder className="size-3.5 shrink-0" />
        <span className="truncate">{root ? t("sidebar.workspace") : basename(path)}</span>
      </span>
    </Tip>
  );
}

function RemoveTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={t("composer.removeAttachment")}
      onClick={onClick}
      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-sm hover:text-fg"
    >
      <X className="size-3" />
    </button>
  );
}

export interface ComposerProps {
  /** null = new session: it is created lazily on the first send. */
  sessionId: string | null;
  /** Hide model/mode/effort pickers (the macOS app has native ones). */
  hidePickers?: boolean;
  /** Hide the Stop button (native toolbar owns it). */
  hideStop?: boolean;
  className?: string;
}

export function Composer({ sessionId, hidePickers, hideStop, className }: ComposerProps) {
  const navigate = useNavigate();
  const mode = useApp((s) => s.mode);
  const user = useApp((s) => s.user);
  const session = useSessions((s) => (sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId]) : undefined));
  const kind = session?.kind ?? mode;
  const draftKey = sessionId ?? `new:${kind}`;
  const draft = useComposer((s) => getDraft(s.drafts, draftKey));
  const uploads = useComposer((s) => getUploads(s.uploads, draftKey));
  const setText = useComposer((s) => s.setText);
  const removeAttachment = useComposer((s) => s.removeAttachment);
  const focusTick = useComposer((s) => s.focusTick);
  const block = useComposerBlock();
  const busy = isBusyStatus(session?.status);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [cmdLoading, setCmdLoading] = useState(false);
  const [index, setIndex] = useState<FileEntry[]>([]);
  const [indexLoading, setIndexLoading] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const text = draft.text;
  const sq = useMemo(() => slashQuery(text, caret), [text, caret]);
  const mention = useMemo(() => (kind === "code" ? mentionAtCaret(text, caret) : null), [text, caret, kind]);
  const slashOpen = sq !== null && dismissed !== `s:${text}`;
  const mentionOpen = !slashOpen && mention !== null && dismissed !== `m:${text}`;
  const newCwd = useComposer((s) => s.newCwd);
  const mentionCwd = (session ? session.cwd : newCwd) || "";

  // Load palette data lazily.
  useEffect(() => {
    if (!slashOpen) return;
    let cancelled = false;
    setCmdLoading(true);
    loadCommands(sessionId)
      .then((l) => !cancelled && setCommands(l))
      .catch(() => !cancelled && setCommands([]))
      .finally(() => !cancelled && setCmdLoading(false));
    return () => {
      cancelled = true;
    };
  }, [slashOpen, sessionId]);

  useEffect(() => {
    if (!mentionOpen) return;
    let cancelled = false;
    setIndexLoading(true);
    setIndex([]);
    loadMentionIndex(user, mentionCwd)
      .then((l) => !cancelled && setIndex(l))
      .finally(() => !cancelled && setIndexLoading(false));
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, user, mentionCwd]);

  const slashMatches = useMemo(() => (slashOpen ? filterCommands(commands, sq ?? "", 40) : []), [slashOpen, commands, sq]);
  const mentionMatches = useMemo(() => (mentionOpen ? filterMentions(index, mention?.query ?? "") : []), [mentionOpen, index, mention?.query]);
  const paletteCount = slashOpen ? slashMatches.length : mentionOpen ? mentionMatches.length : 0;

  useEffect(() => setActive(0), [sq, mention?.query, slashOpen, mentionOpen]);

  // Autosize
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(260, ta.scrollHeight)}px`;
  }, [text]);

  // Focus on request / when the target session changes
  useEffect(() => {
    taRef.current?.focus();
  }, [focusTick, sessionId]);

  const setCaretFromEl = useCallback(() => setCaret(taRef.current?.selectionStart ?? 0), []);

  const replaceRange = (start: number, end: number, insert: string) => {
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(draftKey, next);
    const pos = start + insert.length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const pickSlash = (m: SlashMatch) => {
    const firstSpace = text.search(/\s/);
    replaceRange(0, firstSpace < 0 ? text.length : firstSpace, insertCommand(m.command).trimEnd() + " ");
  };
  const pickMention = (entry: FileEntry) => {
    if (!mention) return;
    replaceRange(mention.start, mention.end, mentionInsertText(entry));
  };

  // A message waits for its uploads: a failed tile must be retried or removed before sending.
  const canSend = (text.trim().length > 0 || draft.attachments.length > 0) && uploads.length === 0 && !block && !submitting;

  const submit = async () => {
    if (!canSend) return;
    const body = text.trim();
    const attachments = draft.attachments;
    setSubmitting(true);
    useComposer.getState().clear(draftKey);
    setCaret(0);
    let id = sessionId;
    try {
      if (!id) {
        const cs = useComposer.getState();
        const incognito = kind === "chat" && cs.newIncognito;
        const created = await createSession(kind, { cwd: cs.newCwd, settings: cs.newSettings, incognito });
        if (!created) {
          useComposer.getState().restore(draftKey, { text: body, attachments });
          return;
        }
        id = created.id;
      }
      const pending = sendMessage(id, body, attachments);
      if (!sessionId) {
        navigate(`/s/${id}`);
        // the ghost is for one chat: the next "New chat" starts a normal one
        useComposer.getState().setNewIncognito(false);
      }
      const outcome = await pending;
      if (!outcome.ok && outcome.restoreDraft) {
        const key = id;
        useComposer.getState().restore(key === sessionId ? draftKey : key, { text: body, attachments });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (paletteCount > 0 && !composing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % paletteCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + paletteCount) % paletteCount);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (slashOpen) {
          const m = slashMatches[active];
          if (m) pickSlash(m);
        } else {
          const m = mentionMatches[active];
          if (m) pickMention(m.entry);
        }
        return;
      }
    }
    if (e.key === "Escape" && (slashOpen || mentionOpen)) {
      e.preventDefault();
      setDismissed(slashOpen ? `s:${text}` : `m:${text}`);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !composing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !composing) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    void ingestFiles(files, draftKey, kind);
  };

  const showStop = !!sessionId && busy && !hideStop;
  const placeholder = t(kind === "code" ? "composer.placeholder.code" : "composer.placeholder.chat");

  return (
    <div className={cn("shrink-0 px-4 pb-4 pt-1 sm:px-6", className)} data-testid="composer">
      <div className="relative mx-auto w-full max-w-3xl">
        {slashOpen && <SlashPalette matches={slashMatches} active={active} loading={cmdLoading} onPick={pickSlash} onHover={setActive} />}
        {mentionOpen && <MentionPalette entries={mentionMatches} active={active} loading={indexLoading} onPick={(e) => pickMention(e)} onHover={setActive} />}
        {block && <BlockNotice block={block} />}
        {session?.status === "queued" && session.queuePosition != null && (
          <div className="mb-2 text-xs text-muted" data-testid="queue-position">
            {t("composer.queued", { n: session.queuePosition })}
          </div>
        )}
        <div className="@container rounded-2xl border border-line bg-surface shadow-sm transition-colors focus-within:border-accent/70">
          {(draft.attachments.length > 0 || uploads.length > 0) && (
            <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="attachments">
              {draft.attachments.map((a, i) => (
                <div key={a.type === "image" ? `i-${i}` : `f-${a.path}`} className="group/att relative">
                  {a.type === "image" ? (
                    <img src={`data:${a.mediaType};base64,${a.dataBase64}`} alt={a.name ?? "image"} className="size-16 rounded-lg border border-line object-cover" />
                  ) : (
                    <FileCard name={a.name} size={a.size} />
                  )}
                  <RemoveTile onClick={() => removeAttachment(draftKey, i)} />
                </div>
              ))}
              {uploads.map((u) => (
                <div key={u.id} className="group/att relative">
                  <FileCard name={u.name} size={u.size} progress={u.progress} error={u.error} onRetry={() => retryUpload(draftKey, u.id)} />
                  <RemoveTile onClick={() => cancelUpload(draftKey, u.id)} />
                </div>
              ))}
            </div>
          )}
          <textarea {...NO_AUTOFILL}
            ref={taRef}
            value={text}
            rows={1}
            data-testid="composer-input"
            aria-label={placeholder}
            placeholder={placeholder}
            onChange={(e) => {
              setText(draftKey, e.target.value);
              setCaret(e.target.selectionStart);
              setDismissed(null);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={setCaretFromEl}
            onClick={setCaretFromEl}
            onSelect={setCaretFromEl}
            onPaste={onPaste}
            spellCheck
            className="block max-h-[260px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14.5px] leading-relaxed outline-none placeholder:text-subtle"
          />
          <div className="flex min-w-0 items-center gap-0.5 px-2 pb-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              data-testid="composer-file-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) void ingestFiles(files, draftKey, kind);
              }}
            />
            <Tip label={t("composer.attach")} side="top">
              <IconButton label={t("composer.attach")} size="sm" onClick={() => fileRef.current?.click()}>
                <Paperclip className="size-4" />
              </IconButton>
            </Tip>
            {typeof window.__workstationShell?.pickFolder === "function" && (
              <Tip label={t("composer.chooseFolder")} side="top">
                <IconButton label={t("composer.chooseFolder")} size="sm" onClick={() => window.__workstationShell?.pickFolder?.()} data-testid="composer-folder">
                  <FolderOpen className="size-4" />
                </IconButton>
              </Tip>
            )}
            {!hidePickers && (
              <>
                <ModelPicker sessionId={sessionId} />
                {kind === "code" && <ModePicker sessionId={sessionId} />}
                <EffortPicker sessionId={sessionId} kind={kind} />
              </>
            )}
            {kind === "code" && <CwdChip cwd={session ? session.cwd : newCwd} />}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <ContextRing sessionId={sessionId} />
              {showStop && (
                <Tip label={t("composer.stop")} shortcut={t("shortcut.stop")} side="top">
                  <button type="button" onClick={() => void stopSession(sessionId!)} className="flex size-8 items-center justify-center rounded-lg border border-line text-muted hover:bg-hover hover:text-fg" aria-label={t("composer.stop")} data-testid="composer-stop">
                    <Square className="size-3.5 fill-current" />
                  </button>
                </Tip>
              )}
              <Tip label={block ? t(`composer.disabled.${block.code}` as I18nKey) : t("composer.send")} side="top">
                <span>
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={!canSend}
                    aria-label={t("composer.send")}
                    data-testid="composer-send"
                    className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg transition-colors hover:bg-accent-hover disabled:bg-active disabled:text-subtle"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                </span>
              </Tip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
