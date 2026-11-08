// THE SEVERITY LABEL on every comment Limn posts for a finding, and the chip the PR details pane
// draws on Limn's own posted threads and comments (docs/CLAUDE-REVIEW.md § Severity labels).
//
// ONE word per severity (`limnSeverityLabel`), ONE lead-line builder (`limnSeverityLead`), and ONE
// seam that decides which severity a posted finding carries (`severityForPostedFinding`). The
// GitHub comment builders (backend review/post-review.ts) and the pane's chip (via the wire field
// `limnSeverity`, db/limn-finding-severity.ts) both go through that seam, so what GitHub shows and
// what the pane shows can never disagree.
//
// Praise is never posted, so it has no label.
//
// THE SAME LEAD MAKES A POSTED FINDING A BOT COMMENT (`limnFindingPost`, docs/CLAUDE-REVIEW.md
// § Limn findings are bots): sync re-attributes such a comment to a per-poster bot user
// ("Limn · alice", login `limn:alice`) and keeps the true poster beside it.
import { PRODUCT_NAME } from './product.js';
import { STILL_OPEN_LEAD } from './still-open.js';
import type { ClaudeFindingSeverity, MlSeverity } from './types.js';

/** A severity Limn posts with a label: every finding severity but praise. */
export type LimnSeverity = Exclude<ClaudeFindingSeverity, 'praise'>;

export const LIMN_SEVERITY_WORD: Record<LimnSeverity, string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
};

export function isLimnSeverity(s: unknown): s is LimnSeverity {
  return s === 'blocker' || s === 'warning' || s === 'nit' || s === 'question';
}

/** The word for a severity ("Warning"), or null for praise / none. */
export function limnSeverityLabel(severity: ClaudeFindingSeverity | null | undefined): string | null {
  return isLimnSeverity(severity) ? LIMN_SEVERITY_WORD[severity] : null;
}

/**
 * The severity a POSTED finding carries — on its GitHub comment and on the pane's chip. It is the
 * review's own severity, and nothing else: every comment builder and the chip's wire mapping read
 * it only through here. ⚠ It is NEVER ML-graded. The ML scorer never sees a Limn finding
 * (`limnFindingPost` takes it out of the scorer's candidates); its severity badge is written from
 * this lead (`LIMN_ML_SEVERITY`).
 */
export function severityForPostedFinding(f: { severity?: ClaudeFindingSeverity | null }): LimnSeverity | null {
  return isLimnSeverity(f.severity) ? f.severity : null;
}

/**
 * The first line of a posted finding comment: the bold severity word, then " · " and each extra
 * part that is set — an optional `tag` (a provider name such as "Codex" on a paired post) and an
 * optional `ref` (a `path:line` reference, already formatted, e.g. "`src/x.ts:42`").
 *   "**Warning**" · "**Warning** · `src/x.ts:42`" · "**Warning** · Codex · `src/x.ts:42`"
 * Null when the severity has no label (praise, or none given) — the caller then keeps its old lead.
 */
export function limnSeverityLead(
  severity: ClaudeFindingSeverity | null | undefined,
  opts?: { tag?: string | null; ref?: string | null },
): string | null {
  const word = limnSeverityLabel(severity);
  if (word == null) return null;
  const parts = [`**${word}**`];
  const tag = opts?.tag?.trim();
  if (tag) parts.push(tag);
  const ref = opts?.ref?.trim();
  if (ref) parts.push(ref);
  return parts.join(' · ');
}

// A lead line as `limnSeverityLead` writes it, at the very start of a body.
export const LEAD_RE = /^\*\*(?:Blocker|Warning|Nit|Question)\*\*(?: · [^\n]*)?(?:\n+|$)/;

/**
 * The body without its leading severity line, if it has one. For matchers that compare a posted
 * comment's START with a finding's text (backend finding-thread.ts): a comment posted before the
 * label existed has no lead and is returned unchanged.
 */
export function stripLimnSeverityLead(body: string): string {
  return body.replace(LEAD_RE, '');
}

// ── LIMN FINDINGS ARE BOTS ──────────────────────────────────────────────────────────────────────
// Limn posts as the reader, so a finding comment carries the reader's login. These are the ONE
// predicate and parser that tell a finding apart from the person's own words, for any author.

/** The hidden stamp on every finding comment Limn posts (backend `FINDING_COMMENT_MARKER`). A reply
 *  to a finding thread carries it too, without a lead line. */
export const LIMN_FINDING_MARKER_RE = /<!--\s*pierre:claude-review-finding/i;
/** Limn's pushback reply on a finding thread. Never a finding. */
const LIMN_PUSHBACK_MARKER_RE = /<!--\s*pierre:claude-review-pushback/i;
/** A reminder's lead (backend posted-state.ts `reminderLead`). */
export const LIMN_REMINDER_LEAD_RE = /^\*\*Reminder:\*\*/;

export interface LimnFindingPost {
  /** The lead's severity; null on a reminder with no severity. */
  severity: LimnSeverity | null;
  reminder: boolean;
  /** A "Still open:" reply on a thread (still-open.ts): Limn's words, never a finding. Absent = no. */
  stillOpen?: boolean;
}

const WORD_TO_SEVERITY: Record<string, LimnSeverity> = {
  Blocker: 'blocker',
  Warning: 'warning',
  Nit: 'nit',
  Question: 'question',
};

