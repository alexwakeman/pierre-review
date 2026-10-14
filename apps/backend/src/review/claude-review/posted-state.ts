// WHAT IS ALREADY ON GITHUB — the one answer to "is this finding posted?" that the Claude Review tab,
// both manual Post routes and auto-posting share (docs/CLAUDE-REVIEW.md § Auto-posting, "Never twice").
//
// A finding's own `posted_at` is not the whole truth. Two real ways it lies (PR 4 of
// DEFRA/bng-metric-template, 2026-10-14):
//   1. A LOST ANSWER. GitHub answered an auto post's review POST with 422 "An internal error
//      occurred" AND published the review. The run was recorded as failed, the finding stayed
//      unposted, and the reader posted the same comment again by hand. The seam now reads the
//      review back (post-seam.ts `findLandedReview`); this module is the second net — a synced
//      comment of Limn's carrying the finding's text, new since the run started and not claimed by
//      any other posted finding, IS this finding's post, and the row is STAMPED (`stampsFor`).
//   2. A RE-RAISE. A later run raises a still-open point again as a NEW finding row
//      (`prior_finding_id`). Auto-posting already skipped it (its chain is on GitHub), but the tab
//      showed it unposted with a Post button, and the reader posted it a second time. Such a finding
//      now carries `earlierPost` (computed on read, never stored): shown as posted, linked to the
//      earlier comment, and refused by both post routes.
//
// ⚠ Only a STAMP writes. `earlierPost` stays derived, so the follow-up chain, auto resolve and
// pushback keep reading the row that really posted (stamping a re-raise would hand two rows one
// GitHub thread).
import { AUTO_POST_FOOTER, type ClaudeFindingEarlierPost } from '@pierre-review/shared';
import { findFindingThread, type ThreadComment } from './finding-thread.js';
import { resolveFindingBody } from './follow-up.js';

const norm = (t: string): string => t.replace(/\r\n?/g, '\n').trim();
// The same prefix `isLimnPostedComment` reads (db/review-threads-for-review.ts).
const LIMN_MARKER = /<!--\s*pierre:claude-review/i;

/** One finding of the PR (any run), as this module reads it. */
export interface PostedStateFinding {
  id: number;
  reviewId: number;
  path: string;
  /** The finding's line (null = file-level). Optional so a caller without it matches on text alone. */
  line?: number | null;
  body: string;
  editedBody: string | null;
  priorFindingId: number | null;
  postedAt: Date | null;
  githubCommentId: string | null;
  postedCommentKind: 'inline' | 'pr_comment' | null;
  postedAuto: boolean | null;
  /** The comments of this finding's REMINDERS ("Post reminder"), latest and earlier. Never this or
   *  any other finding's own post: they are CLAIMED, so no stamp or `earlierPost` can land on one. */
  reminderCommentIds?: readonly string[];
}

/** Comment ids of every REMINDER on the PR — never a candidate for a finding's own post. */
function reminderCommentIds(input: Pick<PostedStateInput, 'findings'>): Set<string> {
  const out = new Set<string>();
  for (const f of input.findings) for (const id of f.reminderCommentIds ?? []) out.add(id);
  return out;
}

/** One synced PR-level comment. */
export interface PrLevelComment {
  databaseId: string | null;
  body: string | null;
  authorLogin: string | null;
  createdAt: number; // ms
}

export interface PostedStateInput {
  // Every finding of the PR, every run.
  findings: readonly PostedStateFinding[];
  // When each run started (ms), by review id.
  runStartedAt: ReadonlyMap<number, number>;
  /** `line` = GitHub's current line for the thread (null when outdated). */
  threads: ReadonlyArray<{ id: number; path: string; line?: number | null }>;
  threadComments: readonly ThreadComment[];
  prComments: readonly PrLevelComment[];
  accountLogin: string | null;
}

/** A comment of Limn's on GitHub that carries a finding's text. */
export interface OwnComment {
  commentId: string;
  kind: 'inline' | 'pr_comment';
  createdAt: number;
  auto: boolean;
}

/** A stamp: this unposted finding's own post, found on GitHub. */
export interface PostedStamp {
  findingId: number;
  githubCommentId: string;
  postedCommentKind: 'inline' | 'pr_comment';
  postedAt: Date;
  postedAuto: boolean;
}

const isOwn = (login: string | null, author: string | null): boolean =>
  login != null && author != null && login.toLowerCase() === author.toLowerCase();

