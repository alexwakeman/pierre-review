// THE HIDDEN METADATA ON A POSTED LIMN REVIEW (docs/CLAUDE-REVIEW.md § Teammates' reviews).
//
// Every review summary Limn posts to GitHub ends in ONE hidden HTML comment, the summary marker:
//
//   <!-- pierre:claude-review v=1 a=<nonce> h=<head sha> k=auto p=claude m=claude-opus-5-5 e=medium d=COMMENT lv=0.1.174 -->
//
// `v=1` and the `a=` per-attempt nonce are as before (review/post-seam.ts). The other keys say how
// the review ran, so a TEAMMATE'S Limn can show it as a review in their AI Review tab:
//   h   the head SHA the review read
//   k   run kind: auto | manual | replies (a replies-pass outcome — never imported as a review)
//   s   'pair' on a Claude + Codex pair's one review; absent on a single run
//   p   provider(s): claude | codex; a pair lists both, comma-separated, in half order
//   m   model id(s), same order
//   e   effort word(s), same order ('-' for a half with none)
//   d   the verdict sent: COMMENT | REQUEST_CHANGES | APPROVE
//   lv  the Limn version that posted it
//   j   THE JUDGEMENTS this review made of earlier Limn findings already on GitHub (the reader's own
//       or a teammate's): `<comment id>:<code>` pairs, comma-separated, ≤ LIMN_META_MAX_JUDGED.
//       The comment id is the finding comment's GitHub databaseId; the code is a (addressed), n (not
//       addressed) or x (no longer applies). A teammate's Limn reads it so the finding's own Limn can
//       say "Robin's review found it addressed". Absent = none (and on every older post).
//       o (STILL OPEN, 2026-11-05; docs/CLAUDE-REVIEW.md § Still-open points): the review found the
//       point not (or only partly) addressed and holds it open. The id may then be ANY thread's root
//       comment — a person's too, not only a Limn finding. ⚠ BACKWARD COMPATIBLE BY CONSTRUCTION: a
//       still-open entry is written as TWO tokens, `<id>:n,<id>:o`. A Limn from before `o` parses
//       `[anx]` only and keeps the first entry per id, so it reads `n` (not addressed — what it
//       understood before) and skips the `o` token; this parser lets the `o` upgrade that `n`.
//   jr  (2026-11-09) THE ONE-LINE "HOW" of some `j=` entries: `<comment id>:<base64>` pairs,
//       comma-separated, the text UTF-8 then standard base64 without padding (an alphabet that can
//       never close the comment). Only ids that `j=` names; at most LIMN_META_JUDGED_REASONS_CHARS in
//       all (later entries are left out whole). A Limn from before it ignores the key; a reader takes
//       it as untrusted text (one line, clipped, made safe before it is ever posted).
//   lift  `1` = THE POSTER'S CONSENT: a teammate's Limn may lift this poster's Limn block (dismiss
//       their standing Request changes) once every point behind it is addressed (docs/CLAUDE-REVIEW.md
//       § Lifting a teammate's block). Written on every post whose comments hold every
//       blocker behind it (always on since 2026-11-10; before, only with the poster's opt-in);
//       absent = no consent (and on every older post).
// Nothing else: no secrets, no paths, no names. Every value is reduced to a small safe alphabet, so a
// value can never close the comment or carry markup.
//
// ⚠ The `pierre:claude-review v=` prefix is permanent: every reader of Limn's posts matches it as a
// PREFIX (`<!--\s*pierre:claude-review`). A LEGACY post carries only `v=1` (and maybe `a=`): it parses
// with every field null.
import type { AiProviderId, ClaudeReviewVerdict } from './types.js';

export type LimnReviewRunKind = 'auto' | 'manual' | 'replies';

/** One run behind a posted review (two for a Claude + Codex pair). */
export interface LimnReviewMetaRun {
  provider: AiProviderId | null;
  model: string | null;
  effort: string | null;
}

