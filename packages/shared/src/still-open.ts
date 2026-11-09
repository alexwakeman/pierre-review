// STILL-OPEN POINTS (docs/CLAUDE-REVIEW.md § Still-open points, 2026-11-05).
//
// A Limn review that judges an EARLIER review comment or thread NOT (or only partly) addressed — its
// own Limn's finding, a teammate's Limn finding or a person's comment — holds that point OPEN. When
// the review is POSTED (auto-posting, or "Review and post"), Limn says so ON THE THREAD, so the PR
// author can find it:
//
//   • ONE reply on the thread, as the reader: `**Still open:** <reason>` + the auto-post footer + the
//     finding marker (so `isLimnPostedComment` holds and sync stores it under the `limn:` bot: it is
//     never a person's answer and never returns the ball) + the STILL-OPEN marker below. At most one
//     per thread per head.
//   • A RESOLVED thread is unresolved — AT MOST ONCE PER THREAD, EVER. The reply's marker carries
//     `r=1` when it reopened the thread, so a SECOND Limn (a teammate's, or the reader's on another
//     machine) sees the reopen on GitHub and never reopens it again.
//   • Reopened once already and still open: a WARNING or BLOCKER starts ONE new inline thread about
//     the same point (`c=<root comment id>` names the thread it continues); a nit, a question or a
//     point with no severity is left as it is. A continuation is never continued again.
//   • ON THE READER'S OWN PR (decision D2): the reply only — never a reopen, never a new thread; a
//     resolved thread there gets one reply, ever.
//   • Later runs judge the CONTINUATION, not the earlier thread (`continuationThreadMap`, below).
//
// The marker: `<!-- pierre:claude-review-still-open v=1 h=<head> [r=1] [c=<comment id>] -->`. Its
// `pierre:claude-review` prefix is the provenance every Limn reader already matches.

/** The lead of a still-open reply. */
export const STILL_OPEN_LEAD = '**Still open:**';
/** The longest reason a reply carries (one or two short sentences). */
export const STILL_OPEN_REASON_MAX = 240;

const STILL_OPEN_MARKER_RE = /<!--\s*pierre:claude-review-still-open\s+([^>]*?)\s*-->/i;
const STILL_OPEN_MARKER_ALL_RE = /<!--\s*pierre:claude-review-still-open[^>]*-->/gi;
const ANY_LIMN_MARKER_RE = /<!--\s*pierre:claude-review[^>]*-->/gi;

export interface StillOpenMarker {
  // The head the judgement was made at (lower-case hex), or null.
  headSha: string | null;
  // This reply reopened (unresolved) its thread.
  reopened: boolean;
  // A NEW thread that continues an earlier one: that thread's root comment databaseId.
  continuesCommentId: string | null;
}

/** The hidden still-open marker. */
export function stillOpenMarker(m: { headSha: string; reopened?: boolean; continuesCommentId?: string | null }): string {
  const parts = ['v=1'];
  const h = String(m.headSha ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 64).toLowerCase();
  if (h) parts.push(`h=${h}`);
  if (m.reopened === true) parts.push('r=1');
  const c = String(m.continuesCommentId ?? '');
  if (/^\d{1,20}$/.test(c)) parts.push(`c=${c}`);
  return `<!-- pierre:claude-review-still-open ${parts.join(' ')} -->`;
}

/** The still-open marker a body carries, or null. Tolerant: unknown keys are ignored. */
export function parseStillOpenMarker(body: string | null | undefined): StillOpenMarker | null {
  if (typeof body !== 'string') return null;
  const m = STILL_OPEN_MARKER_RE.exec(body);
  if (!m) return null;
  const kv = new Map<string, string>();
  for (const tok of m[1]!.split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0 && !kv.has(tok.slice(0, eq).toLowerCase())) kv.set(tok.slice(0, eq).toLowerCase(), tok.slice(eq + 1));
  }
  const h = kv.get('h') ?? '';
  const c = kv.get('c') ?? '';
  return {
    headSha: /^[0-9a-f]{7,64}$/i.test(h) ? h.toLowerCase() : null,
    reopened: kv.get('r') === '1',
    continuesCommentId: /^\d{1,20}$/.test(c) ? c : null,
  };
}

