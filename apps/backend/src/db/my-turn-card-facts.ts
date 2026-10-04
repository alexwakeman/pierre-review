// ── HEADING FACTS for Pending cards (CORE, no AI, no GitHub call) ─────────────────────────────
//
// The Pending board's cards lead with WHAT HAPPENED ("Robin Dunn mentioned you: …", "A commit by
// Priya changed src/app.ts after your comment"). The server's `detail` strings stay as they are —
// Slack and the notifications print them — so the SPA composes those headings itself, from the
// facts this module folds onto the cards:
//
//   • `mentionExcerpt`   — the comment that @-mentioned you                       (mention)
//   • `committerId`      — who wrote the first commit after your comment that
//                          changed the thread's file                               (thread, likely_addressed)
//   • `firstComment`     — the opening comment of an unanswered thread            (own_thread, untouched_thread)
//   • `newActorIds/Total`— who did the new things on your PR                       (your_pr)
//   • `requesterId`      — who asked you to review                                 (review_request)
//
// (`threadPath`, `threadLine` and `mentionedById` need no read: they ride the My Turn rows already.)
//
// ⚠ THE RULES, all four of which keep these off every path that matters:
//   1. SYNCED ROWS ONLY. Every reader below is a batched select over tables the sync writes — the
//      board may not fetch on mount, and it may not make the server fetch on its behalf either.
//   2. AFTER THE FOLD, NEVER IN IT — AND ONLY FOR WHAT IS LISTED. `getWorkspaceInsights` defers
//      these until the board has ranked and LISTED its cards (`BoardFactsSink`), so no fact can
//      add, drop or re-count a card, and the uncapped fold's ~1,600 unlisted cards cost nothing.
//   3. DISPLAY ONLY. Never in a `detail`, a payload hash, the work-plan hash or a model payload.
//   4. ABSENT IS "NOT KNOWN". A reader that cannot answer leaves the PR / thread out of its map;
//      the card then drops the clause, never prints a placeholder.
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import {
  CARD_EXCERPT_MAX_CHARS,
  YOUR_PR_NEW_ACTORS_SHOWN,
  type CardExcerpt,
  type CardThreadComment,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { mentionPattern, mentionsLogin, withoutQuotedLines } from './pr-mentions.js';

const {
  prComments,
  reviewComments,
  reviews,
  commits,
  commitFiles,
  events,
  prViews,
  reviewRequestEvents,
} = schema;

/** The review-request history keeps a PR's FIRST this-many events (the GraphQL selection's
 *  `first: 25`). A PR at the cap may have newer requests we never stored. */
export const REVIEW_REQUEST_HISTORY_CAP = 25;

// SQLite's default bound-variable limit is 999; every IN list below is chunked under it.
const ID_CHUNK = 500;

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += ID_CHUNK) out.push(xs.slice(i, i + ID_CHUNK));
  return out;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * Markdown → the plain text a heading can quote. Deliberately small: it removes what would read as
 * noise in one line (HTML and comments, image embeds, link targets, code fences and backticks,
 * heading / list / quote markers, emphasis markers) and keeps every word a person typed. It is not
 * a markdown renderer and must never be used as one.
 */
