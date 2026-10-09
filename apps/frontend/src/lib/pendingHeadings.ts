import type {
  AutomatedReviewerKind,
  CiFailingCard,
  InsightCard,
  InsightPrRef,
  MergeQueueEntryState,
  MyLastAction,
  MyTurnCard,
  MyTurnTrunkCard,
  PrAutomation,
  ClaudeReviewVerdict,
} from '@pierre-review/shared';
import { automatedReviewerMeta } from './ui.js';
import { CLAUDE_VERDICT_LABEL } from './claudeReviewColumn.js';
import {
  cardKindLabel,
  pendingQueueBadge,
  SECURITY_ALERT_SOURCE_LABEL,
} from '../components/Activity/pendingLabels.js';

// THE PENDING CARD'S FIRST TWO LINES, composed here and nowhere else (layout B, "Balanced").
//
//   1. THE HEADING — what happened, who did it, the quote when there is one, and the time ONCE:
//        David Buckley replied: "that probably makes sense…" · 2d
//   2. THE ACTION LINE — what to do and where:
//        [In your repos] [muted] Reply or resolve · your comment on app/x.ts · on <PR title> · repo#352
//
// ⚠ PURE AND FED ONLY THE CARD. Nothing here fetches, and nothing reads a store: the board may not
// fetch on mount, and a heading that needed a request would be a heading that flickers.
//
// ⚠ THE SERVER'S `detail` IS NOT REWRITTEN. Slack, the browser notification and the work plan
// print it verbatim, so it stays as it is; the heading is composed HERE from the card's facts
// (`reply`, `ball`, `reason`, the optional heading facts). `detail` is read only where it is the
// one place a fact lives (a base branch name, "N others also requested"), and only to lift that
// fact out — never printed whole, because it carries an @login and a second clock.
//
// ⚠ ABSENT IS "NOT KNOWN". Every optional heading fact (`mentionExcerpt`, `threadPath`,
// `committerId`, `firstComment`, `newActorIds`, `requesterId`) drops the clause that needed it. Nothing prints a
// placeholder, and a missing actor reads "Someone", never "user 12" and never an @login.
//
// ⚠ A REPO-GRAINED CARD IS NOT A PR. A red default branch (`trunk_red`, `ci_failing`'s trunk arm)
// is headed by its branch and repository, and nothing on it says "PR" except the landing PR line.

/** Characters of quote a heading carries before it is cut on a word boundary. The heading is also
 *  clamped to two lines in CSS; this keeps the text node short enough that the clamp rarely bites. */
export const HEADING_QUOTE_MAX_CHARS = 120;

/** Resolves a user id to the name a heading prints: the display name, else the login. null when the
 *  id is null or not in the response's users table — the heading then says "Someone". */
export type NameOf = (id: number | null | undefined) => string | null;

export interface HeadingContext {
  nameOf: NameOf;
  /** The Pending tab on screen. Inside My turn the tab already says "your turn", so the action line
   *  drops that label; "In your repos" and the neutral label stay. */
  tab?: string | null;
  /** The viewer's own user id, when known — lets a conflicts card say "Your PR". */
  viewerId?: number | null;
  /** The owner every repository on the board shares, or null. Dropped from `repo#N`. */
  sharedOwner?: string | null;
  /**
   * The merge queue's line for a card whose merge row decides it (newer of the card and a cached
   * live answer). Undefined = use the card's own synced field. null = not queued.
   */
  queueLine?: string | null;
  now?: number;
}

/** A plain-text quote in a heading. */
export interface HeadingQuote {
  text: string;
  /** The quote was cut here (or arrived cut): the event's content block can show the rest. */
  cut: boolean;
}

export interface PendingHeading {
  /** The words before the quote, e.g. "David Buckley replied". Never empty. */
  lead: string;
  quote: HeadingQuote | null;
  /** The instant the trailing "· 2d" measures, or null for a heading with no clock of its own. */
  at: string | null;
  /** A word before the age ("opened 9d"); null = the bare age. */
  atPrefix: string | null;
}

/** One clause of the action line. `mono` marks a path or a sha; `href` makes it a link (a red
 *  trunk's sha opens the commit, where its checks live). */
export interface ActionClause {
  text: string;
  mono?: boolean;
  href?: string;
}

export interface PendingActionLine {
  /** "In your repos" / the neutral kind label / "Your turn" outside My turn; null for none. */
  label: string | null;
  /** The repo is muted for Pending: one grey word. Display only. */
  muted: boolean;
  /** The bold action verb ("Reply or resolve"). null on a card with nothing to do (review load). */
  verb: string | null;
  /** Clauses after the verb, before the PR, each separated by "·". */
  where: ActionClause[];
  /** Print the PR title (it opens Overview). False on a repo- or person-grained card. */
  showTitle: boolean;
  /** "on <title>" vs a bare title. */
  titleOn: boolean;
  /** "by <author>" after repo#N, when the author is not the heading's actor and not you. */
  by: string | null;
  /** Clauses after the PR reference ("1 other asked", "last commit 3h"). */
  after: ActionClause[];
}

// ── small pure helpers ───────────────────────────────────────────────────────────────────────