// ── CONTINUATION THREADS (gap 8) ───────────────────────────────────────────────────────────────────
//
// THE MAPPING IS STORED ON GITHUB: a continuation thread's ROOT comment carries the still-open marker
// with `c=<the earlier thread's root comment databaseId>`. Every Limn reads it on sync, so the reader's
// own continuations and a teammate's are followed the same way. (This account's `escalate:<node>`
// claim row also keeps the new root's comment id; the marker is what every reader trusts.)

/** One synced review comment, as `continuationThreadMap` reads it. */
export interface ContinuationComment {
  threadId: number | null;
  databaseId: string | null;
  body: string | null;
  // Any order key that sorts a thread's comments oldest first (ms).
  createdAt: number;
  // A tie-break (the comment's local id); optional.
  id?: number;
}

/**
 * Per PR's comments: earlier thread id → the thread that continues it (followed to the END of a
 * chain; the oldest continuation wins when two name the same thread). Only a thread ROOT counts on
 * either side. Pure.
 */
export function continuationThreadMap(comments: readonly ContinuationComment[]): Map<number, number> {
  const roots = new Map<number, ContinuationComment>();
  for (const c of comments) {
    if (c.threadId == null) continue;
    const r = roots.get(c.threadId);
    if (!r || c.createdAt < r.createdAt || (c.createdAt === r.createdAt && (c.id ?? 0) < (r.id ?? 0))) roots.set(c.threadId, c);
  }
  const threadOfRoot = new Map<string, number>();
  for (const [threadId, r] of roots) if (r.databaseId != null) threadOfRoot.set(r.databaseId, threadId);
  const next = new Map<number, { to: number; at: number }>();
  for (const [threadId, r] of roots) {
    const from = parseStillOpenMarker(r.body)?.continuesCommentId;
    const original = from != null ? threadOfRoot.get(from) : undefined;
    if (original == null || original === threadId) continue;
    const had = next.get(original);
    if (!had || r.createdAt < had.at) next.set(original, { to: threadId, at: r.createdAt });
  }
  const out = new Map<number, number>();
  for (const start of next.keys()) {
    let at = start;
    const seen = new Set<number>([start]);
    for (let hop = 0; hop < 10; hop += 1) {
      const n = next.get(at);
      if (!n || seen.has(n.to)) break;
      seen.add(n.to);
      at = n.to;
    }
    if (at !== start) out.set(start, at);
  }
  return out;
}

/** Does this body START with the still-open lead (after leading space)? */
export function hasStillOpenLead(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.replace(/\r\n?/g, '\n').replace(/^\s+/, '').startsWith(STILL_OPEN_LEAD);
}

/**
 * The reason a still-open reply gives, as a reader sees it: no lead, no footer, no marker, one line.
 * '' when there is none. Pure.
 */
export function stillOpenReasonOf(body: string | null | undefined): string {
  let text = (body ?? '').replace(/\r\n?/g, '\n').replace(ANY_LIMN_MARKER_RE, '').replace(STILL_OPEN_MARKER_ALL_RE, '').trim();
  if (text.startsWith(STILL_OPEN_LEAD)) text = text.slice(STILL_OPEN_LEAD.length);
  // The first paragraph only (the footer is its own italic paragraph).
  const first = text.trim().split(/\n\s*\n/)[0] ?? '';
  return first.replace(/\s+/g, ' ').trim();
}

/**
 * A still-open reason made short and safe for OUR GitHub comment: one line, at most
 * STILL_OPEN_REASON_MAX characters cut at a sentence end where one fits, no @-mention pings, no
 * HTML comment (a forged marker). The text is a model's, which read untrusted PR text. Pure.
 */
