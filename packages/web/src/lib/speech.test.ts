import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkText, detectLang, pickVoice, speakMarkdown, speechSupported, stopSpeaking, stripMarkdown } from "./speech";

const voice = (lang: string, over: Partial<SpeechSynthesisVoice> = {}) => ({ lang, name: `v-${lang}`, default: false, localService: true, voiceURI: lang, ...over }) as SpeechSynthesisVoice;

describe("stripMarkdown", () => {
  it("skips fenced code blocks (also an unterminated one) and display math", () => {
    expect(stripMarkdown("Before\n\n```ts\nconst a = 1;\n```\n\nAfter")).toBe("Before\n\nAfter");
    expect(stripMarkdown("Intro\n\n~~~\ncode\n~~~\nOutro")).toBe("Intro\n\nOutro");
    expect(stripMarkdown("Intro\n\n```\nnever closed")).toBe("Intro");
    expect(stripMarkdown("Energy:\n$$E=mc^2$$\ndone")).toBe("Energy:\n\ndone");
  });

  it("drops the markup and keeps the words", () => {
    const md = "# Title\n\n- **bold** and *italic* and ~~gone~~\n1. [a link](https://x.test) and `code`\n> quoted\n\n![img](a.png)text\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const out = stripMarkdown(md);
    expect(out).toContain("Title");
    expect(out).toContain("bold and italic and gone");
    expect(out).toContain("a link and code");
    expect(out).toContain("quoted");
    expect(out).not.toMatch(/[*#`>~[\]]|https?:|---/);
    expect(out).toContain("text");
  });

  it("is empty for a message that is only code", () => {
    expect(stripMarkdown("```\nonly code\n```")).toBe("");
  });
});

describe("language and voice", () => {
  const nav = vi.spyOn(navigator, "language", "get");
  afterEach(() => nav.mockReturnValue("en-US"));

  it("Chinese text gets a Chinese language, Japanese and Korean theirs, anything else the browser's (English for a CJK browser)", () => {
    nav.mockReturnValue("en-US");
    expect(detectLang("你好，今天天气很好。")).toBe("zh-CN");
    expect(detectLang("Use the 文件 menu")).toBe("en-US"); // a few Chinese words in English text
    expect(detectLang("こんにちは、元気ですか")).toBe("ja-JP");
    expect(detectLang("안녕하세요 여러분")).toBe("ko-KR");
    expect(detectLang("Hello there")).toBe("en-US");
    nav.mockReturnValue("fr-FR");
    expect(detectLang("Bonjour")).toBe("fr-FR");
    nav.mockReturnValue("zh-TW");
    expect(detectLang("你好")).toBe("zh-TW");
    expect(detectLang("Hello there")).toBe("en-US");
  });

  it("picks a voice of the language, preferring the exact locale, the default, then an on-device one", () => {
    const voices = [voice("en-GB"), voice("zh-HK", { localService: false }), voice("zh-CN"), voice("zh_CN", { localService: false }), voice("en-US", { default: true })];
    expect(pickVoice("zh-CN", voices)?.lang).toBe("zh-CN");
    expect(pickVoice("zh-TW", voices)?.lang).toBe("zh-CN"); // same language, on-device first
    expect(pickVoice("en-US", voices)?.lang).toBe("en-US");
    expect(pickVoice("ja-JP", voices)).toBeUndefined();
    // network voices (Chrome's "Google …") are never picked: the text would leave the device
    expect(pickVoice("en-US", [voice("en-US", { localService: false, default: true })])).toBeUndefined();
  });
});

describe("chunkText", () => {
  it("packs sentences up to the limit and splits paragraphs", () => {
    expect(chunkText("One. Two. Three.", 220)).toEqual(["One. Two. Three."]);
    expect(chunkText("First paragraph.\n\nSecond paragraph.")).toEqual(["First paragraph.", "Second paragraph."]);
    expect(chunkText("Aaaa. Bbbb. Cccc.", 10)).toEqual(["Aaaa.", "Bbbb.", "Cccc."]);
    expect(chunkText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "xxxxx"]);
  });
});

describe("speakMarkdown", () => {
  class Utterance {
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    lang = "";
    voice: SpeechSynthesisVoice | null = null;
    constructor(public text: string) {}
  }
  const spoken: Utterance[] = [];
  const synth = { speak: vi.fn((u: Utterance) => void spoken.push(u)), cancel: vi.fn(), getVoices: vi.fn(() => [voice("zh-CN"), voice("en-US")]) };

  beforeEach(() => {
    spoken.length = 0;
    synth.speak.mockClear();
    synth.cancel.mockClear();
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  });
  afterEach(() => {
    stopSpeaking();
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
    vi.unstubAllGlobals();
  });

  it("speaks the message without its code, in the voice of its language", () => {
    expect(speechSupported()).toBe(true);
    expect(speakMarkdown("m1", "你好，世界。\n\n```py\nprint(1)\n```")).toBe(true);
    expect(spoken.map((u) => u.text)).toEqual(["你好，世界。"]);
    expect(spoken[0]!.lang).toBe("zh-CN");
    expect(spoken[0]!.voice?.lang).toBe("zh-CN");
  });

  it("refuses to speak when only network voices exist (never leaves the choice to the engine)", () => {
    synth.getVoices.mockReturnValueOnce([voice("en-US", { localService: false, default: true })]);
    expect(speakMarkdown("m9", "Hello there.")).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it("falls back to another on-device voice when none speaks the language", () => {
    synth.getVoices.mockReturnValueOnce([voice("en-US", { default: true }), voice("ja-JP", { localService: false })]);
    expect(speakMarkdown("m10", "こんにちは。")).toBe(true);
    expect(spoken[0]!.voice?.lang).toBe("en-US");
  });

  it("says nothing for a message that is only code, and is a no-op without speech support", () => {
    expect(speakMarkdown("m1", "```\ncode\n```")).toBe(false);
    expect(synth.speak).not.toHaveBeenCalled();
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
    expect(speechSupported()).toBe(false);
    expect(speakMarkdown("m1", "text")).toBe(false);
  });
});