/** One earlier finding a posted review judged (`j=`). */
export type LimnJudgedOutcome = 'addressed' | 'not_addressed' | 'no_longer_applies' | 'still_open';
export interface LimnJudgedFinding {
  // The finding comment's GitHub databaseId (digits).
  commentId: string;
  outcome: LimnJudgedOutcome;
  // The one-line "how" (`jr=`). Absent = none sent.
  reason?: string;
}

/** The most characters the `jr=` value may take (later reasons are left out whole). */
export const LIMN_META_JUDGED_REASONS_CHARS = 6_000;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// UTF-8 + base64 by hand: this module runs in the browser and in Node, and its lib has neither
// TextEncoder nor btoa. `encodeURIComponent` / `decodeURIComponent` do the UTF-8 part.
function utf8ToBase64(text: string): string {
  const bin = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  let out = '';
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i);
    const b = i + 1 < bin.length ? bin.charCodeAt(i + 1) : -1;
    const c = i + 2 < bin.length ? bin.charCodeAt(i + 2) : -1;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)]!;
    if (b >= 0) out += B64[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)]!;
    if (c >= 0) out += B64[c & 63]!;
  }
  return out;
}

function base64ToUtf8(b64: string): string | null {
  if (b64.length % 4 === 1) return null;
  let bits = 0;
  let acc = 0;
  let hex = '';
  for (const ch of b64) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      hex += `%${((acc >> bits) & 255).toString(16).padStart(2, '0')}`;
    }
  }
  try {
    return decodeURIComponent(hex);
  } catch {
    return null;
  }
}

const cleanJudgedReason = (raw: string | null | undefined): string => {
  const one = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > 120 ? `${one.slice(0, 119).trimEnd()}…` : one;
};

/**
 * The `jr=` value: the reasons of the entries `limnJudgedValue` keeps, in its order, within
 * LIMN_META_JUDGED_REASONS_CHARS. '' ⇒ omitted.
 */
export function limnJudgedReasonsValue(judged: readonly LimnJudgedFinding[] | null | undefined): string {
  const kept = new Set(parseLimnJudged(limnJudgedValue(judged)).map((j) => j.commentId));
  const seen = new Set<string>();
  const out: string[] = [];
  let size = 0;
  for (const j of judged ?? []) {
    const id = String(j.commentId ?? '');
    if (!kept.has(id) || seen.has(id)) continue;
    seen.add(id);
    const text = cleanJudgedReason(j.reason);
    if (text === '') continue;
    const tok = `${id}:${utf8ToBase64(text)}`;
    if (size + tok.length + 1 > LIMN_META_JUDGED_REASONS_CHARS) break;
    size += tok.length + 1;
    out.push(tok);
  }
  return out.join(',');
}

/** Parse a `jr=` value into comment id → reason (tolerant: a malformed entry is skipped). */
export function parseLimnJudgedReasons(v: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (v == null) return out;
  for (const tok of v.split(',')) {
    const m = /^(\d{1,20}):([A-Za-z0-9+/]{1,400})$/.exec(tok.trim());
    if (!m || out.has(m[1]!)) continue;
    const text = cleanJudgedReason(base64ToUtf8(m[2]!));
    if (text !== '') out.set(m[1]!, text);
  }
  return out;
}

/** The most judgements one marker carries (the rest are left out, never truncated mid-entry). */
export const LIMN_META_MAX_JUDGED = 50;

const JUDGED_CODE: Record<LimnJudgedOutcome, string> = { addressed: 'a', not_addressed: 'n', no_longer_applies: 'x', still_open: 'o' };
const JUDGED_OF_CODE: Record<string, LimnJudgedOutcome> = { a: 'addressed', n: 'not_addressed', x: 'no_longer_applies', o: 'still_open' };

/**
 * The `j=` value: valid entries only, first per comment id, at most LIMN_META_MAX_JUDGED ids. A
 * still-open entry is written `<id>:n,<id>:o` (see the header: an older parser reads the `n`).
 * '' ⇒ omitted.
 */