/**
 * MARKDOWN AND HTML TO ONE LINE OF PLAIN TEXT. A heading quote is a text node, so every bit of
 * syntax a reader would see as noise goes: fenced code, quoted lines (a quote-reply repeats YOUR
 * words back), images, link targets, tags, emphasis marks, list bullets, heading hashes.
 */
export function markdownToPlain(md: string): string {
  return (
    md
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .split('\n')
      .filter((line) => !/^\s*>/.test(line))
      .join('\n')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Cut plain text to `max` characters on a word boundary, marking the cut with "…". */
export function clipText(text: string, max: number = HEADING_QUOTE_MAX_CHARS): HeadingQuote {
  const t = text.trim();
  if (t.length <= max) return { text: t, cut: false };
  const slice = t.slice(0, max);
  const space = slice.lastIndexOf(' ');
  const body = (space > max * 0.6 ? slice.slice(0, space) : slice).replace(/[\s,.;:!?—-]+$/, '');
  return { text: `${body}…`, cut: true };
}

/** A quote from a markdown body, or null when nothing readable is left. */
export function quoteFromMarkdown(
  body: string | null | undefined,
  arrivedCut = false,
): HeadingQuote | null {
  if (body == null) return null;
  const plain = markdownToPlain(body);
  if (plain === '') return null;
  const q = clipText(plain);
  return { text: q.text, cut: q.cut || arrivedCut };
}

/** A quote from an already-plain server excerpt (`CardExcerpt`). */
function quoteFromExcerpt(
  ex: { text: string; truncated: boolean } | null | undefined,
): HeadingQuote | null {
  if (ex == null) return null;
  const t = ex.text.replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  const q = clipText(t);
  return { text: q.text, cut: q.cut || ex.truncated };
}

/** The short age a heading ends on: "now", "14m", "4h", "2d". null when unreadable. */
export function compactAge(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (iso == null) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ms = Math.max(0, now - t);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (ms < min) return 'now';
  if (ms < hr) return `${Math.round(ms / min)}m`;
  if (ms < day) return `${Math.round(ms / hr)}h`;
  return `${Math.round(ms / day)}d`;
}

/** The owner every name shares ("DEFRA" for DEFRA/a + DEFRA/b), or null when they differ. */
export function sharedRepoOwner(repoFullNames: readonly string[]): string | null {
  let owner: string | null = null;
  for (const name of repoFullNames) {
    const slash = name.indexOf('/');
    if (slash <= 0) return null;
    const o = name.slice(0, slash);
    if (owner == null) owner = o;
    else if (owner !== o) return null;
  }
  return owner;
}

/** The repository as the board prints it: the org prefix dropped when every card shares it. */
export function repoShortName(repoFullName: string, sharedOwner: string | null | undefined): string {
  if (sharedOwner != null && repoFullName.startsWith(`${sharedOwner}/`)) {
    return repoFullName.slice(sharedOwner.length + 1);
  }
  return repoFullName;
}

/** `bng-metric-frontend#352`. */
export function repoRef(
  repoFullName: string,
  prNumber: number,
  sharedOwner: string | null | undefined,
): string {
  return `${repoShortName(repoFullName, sharedOwner)}#${prNumber}`;
}

/** "Alice", "Alice and Bob", "Alice, Bob and 2 others". `total` is the uncapped count when known. */
export function joinNames(names: readonly string[], total: number = names.length): string {
  const shown = names.filter((n) => n !== '');
  const others = Math.max(0, total - shown.length);
  if (shown.length === 0) return others > 0 ? `${others} ${others === 1 ? 'person' : 'people'}` : '';
  if (others > 0) return `${shown.join(', ')} and ${others} other${others === 1 ? '' : 's'}`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** Vendor kinds that name no product. */
const UNBRANDED: ReadonlySet<AutomatedReviewerKind> = new Set<AutomatedReviewerKind>([
  'in_house',
  'vendor',
  'pierre',
]);

/** A vendor's brand ("Dependabot"), or null for an unbranded kind. */
export function brandName(kind: AutomatedReviewerKind | null | undefined): string | null {
  return kind != null && !UNBRANDED.has(kind) ? automatedReviewerMeta(kind).label : null;
}

/** Who opened a PR, as a heading names them: the vendor's brand, else the account's name. */
export function authorName(
  pr: { authorId: number | null; automation?: PrAutomation | null },
  nameOf: NameOf,
): string | null {
  return brandName(pr.automation?.kind) ?? nameOf(pr.authorId);
}

/** "David Buckley's", "Dependabot's" — the possessive, without a doubled "s's" spelling trap. */
function possessive(name: string): string {
  return name.endsWith('s') ? `${name}’` : `${name}’s`;
}

const LAST_ACTION_PAST: Record<MyLastAction, string> = {
  approved: 'approved',
  changes_requested: 'requested changes',
  reviewed: 'reviewed',
  commented: 'commented',
  pushed: 'pushed',
};

/** A `likely_addressed` thread card: no reply rides it, and the commit is the event. */
export function isLikelyAddressed(card: MyTurnCard): boolean {
  if (card.reason !== 'thread' || card.reply != null) return false;
  return card.committerId != null || card.detail.startsWith('A later commit touched');
}

/** The path a thread card is about: the heading fact, else the promoted card's own copy, else the
 *  one the likely_addressed sentence names. */
function threadPathOf(card: MyTurnCard): string | null {
  if (card.threadPath != null && card.threadPath !== '') return card.threadPath;
  if (card.own?.kind === 'thread') return card.own.path;
  const m = /^A later commit touched (.+) — /.exec(card.detail);
  return m?.[1] ?? null;
}

/** The base branch a "Conflicts with main" sentence names, or null. */
function conflictBase(detail: string): string | null {
  const m = /^Conflicts with (.+)$/.exec(detail.trim());
  const base = m?.[1]?.trim();
  return base == null || base === '' || base === 'the base branch' ? null : base;
}

/** The branch a red-trunk sentence names ("You maintain this repo — main is red at f48aec5"). */
function trunkBranch(detail: string): string | null {
  const m = /(?:^|— )(\S+) is red\b/.exec(detail);
  return m?.[1] ?? null;
}

/** "N other reviewers also requested" — lifted from the review-request sentence. */
function alsoRequested(detail: string): number {
  const m = /· (\d+) other reviewers? also requested/.exec(detail);
  return m == null ? 0 : Number(m[1]);
}

/** The verdict a "Claude review ready · COMMENT · head moved since" sentence names. */
function claudeVerdictOf(detail: string): string | null {
  const parts = detail.split(' · ').slice(1);
  const v = parts.find((p) => p !== 'head moved since');
  if (v == null) return null;
  return CLAUDE_VERDICT_LABEL[v as ClaudeReviewVerdict] ?? v;
}

/** "3 new comments · 1 new review · 2 new commits" → "3 new comments, 1 new review and 2 new commits". */
function joinSummary(summary: string): string {
  const parts = summary.split(' · ').map((s) => s.trim()).filter((s) => s !== '');
  return joinNames(parts);
}

/**
 * A check name with its repeated path segments collapsed: GitHub names an Actions job
 * "<workflow> / <job>", and when the two are the same the card read "Run Journey Tests / Run
 * Journey Tests". Only ADJACENT equal segments fold, so "build / test / build" keeps its shape.
 */
export function collapseCheckName(name: string): string {
  const parts = name.split(' / ').map((p) => p.trim());
  const out: string[] = [];
  for (const p of parts) if (p !== '' && out[out.length - 1] !== p) out.push(p);
  return out.length > 0 ? out.join(' / ') : name.trim();
}

/** The first failing check, collapsed, or null. */
function firstCheck(c: { failingChecks?: readonly string[] | null }): string | null {
  const n = (c.failingChecks ?? []).find((x) => x.trim() !== '');
  return n != null ? collapseCheckName(n) : null;
}

/** The queue line a card's heading leads with, or null when it is not queued. */
function queueHeading(
  card: Partial<Pick<InsightPrRef, 'inMergeQueue' | 'mergeQueueEntryState'>>,
  ctx: HeadingContext,
): string | null {
  if (ctx.queueLine !== undefined) return ctx.queueLine;
  return pendingQueueBadge(card)?.label ?? null;
}

/** "In the merge queue · running checks" → "is in the merge queue · running checks", for "Your PR …". */
function queueAsPredicate(line: string): string {
  return line.replace(/^In the/, 'is in the').replace(/^Leaving the/, 'is leaving the');
}

const SOMEONE = 'Someone';

/** The age of a server `ageHours`, as an instant. */
function agoIso(hours: number, now: number): string {
  return new Date(now - hours * 3_600_000).toISOString();
}

// ── the heading ──────────────────────────────────────────────────────────────────────────────

/** The heading for a red default branch: "main is red in bng-metric-frontend: Run Journey Tests". */
function trunkHeading(
  card: { repoFullName: string; detail: string; failingChecks?: readonly string[] | null },
  branch: string | null,
  ctx: HeadingContext,
): string {
  const b = branch ?? trunkBranch(card.detail) ?? 'The default branch';
  const check = firstCheck(card);
  const lead = `${b} is red in ${repoShortName(card.repoFullName, ctx.sharedOwner)}`;
  return check != null ? `${lead}: ${check}` : lead;
}

/** WHAT HAPPENED, for one card. */
export function pendingHeading(card: InsightCard, ctx: HeadingContext): PendingHeading {
  const now = ctx.now ?? Date.now();
  const plain = (lead: string, at: string | null, quote: HeadingQuote | null = null): PendingHeading => ({
    lead,
    quote,
    at,
    atPrefix: null,
  });
  const name = (id: number | null | undefined): string => ctx.nameOf(id) ?? SOMEONE;

  switch (card.kind) {
    case 'my_turn': {
      if (card.reason === 'trunk_red') {
        return plain(trunkHeading(card, card.branchName, ctx), card.observedAt ?? card.since);
      }
      return myTurnHeading(card, ctx);
    }
    case 'ci_failing':
      return card.arm === 'trunk'
        ? plain(trunkHeading(card, null, ctx), card.observedAt)
        : plain(ciRedLead(card), card.observedAt);
    case 'conflicts': {
      const base = conflictBase(card.detail);
      const whose =
        ctx.viewerId != null && card.authorId === ctx.viewerId
          ? 'Your PR'
          : `${possessive(authorName(card, ctx.nameOf) ?? SOMEONE)} PR`;
      return plain(`${whose} conflicts with ${base ?? 'its base branch'}`, null);
    }
    case 'stalled_review': {
      const who = [
        ...card.requestedReviewerIds.map((id) => ctx.nameOf(id) ?? ''),
        ...card.requestedTeamNames.map((t) => `@${t}`),
      ].filter((n) => n !== '');
      const total = card.requestedReviewerIds.length + card.requestedTeamNames.length;
      const age = compactAge(agoIso(card.ageHours, now), now) ?? `${card.ageHours}h`;
      const lead =
        total === 0
          ? `Waiting ${age} for a review`
          : `Waiting ${age} on ${joinNames(who.slice(0, 2), total)}`;
      return plain(lead, null);
    }
    case 'reviewer_routing':
      return { lead: 'Nobody was asked to review this', quote: null, at: card.openedAt, atPrefix: 'opened' };
    case 'reviewer_load': {
      const n = card.pendingCount;
      return plain(`${name(card.reviewerId)} has ${n} review${n === 1 ? '' : 's'} waiting`, null);
    }
    case 'untouched_thread': {
      const who = brandName(card.botKind) ?? ctx.nameOf(card.originalCommenterId) ?? 'A reviewer';
      return plain(
        `${possessive(who)} comment on ${card.path} has no reply`,
        card.firstComment?.at ?? agoIso(card.ageHours, now),
      );
    }
    case 'merge':
    case 'update_branch': {
      const q = queueHeading(card, ctx);
      if (q != null) return plain(q, null);
      if (card.kind === 'update_branch') return plain('Behind its base branch — GitHub blocks the merge', null);
      return plain(
        card.mergeStateStatus === 'unstable'
          ? 'Ready to merge · non-required checks are red'
          : 'Ready to merge',
        null,
      );
    }
    case 'security': {
      const q = card.dependencyUpdate ? queueHeading(card, ctx) : null;
      if (q != null) return plain(q, null);
      const id = card.advisoryIds[0] ?? null;
      const who = authorName(card, ctx.nameOf) ?? 'This PR';
      if (card.fix === 'proven') {
        return plain(id != null ? `${who} fixes ${id}` : `${who} fixes a known advisory`, card.lastCommitAt);
      }
      if (card.fix === 'inferred') {
        return plain(
          id != null ? `${who} likely fixes ${id}` : `${who} likely fixes a known advisory`,
          card.lastCommitAt,
        );
      }
      const alert = card.alerts[0];
      if (alert != null) {
        const source =
          alert.source === 'reviewer'
            ? (brandName(alert.vendorKind) ?? ctx.nameOf(alert.authorId) ?? 'A reviewer')
            : SECURITY_ALERT_SOURCE_LABEL[alert.source];
        const what = alert.advisoryIds[0] ?? id ?? 'a known advisory';
        return plain(`${source} flagged ${what}`, alert.at);
      }
      return plain(id != null ? `Flagged for ${id}` : 'Flagged for a known advisory', null);
    }
    case 'dependency_bump': {
      const q = queueHeading(card, ctx);
      if (q != null) return plain(q, null);
      const who = `${authorName(card, ctx.nameOf) ?? 'Dependency'} bump`;
      switch (card.depState) {
        case 'ready':
          return plain(
            card.mergeStateStatus === 'unstable'
              ? `${who} can land now · non-required checks are red`
              : `${who} can land now`,
            card.lastCommitAt,
          );
        case 'behind':
          return plain(`${who} is behind its base branch`, card.lastCommitAt);
        case 'conflicts':
          return plain(`${who} conflicts with ${conflictBase(card.detail) ?? 'its base branch'}`, card.lastCommitAt);
        case 'ci_red': {
          const check = firstCheck(card);
          return plain(check != null ? `${who} failed: ${check}` : `${who} failed its build`, card.lastCommitAt);
        }
        case 'needs_review':
          return plain(`${who} needs an approving review`, card.lastCommitAt);
        case 'blocked':
          return plain(`${who} is blocked`, card.lastCommitAt);
        default:
          return plain(`${who} is open`, card.lastCommitAt);
      }
    }
    default:
      return plain(cardKindLabel(card), null);
  }
}

/** "Your build failed: SonarCloud Code Analysis". */
function ciRedLead(c: { failingChecks?: readonly string[] | null }): string {
  const check = firstCheck(c);
  return check != null ? `Your build failed: ${check}` : 'Your build failed';
}

function myTurnHeading(card: MyTurnCard, ctx: HeadingContext): PendingHeading {
  const plain = (lead: string, at: string | null, quote: HeadingQuote | null = null): PendingHeading => ({
    lead,
    quote,
    at,
    atPrefix: null,
  });
  const name = (id: number | null | undefined): string => ctx.nameOf(id) ?? SOMEONE;
  switch (card.reason) {
    case 'thread': {
      if (isLikelyAddressed(card)) {
        const path = threadPathOf(card);
        const commit = card.committerId != null && ctx.nameOf(card.committerId) != null
          ? `A commit by ${ctx.nameOf(card.committerId)}`
          : 'A commit';
        return plain(
          path != null
            ? `${commit} changed ${path} after your comment`
            : `${commit} changed the file after your comment`,
          card.since,
        );
      }
      const reply = card.reply;
      if (reply == null) return plain('New reply in your thread', card.since);
      return plain(`${name(reply.authorId)} replied`, reply.at, quoteFromMarkdown(reply.body, reply.truncated));
    }
    case 'thread_reply': {
      const reply = card.reply;
      if (reply == null) return plain('New reply to your comment', card.since);
      return plain(
        `${name(reply.authorId)} replied to your comment`,
        reply.at,
        quoteFromMarkdown(reply.body, reply.truncated),
      );
    }
    case 'comment_reply': {
      const reply = card.reply;
      // The commenter is named only in `detail` when no body rode the card — never lift an @login.
      if (reply == null) return plain('New comment after yours', card.since);
      return plain(
        `${name(reply.authorId)} commented after you`,
        reply.at,
        quoteFromMarkdown(reply.body, reply.truncated),
      );
    }
    case 'mention':
      return plain(
        card.mentionedById != null ? `${name(card.mentionedById)} mentioned you` : 'You were mentioned',
        card.since,
        quoteFromExcerpt(card.mentionExcerpt),
      );
    case 'review_request': {
      // Who ASKED, when the synced history says (`requesterId`); a name we cannot resolve drops
      // back to the passive sentence rather than "Someone asked you".
      const asker = card.requesterId != null ? ctx.nameOf(card.requesterId) : null;
      return plain(asker != null ? `${asker} asked you to review` : 'Your review was requested', card.since);
    }
    case 'pushed_since': {
      const ball = card.ball;
      const n = ball?.humanCommitsAfter ?? ball?.commits?.length ?? 0;
      const commits = n > 0 ? `${n} commit${n === 1 ? '' : 's'}` : 'new commits';
      const since = ball?.yourLastAction != null ? ` since you ${LAST_ACTION_PAST[ball.yourLastAction]}` : ' since you last looked';
      const pusher = ball?.pusherId != null ? ctx.nameOf(ball.pusherId) : null;
      return plain(
        pusher != null ? `${pusher} pushed ${commits}${since}` : `${n > 0 ? commits : 'New commits'} pushed${since}`,
        card.since,
      );
    }
    case 'watched_repo_pr':
      return plain(`${authorName(card, ctx.nameOf) ?? SOMEONE} opened a new PR`, card.since);
    case 'your_pr': {
      const what = joinSummary(card.detail);
      return plain(what !== '' ? `${what} on your PR` : 'New activity on your PR', card.since);
    }
    case 'pr_approved': {
      const approvers = card.reviewers
        .filter((r) => r.standing === 'approved')
        .map((r) => (r.isBot ? (brandName(r.botKind) ?? ctx.nameOf(r.userId)) : ctx.nameOf(r.userId)))
        .filter((n): n is string => n != null);
      const total = Math.max(card.reviewApprovals, approvers.length);
      const conflicts = card.detail.endsWith(' · conflicts') ? ', but it has conflicts' : '';
      const lead =
        approvers.length > 0
          ? `${joinNames(approvers.slice(0, 2), total)} approved your PR${conflicts}`
          : total > 0
            ? `Your PR has ${total} approval${total === 1 ? '' : 's'}${conflicts}`
            : `Your PR was approved${conflicts}`;
      return plain(lead, card.since);
    }
    case 'own_ready': {
      const q = queueHeading(card, ctx);
      if (q != null) return plain(`Your PR ${queueAsPredicate(q)}`, null);
      if (card.own?.kind === 'ready' && card.own.forward === 'update_branch') {
        return plain('Your PR is behind its base branch', null);
      }
      const ms = card.own?.kind === 'ready' ? card.own.mergeStateStatus : null;
      return plain(
        ms === 'unstable' ? 'Your PR can land now · non-required checks are red' : 'Your PR can land now',
        null,
      );
    }
    case 'own_conflicts':
      return plain(`Your PR conflicts with ${conflictBase(card.detail) ?? 'its base branch'}`, card.since);
    case 'own_ci_red':
      return plain(ciRedLead(card), card.since);
    case 'own_thread': {
      const own = card.own?.kind === 'thread' ? card.own : null;
      const who =
        brandName(own?.botKind) ??
        ctx.nameOf(own?.originalCommenterId ?? card.firstComment?.authorId) ??
        'A reviewer';
      const path = threadPathOf(card);
      return plain(
        path != null ? `${possessive(who)} comment on ${path} has no reply` : `${possessive(who)} comment has no reply`,
        card.since,
      );
    }
    case 'claude_review': {
      const verdict = claudeVerdictOf(card.detail);
      const auto = card.trigger === 'auto';
      const lead =
        verdict != null
          ? `${auto ? 'Claude’s auto review' : 'Claude reviewed'}: ${verdict}`
          : auto
            ? 'Claude’s auto review finished'
            : 'Claude finished a review';
      return plain(lead, card.since);
    }
    default: {
      const _x: never = card.reason;
      return plain(card.detail, card.since);
    }
  }
}

// ── the action line ──────────────────────────────────────────────────────────────────────────

/** The relevance label a my_turn card's action line starts with, or null. */
export function pendingRelevanceLabel(
  card: MyTurnCard | MyTurnTrunkCard,
  tab: string | null | undefined,
): string | null {
  // ⚠ ABSENT relevance is NEUTRAL — the same rule `cardKindLabel` follows: a missing field may
  // never invent an ownership claim on screen.
  // Inside My turn and Claude reviews the tab already says it is yours.
  if (card.relevance === 'direct') return tab === 'my_turn' || tab === 'claude' ? null : 'Your turn';
  return cardKindLabel(card);
}

const DEP_VERB: Record<string, string> = {
  ready: 'Merge it',
  behind: 'Update branch',
  conflicts: 'Resolve conflicts',
  ci_red: 'Fix the build',
  needs_review: 'Review it',
  blocked: 'See what blocks it',
  unknown: 'Open it',
};

/** A Dependencies card's verb. The two that are a press of the merge row ("Merge it", "Update
 *  branch") drop when the viewer cannot push, because the row is hidden then. */
function depVerb(state: string, viewerCanPush: boolean): string | null {
  if (!viewerCanPush && (state === 'ready' || state === 'behind')) return null;
  return DEP_VERB[state] ?? 'Open it';
}

/** WHAT TO DO, AND WHERE, for one card. */
export function pendingActionLine(card: InsightCard, ctx: HeadingContext): PendingActionLine {
  const now = ctx.now ?? Date.now();
  const base: PendingActionLine = {
    label: null,
    muted: false,
    verb: null,
    where: [],
    showTitle: true,
    titleOn: true,
    by: null,
    after: [],
  };
  const byAuthor = (pr: { authorId: number | null; automation?: PrAutomation | null }): string | null => {
    if (ctx.viewerId != null && pr.authorId === ctx.viewerId) return null;
    return authorName(pr, ctx.nameOf);
  };
  const lastCommit = (iso: string | null | undefined): ActionClause[] => {
    const a = compactAge(iso, now);
    return a != null ? [{ text: `last commit ${a}` }] : [];
  };

  switch (card.kind) {
    case 'my_turn': {
      const label = pendingRelevanceLabel(card, ctx.tab);
      const muted = card.muted === true;
      if (card.reason === 'trunk_red') {
        return {
          ...base,
          label,
          muted,
          verb: 'Fix it or chase it',
          where: [
            ...(card.maintained ? [{ text: 'you maintain this repo' }] : []),
            ...(card.headSha != null
              ? [{ text: `at ${card.headSha.slice(0, 7)}`, mono: true, href: card.githubUrl }]
              : []),
          ],
          showTitle: false,
        };
      }
      const line = { ...base, label, muted };
      const path = threadPathOf(card);
      const pathClause = (prefix: string): ActionClause[] =>
        path != null
          ? [{ text: `${prefix}${path}${card.threadLine != null ? `:${card.threadLine}` : ''}`, mono: true }]
          : [];
      switch (card.reason) {
        case 'thread':
          return isLikelyAddressed(card)
            ? { ...line, verb: 'Check it answers you, then resolve' }
            : { ...line, verb: 'Reply or resolve', where: pathClause('your comment on ') };
        case 'thread_reply':
          return { ...line, verb: 'Reply or resolve', where: pathClause('your comment on ') };
        case 'comment_reply':
          return { ...line, verb: 'Answer on the PR' };
        case 'mention':
          return { ...line, verb: 'Read it and reply' };
        case 'review_request': {
          const others = alsoRequested(card.detail);
          // The author who asked is already the heading's actor: "by <them>" would say it twice.
          const authorAsked =
            card.requesterId != null &&
            card.requesterId === card.authorId &&
            ctx.nameOf(card.requesterId) != null;
          return {
            ...line,
            verb: 'Review it',
            titleOn: false,
            by: authorAsked ? null : byAuthor(card),
            after: others > 0 ? [{ text: `${others} other${others === 1 ? '' : 's'} asked` }] : [],
          };
        }
        case 'pushed_since':
          return { ...line, verb: 'Re-review the new commits' };
        case 'watched_repo_pr':
          return { ...line, verb: 'Take a first look', titleOn: false };
        case 'your_pr': {
          const ids = card.newActorIds ?? [];
          const names = ids.map((id) => ctx.nameOf(id)).filter((n): n is string => n != null);
          const from =
            names.length > 0 ? [{ text: `from ${joinNames(names, card.newActorTotal ?? names.length)}` }] : [];
          return { ...line, verb: 'Read what’s new', where: [...from, { text: 'clears when you open it' }] };
        }
        case 'pr_approved':
          return { ...line, verb: 'Open to merge' };
        case 'own_ready': {
          const queued = queueHeading(card, ctx) != null;
          const forward = card.own?.kind === 'ready' ? card.own.forward : 'merge';
          const canPush = card.own?.kind === 'ready' ? card.own.viewerCanPush : false;
          return {
            ...line,
            verb: queued ? 'Let it land' : !canPush ? null : forward === 'update_branch' ? 'Update branch' : 'Merge',
            after: lastCommit(card.own?.kind === 'ready' ? card.own.lastCommitAt : null),
          };
        }
        case 'own_conflicts':
          return { ...line, verb: 'Resolve conflicts' };
        case 'own_ci_red':
          return { ...line, verb: 'Fix the build' };
        case 'own_thread':
          return { ...line, verb: 'Reply on your PR' };
        case 'claude_review':
          return {
            ...line,
            verb: 'Read the review',
            where: card.detail.includes('head moved since') ? [{ text: 'new commits since' }] : [],
          };
        default: {
          const _x: never = card;
          return line;
        }
      }
    }
    case 'ci_failing':
      return card.arm === 'trunk'
        ? {
            ...base,
            verb: 'Fix it or chase it',
            where: [
              { text: 'you maintain this repo' },
              ...(card.headSha != null
                ? [{ text: `at ${card.headSha.slice(0, 7)}`, mono: true, href: card.githubUrl }]
                : []),
            ],
            showTitle: false,
          }
        : { ...base, verb: 'Fix the build', showTitle: card.prTitle != null };
    case 'conflicts':
      return { ...base, verb: 'Resolve conflicts', titleOn: false };
    case 'stalled_review':
      return { ...base, verb: 'Chase them or review it', titleOn: false, by: byAuthor(card) };
    case 'reviewer_routing':
      return { ...base, verb: 'Assign a reviewer', titleOn: false, by: byAuthor(card) };
    case 'reviewer_load': {
      const n = card.reviewsThisSprint;
      return { ...base, showTitle: false, where: [{ text: `${n} done this sprint` }] };
    }
    case 'untouched_thread':
      return { ...base, verb: 'Reply or resolve', by: byAuthor(card) };
    case 'merge':
    case 'update_branch': {
      const queued = queueHeading(card, ctx) != null;
      return {
        ...base,
        // ⚠ NO IMPERATIVE WITHOUT ITS BUTTON. The merge row is HIDDEN when the viewer cannot push
        // (`pendingMergeGate`), so "Merge" would be an instruction the card gives no way to follow;
        // the heading already states the fact ("can land now", "is behind main").
        verb: queued
          ? 'Let it land'
          : !card.viewerCanPush
            ? null
            : card.kind === 'update_branch'
              ? 'Update branch'
              : 'Merge',
        titleOn: false,
        by: byAuthor(card),
        after: lastCommit(card.lastCommitAt),
      };
    }
    case 'security': {
      const verb = card.dependencyUpdate
        ? queueHeading(card, ctx) != null
          ? 'Let it land'
          : card.depState === 'ready'
            ? card.viewerCanPush
              ? 'Merge the fix'
              : null
            : depVerb(card.depState ?? 'unknown', card.viewerCanPush)
        : 'Check the alert';
      return { ...base, verb, titleOn: false };
    }
    case 'dependency_bump': {
      const verb = queueHeading(card, ctx) != null ? 'Let it land' : depVerb(card.depState, card.viewerCanPush);
      return { ...base, verb, titleOn: false };
    }
    default:
      return { ...base, verb: null };
  }
}

/**
 * WHICH PR THE ACTION LINE NAMES — its title and `repo#N` — or null for a card about a repository
 * or a person. A PR card carries `InsightPrRef`; a red build on YOUR PR (`ci_failing`'s `your_pr`
 * arm) does not, but its own fields name the PR, so it still says which one ("Fix the build · on
 * <title> · repo#352"). Without them two red-build cards on the board would read the same.
 */
export function pendingCardPrLabel(
  card: InsightCard,
  sharedOwner: string | null | undefined,
): { title: string; ref: string } | null {
  if ('inMergeQueue' in card && 'prTitle' in card && 'prNumber' in card && 'repoFullName' in card) {
    const c = card as InsightCard & InsightPrRef;
    return { title: c.prTitle, ref: repoRef(c.repoFullName, c.prNumber, sharedOwner) };
  }
  if (card.kind === 'ci_failing' && card.arm === 'your_pr' && card.prTitle != null && card.prNumber != null) {
    return { title: card.prTitle, ref: repoRef(card.repoFullName, card.prNumber, sharedOwner) };
  }
  return null;
}

// ── which fact line, and what the whole card opens ───────────────────────────────────────────

/**
 * THE ONE FACT LINE a card carries, chosen by its JOB:
 *   'reply'  — CI + where the review stands (people events, your own PR, threads)
 *   'review' — CI · standing · reach word · code lines (review requests, new PRs, stalled, routing)
 *   'merge'  — CI · standing · reach (forward cards, conflicts, dependencies)
 *   'none'   — a CI card (the heading already says red) or a card with no PR
 */
export type PendingFactPlan = 'reply' | 'review' | 'merge' | 'none';

export function pendingFactPlan(card: InsightCard): PendingFactPlan {
  switch (card.kind) {
    case 'my_turn':
      switch (card.reason) {
        case 'trunk_red':
        case 'own_ci_red':
          return 'none';
        case 'review_request':
        case 'pushed_since':
        case 'watched_repo_pr':
          return 'review';
        case 'own_ready':
        case 'own_conflicts':
          return 'merge';
        default:
          return 'reply';
      }
    case 'ci_failing':
    case 'reviewer_load':
      return 'none';
    case 'stalled_review':
    case 'reviewer_routing':
      return 'review';
    case 'untouched_thread':
      return 'reply';
    default:
      return 'merge';
  }
}

/** Does this card's fact line state where the review stands? Not where the heading already said
 *  it: an approved PR, or a Dependencies card whose heading says it "needs an approving review".
 *  (A Needs-a-reviewer card drops only "No reviews yet" — see `factDropsNoReviews`.) */
export function factShowsStanding(card: InsightCard): boolean {
  if (card.kind === 'my_turn' && card.reason === 'pr_approved') return false;
  if ((card.kind === 'dependency_bump' || card.kind === 'security') && card.depState === 'needs_review') {
    return false;
  }
  return true;
}

/** "Nobody was asked to review this" already says nobody has reviewed: the fact line keeps
 *  GitHub's rule but not a "No reviews yet" beside it. */
export function factDropsNoReviews(card: InsightCard): boolean {
  return card.kind === 'reviewer_routing';
}

/** What a WHOLE-CARD click opens: the event, never just "the PR". */
export type PendingCardEvent =
  | { kind: 'thread'; threadId: number }
  | { kind: 'pr'; tab: 'overview' | 'activity' }
  | { kind: 'claude_review' }
  | { kind: 'external' }
  | { kind: 'landing_pr' }
  | { kind: 'none' };

export function pendingCardEvent(card: InsightCard): PendingCardEvent {
  switch (card.kind) {
    case 'my_turn':
      if (card.reason === 'trunk_red') return { kind: 'external' };
      if (
        card.threadId != null &&
        (card.reason === 'thread' || card.reason === 'thread_reply' || card.reason === 'own_thread')
      ) {
        return { kind: 'thread', threadId: card.threadId };
      }
      if (card.reason === 'claude_review') return { kind: 'claude_review' };
      if (
        card.reason === 'pushed_since' ||
        card.reason === 'comment_reply' ||
        card.reason === 'mention' ||
        // The heading announces new comments, reviews and commits — they live on Activity.
        card.reason === 'your_pr'
      ) {
        return { kind: 'pr', tab: 'activity' };
      }
      return { kind: 'pr', tab: 'overview' };
    case 'ci_failing':
      if (card.arm === 'trunk') return { kind: 'external' };
      return card.prId != null ? { kind: 'landing_pr' } : { kind: 'external' };
    case 'untouched_thread':
      return { kind: 'thread', threadId: card.threadId };
    case 'reviewer_load':
      return { kind: 'none' };
    default:
      return { kind: 'pr', tab: 'overview' };
  }
}

/** The failing checks the heading did NOT already name — the CI card's event content. With
 *  `headingNamedFirst: false` (a heading that names no check, e.g. a security card) every name. */
export function restOfFailingChecks(
  c: {
    failingChecks?: readonly string[] | null;
    failingCheckTotal?: number | null;
  },
  opts: { headingNamedFirst?: boolean } = {},
): { names: string[]; more: number } {
  const all = (c.failingChecks ?? []).filter((n) => n.trim() !== '');
  const rest = (opts.headingNamedFirst === false ? all : all.slice(1)).map(collapseCheckName);
  const total = c.failingCheckTotal ?? all.length;
  return { names: rest, more: Math.max(0, total - all.length) };
}

/** Is the card's reply worth a block under the heading? Only when the heading's quote was cut —
 *  a short reply already sits whole in the heading, and printing it twice is the noise this layout
 *  exists to remove. */
export function replyBlockShown(heading: PendingHeading, reply: { body: string } | null | undefined): boolean {
  if (reply == null) return false;
  if (heading.quote == null) return markdownToPlain(reply.body) !== '';
  return heading.quote.cut;
}

/** The trunk card's landing-PR line, as words: "#354 chore(deps): bump … by Dependabot, merged by
 *  Robin Dunn — not necessarily the cause". null when no PR landed the red head (a direct push). */
export function lastLandedLine(
  card: Pick<CiFailingCard, 'prId' | 'prNumber' | 'prTitle' | 'authorId' | 'automation' | 'mergedById'>,
  nameOf: NameOf,
): { pr: string; by: string | null; mergedBy: string | null } | null {
  if (card.prId == null || card.prNumber == null || card.prTitle == null) return null;
  const by = authorName(card, nameOf);
  const mergedBy = card.mergedById != null ? nameOf(card.mergedById) : null;
  return { pr: `#${card.prNumber} ${card.prTitle}`, by, mergedBy };
}

/** A queue entry's words for a card's fact line, from its synced fields — re-exported so the
 *  renderer and the tests read one spelling. */
export function queueFact(card: {
  inMergeQueue?: boolean | null;
  mergeQueueEntryState?: MergeQueueEntryState | null;
}): string | null {
  return pendingQueueBadge(card)?.label ?? null;
}
