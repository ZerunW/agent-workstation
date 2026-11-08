/**
 * Search across a user's sessions (both kinds; incognito and hidden sessions are never indexed).
 *
 * Keyword (GET /api/search): SQLite FTS5 with the trigram tokenizer over search_docs (session titles and the plain
 * text of user/assistant messages, kept current by Store on append / rename / delete). Every term must match:
 * terms of 3+ characters through the FTS index (substring match, CJK included, case- and diacritic-insensitive),
 * shorter terms (2-character CJK words, "UI") with LIKE. Without FTS5 every term uses LIKE. When fewer than `limit`
 * sessions match exactly, a fuzzy pass (FTS5 OR over the term's trigrams, then word-level trigram similarity ≥ 0.5)
 * adds near misses ("kubernets" → "Kubernetes") after the exact hits. One hit per session: its newest matching
 * message (or the title), with a snippet that marks the matches with « » (word-character terms as whole words, CJK
 * and other terms as substrings).
 *
 * Relevant (GET /api/search/relevant): Claude Haiku (helper.ts) picks the best matches for the query from a compact list of
 * the user's newest sessions (number, date, title, summary — the title and first message when there is no summary
 * yet), answering a JSON array of {id, reason}. Ids are validated against the list; results are cached per (user,
 * normalized query, Store.searchVersion) for 10 minutes. The call is billed in api_requests (purpose `search`).
 */
import type { RelevantSearchResponse, SearchHit, Session } from "@agent-workstation/protocol";
import type { SessionRow, Store } from "../db/store.js";
import { HttpError } from "../util/errors.js";
import type { Logger } from "../util/log.js";
import { HELPER_MODEL } from "../sessions/models.js";
import { HELPER_PROMPT_MAX_BYTES, type HelperRunner } from "../helper.js";
import { messagePlainText } from "./text.js";

export const KEYWORD_DEFAULT_LIMIT = 20;
export const RELEVANT_DEFAULT_LIMIT = 10;
/** How many of the newest sessions relevant search shows the helper model. */
export const RELEVANT_MAX_SESSIONS = 400;
const RELEVANT_CACHE_MS = 10 * 60_000;
const CANDIDATE_ROWS = 3000;

export interface SearchDeps {
  store: Store;
  toSession: (row: SessionRow) => Session;
  /** Runs one helper prompt (null = no helper). */
  helper: HelperRunner | null;
  helperAvailable: () => boolean;
  helperUnavailableReason: () => string;
  log: Logger;
  clock?: () => number;
}

interface DocHit {
  session_id: string;
  seq: number;
  role: string;
  at: string;
  text: string;
}

// ------------------------------------------------------------------ text helpers

/** Lowercased, diacritic-free copy of `text` plus, for every char of it, the index in `text` it came from. */
function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

const foldTerm = (t: string): string => fold(t).folded;