export function limnJudgedValue(judged: readonly LimnJudgedFinding[] | null | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const j of judged ?? []) {
    if (seen.size >= LIMN_META_MAX_JUDGED) break;
    const id = String(j.commentId ?? '');
    const code = JUDGED_CODE[j.outcome];
    if (!/^\d{1,20}$/.test(id) || code == null || seen.has(id)) continue;
    seen.add(id);
    if (code === 'o') out.push(`${id}:n`, `${id}:o`);
    else out.push(`${id}:${code}`);
  }
  return out.join(',');
}

/**
 * Parse a `j=` value (tolerant: a malformed or unknown entry is skipped; the first entry per id
 * wins, except that an `o` upgrades the same id's `n` — the pair a still-open entry is written as).
 */
export function parseLimnJudged(v: string | undefined): LimnJudgedFinding[] {
  if (v == null) return [];
  const byId = new Map<string, LimnJudgedFinding>();
  for (const tok of v.split(',')) {
    const m = /^(\d{1,20}):([a-z])$/.exec(tok.trim());
    if (!m) continue;
    const outcome = JUDGED_OF_CODE[m[2]!];
    if (outcome == null) continue;
    const cur = byId.get(m[1]!);
    if (cur == null) {
      if (byId.size >= LIMN_META_MAX_JUDGED) continue;
      byId.set(m[1]!, { commentId: m[1]!, outcome });
    } else if (cur.outcome === 'not_addressed' && outcome === 'still_open') {
      cur.outcome = 'still_open';
    }
  }
  return [...byId.values()];
}

export interface LimnReviewMeta {
  headSha: string | null;
  run: LimnReviewRunKind | null;
  pair: boolean;
  // One entry for a single run, two for a pair; [] when unknown (a legacy post).
  runs: LimnReviewMetaRun[];
  verdict: ClaudeReviewVerdict | null;
  limnVersion: string | null;
  // The earlier Limn findings this review judged (`j=`). Absent = none.
  judged?: LimnJudgedFinding[];
  // `lift=1`: the poster consents to a teammate's Limn lifting this block. Absent / false = no.
  liftConsent?: boolean;
  // `ov=` (2026-11-10, docs/TEAM-REVIEW.md § 4): on the poster's OWN PR, the verdict Limn chose but
  // could not send (GitHub forbids self-approval, so the post is a comment). Written only under the
  // poster's own auto-verdict switch and impact gate. A teammate's Limn reads it to say "alex's own
  // review would approve" and to pick the PR up for a verdict first. Absent = none.
  ownPrVerdict?: 'APPROVE' | 'REQUEST_CHANGES';
}

/** What `parseLimnReviewMarker` found. `legacy` = the marker carried none of the metadata keys. */
export interface ParsedLimnReviewMarker extends LimnReviewMeta {
  legacy: boolean;
}

// The SUMMARY marker only: `pierre:claude-review` followed by whitespace and `v=`. The finding,
// pushback, sonar, CI and dependency markers (`pierre:claude-review-…`) never match.
const SUMMARY_MARKER_RE = /<!--\s*pierre:claude-review\s+(v=[^>]*?)\s*-->/i;
const SUMMARY_MARKER_ALL_RE = /<!--\s*pierre:claude-review\s+v=[^>]*?-->/gi;

const MAX_VALUE = 80;
const VERDICTS: readonly ClaudeReviewVerdict[] = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];

/** A value as it may appear in the marker: a small safe alphabet, no `--`, bounded. '' ⇒ omitted. */
export function limnMetaValue(v: string | null | undefined): string {
  if (v == null) return '';
  return String(v)
    .replace(/[^A-Za-z0-9._:@+/-]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_VALUE);
}

/**
 * The summary marker for one post: `v=1`, the attempt nonce, then each metadata key that is set.
 * `meta` absent ⇒ the bare legacy shape (`v=1 a=<nonce>`).
 */
