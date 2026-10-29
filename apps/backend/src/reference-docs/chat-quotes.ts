import {
  REVIEW_DOC_QUOTE_MAX_CHARS,
  REVIEW_DOC_QUOTE_MIN_CHARS,
  foldForQuote,
  quoteAppearsInFolded,
  type ReferenceDocCitation,
} from '@pierre-review/shared';
import { parseLibraryPath } from './paths.js';
import { markdownLinks } from './render.js';
import { groundingTextOf } from './review-refs.js';
import type { DocRow } from './store.js';

// THE QUOTE BESIDE A CHAT LINK (docs/REFERENCE-DOCS.md § The chat). A chat answer cites a section with
// a markdown link and usually quotes the passage right beside it: `*"…"* ([Refunds](slug/sections/…))`,
// or a `> "…"` blockquote just above the line. These are the CANDIDATES for that link's quote, nearest
// first; the caller keeps the first one the SAME check reviews use (`quoteAppearsIn`) passes against
// that section, and drops the rest. An unchecked quote is never stored, so it is never highlighted.
//
// ⚠ Model output is untrusted text: every scan here is indexOf / a single character walk — no RegExp
// that could backtrack over it.

/** At most this many candidates are tried per link (each is a fold of the section). */
export const CHAT_QUOTE_CANDIDATES_MAX = 8;

const OPEN_TO_CLOSE: Record<string, string> = { '"': '"”', '“': '”"' };

interface Span {
  text: string;
  start: number;
  end: number;
}

/** Quoted spans ("…" or “…”) inside [from, to), in order. An unclosed quote ends the scan. */
export function quotedSpans(text: string, from: number, to: number): Span[] {
  const out: Span[] = [];
  let i = from;
  while (i < to) {
    const ch = text[i]!;
    const closers = OPEN_TO_CLOSE[ch];
    if (closers == null) {
      i += 1;
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < to; j += 1) {
      if (closers.includes(text[j]!)) {
        close = j;
        break;
      }
      if (text[j] === '\n' && text[j + 1] === '\n') break; // never across a blank line
    }
    if (close < 0) break;
    out.push({ text: text.slice(i + 1, close), start: i, end: close + 1 });
    i = close + 1;
  }
  return out;
}

/** [start, end) of the paragraph (blank-line-delimited block) holding `at`. */
function blockAround(text: string, at: number): [number, number] {
  const before = text.lastIndexOf('\n\n', at);
  const after = text.indexOf('\n\n', at);
  return [before < 0 ? 0 : before + 2, after < 0 ? text.length : after];
}

/** A block's text when every line of it is a `>` blockquote line, markers stripped; else null. */
function blockquoteText(text: string, start: number, end: number): string | null {
  const lines = text.slice(start, end).split('\n');
  const kept: string[] = [];
  for (const l of lines) {
    const t = l.trimStart();
    if (t === '') continue;
    if (!t.startsWith('>')) return null;
    kept.push(t.slice(1).trim());
  }
  return kept.length > 0 ? kept.join(' ') : null;
}

/** Strip one pair of surrounding quotation marks and emphasis (`*"…"*`). */
function unwrap(s: string): string {
  let t = s.trim();
  for (let k = 0; k < 3; k += 1) {
    const a = t[0];
    const b = t[t.length - 1];
    if (t.length >= 2 && ((a === '*' && b === '*') || (a === '_' && b === '_') || (a === '"' && b === '"') || (a === '“' && b === '”'))) {
      t = t.slice(1, -1).trim();
    } else break;
  }
  return t;
}

const distance = (s: Span, start: number, end: number): number => (s.end <= start ? start - s.end : s.start >= end ? s.start - end : 0);

/** The link at [start, end)'s candidate quotes, nearest first, de-duplicated, at most the cap. */
export function quoteCandidates(text: string, start: number, end: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const t = clipQuote(unwrap(raw));
    if (t === '' || seen.has(t) || out.length >= CHAT_QUOTE_CANDIDATES_MAX) return;
    seen.add(t);
    out.push(t);
  };
  // The same line first, then the rest of its paragraph — nearest first within each.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEndRaw = text.indexOf('\n', end);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const [bStart, bEnd] = blockAround(text, start);
  const inBlock = quotedSpans(text, bStart, bEnd).filter((s) => s.end <= start || s.start >= end);
  const byNear = (a: Span, b: Span): number => distance(a, start, end) - distance(b, start, end);
  for (const s of inBlock.filter((x) => x.start >= lineStart && x.end <= lineEnd).sort(byNear)) add(s.text);
  for (const s of inBlock.filter((x) => x.start < lineStart || x.end > lineEnd).sort(byNear)) add(s.text);
  // The block itself when it is a blockquote holding the link; then a blockquote just before, then
  // just after.
  const own = blockquoteText(text, bStart, bEnd);
  if (own != null) add(own);
  if (bStart >= 3) {
    const [pStart, pEnd] = blockAround(text, bStart - 3);
    const prev = blockquoteText(text, pStart, pEnd);
    if (prev != null) {
      for (const s of quotedSpans(text, pStart, pEnd)) add(s.text);
      add(prev);
    }
  }
  if (bEnd < text.length) {
    const [nStart, nEnd] = blockAround(text, Math.min(text.length, bEnd + 2));
    const next = blockquoteText(text, nStart, nEnd);
    if (next != null) {
      for (const s of quotedSpans(text, nStart, nEnd)) add(s.text);
      add(next);
    }
  }
  return out;
}