export function stillOpenReasonText(raw: string | null | undefined): string {
  const one = (raw ?? '')
    .replace(/<!--/g, '&lt;!--')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@​')
    .replace(/\s+/g, ' ')
    .trim();
  if (one.length <= STILL_OPEN_REASON_MAX) return one;
  const cut = one.slice(0, STILL_OPEN_REASON_MAX);
  // At most two sentences: the last sentence end that fits.
  const ends = [...cut.matchAll(/[.!?](?=\s|$)/g)].map((x) => x.index ?? -1).filter((i) => i > 40);
  if (ends.length > 0) return cut.slice(0, ends[ends.length - 1]! + 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 40 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

// ── THE ONE-LINE "HOW" OF A JUDGEMENT (docs/CLAUDE-REVIEW.md § The one-line how) ─────────────────

/** The longest "how" a judgement keeps (the thread assessment's `reason` has the same limit). */
export const JUDGEMENT_HOW_MAX = 120;

/** A model's one-line "how": whitespace collapsed, clipped to JUDGEMENT_HOW_MAX. null when empty. Pure. */
export function oneLineHow(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const one = raw.replace(/\s+/g, ' ').trim();
  if (one === '') return null;
  return one.length > JUDGEMENT_HOW_MAX ? `${one.slice(0, JUDGEMENT_HOW_MAX - 1).trimEnd()}…` : one;
}

/** The first sentence of a longer text, clipped like a "how". null when empty. Pure. */
export function firstSentenceHow(text: string | null | undefined): string | null {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  if (one === '') return null;
  const m = /^(.+?[.!?])(?=\s|$)/.exec(one);
  return oneLineHow(m?.[1] ?? one);
}

/**
 * The "how" of one follow-up item as every surface shows it: the model's own line, else (a row from
 * before the field) the first sentence of its explanation. null when neither says anything. Pure.
 */
export function judgementHowOf(it: { how?: string | null; explanation?: string | null }): string | null {
  return oneLineHow(it.how) ?? firstSentenceHow(it.explanation);
}

/** Who made a still-open judgement shown on a thread. */
export type ClaudeStillOpenBy =
  | { you: true }
  | { you: false; login: string; name: string | null };

/**
 * A still-open judgement on one thread (`ClaudeThreadJudgement.stillOpen`): the reader's own Limn's,
 * or a teammate's Limn's posted one (its `j=` entry `o`, its reason from that Limn's reply on the
 * thread). The newer of the two stands.
 */
export interface ClaudeThreadStillOpen {
  by: ClaudeStillOpenBy;
  // ONE line, or null when none was given (a teammate's Limn that did not reply at that head).
  reason: string | null;
  // When it was judged (the run's finish, or the teammate review's post). ISO-8601.
  at: string | null;
  // The head it was judged at ('' when unknown). A push since makes it a judgement of older code.
  headSha: string;
  // The finding's severity when known (a Limn finding's lead, or the reader's finding).
  severity: 'blocker' | 'warning' | 'nit' | 'question' | null;
  // Where the thread sits (review_threads), for a list that links into it, and whether GitHub shows it
  // resolved now (a thread resolved again after its one reopen is still held open).
  path: string | null;
  line: number | null;
  threadResolved: boolean;
}

/** "You", "Robin" — the owner of a still-open judgement, for a label. */
export function stillOpenByName(by: ClaudeStillOpenBy): string {
  if (by.you) return 'Your Limn';
  const n = (by.name ?? '').trim();
  const first = n !== '' ? n.split(/\s+/)[0]! : by.login;
  return `${first}’s Limn`;
}

/** The one label a still-open thread wears: "Robin’s Limn: still open". */
export function stillOpenLabel(by: ClaudeStillOpenBy): string {
  return `${stillOpenByName(by)}: still open`;
}

// ── THE ONE RULE: which judgement holds a point open ───────────────────────────────────────────────

/** A follow-up status that holds an earlier Limn finding open (`reply_disputed` too: Limn disagreed
 *  with the reply). */
export function isStillOpenFollowUp(status: string | null | undefined): boolean {
  return status === 'not_addressed' || status === 'partly_addressed' || status === 'reply_disputed';
}

/** A thread judgement that holds a point open: the comment holds up (or partly) and the code does
 *  not deal with it (or only partly). A comment judged wrong, or a judgement with no reading of the
 *  code, holds nothing open. */
export function isStillOpenThread(a: { validity: string | null | undefined; addressed: string | null | undefined }): boolean {
  return (a.validity === 'valid' || a.validity === 'partly_valid') && (a.addressed === 'not_addressed' || a.addressed === 'partly_addressed');
}