export function limnReviewMarker(nonce: string, meta?: Partial<LimnReviewMeta> | null): string {
  const parts = ['v=1', `a=${limnMetaValue(nonce)}`];
  if (meta) {
    const h = limnMetaValue(meta.headSha);
    if (h) parts.push(`h=${h}`);
    if (meta.run) parts.push(`k=${meta.run}`);
    const runs = (meta.runs ?? []).slice(0, 2);
    if (meta.pair && runs.length > 1) parts.push('s=pair');
    const list = (pick: (r: LimnReviewMetaRun) => string | null): string => {
      const vals = runs.map((r) => limnMetaValue(pick(r)).replace(/,/g, '') || '-');
      return vals.every((x) => x === '-') ? '' : vals.join(',');
    };
    const p = list((r) => r.provider);
    if (p) parts.push(`p=${p}`);
    const m = list((r) => r.model);
    if (m) parts.push(`m=${m}`);
    const e = list((r) => r.effort);
    if (e) parts.push(`e=${e}`);
    if (meta.verdict && VERDICTS.includes(meta.verdict)) parts.push(`d=${meta.verdict}`);
    const lv = limnMetaValue(meta.limnVersion);
    if (lv) parts.push(`lv=${lv}`);
    const j = limnJudgedValue(meta.judged);
    if (j) parts.push(`j=${j}`);
    const jr = j ? limnJudgedReasonsValue(meta.judged) : '';
    if (jr) parts.push(`jr=${jr}`);
    if (meta.liftConsent === true) parts.push('lift=1');
    if (meta.ownPrVerdict === 'APPROVE' || meta.ownPrVerdict === 'REQUEST_CHANGES') parts.push(`ov=${meta.ownPrVerdict}`);
  }
  return `<!-- pierre:claude-review ${parts.join(' ')} -->`;
}

/** Does this body carry Limn's review SUMMARY marker (any version, with or without metadata)? */
export function hasLimnReviewMarker(body: string | null | undefined): boolean {
  return typeof body === 'string' && SUMMARY_MARKER_RE.test(body);
}

/**
 * THE ONE PARSER of a posted review summary's marker. Null when the body has no summary marker.
 * Tolerant: unknown keys are ignored, a malformed value reads as null, and a legacy post (no keys
 * beyond `v` / `a`) returns every field null with `legacy: true`.
 */
export function parseLimnReviewMarker(body: string | null | undefined): ParsedLimnReviewMarker | null {
  if (typeof body !== 'string') return null;
  const m = SUMMARY_MARKER_RE.exec(body);
  if (!m) return null;
  const kv = new Map<string, string>();
  for (const tok of m[1]!.split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const k = tok.slice(0, eq).toLowerCase();
    if (!kv.has(k)) kv.set(k, tok.slice(eq + 1));
  }
  const keys = ['h', 'k', 's', 'p', 'm', 'e', 'd', 'lv', 'j', 'jr', 'lift', 'ov'];
  const legacy = !keys.some((k) => kv.has(k));
  const clean = (v: string | undefined): string | null => {
    const c = limnMetaValue(v);
    return c === '' || c === '-' ? null : c;
  };
  const split = (v: string | undefined): Array<string | null> =>
    v == null ? [] : v.split(',').slice(0, 2).map((x) => clean(x));
  const providers = split(kv.get('p'));
  const models = split(kv.get('m'));
  const efforts = split(kv.get('e'));
  const n = Math.max(providers.length, models.length, efforts.length);
  const runs: LimnReviewMetaRun[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = providers[i];
    runs.push({
      provider: p === 'claude' || p === 'codex' ? p : null,
      model: models[i] ?? null,
      effort: efforts[i] ?? null,
    });
  }
  const k = kv.get('k');
  const d = kv.get('d');
  const h = clean(kv.get('h'));
  const reasons = parseLimnJudgedReasons(kv.get('jr'));
  const judged = parseLimnJudged(kv.get('j')).map((x) => {
    const reason = reasons.get(x.commentId);
    return reason != null ? { ...x, reason } : x;
  });
  return {
    legacy,
    headSha: h != null && /^[0-9a-f]{7,64}$/i.test(h) ? h.toLowerCase() : null,
    run: k === 'auto' || k === 'manual' || k === 'replies' ? k : null,
    pair: kv.get('s') === 'pair' && runs.length > 1,
    runs,
    verdict: d != null && (VERDICTS as readonly string[]).includes(d) ? (d as ClaudeReviewVerdict) : null,
    limnVersion: clean(kv.get('lv')),
    // Only when the post carried judgements.
    ...(judged.length > 0 ? { judged } : {}),
    // Only when the post consented.
    ...(kv.get('lift') === '1' ? { liftConsent: true } : {}),
    // Only on an own-PR post whose verdict was held (a comment went out instead).
    ...(kv.get('ov') === 'APPROVE' || kv.get('ov') === 'REQUEST_CHANGES'
      ? { ownPrVerdict: kv.get('ov') as 'APPROVE' | 'REQUEST_CHANGES' }
      : {}),
  };
}