/**
 * The comment of Limn's on the PR that carries this finding's text, or null. Inline: the root of a
 * thread on the same file and line (the shared `findFindingThread` matcher). PR-level: a comment
 * naming the file and line whose text contains the finding's. `exclude` = comment ids that are not candidates.
 */
export function findOwnComment(
  f: Pick<PostedStateFinding, 'path' | 'line' | 'body' | 'editedBody'>,
  input: Pick<PostedStateInput, 'threads' | 'threadComments' | 'prComments' | 'accountLogin'>,
  exclude: ReadonlySet<string> = new Set(),
): OwnComment | null {
  const login = input.accountLogin;
  if (!login) return null;
  const text = norm(resolveFindingBody(f));
  if (text === '') return null;
  const roots = new Map<number, ThreadComment>();
  for (const c of input.threadComments) {
    const r = roots.get(c.threadId);
    if (!r || c.createdAt < r.createdAt) roots.set(c.threadId, c);
  }
  const taken = new Set<number>();
  for (const [threadId, root] of roots) if (root.databaseId != null && exclude.has(root.databaseId)) taken.add(threadId);
  if (f.path !== '') {
    const t = findFindingThread({ ...f, githubCommentId: null }, input.threads, input.threadComments, login, taken);
    const root = t ? roots.get(t.id) : undefined;
    if (root?.databaseId != null) {
      return { commentId: root.databaseId, kind: 'inline', createdAt: root.createdAt, auto: (root.body ?? '').includes(AUTO_POST_FOOTER) };
    }
  }
  for (const c of input.prComments) {
    if (c.databaseId == null || exclude.has(c.databaseId) || !isOwn(login, c.authorLogin)) continue;
    const body = norm(c.body ?? '');
    if (!LIMN_MARKER.test(body) || !body.includes(text)) continue;
    // The file AND line reference `prLevelFindingBody` opens with: the same words about another line
    // are another finding.
    if (f.path !== '' && !body.includes(f.line != null ? `\`${f.path}:${f.line}\`` : `\`${f.path}\``)) continue;
    return { commentId: c.databaseId, kind: 'pr_comment', createdAt: c.createdAt, auto: body.includes(AUTO_POST_FOOTER) };
  }
  return null;
}

/** The comment ids POSTED findings of the PR already own (stored ids, else their matched thread root). */
export function claimedCommentIds(input: PostedStateInput): Set<string> {
  // A reminder's comment repeats the finding's text on the same line — claimed, or it would read as
  // a lost post (a stamp) of the next run's re-raise.
  const out = reminderCommentIds(input);
  const bare: PostedStateFinding[] = [];
  for (const f of input.findings) {
    if (f.postedAt == null) continue;
    if (f.githubCommentId != null) out.add(f.githubCommentId);
    else if (f.postedCommentKind === 'inline') bare.push(f);
  }
  for (const f of bare) {
    const m = findOwnComment(f, input, out);
    if (m?.kind === 'inline') out.add(m.commentId);
  }
  return out;
}

/**
 * This run's unposted findings whose OWN post is on GitHub: a comment of Limn's with the finding's
 * text, made since the run started, that no posted finding of the PR owns. Each comment stamps at
 * most one finding.
 */
export function stampsFor(input: PostedStateInput, reviewId: number): PostedStamp[] {
  const started = input.runStartedAt.get(reviewId);
  if (started == null) return [];
  const claimed = claimedCommentIds(input);
  const out: PostedStamp[] = [];
  for (const f of input.findings) {
    if (f.reviewId !== reviewId || f.postedAt != null) continue;
    const m = findOwnComment(f, input, claimed);
    if (m == null || m.createdAt < started) continue;
    // A LATER run that had started by the time the comment was made, with an unposted finding the
    // same comment matches, is the likelier owner — never this one.
    const laterOwner = input.findings.some((g) => {
      if (g.reviewId === reviewId || g.postedAt != null) return false;
      const gs = input.runStartedAt.get(g.reviewId);
      if (gs == null || gs <= started || gs > m.createdAt) return false;
      return findOwnComment(g, input, claimed)?.commentId === m.commentId;
    });
    if (laterOwner) continue;
    claimed.add(m.commentId);
    out.push({ findingId: f.id, githubCommentId: m.commentId, postedCommentKind: m.kind, postedAt: new Date(m.createdAt), postedAuto: m.auto });
  }
  return out;
}

