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

export interface LimnReviewMeta {
  headSha: string | null;
  run: LimnReviewRunKind | null;
  pair: boolean;
  // One entry for a single run, two for a pair; [] when unknown (a legacy post).
  runs: LimnReviewMetaRun[];
  verdict: ClaudeReviewVerdict | null;
  limnVersion: string | null;
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
  const keys = ['h', 'k', 's', 'p', 'm', 'e', 'd', 'lv'];
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
  return {
    legacy,
    headSha: h != null && /^[0-9a-f]{7,64}$/i.test(h) ? h.toLowerCase() : null,
    run: k === 'auto' || k === 'manual' || k === 'replies' ? k : null,
    pair: kv.get('s') === 'pair' && runs.length > 1,
    runs,
    verdict: d != null && (VERDICTS as readonly string[]).includes(d) ? (d as ClaudeReviewVerdict) : null,
    limnVersion: clean(kv.get('lv')),
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