/** The summary text a reader sees: the body without Limn's summary marker(s), trimmed. */
export function stripLimnReviewMarker(body: string | null | undefined): string {
  return (body ?? '').replace(SUMMARY_MARKER_ALL_RE, '').trim();
}

// ── A POSTED FINDING COMMENT, READ BACK ────────────────────────────────────────────────────────────

/** A Limn finding comment as a teammate's Limn reads it back from GitHub. */
export interface PostedLimnFinding {
  // From the lead ("**Warning**"); null on a finding posted before leads existed.
  severity: 'blocker' | 'warning' | 'nit' | 'question' | null;
  // The lead's tag on a pair's post ("Codex", "Claude + Codex"), else null.
  tag: string | null;
  // A PR-level comment's file reference from its lead ("src/x.ts", 42); null on an inline comment.
  refPath: string | null;
  refLine: number | null;
  // The first line of the text, as a short title (≤ 120 characters).
  title: string;
  // The text without the lead, Limn's notes, footers and marker.
  body: string;
}

const LEAD_LINE_RE = /^\*\*(Blocker|Warning|Nit|Question)\*\*((?: · [^\n]*)?)\s*(?:\n+|$)/;
const BARE_REF_RE = /^\*\*`([^`\n]+)`\*\*\s*(?:\n+|$)/;
const ANY_LIMN_MARKER_RE = /<!--\s*pierre:claude-review[^>]*-->/gi;
// Limn's own italic one-line notes and footers (the fallback-anchor note, the outside-the-diff note,
// "_Posted automatically by Limn's … review._"). A whole paragraph in underscores.
const ITALIC_NOTE_RE = /\n*\n_[^_\n][^\n]*_\s*$/;

function parseRef(ref: string): { path: string; line: number | null } {
  const m = /^(.*?):(\d+)$/.exec(ref);
  return m ? { path: m[1]!, line: Number(m[2]) } : { path: ref, line: null };
}

/**
 * A finding comment's parts: severity and tag from the lead, a PR-level comment's file reference,
 * and the text without lead, notes, footer or marker. Pure; never throws.
 */
export function parsePostedLimnFinding(raw: string | null | undefined): PostedLimnFinding {
  let text = (raw ?? '').replace(/\r\n?/g, '\n').replace(ANY_LIMN_MARKER_RE, '').trim();
  let severity: PostedLimnFinding['severity'] = null;
  let tag: string | null = null;
  let refPath: string | null = null;
  let refLine: number | null = null;
  const lead = LEAD_LINE_RE.exec(text);
  if (lead) {
    severity = lead[1]!.toLowerCase() as PostedLimnFinding['severity'];
    for (const part of (lead[2] ?? '').split(' · ').map((p) => p.trim()).filter(Boolean)) {
      const ref = /^`([^`]+)`$/.exec(part);
      if (ref) ({ path: refPath, line: refLine } = parseRef(ref[1]!));
      else if (tag == null) tag = part;
    }
    text = text.slice(lead[0].length).trim();
  } else {
    const bare = BARE_REF_RE.exec(text);
    if (bare) {
      ({ path: refPath, line: refLine } = parseRef(bare[1]!));
      text = text.slice(bare[0].length).trim();
    }
  }
  for (let i = 0; i < 4 && ITALIC_NOTE_RE.test(text); i += 1) text = text.replace(ITALIC_NOTE_RE, '').trim();
  const first = (text.split('\n').find((l) => l.trim() !== '') ?? '').replace(/^#+\s*/, '').trim();
  const title = first.length > 120 ? `${first.slice(0, 119).trimEnd()}…` : first;
  return { severity, tag, refPath, refLine, title, body: text };
}

