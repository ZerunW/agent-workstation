import type { StoredMessage } from "@agent-workstation/protocol";
import { stripMarkdown } from "./speech";
import { buildTranscript } from "./transcript";

export interface PinnedEntry {
  uuid: string;
  /** First line of the message. */
  line: string;
}

/** The pinned messages that are loaded, in pin order, each with the first line of its text. */
export function pinnedEntries(messages: readonly StoredMessage[], pinned: readonly string[] | undefined): PinnedEntry[] {
  if (!pinned || pinned.length === 0) return [];
  const { items } = buildTranscript(messages);
  const out: PinnedEntry[] = [];
  for (const uuid of pinned) {
    for (const it of items) {
      if (it.kind === "user" ? it.uuid !== uuid : it.kind === "assistant" ? !it.uuids.includes(uuid) : true) continue;
      const text = it.kind === "user" ? it.text : it.kind === "assistant" ? it.finalText : "";
      const line = stripMarkdown(text).split("\n").find((l) => l.trim()) ?? "";
      out.push({ uuid, line: line.trim() });
      break;
    }
  }
  return out;
}

/** Scroll the transcript to the message with this uuid; false when it is not on the page (older page not loaded). */
export function scrollToMessage(uuid: string): boolean {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-uuids]"))) {
    if (!el.dataset.uuids?.split(" ").includes(uuid)) continue;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("msg-flash");
    void el.offsetWidth; // restart the animation when the same message is picked twice
    el.classList.add("msg-flash");
    setTimeout(() => el.classList.remove("msg-flash"), 1500);
    return true;
  }
  return false;
}
