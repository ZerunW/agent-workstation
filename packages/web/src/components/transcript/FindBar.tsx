import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { clearHighlights, findMatches, paintHighlights } from "../../lib/find";
import { t } from "../../i18n";

const DEBOUNCE_MS = 120;

/**
 * ⌘F inside a session: a bar at the top of the transcript. Searches the rendered text of the whole session (older pages
 * are loaded first), highlights every match and scrolls to the current one. Enter / Shift+Enter walk the matches, Esc closes.
 */
export function FindBar({
  rootRef,
  focusTick,
  earlier,
  loadingEarlier,
  messageCount,
  onLoadEarlier,
  onApply,
  onClose,
}: {
  /** The element whose text is searched. */
  rootRef: RefObject<HTMLElement>;
  /** Changes when ⌘F is pressed again: focus and select the input. */
  focusTick: number;
  earlier: boolean;
  loadingEarlier: boolean;
  messageCount: number;
  onLoadEarlier: () => void;
  /** The query being searched (after the typing pause), "" when none; folded tool groups open from it. */
  onApply: (query: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const indexRef = useRef(0);
  const scrollNext = useRef(true);
  indexRef.current = index;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  useEffect(() => {
    const q = input.trim() === "" ? "" : input;
    if (q === query) return;
    const id = setTimeout(() => {
      scrollNext.current = true;
      setIndex(0);
      setQuery(q);
      onApply(q);
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input, query, onApply]);

  // Older pages first (one at a time; a request that added nothing is not repeated).
  const lastTry = useRef(-1);
  useEffect(() => {
    if (!query || !earlier || loadingEarlier || lastTry.current === messageCount) return;
    lastTry.current = messageCount;
    onLoadEarlier();
  }, [query, earlier, loadingEarlier, messageCount, onLoadEarlier]);

  const observer = useRef<MutationObserver | null>(null);
  const scan = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    clearHighlights(root);
    const found = query ? findMatches(root, query) : [];
    const current = Math.min(indexRef.current, Math.max(0, found.length - 1));
    const target = found.length ? paintHighlights(root, found, current) : null;
    // what the painting itself changed in the DOM is not a reason to scan again
    observer.current?.takeRecords();
    setCount(found.length);
    if (current !== indexRef.current) setIndex(current);
    if (scrollNext.current && found.length) {
      scrollNext.current = false;
      target?.scrollIntoView({ block: "center" });
    }
  }, [rootRef, query]);

  // The query or the current match changed, or the transcript did (streaming, folded groups opening, older pages).
  useEffect(() => {
    scan();
  }, [scan, index]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof MutationObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(scan, 60);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    observer.current = mo;
    return () => {
      clearTimeout(timer);
      mo.disconnect();
      observer.current = null;
    };
  }, [rootRef, scan]);
  useEffect(() => () => clearHighlights(rootRef.current), [rootRef]);

  const go = (step: 1 | -1) => {
    if (count === 0) return;
    scrollNext.current = true;
    setIndex((i) => (Math.min(i, count - 1) + step + count) % count);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    }
  };

  const btn = "inline-flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40";
  return (
    <div
      role="search"
      onKeyDown={onKeyDown}
      className="anim-pop absolute right-4 top-2 z-20 flex items-center gap-1 rounded-lg border border-line bg-surface py-1 pl-2.5 pr-1 shadow-[var(--shadow-pop)]"
      data-testid="find-bar"
    >
      <Search className="size-3.5 shrink-0 text-subtle" aria-hidden />
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t("find.placeholder")}
        aria-label={t("find.placeholder")}
        spellCheck={false}
        autoComplete="off"
        className="h-6 w-44 bg-transparent px-1 text-[13px] outline-none placeholder:text-subtle"
        data-testid="find-input"
      />
      <span className="min-w-[2.75rem] text-right text-[11.5px] tabular-nums text-subtle" data-testid="find-count" aria-live="polite">
        {count > 0 ? `${Math.min(index, count - 1) + 1}/${count}` : query ? "0/0" : ""}
      </span>
      <button type="button" className={btn} title={t("find.prev")} aria-label={t("find.prev")} disabled={count === 0} onClick={() => go(-1)}>
        <ChevronUp className="size-4" />
      </button>
      <button type="button" className={btn} title={t("find.next")} aria-label={t("find.next")} disabled={count === 0} onClick={() => go(1)}>
        <ChevronDown className="size-4" />
      </button>
      <button type="button" className={btn} title={t("find.close")} aria-label={t("find.close")} onClick={onClose}>
        <X className="size-4" />
      </button>
    </div>
  );
}