/**
 * `earlierPost` for each of this run's unposted findings whose point is already on GitHub: the
 * first POSTED finding up its follow-up chain, else a comment of Limn's carrying its text.
 * Call after the stamps are applied (a stamped finding is posted itself).
 */
export function earlierPostsFor(input: PostedStateInput, reviewId: number): Map<number, ClaudeFindingEarlierPost> {
  const byId = new Map(input.findings.map((f) => [f.id, f]));
  const out = new Map<number, ClaudeFindingEarlierPost>();
  const siblingClaimed = new Set([
    ...input.findings.filter((g) => g.reviewId === reviewId && g.postedAt != null && g.githubCommentId != null).map((g) => g.githubCommentId!),
    // A reminder is never the earlier post: that is the comment it links to.
    ...reminderCommentIds(input),
  ]);
  for (const f of input.findings) {
    if (f.reviewId !== reviewId || f.postedAt != null) continue;
    let next = f.priorFindingId;
    const seen = new Set<number>([f.id]);
    let hit: PostedStateFinding | null = null;
    while (next != null && !seen.has(next)) {
      seen.add(next);
      const e = byId.get(next);
      if (!e) break;
      if (e.postedAt != null) {
        hit = e;
        break;
      }
      next = e.priorFindingId;
    }
    if (hit) {
      out.set(f.id, {
        findingId: hit.id,
        githubCommentId: hit.githubCommentId,
        postedCommentKind: hit.postedCommentKind,
        postedAt: hit.postedAt!.toISOString(),
        postedAuto: hit.postedAuto === true,
      });
      continue;
    }
    // A comment a SIBLING of this run posted is that sibling's, never this finding's earlier post.
    const m = findOwnComment(f, input, siblingClaimed);
    if (m) {
      out.set(f.id, {
        findingId: null,
        githubCommentId: m.commentId,
        postedCommentKind: m.kind,
        postedAt: new Date(m.createdAt).toISOString(),
        postedAuto: m.auto,
      });
    }
  }
  return out;
}

/**
 * Of the findings an auto post TRIED (`triedIds`, its record's `findingIds`), the ones GitHub holds
 * a post of from that attempt: posted by the row itself, or — the lost-answer case where a person
 * then posted it again by hand — an UNCLAIMED comment of Limn's with its text, made since the run
 * started. Lets a `failed` record be corrected to what GitHub really took.
 */
export function landedAutoPosts(input: PostedStateInput, reviewId: number, triedIds: readonly number[]): number[] {
  const started = input.runStartedAt.get(reviewId);
  const claimed = claimedCommentIds(input);
  const byId = new Map(input.findings.map((f) => [f.id, f]));
  const out: number[] = [];
  for (const id of triedIds) {
    const f = byId.get(id);
    if (!f || f.reviewId !== reviewId) continue;
    if (f.postedAt != null && f.postedAuto === true) {
      out.push(id);
      continue;
    }
    if (started == null) continue;
    const m = findOwnComment(f, input, claimed);
    if (m != null && m.auto && m.createdAt >= started) {
      claimed.add(m.commentId);
      out.push(id);
    }
  }
  return out;
}

// A REMINDER's first line ("Post reminder" on an already-posted finding): says it is a reminder and
// links the earlier comment. Rides as the comment's LEAD (before any story lead), so the hidden marker
// and any footer stay where every finding comment has them.
export function reminderLead(earlier: { url: string | null; postedAt: string | null }): string {
  const d = earlier.postedAt != null ? new Date(earlier.postedAt) : null;
  const day =
    d != null && !Number.isNaN(d.getTime())
      ? `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`
      : null;
  if (earlier.url != null) return `**Reminder:** first raised [${day != null ? `on ${day}` : 'earlier'}](${earlier.url}).`;
  return day != null ? `**Reminder:** first raised on ${day}.` : '**Reminder:** raised earlier on this PR.';
}

/** The GitHub permalink of a posted finding comment. */
export function findingCommentUrl(
  pr: { owner: string; name: string; prNumber: number },
  c: { githubCommentId: string | null; postedCommentKind: 'inline' | 'pr_comment' | null },
): string | null {
  if (c.githubCommentId == null) return null;
  const base = `https://github.com/${pr.owner}/${pr.name}/pull/${pr.prNumber}`;
  return c.postedCommentKind === 'pr_comment' ? `${base}#issuecomment-${c.githubCommentId}` : `${base}#discussion_r${c.githubCommentId}`;
}