/** A posted finding's text, split the way the reader's own findings are shown (`postedFindingDisplay`). */
export interface PostedFindingDisplay {
  // A short title: the text's first sentence (≤ 160 characters), else the stored title.
  title: string;
  // The rest of the text (no title sentence, no trailing suggestion block). May be ''.
  body: string;
  // The trailing ```suggestion block's code, or null.
  suggestion: string | null;
}

const TRAILING_SUGGESTION_RE = /\n*```suggestion[^\n]*\n([\s\S]*?)\n?```\s*$/;
const TITLE_MAX = 160;

/**
 * A posted finding's text without its trailing ```suggestion block, and that block's code (null when
 * there is none). Limn posts a finding's suggestion LAST, so only a trailing block is one. Pure.
 */
export function splitTrailingSuggestion(text: string): { text: string; suggestion: string | null } {
  const rest = text.replace(/\r\n?/g, '\n').trim();
  const sug = TRAILING_SUGGESTION_RE.exec(rest);
  if (!sug) return { text: rest, suggestion: null };
  return { text: rest.slice(0, sug.index).trim(), suggestion: sug[1]! };
}

/**
 * A POSTED Limn finding's text (a teammate's, as `parsePostedLimnFinding` returns its `body`) shown
 * like the reader's own finding: a title, a body and a separate suggestion. Limn posts a finding's
 * BODY only (never its title), so the title is the text's first sentence — a full stop, question
 * mark or exclamation mark followed by a space or the line end, outside `code` — when it is short;
 * else the stored title (`fallbackTitle`) and the whole text. Pure; never throws.
 */