export function markdownToPlainText(md: string): string {
  let s = md.replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Fences: keep the code, drop the ``` lines (a ```suggestion block is the substance of a comment).
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*$/gm, ' ');
  s = s.replace(/<[^>\n]+>/g, ' ');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/`+([^`]*)`+/g, '$1');
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '');
  s = s.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
  s = s.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ' ');
  s = s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e);
  return s.replace(/\s+/g, ' ').trim();
}

/** Cut plain text to `max` characters on a word boundary when one is near, marking the cut. */
function cutAtWord(text: string, max: number): CardExcerpt {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max - 1);
  const space = cut.search(/\s\S*$/);
  if (space > (max - 1) * 0.7) cut = cut.slice(0, space);
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

/**
 * A stored comment body → the heading's quote. Null for a missing or blank body (unknown is never
 * an empty quote). With `focus` (a login), a mention that sits beyond the first stretch of a long
 * comment is brought into view: the excerpt starts a few words before it, marked with a leading
 * "…" — a quote that cuts off before the @-mention would not show what you were asked.
 */
export function cardExcerpt(
  body: string | null | undefined,
  opts: { max?: number; focusLogin?: string } = {},
): CardExcerpt | null {
  if (body == null) return null;
  const text = markdownToPlainText(body);
  if (text === '') return null;
  const max = opts.max ?? CARD_EXCERPT_MAX_CHARS;
  if (text.length <= max) return { text, truncated: false };
  if (opts.focusLogin) {
    const m = mentionPattern(opts.focusLogin).exec(text);
    if (m != null && m.index + m[0].length > max * 0.6) {
      // Back up ~40 characters, then forward to the next word start so no word is split.
      let start = Math.max(0, m.index - 40);
      if (start > 0) {
        const ws = text.slice(start, m.index).search(/\s/);
        start = ws >= 0 ? start + ws + 1 : m.index;
      }
      const tail = cutAtWord(text.slice(start), max - 1);
      return { text: `…${tail.text}`, truncated: true };
    }
  }
  return cutAtWord(text, max);
}

/** One mention card's lookup key: the PR, who mentioned you, and when (`pr_mentions.mentioned_at`). */
export interface MentionFactInput {
  prId: number;
  byId: number | null;
  at: Date;
}

/**
 * The comment that @-mentioned the viewer, per PR. Looked up in the SAME three tables the mention
 * scanner reads (a PR comment, an inline review comment, a review body), by the scanner's author,
 * through the scanner's own match rule on the TYPED lines — so the quote is the comment that made
 * the card, not a quote-reply of it. Prefers the row at exactly the stamped time; falls back to that
 * author's newest matching comment (the scanner may not have re-stamped yet). Missing ⇒ absent.
 */
export async function mentionExcerpts(
  inputs: readonly MentionFactInput[],
  login: string,
): Promise<Map<number, CardExcerpt>> {
  const out = new Map<number, CardExcerpt>();
  const wanted = inputs.filter((i) => i.byId != null);
  if (wanted.length === 0 || login === '') return out;
  const prIds = [...new Set(wanted.map((i) => i.prId))];
  const byIds = [...new Set(wanted.map((i) => i.byId as number))];
  type Row = { prId: number; authorId: number | null; body: string | null; at: Date };
  const rows: Row[] = [];
  for (const ids of chunks(prIds)) {
    const [pc, rc, rv] = await Promise.all([
      db
        .select({
          prId: prComments.prId,
          authorId: prComments.authorId,
          body: prComments.body,
          at: prComments.createdAt,
        })
        .from(prComments)
        .where(and(inArray(prComments.prId, ids), inArray(prComments.authorId, byIds)))
        .execute(),
      db
        .select({
          prId: reviewComments.prId,
          authorId: reviewComments.authorId,
          body: reviewComments.body,
          at: reviewComments.createdAt,
        })
        .from(reviewComments)
        .where(and(inArray(reviewComments.prId, ids), inArray(reviewComments.authorId, byIds)))
        .execute(),
      db
        .select({
          prId: reviews.prId,
          authorId: reviews.authorId,
          body: reviews.body,
          at: reviews.submittedAt,
        })
        .from(reviews)
        .where(and(inArray(reviews.prId, ids), inArray(reviews.authorId, byIds)))
        .execute(),
    ]);
    rows.push(...pc, ...rc, ...rv);
  }
  const byPr = new Map<number, Row[]>();
  for (const r of rows) {
    const arr = byPr.get(r.prId) ?? [];
    arr.push(r);
    byPr.set(r.prId, arr);
  }
  for (const i of wanted) {
    const typed = (byPr.get(i.prId) ?? [])
      .filter((r) => r.authorId === i.byId && r.body != null)
      .map((r) => ({ ...r, typed: withoutQuotedLines(r.body as string) }))
      .filter((r) => mentionsLogin(r.typed, login))
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    const hit = typed.find((r) => r.at.getTime() === i.at.getTime()) ?? typed[0];
    if (hit == null) continue;
    const excerpt = cardExcerpt(hit.typed, { focusLogin: login });
    if (excerpt != null) out.set(i.prId, excerpt);
  }
  return out;
}

/** One likely_addressed thread: its file, and the moment of YOUR comment the commit must follow. */
export interface AddressedCommitInput {
  threadId: number;
  prId: number;
  path: string;
  after: Date;
}

/**
 * Who wrote the FIRST commit on the PR after `after` whose stored file list includes `path` — the
 * same predicate `derive-thread-state.ts` flips a thread to `likely_addressed` on (strictly later,
 * exact path). Keyed by thread id. Absent when no such commit is stored (the heuristic also fires
 * on an outdated thread or a bot marker), when the commit's files were never fetched, or when its
 * author is unmapped. The AUTHOR, not GitHub's committer — the committer of a web edit or a merge is
 * GitHub itself.
 *
 * ⚠ `skipAuthorIds` is the ball rule's exclusions — the automation set (a bot's commit never
 * returns the ball) and the viewer (your own fix is not why the ball came back). A commit by one of
 * them is passed over for the first commit by anyone else; when only such commits touched the
 * file, the thread is absent and the heading says "A commit". An unattributed commit is passed
 * over too: it cannot be named.
 */
export async function addressedCommitAuthors(
  inputs: readonly AddressedCommitInput[],
  opts: { skipAuthorIds?: ReadonlySet<number> } = {},
): Promise<Map<number, number>> {
  const skip = opts.skipAuthorIds ?? new Set<number>();
  const out = new Map<number, number>();
  if (inputs.length === 0) return out;
  const prIds = [...new Set(inputs.map((i) => i.prId))];
  const minAfter = new Date(Math.min(...inputs.map((i) => i.after.getTime())));
  const commitRows: { prId: number; sha: string; authorId: number | null; at: Date }[] = [];
  for (const ids of chunks(prIds)) {
    commitRows.push(
      ...(await db
        .select({
          prId: commits.prId,
          sha: commits.sha,
          authorId: commits.authorId,
          at: commits.committedAt,
        })
        .from(commits)
        .where(and(inArray(commits.prId, ids), gt(commits.committedAt, minAfter)))
        .orderBy(asc(commits.committedAt))
        .execute()),
    );
  }
  if (commitRows.length === 0) return out;
  const pathsBySha = new Map<string, string[]>();
  for (const shas of chunks([...new Set(commitRows.map((c) => c.sha))])) {
    for (const r of await db
      .select({ sha: commitFiles.sha, paths: commitFiles.paths })
      .from(commitFiles)
      .where(inArray(commitFiles.sha, shas))
      .execute()) {
      pathsBySha.set(r.sha, r.paths);
    }
  }
  for (const i of inputs) {
    const first = commitRows.find(
      (c) =>
        c.prId === i.prId &&
        c.authorId != null &&
        !skip.has(c.authorId) &&
        c.at.getTime() > i.after.getTime() &&
        (pathsBySha.get(c.sha) ?? []).includes(i.path),
    );
    if (first?.authorId != null) out.set(i.threadId, first.authorId);
  }
  return out;
}

/** The opening comment of each thread (the oldest stored review comment), as a heading quote.
 *  Keyed by thread id; a thread with no stored comment, or only blank ones, is absent.
 *
 *  Reads ONE BODY PER THREAD: the ordering pass selects ids and timestamps only, then the bodies of
 *  each thread's earliest comment are read. A thread whose earliest body is blank moves on to its
 *  next comment in a further round (rare), so the result matches reading every body in order. */
export async function threadFirstComments(
  threadIds: readonly number[],
): Promise<Map<number, CardThreadComment>> {
  const out = new Map<number, CardThreadComment>();
  // Per thread, its comment ids oldest first (createdAt, then id — the old single-query order).
  const order = new Map<number, number[]>();
  for (const ids of chunks([...new Set(threadIds)])) {
    const rows = await db
      .select({ id: reviewComments.id, threadId: reviewComments.threadId })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, ids))
      .orderBy(asc(reviewComments.createdAt), asc(reviewComments.id))
      .execute();
    for (const r of rows) {
      const arr = order.get(r.threadId) ?? [];
      arr.push(r.id);
      order.set(r.threadId, arr);
    }
  }
  let round = 0;
  let pending = [...order.keys()];
  while (pending.length > 0) {
    const wanted = new Map<number, number>(); // comment id → thread id
    for (const t of pending) {
      const id = order.get(t)?.[round];
      if (id != null) wanted.set(id, t);
    }
    if (wanted.size === 0) break;
    const blank: number[] = [];
    for (const ids of chunks([...wanted.keys()])) {
      for (const r of await db
        .select({
          id: reviewComments.id,
          authorId: reviewComments.authorId,
          body: reviewComments.body,
          excerpt: reviewComments.excerpt,
          at: reviewComments.createdAt,
        })
        .from(reviewComments)
        .where(inArray(reviewComments.id, ids))
        .execute()) {
        const threadId = wanted.get(r.id);
        if (threadId == null) continue;
        // The stored body first; a pre-persistence lean row still has its short excerpt.
        const ex = cardExcerpt(r.body ?? r.excerpt);
        if (ex == null) blank.push(threadId);
        else out.set(threadId, { ...ex, authorId: r.authorId, at: r.at.toISOString() });
      }
    }
    pending = blank;
    round += 1;
  }
  return out;
}

/**
 * Who did the new things on each of your PRs since you last opened it — the SAME events
 * `computeTriage` counts into `newSinceLastViewed` (comments, review comments, reviews and commit
 * pushes strictly after `pr_views.last_viewed_at`), you excluded, distinct actors ordered by their
 * newest such event. `ids` is capped at `YOUR_PR_NEW_ACTORS_SHOWN`; `total` is every one of them.
 * A PR whose new activity is all yours (or unattributed) is absent.
 */
export async function yourPrNewActors(
  accountId: number,
  prIds: readonly number[],
  viewerUserId: number | null,
): Promise<Map<number, { ids: number[]; total: number }>> {
  const out = new Map<number, { ids: number[]; total: number }>();
  const unique = [...new Set(prIds)];
  if (unique.length === 0) return out;
  const viewedAt = new Map<number, number>();
  for (const ids of chunks(unique)) {
    for (const r of await db
      .select({ prId: prViews.prId, at: prViews.lastViewedAt })
      .from(prViews)
      .where(inArray(prViews.prId, ids))
      .execute()) {
      viewedAt.set(r.prId, r.at.getTime());
    }
  }
  if (viewedAt.size === 0) return out;
  const minViewed = new Date(Math.min(...viewedAt.values()));
  const newest = new Map<number, Map<number, number>>();
  for (const ids of chunks([...viewedAt.keys()])) {
    const rows = await db
      .select({ prId: events.prId, actorId: events.actorId, at: events.occurredAt })
      .from(events)
      .where(
        and(
          eq(events.accountId, accountId),
          inArray(events.prId, ids),
          inArray(events.type, ['commit_pushed', 'pr_comment', 'review_comment', 'review_submitted']),
          gt(events.occurredAt, minViewed),
        ),
      )
      .execute();
    for (const r of rows) {
      if (r.prId == null || r.actorId == null || r.actorId === viewerUserId) continue;
      const threshold = viewedAt.get(r.prId);
      if (threshold == null || r.at.getTime() <= threshold) continue;
      const m = newest.get(r.prId) ?? new Map<number, number>();
      m.set(r.actorId, Math.max(m.get(r.actorId) ?? 0, r.at.getTime()));
      newest.set(r.prId, m);
    }
  }
  for (const [prId, m] of newest) {
    const ordered = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
    out.set(prId, { ids: ordered.slice(0, YOUR_PR_NEW_ACTORS_SHOWN), total: ordered.length });
  }
  return out;
}

/**
 * Who asked the viewer to review each PR — the requester of the NEWEST stored `requested` event
 * naming the viewer (`review_request_events`, synced rows only). Absent (not known) when:
 *   • the newest event naming the viewer is a WITHDRAWAL (the history does not explain the card);
 *   • the requester is NULL (a row synced before migration 0081, or GitHub's ghost actor);
 *   • the requester IS the viewer (a self-request names nobody);
 *   • the PR's stored history is at `REVIEW_REQUEST_HISTORY_CAP` — the newest request may sit past
 *     the selection's first 25, so the newest STORED one could name the wrong person.
 * The card qualifies only on a request to the viewer personally (`review_requests.user_id`), so a
 * team request is not read here.
 */
export async function reviewRequesters(
  prIds: readonly number[],
  viewerUserId: number | null,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const unique = [...new Set(prIds)];
  if (unique.length === 0 || viewerUserId == null) return out;
  type Row = {
    prId: number;
    kind: 'requested' | 'removed';
    at: Date;
    id: number;
    reviewerUserId: number | null;
    requesterUserId: number | null;
  };
  const byPr = new Map<number, Row[]>();
  for (const ids of chunks(unique)) {
    const rows = await db
      .select({
        prId: reviewRequestEvents.prId,
        kind: reviewRequestEvents.kind,
        at: reviewRequestEvents.occurredAt,
        id: reviewRequestEvents.id,
        reviewerUserId: reviewRequestEvents.reviewerUserId,
        requesterUserId: reviewRequestEvents.requesterUserId,
      })
      .from(reviewRequestEvents)
      .where(inArray(reviewRequestEvents.prId, ids))
      .execute();
    for (const r of rows) {
      const arr = byPr.get(r.prId) ?? [];
      arr.push(r);
      byPr.set(r.prId, arr);
    }
  }
  for (const [prId, history] of byPr) {
    if (history.length >= REVIEW_REQUEST_HISTORY_CAP) continue;
    const mine: Row[] = history
      .filter((r) => r.reviewerUserId === viewerUserId)
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id);
    const newest: Row | undefined = mine[0];
    if (newest == null || newest.kind !== 'requested') continue;
    const by: number | null = newest.requesterUserId;
    if (by == null || by === viewerUserId) continue;
    out.set(prId, by);
  }
  return out;
}