/** Query → distinct terms (whitespace-separated, quotes stripped, at most 8). */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const raw of q.split(/\s+/)) {
    const t = raw.replace(/^["'“”«»]+|["'“”«»]+$/g, "").trim();
    if (!t || out.includes(t)) continue;
    out.push(t.slice(0, 100));
    if (out.length >= 8) break;
  }
  return out;
}

const charLen = (s: string): number => [...s].length;

/** CJK scripts: no spaces between words, so they never form word boundaries and always match as substrings. */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** A character that continues a word (letters, digits, underscore; CJK characters do not). */
const isWordChar = (ch: string | undefined): boolean => !!ch && /^[\p{L}\p{N}\p{M}_]$/u.test(ch) && !CJK_RE.test(ch);
/** Terms made only of word characters (no CJK) are highlighted as whole words, everything else as substrings. */
const isWordTerm = (t: string): boolean => [...t].every((ch) => isWordChar(ch));

/** The code point just before UTF-16 index `i` of `s` (undefined at the start). */
function charBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const lo = s.charCodeAt(i - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s[i - 1];
}
/** The code point starting at UTF-16 index `i` of `s` (undefined at the end). */
const charAt = (s: string, i: number): string | undefined => (i < s.length ? String.fromCodePoint(s.codePointAt(i)!) : undefined);

/**
 * A snippet needle: `word` = highlight whole-word occurrences only (falling back to occurrences at the start of a word
 * for terms of 3+ characters when the text has no whole-word occurrence), `substring` = every occurrence. A plain
 * string picks `word` for word-character terms and `substring` for CJK and other terms.
 */
export type SnippetNeedle = string | { text: string; mode: "word" | "substring" };

/**
 * A window of `text` around the first highlighted match, with every highlighted match wrapped in « ». When nothing can
 * be highlighted (e.g. a word term that only occurs inside longer words) the window is centred on its first raw
 * occurrence, unmarked.
 */
export function makeSnippet(text: string, needles: SnippetNeedle[], radius = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const { folded, map } = fold(clean);
  const byText = new Map<string, "word" | "substring">();
  for (const n of needles) {
    const raw = typeof n === "string" ? n : n.text;
    const f = foldTerm(raw);
    if (!f) continue;
    const mode = typeof n === "string" ? (isWordTerm(f) ? "word" : "substring") : n.mode === "word" && isWordTerm(f) ? "word" : "substring";
    // The same term asked both ways highlights as a substring (the looser of the two).
    byText.set(f, byText.get(f) === "substring" ? "substring" : mode);
  }
  const ns = [...byText.entries()].sort((a, b) => b[0].length - a[0].length);
  const ranges: [number, number][] = [];
  let firstRaw: [number, number] | null = null;
  const occurrences = (n: string): number[] => {
    const out: number[] = [];
    for (let from = 0; ; ) {
      const at = folded.indexOf(n, from);
      if (at < 0) break;
      out.push(at);
      from = at + n.length;
    }
    return out;
  };
  for (const [n, mode] of ns) {
    const all = occurrences(n);
    if (all.length && (!firstRaw || map[all[0]!]! < firstRaw[0])) firstRaw = [map[all[0]!]!, map[all[0]! + n.length]!];
    let hits = all;
    if (mode === "word") {
      const starts = all.filter((at) => !isWordChar(charBefore(folded, at)));
      const whole = starts.filter((at) => !isWordChar(charAt(folded, at + n.length)));
      hits = whole.length ? whole : charLen(n) >= 3 ? starts : [];
    }
    for (const at of hits) {
      const s = map[at]!;
      const e = map[at + n.length]!;
      if (!ranges.some(([a, b]) => s < b && e > a)) ranges.push([s, e]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0] ?? firstRaw;
  let start = first ? Math.max(0, first[0] - radius) : 0;
  let end = first ? Math.min(clean.length, first[1] + Math.round(radius * 1.5)) : Math.min(clean.length, radius * 2);
  // Do not cut a surrogate pair in half.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(clean[start] ?? "")) start--;
  if (end < clean.length && /[\uDC00-\uDFFF]/.test(clean[end] ?? "")) end++;
  let out = "";
  let pos = start;
  for (const [s, e] of ranges) {
    if (e <= start || s >= end) continue;
    const a = Math.max(s, start);
    const b = Math.min(e, end);
    out += clean.slice(pos, a) + "«" + clean.slice(a, b) + "»";
    pos = b;
  }
  out += clean.slice(pos, end);
  return (start > 0 ? "…" : "") + out + (end < clean.length ? "…" : "");
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const cps = [...s];
  for (let i = 0; i + 3 <= cps.length; i++) out.add(cps.slice(i, i + 3).join(""));
  return out;
}

/** Dice coefficient of the trigram sets of two (folded) words. */
function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

/** Terms the fuzzy pass handles: Latin letters / digits, 4+ characters (CJK has no typo-friendly word boundaries). */
const fuzzyEligible = (t: string): boolean => charLen(t) >= 4 && /^[\p{Script=Latin}\d_.-]+$/u.test(t);

/** The word of `text` most similar to `term` (≥ 0.5), or null. */
function fuzzyWord(text: string, term: string): string | null {
  const ft = foldTerm(term);
  let best: { word: string; score: number } | null = null;
  for (const w of text.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (Math.abs(charLen(w) - charLen(ft)) > 3) continue;
    const score = similarity(foldTerm(w), ft);
    if (score >= 0.5 && (!best || score > best.score)) best = { word: w, score };
  }
  return best?.word ?? null;
}

const likeArg = (t: string): string => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const ftsPhrase = (t: string): string => `"${t.replace(/"/g, '""')}"`;
const normalizeQuery = (q: string): string => q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const dateOf = (iso: string): string => iso.slice(0, 10);

// ------------------------------------------------------------------ service

export class SearchService {
  private readonly cache = new Map<string, { at: number; picks: { id: string; reason: string }[] }>();
  private readonly inflight = new Map<string, Promise<{ id: string; reason: string }[]>>();
  private building: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: SearchDeps) {}

  private now(): number {
    return (this.deps.clock ?? Date.now)();
  }

  /** The session if it may appear in `user`'s results. */
  private visible(user: string, id: string): SessionRow | null {
    const row = this.deps.store.getSession(id);
    return row && row.user === user && !row.hidden && !row.incognito && !row.parentSessionId ? row : null;
  }

  // ---------------------------------------------------------------- index build

  /**
   * Builds the index for data that predates it (or after a SEARCH_INDEX_VERSION bump), in the background: one session
   * per macrotask, newest first. Appends during the build are safe (a session is re-indexed in one transaction).
   */
  startBuild(version: number): Promise<void> {
    if (this.building) return this.building;
    const store = this.deps.store;
    if (store.kvGet<number>("search_index_version") === version) return Promise.resolve();
    this.building = (async () => {
      const ids = store.indexableSessionIds();
      let docs = 0;
      const started = Date.now();
      const yieldNow = () => new Promise((r) => setImmediate(r));
      for (const id of ids) {
        if (this.stopped) return;
        try {
          const row = store.resetSessionDocs(id);
          // One page of messages per macrotask: a huge session never blocks the event loop for long.
          for (let after = 0; row && !this.stopped; ) {
            const page = store.listMessages(id, after, 200);
            if (!page.length) break;
            docs += store.indexMessages(row, page);
            after = page[page.length - 1]!.seq;
            await yieldNow();
          }
        } catch (err) {
          this.deps.log.warn({ sessionId: id, err: String(err) }, "search index: could not index a session");
        }
        await yieldNow();
      }
      if (this.stopped) return;
      store.kvSet("search_index_version", version);
      this.deps.log.info({ sessions: ids.length, docs, ms: Date.now() - started, fts: store.fts }, "search index built");
    })().finally(() => (this.building = null));
    return this.building;
  }

  stop(): void {
    this.stopped = true;
  }

  // ---------------------------------------------------------------- keyword

  keyword(user: string, q: string, limit = KEYWORD_DEFAULT_LIMIT): SearchHit[] {
    const terms = queryTerms(q);
    if (!terms.length) return [];
    const store = this.deps.store;
    const long = terms.filter((t) => charLen(t) >= 3);
    const short = terms.filter((t) => charLen(t) < 3);
    let rows: DocHit[];
    if (store.fts && long.length) {
      const sql = `SELECT d.session_id, d.seq, d.role, d.at, d.text FROM search_fts JOIN search_docs d ON d.id = search_fts.rowid
                   WHERE search_fts MATCH ? AND d.user = ? ${short.map(() => "AND d.text LIKE ? ESCAPE '\\'").join(" ")}
                   ORDER BY d.at DESC, d.seq DESC LIMIT ?`;
      rows = store.db.prepare(sql).all(long.map(ftsPhrase).join(" AND "), user, ...short.map(likeArg), CANDIDATE_ROWS) as DocHit[];
      // FTS5 folds case and diacritics; LIKE (short terms) is case-insensitive for ASCII only.
    } else {
      const sql = `SELECT d.session_id, d.seq, d.role, d.at, d.text FROM search_docs d
                   WHERE d.user = ? ${terms.map(() => "AND d.text LIKE ? ESCAPE '\\'").join(" ")} ORDER BY d.at DESC, d.seq DESC LIMIT ?`;
      rows = store.db.prepare(sql).all(user, ...terms.map(likeArg), CANDIDATE_ROWS) as DocHit[];
    }
    const hits = this.toHits(user, rows, limit, (d) => makeSnippet(d.text, terms));
    if (hits.length < limit && store.fts) {
      const seen = new Set(hits.map((h) => h.session.id));
      hits.push(...this.fuzzy(user, terms, limit - hits.length, seen));
    }
    return hits;
  }

  /** One hit per session (rows are newest first), skipping sessions the user may not see. */
  private toHits(user: string, rows: DocHit[], limit: number, snippet: (d: DocHit) => string, skip: Set<string> = new Set()): SearchHit[] {
    const out: SearchHit[] = [];
    const done = new Set<string>(skip);
    for (const d of rows) {
      if (out.length >= limit) break;
      if (done.has(d.session_id)) continue;
      done.add(d.session_id);
      const row = this.visible(user, d.session_id);
      if (!row) continue;
      out.push({ session: this.deps.toSession(row), snippet: snippet(d), at: d.seq === 0 ? row.lastActiveAt : d.at });
    }
    return out;
  }

  private fuzzy(user: string, terms: string[], limit: number, skip: Set<string>): SearchHit[] {
    const fuzzyTerms = terms.filter(fuzzyEligible);
    if (!fuzzyTerms.length || limit <= 0) return [];
    const grams = [...new Set(fuzzyTerms.flatMap((t) => [...trigrams(foldTerm(t))]))].slice(0, 48);
    if (!grams.length) return [];
    let rows: DocHit[];
    try {
      rows = this.deps.store.db
        .prepare(
          `SELECT d.session_id, d.seq, d.role, d.at, d.text FROM search_fts JOIN search_docs d ON d.id = search_fts.rowid
           WHERE search_fts MATCH ? AND d.user = ? ORDER BY rank LIMIT 500`,
        )
        .all(grams.map(ftsPhrase).join(" OR "), user) as DocHit[];
    } catch (err) {
      this.deps.log.debug({ err: String(err) }, "fuzzy search failed");
      return [];
    }
    const matched: (DocHit & { words: SnippetNeedle[] })[] = [];
    for (const d of rows) {
      const folded = foldTerm(d.text);
      // Exact terms highlight like keyword hits; words that only matched fuzzily highlight as substrings.
      const words: SnippetNeedle[] = [];
      let ok = true;
      for (const t of terms) {
        if (folded.includes(foldTerm(t))) {
          words.push(t);
          continue;
        }
        const w = fuzzyEligible(t) ? fuzzyWord(d.text, t) : null;
        if (!w) {
          ok = false;
          break;
        }
        words.push({ text: w, mode: "substring" });
      }
      if (ok) matched.push({ ...d, words });
    }
    matched.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return this.toHits(user, matched, limit, (d) => makeSnippet(d.text, (d as DocHit & { words: SnippetNeedle[] }).words), skip);
  }

  // ---------------------------------------------------------------- relevant

  /** Summary of a session, else its title and first message (what relevant search and the tools show). */
  sessionBlurb(row: SessionRow): { text: string; isSummary: boolean } {
    const s = this.deps.store.getSummary(row.id);
    if (s?.summary) return { text: s.summary, isSummary: true };
    const first = this.deps.store.firstUserText(row.id) ?? this.firstUserFromMessages(row.id);
    return { text: first ? first.replace(/\s+/g, " ").trim().slice(0, 300) : "", isSummary: false };
  }

  private firstUserFromMessages(sessionId: string): string | null {
    for (const m of this.deps.store.listMessages(sessionId, 0, 50)) {
      if (m.kind !== "user") continue;
      const t = messagePlainText("user", m.payload);
      if (t) return t.text;
    }
    return null;
  }

  async relevant(user: string, q: string, limit = RELEVANT_DEFAULT_LIMIT): Promise<RelevantSearchResponse> {
    if (!this.deps.helper || !this.deps.helperAvailable()) throw new HttpError(503, "api_unavailable", this.deps.helperUnavailableReason());
    const key = `${user}\u0000${normalizeQuery(q)}\u0000${limit}\u0000${this.deps.store.searchVersion(user)}`;
    const now = this.now();
    for (const [k, v] of this.cache) if (now - v.at > RELEVANT_CACHE_MS) this.cache.delete(k);
    const hit = this.cache.get(key);
    if (hit) return { hits: this.relevantHits(user, hit.picks), model: HELPER_MODEL, cached: true };
    let p = this.inflight.get(key);
    if (!p) {
      p = this.rank(user, q, limit).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const picks = await p;
    this.cache.set(key, { at: this.now(), picks });
    return { hits: this.relevantHits(user, picks), model: HELPER_MODEL, cached: false };
  }

  private relevantHits(user: string, picks: { id: string; reason: string }[]): SearchHit[] {
    const out: SearchHit[] = [];
    for (const p of picks) {
      const row = this.visible(user, p.id);
      if (!row) continue;
      const blurb = this.sessionBlurb(row);
      out.push({ session: this.deps.toSession(row), snippet: blurb.text || null, at: row.lastActiveAt, ...(p.reason ? { reason: p.reason } : {}) });
    }
    return out;
  }

  /** Asks the helper model; returns validated picks (session id + reason), best first. */
  private async rank(user: string, q: string, limit: number): Promise<{ id: string; reason: string }[]> {
    const rows = this.deps.store.listSessions(user).slice(0, RELEVANT_MAX_SESSIONS);
    if (!rows.length) return [];
    const { prompt, listed } = buildRelevantPrompt(q, limit, rows.map((r) => ({ row: r, blurb: this.sessionBlurb(r).text })));
    const out = await this.deps.helper!(prompt, { purpose: "search", user });
    if (!out.ok) throw new HttpError(502, "search_failed", `Could not rank your conversations: ${out.error ?? "no answer"}`);
    return parseRelevantAnswer(out.text, listed, limit);
  }
}

/**
 * The relevant-search prompt: the query and a numbered list (newest first) that fits the prompt budget. Returns the
 * session ids in list order (index 0 = number 1).
 */
export function buildRelevantPrompt(q: string, limit: number, sessions: { row: SessionRow; blurb: string }[]): { prompt: string; listed: string[] } {
  const head = [
    "You help a person find their own past conversations with AI assistants.",
    `Pick the conversations from the list below that best match what they are looking for: at most ${limit}, best match first, only ones that really match (an empty list is fine).`,
    'Answer with a JSON array only, no other text: [{"id": <the conversation\'s number>, "reason": "<one short sentence: why it matches>"}]. Write the reasons in the language of the query.',
    "",
    `What they are looking for: ${q.trim()}`,
    "",
    "Conversations (number. [date] (kind) title — summary):",
  ].join("\n");
  const budget = HELPER_PROMPT_MAX_BYTES - Buffer.byteLength(head, "utf8") - 512;
  const lines: string[] = [];
  const listed: string[] = [];
  let used = 0;
  for (const { row, blurb } of sessions) {
    const title = row.title.replace(/\s+/g, " ").trim().slice(0, 120);
    const text = blurb.replace(/\s+/g, " ").trim().slice(0, 400);
    const line = `${listed.length + 1}. [${dateOf(row.lastActiveAt)}] (${row.kind}) ${title}${text ? ` — ${text}` : ""}`;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (used + bytes > budget) break;
    used += bytes;
    lines.push(line);
    listed.push(row.id);
  }
  return { prompt: `${head}\n${lines.join("\n")}\n`, listed };
}

/** Parses the helper's answer: a JSON array of {id, reason}; ids are list numbers (or session ids); invalid ones are dropped. */
export function parseRelevantAnswer(text: string, listed: string[], limit: number): { id: string; reason: string }[] {
  const body = text.replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  let items: unknown = null;
  if (start >= 0 && end > start) {
    try {
      items = JSON.parse(body.slice(start, end + 1));
    } catch {
      items = null;
    }
  }
  if (!Array.isArray(items)) {
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      items = Array.isArray(obj.results) ? obj.results : Array.isArray(obj.matches) ? obj.matches : null;
    } catch {
      items = null;
    }
  }
  if (!Array.isArray(items)) return [];
  const out: { id: string; reason: string }[] = [];
  for (const it of items) {
    if (out.length >= limit) break;
    const o = (it && typeof it === "object" ? it : { id: it }) as { id?: unknown; reason?: unknown };
    let id: string | null = null;
    const n = typeof o.id === "number" ? o.id : typeof o.id === "string" && /^\d+$/.test(o.id.trim()) ? Number(o.id) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= listed.length) id = listed[n - 1]!;
    else if (typeof o.id === "string" && listed.includes(o.id.trim())) id = o.id.trim();
    if (!id || out.some((x) => x.id === id)) continue;
    const reason = typeof o.reason === "string" ? o.reason.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    out.push({ id, reason });
  }
  return out;
}