export function postedFindingDisplay(text: string, fallbackTitle: string): PostedFindingDisplay {
  const { text: rest, suggestion } = splitTrailingSuggestion(text);
  const firstLineEnd = rest.indexOf('\n');
  const firstLine = (firstLineEnd < 0 ? rest : rest.slice(0, firstLineEnd)).replace(/^#+\s*/, '');
  let end = -1;
  let inCode = false;
  for (let i = 0; i < firstLine.length; i += 1) {
    const ch = firstLine[i]!;
    if (ch === '`') inCode = !inCode;
    else if (!inCode && (ch === '.' || ch === '?' || ch === '!') && (i + 1 === firstLine.length || firstLine[i + 1] === ' ')) {
      // "e.g." / "i.e." are not the end of a sentence.
      if (ch === '.' && /\b(?:e\.g|i\.e|etc|vs)$/i.test(firstLine.slice(0, i))) continue;
      end = i + 1;
      break;
    }
  }
  if (end < 0 && firstLineEnd >= 0) end = firstLine.length;
  if (end < 0 && firstLine.length <= TITLE_MAX) end = firstLine.length;
  if (end > 0 && end <= TITLE_MAX) {
    const title = firstLine.slice(0, end).trim();
    const afterTitle = firstLine.slice(end).trim();
    // The rest keeps its own line breaks (a paragraph break stays one).
    const body = (afterTitle + (firstLineEnd < 0 ? '' : rest.slice(firstLineEnd))).trim();
    if (title !== '') return { title, body, suggestion };
  }
  return { title: fallbackTitle, body: rest, suggestion };
}

// ---- THE TEAM'S MINIMUM LIMN VERSION (docs/TEAM-REVIEW.md § 12 Mixed versions) ----

/**
 * The oldest Limn that takes full part in shared reviews: still-open replies and reopens, and claims
 * that never take an open point it did not record; no approval over an open earlier warning (D1)
 * and no reopen on its own PR (D2). A teammate whose newest review on a PR carries an
 * older `lv=` (or none) gets a plain "update" line on the AI Review tab. Raise it when a release
 * changes how Limns on one team cooperate.
 */
export const MIN_TEAM_LIMN_VERSION = '1.0.5';

/** `1.2.3`, `v1.2.3`, `1.2.3-beta.1` → [1, 2, 3, prerelease]. null when it is not a version. */
function parseLimnVersion(v: string): { nums: [number, number, number]; pre: string | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (m == null) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/**
 * SEMVER ORDER of two Limn versions: < 0 when `a` is older, 0 when equal, > 0 when newer. A
 * prerelease is older than its release (`1.0.3-beta` < `1.0.3`); two prereleases compare by
 * dot-separated identifier, numbers numerically. null when either is not a version.
 */
export function compareLimnVersions(a: string, b: string): number | null {
  const pa = parseLimnVersion(a);
  const pb = parseLimnVersion(b);
  if (pa == null || pb == null) return null;
  for (let i = 0; i < 3; i += 1) {
    const d = pa.nums[i]! - pb.nums[i]!;
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre == null) return 1;
  if (pb.pre == null) return -1;
  const ia = pa.pre.split('.');
  const ib = pb.pre.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    const x = ia[i];
    const y = ib[i];
    if (x == null) return -1;
    if (y == null) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx != null && ny != null) {
      if (nx !== ny) return nx - ny;
    } else if (nx != null) {
      return -1;
    } else if (ny != null) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Is a teammate's Limn (the `lv=` on their review) older than the team minimum? An unknown or
 * unreadable version (a legacy post) counts as older: every Limn that writes `lv=` also writes it in
 * a readable form.
 */
export function isLimnBelowTeamMinimum(version: string | null | undefined, min: string = MIN_TEAM_LIMN_VERSION): boolean {
  if (version == null || version.trim() === '') return true;
  const c = compareLimnVersions(version, min);
  return c == null || c < 0;
}

// ── A REVIEW DISMISSAL, READ BACK (migration 0183) ──────────────────────────────────────────────────

/** Is this review DISMISSAL Limn's, by its GitHub message? Limn writes three: its own approval
 *  withdrawn ("Limn withdrew its approval: …", backend approval-withdraw.ts), a teammate's block
 *  lifted ("Limn (robin) checked …", teammate-lift.ts — the away path too: "… checked … at abc1234.
 *  bob's Limn has not reviewed it and has been away for 5 hours.") and its own block lifted ("Claude's blocking
 *  findings are fixed.", auto-post.ts `liftBlockMessage`). Pure. */
export function isLimnDismissalMessage(message: string | null | undefined): boolean {
  const m = (message ?? '').trim();
  return m.startsWith('Limn withdrew its approval') || /^Limn \([^)]+\) checked /.test(m) || /^(Claude|Codex)['’]s blocking findings are fixed\.$/.test(m);
}

/** A dismissal message as the tab says it after "withdrawn: " — Limn's lead words and the final full
 *  stop dropped ("3 warnings found at 951c4aa"). null when empty. Pure. */
export function dismissalReasonText(message: string | null | undefined): string | null {
  const m = (message ?? '').replace(/\s+/g, ' ').trim().replace(/^Limn withdrew its approval:\s*/, '').replace(/\.$/, '').trim();
  return m === '' ? null : m;
}