/**
 * A comment body that is a Limn FINDING (or a reminder of one): the finding marker plus a severity
 * lead or a reminder lead at the start. Null for everything else — a reply on a finding thread
 * (marker, no lead), a pushback, a review body, a ticket post, a finding posted before leads
 * existed, and any comment without the marker.
 *
 * `threadRoot`: the comment OPENS an inline review thread. Limn posts every finding as a new thread
 * root, so a root with the finding marker and no lead is a finding posted before leads existed: a
 * finding with no severity. (Replies never open a thread; a ticket story-check post is not a finding.)
 */
export function limnFindingPost(
  body: string | null | undefined,
  opts: { threadRoot?: boolean } = {},
): LimnFindingPost | null {
  if (typeof body !== 'string' || body === '') return null;
  if (!LIMN_FINDING_MARKER_RE.test(body)) return null;
  if (LIMN_PUSHBACK_MARKER_RE.test(body)) return null;
  const text = body.replace(/\r\n?/g, '\n').replace(/^[\s]+/, '');
  const lead = /^\*\*(Blocker|Warning|Nit|Question)\*\*/.exec(text);
  if (lead != null && LEAD_RE.test(text)) {
    const rest = stripLimnSeverityLead(text).replace(/^[\s]+/, '');
    return { severity: WORD_TO_SEVERITY[lead[1]!] ?? null, reminder: LIMN_REMINDER_LEAD_RE.test(rest) };
  }
  if (LIMN_REMINDER_LEAD_RE.test(text)) return { severity: null, reminder: true };
  // A still-open reply (still-open.ts): Limn's words on the thread, stored under the `limn:` bot like
  // a reminder, so it is never read as the poster's own answer. Never a finding.
  if (text.startsWith(STILL_OPEN_LEAD)) return { severity: null, reminder: false, stillOpen: true };
  if (opts.threadRoot === true && !/^\*\*[^*\n]* story check\*\*/.test(text)) return { severity: null, reminder: false };
  return null;
}

// ── LIMN'S REPLIES ARE BOTS TOO (docs/TEAM-REVIEW.md § 8, gap 1 settled 2026-11-05) ─────────────────
// Every reply Limn writes on a review thread carries one of Limn's hidden markers: a pushback
// (`pierre:claude-review-pushback`), an acknowledgement or resolve reply ("Addressed in abc1234.",
// `pierre:claude-review-finding`), a "Still open:" reply (finding + still-open markers), and the
// reader's "Post reply" of a drafted answer. Those words are the review's, not the person's, so sync
// stores such a reply under the poster's `limn:` bot exactly like a finding. A person's own reply has
// no marker (they cannot type a hidden comment by accident; a GitHub quote-reply copies rendered
// text, and quoted `>` lines are ignored here anyway).

const LIMN_ANY_MARKER_RE = /<!--\s*pierre:claude-review/i;

/**
 * Is this review-thread REPLY (never a thread root) one Limn wrote? True when the body carries any
 * Limn hidden marker outside a quoted (`>`) line. Pure.
 */
export function isLimnThreadReply(body: string | null | undefined): boolean {
  if (typeof body !== 'string' || body === '') return false;
  if (!LIMN_ANY_MARKER_RE.test(body)) return false;
  const unquoted = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
  return LIMN_ANY_MARKER_RE.test(unquoted);
}

/**
 * Is this body Limn's own writing, posted under someone's account? True when it carries any Limn hidden
 * marker (`<!-- pierre:claude-review…`: a finding, a reply, a review summary, a CI review, a story
 * check) outside a quoted (`>`) line. The Feed's "Limn" label and its My Turn exclusion read it. Pure.
 */
export function isLimnAuthoredBody(body: string | null | undefined): boolean {
  return isLimnThreadReply(body);
}

/** A finding's severity as the ML severity scale reads it, for its badge. */
export const LIMN_ML_SEVERITY: Record<LimnSeverity, MlSeverity> = {
  blocker: 'critical',
  warning: 'major',
  nit: 'nit',
  question: 'minor',
};

/** The login prefix of the per-poster Limn bot users. ':' cannot occur in a GitHub login, so a
 *  `limn:` login never collides with a real account and must NEVER be sent to GitHub. */
export const LIMN_BOT_LOGIN_PREFIX = 'limn:';

export function limnBotLogin(posterLogin: string): string {
  return `${LIMN_BOT_LOGIN_PREFIX}${posterLogin}`;
}

export function isLimnBotLogin(login: string | null | undefined): boolean {
  return typeof login === 'string' && login.startsWith(LIMN_BOT_LOGIN_PREFIX);
}

/** The poster's GitHub login behind a `limn:` bot login; null for any other login. */
export function limnPosterOf(botLogin: string | null | undefined): string | null {
  return isLimnBotLogin(botLogin) ? botLogin!.slice(LIMN_BOT_LOGIN_PREFIX.length) : null;
}

/** The bot's display name: "Limn · alice". */
export function limnBotLabel(posterLogin: string): string {
  return `${PRODUCT_NAME} · ${posterLogin}`;
}

/** `ml_comment_labels.backend` / `model_version` of a label written from a finding's own lead. */
export const LIMN_LABEL_BACKEND = 'limn-review';
export const LIMN_LABEL_MODEL_VERSION = 'limn-finding-v1';
