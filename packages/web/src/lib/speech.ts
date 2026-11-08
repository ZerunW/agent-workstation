import { useSyncExternalStore } from "react";

/** Read aloud: Web Speech `speechSynthesis`, one message at a time. */

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && !!window.speechSynthesis;
}

/** Markdown as plain prose for a voice: code blocks and display math are skipped, the rest loses its markup. */
export function stripMarkdown(md: string): string {
  return (
    md
      .replace(/\r\n?/g, "\n")
      .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, "")
      .replace(/\$\$[\s\S]*?\$\$/g, "")
      .replace(/\\\[[\s\S]*?\\\]/g, "")
      .replace(/<(?:https?:\/\/|mailto:)[^>]*>/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^ {0,3}>[ \t]?/gm, "")
      .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, "")
      .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, "")
      .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "")
      .replace(/^[ \t]*\|/gm, "")
      .replace(/\|/g, ", ")
      .replace(/`([^`\n]*)`/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])([*_])(\S(?:.*?\S)?)\2(?=$|[\s).,;:!?])/g, "$1$3")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** The language to speak a text in: Chinese, Japanese and Korean by script, anything else the browser's language (English when that is CJK). */
export function detectLang(text: string): string {
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  const han = count(/[㐀-䶿一-鿿豈-﫿]/g);
  const kana = count(/[぀-ヿ]/g);
  const hangul = count(/[가-힯]/g);
  const letters = Math.max(1, count(/\p{L}/gu));
  const nav = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
  if (kana > 0 && (kana + han) / letters >= 0.2) return "ja-JP";
  if (hangul / letters >= 0.2) return "ko-KR";
  if (han / letters >= 0.2) return /^zh\b/i.test(nav) ? nav : "zh-CN";
  return /^(zh|ja|ko)\b/i.test(nav) ? "en-US" : nav;
}

const norm = (lang: string) => lang.toLowerCase().replace(/_/g, "-");

/**
 * The voice for a language, on-device voices only (`localService`): network voices (for example Chrome's "Google …"
 * voices) would send the text off the device. Same language, preferring the exact locale, then the default voice.
 */
export function pickVoice(lang: string, voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const want = norm(lang);
  const base = want.split("-")[0]!;
  const same = voices.filter((v) => v.localService && norm(v.lang).split("-")[0] === base);
  const score = (v: SpeechSynthesisVoice) => (norm(v.lang) === want ? 4 : 0) + (v.default ? 2 : 0);
  return [...same].sort((a, b) => score(b) - score(a))[0];
}

/** Pieces short enough for engines that cut long utterances off (Chrome stops after ~15 s): sentences, packed up to `max` characters. */
export function chunkText(text: string, max = 220): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    let cur = "";
    const flush = () => {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    };
    for (const sentence of para.replace(/\n/g, " ").match(/[^.!?。！？;；]+[.!?。！？;；]*\s*/g) ?? []) {
      if (cur && cur.length + sentence.length > max) flush();
      if (sentence.length > max) {
        for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max).trim());
      } else cur += sentence;
    }
    flush();
  }
  return out.filter(Boolean);
}

let current: { id: string; token: number } | null = null;
let token = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function utterance(text: string): SpeechSynthesisUtterance {
  if (typeof SpeechSynthesisUtterance === "function") return new SpeechSynthesisUtterance(text);
  return { text } as SpeechSynthesisUtterance;
}

export function stopSpeaking(): void {
  if (!current) return;
  current = null;
  if (speechSupported()) window.speechSynthesis.cancel();
  notify();
}

/** Stop, but only when this message is the one speaking (its button went away). */
export function stopIfSpeaking(id: string): void {
  if (current?.id === id) stopSpeaking();
}

/** Speak a Markdown message (stopping whatever else speaks). false when there is nothing to say or no speech support. */
export function speakMarkdown(id: string, markdown: string): boolean {
  if (!speechSupported()) return false;
  const chunks = chunkText(stripMarkdown(markdown));
  if (chunks.length === 0) return false;
  const synth = window.speechSynthesis;
  const lang = detectLang(chunks.join(" "));
  const voices = synth.getVoices?.() ?? [];
  // Never leave the choice to the engine: its default may be a network voice.
  const voice = pickVoice(lang, voices) ?? voices.filter((v) => v.localService).sort((a, b) => Number(b.default) - Number(a.default))[0];
  if (!voice) return false;
  synth.cancel();
  const mine = ++token;
  current = { id, token: mine };
  const done = () => {
    if (current?.token !== mine) return;
    current = null;
    synth.cancel();
    notify();
  };
  chunks.forEach((chunk, i) => {
    const u = utterance(chunk);
    u.lang = voice.lang;
    u.voice = voice;
    u.onend = i === chunks.length - 1 ? done : null;
    u.onerror = done;
    synth.speak(u);
  });
  notify();
  return true;
}

/** Whether the message with this id is the one being read aloud. */
export function useSpeaking(id: string): boolean {
  return useSyncExternalStore(subscribe, () => current?.id === id);
}