/** Control characters out, whitespace collapsed, at most the review quote's length (an ellipsis when cut). */
export function clipQuote(raw: string): string {
  let t = '';
  let space = false;
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) {
      if (ch === '\n' || ch === '\t' || ch === '\r') {
        space = true;
      }
      continue;
    }
    if (ch.trim() === '') {
      space = true;
      continue;
    }
    if (space && t !== '') t += ' ';
    space = false;
    t += ch;
  }
  return t.length <= REVIEW_DOC_QUOTE_MAX_CHARS ? t : `${t.slice(0, REVIEW_DOC_QUOTE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Letters and digits — a quote needs at least REVIEW_DOC_QUOTE_MIN_CHARS, so "the" matches nothing. */
export function quoteLongEnough(q: string): boolean {
  let n = 0;
  for (const ch of q) {
    if (/[\p{L}\p{N}]/u.test(ch)) n += 1;
    if (n >= REVIEW_DOC_QUOTE_MIN_CHARS) return true;
  }
  return false;
}

// ---- the citations ----

const MAX_CITATIONS = 30;

/**
 * The answer's links that name a file of this library, de-duplicated, with the document and section
 * titles from the stored rows. Anything else (an outside URL, a made-up path) is not a citation.
 *
 * A SECTION citation also carries the quote beside its link (`chat-quotes.ts`), when one of the
 * candidates passes the SAME check a review's quote passes (`quoteAppearsIn` over the section body,
 * header left off) — the viewer highlights it. A candidate that fails is dropped; the first verified
 * quote for a path#anchor wins (a later link to the same place fills in a citation that had none).
 */
export function extractCitations(
  text: string,
  docs: ReadonlyArray<Pick<DocRow, 'slug' | 'title' | 'sections' | 'builtAt'>>,
  read: (path: string) => string | null,
): ReferenceDocCitation[] {
  const bySlug = new Map(docs.filter((d) => d.builtAt != null).map((d) => [d.slug, d]));
  const out: ReferenceDocCitation[] = [];
  const byKey = new Map<string, ReferenceDocCitation>();
  const files = new Map<string, string | null>();
  const folded = new Map<string, string>();
  const readOnce = (path: string): string | null => {
    if (!files.has(path)) files.set(path, read(path));
    return files.get(path)!;
  };
  const verifiedQuote = (path: string, body: string, start: number, end: number): string | undefined => {
    let hay = folded.get(path);
    if (hay == null) {
      hay = foldForQuote(groundingTextOf(body));
      folded.set(path, hay);
    }
    for (const q of quoteCandidates(text, start, end)) {
      if (quoteLongEnough(q) && quoteAppearsInFolded(hay, q)) return q;
    }
    return undefined;
  };
  for (const link of markdownLinks(text)) {
    const parsed = parseLibraryPath(link.target.replace(/^<|>$/g, ''));
    if (!parsed || parsed.path.kind === 'index') continue;
    const doc = bySlug.get(parsed.path.slug);
    if (!doc) continue;
    const key = `${parsed.path.path}#${parsed.anchor ?? ''}`;
    const had = byKey.get(key);
    if (had != null && had.quote != null) continue;
    if (had == null && out.length >= MAX_CITATIONS) continue;
    const body = readOnce(parsed.path.path);
    if (body == null) continue;
    const quote = parsed.path.kind === 'section' ? verifiedQuote(parsed.path.path, body, link.start, link.end) : undefined;
    if (had != null) {
      if (quote != null) had.quote = quote;
      continue;
    }
    const section = parsed.path.kind === 'section' ? (doc.sections ?? []).find((s) => s.path === parsed.path.path) : undefined;
    const c: ReferenceDocCitation = {
      path: parsed.path.path,
      anchor: parsed.anchor,
      docSlug: doc.slug,
      docTitle: doc.title,
      sectionTitle: section?.title ?? null,
      ...(quote != null ? { quote } : {}),
    };
    byKey.set(key, c);
    out.push(c);
  }
  return out;
}
