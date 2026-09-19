// ── LIVE AUTOMATION SECURITY ALERTS, DERIVED ON READ (CORE, deterministic, no AI) ──────────────
//
// The Dependencies tab's second source of `security` cards: a security TOOL's own comment on a PR
// naming a KNOWN ADVISORY (a CVE / GHSA / … id) — Socket's "Critical CVE" report, a Dependency
// Review failure, an AI reviewer's own thread finding. Nothing is stored: every read re-derives the
// alert from the comment rows the sync already persists (comment and review bodies are ALWAYS
// persisted), so an alert clears itself by STATE — the tool's latest comment stops naming one, or
// the review thread is resolved / likely addressed — with no tombstone to forget.
//
// The rules are the detector's (sync/security-detect.ts `evaluateSecurityAlerts`); this file only
// reads the candidate rows. ⚠ The SQL pre-filter is built straight from `SECURITY_ALERT_PREFILTER`
// and may be LOOSER than the evaluator, never stricter: a tool's "all clear" (Socket's "All alerts
// resolved") names no advisory, and it must still reach the evaluator, because it is the latest row
// that decides. SQLite's case-blind `LIKE` and an `_` in a literal both widen it; the evaluator
// re-applies every literal exact-case, so both dialects alert on the same rows.
//
// ⚠ COMMENTS AND REVIEWS ARE NARROWED TO THE TOOLS' OWN ACCOUNTS, and are still exactly as loose:
// on those two surfaces an author-gated rule reads only its own tool's login, an author-free rule
// (Frogbot, Checkmarx — they post through github-actions or a person's token) reads anyone's row
// that carries its marker, and the `reviewer` fallback never reads them at all. THREADS are not
// narrowed: that fallback reads every automated root carrying any literal, which on Postgres (a
// case-sensitive `LIKE`) no narrower SQL can promise to keep. COST, measured on a copy of the dev DB
// over Erxes' 83 active PRs, whose 5.2 MB of text is 99.8% automation's own (CodeRabbit and co.):
// all 18 literals over every comment and review took ~65 ms of a ~400 ms fold; the narrowed reads
// take ~10 ms. Threads stay at ~60 ms.
import { and, asc, eq, inArray, like, ne, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { normalizeBotLogin } from '@pierre-review/shared';
import type { AutomatedReviewerKind, SecurityAlert } from '@pierre-review/shared';
import { db, schema } from './client.js';
import {
  evaluateSecurityAlerts,
  SECURITY_ALERT_PREFILTER,
  SECURITY_ALERT_RULES,
  type AlertCandidateRow,
  type SecurityAlertSource,
} from '../sync/security-detect.js';

const { prComments, reviews, reviewComments, reviewThreads, users } = schema;

type Column = Parameters<typeof like>[0];

/** Each AUTHOR-FREE rule's marker (`author: null`): a `SECURITY_ALERT_PREFILTER` literal that every
 *  body the rule `identifies` contains, so a person's row carrying it still reaches the evaluator.
 *  pending-deps.test.ts holds this to the rules. */
export const AUTHOR_FREE_ALERT_MARKERS: Readonly<Partial<Record<SecurityAlertSource, string>>> = {
  frogbot: 'Frogbot',
  checkmarx: 'Checkmarx One',
};

/** `body LIKE '%s1%' OR body LIKE '%s2%' OR …` over the given literals. */
function anyLike(body: Column, literals: readonly string[]): SQL {
  return or(...literals.map((s) => like(body, `%${s}%`)))!;
}

/** The rows of a COMMENT or REVIEW surface that may reach the evaluator — every row a rule reading
 *  that surface could use. `null` = no rule reads it from anyone here: skip the read.
 *  `toolIds` = the automated authors whose login an author-gated rule on this surface names. */
function surfaceCandidates(
  surface: 'comment' | 'review',
  authorId: AnyColumn,
  body: Column,
  toolIds: readonly number[],
): SQL | null {
  const parts: SQL[] = [];
  if (toolIds.length > 0) {
    parts.push(and(inArray(authorId, [...toolIds]), anyLike(body, SECURITY_ALERT_PREFILTER))!);
  }
  for (const rule of SECURITY_ALERT_RULES) {
    if (rule.author !== null || !rule.surfaces.includes(surface)) continue;
    const marker = AUTHOR_FREE_ALERT_MARKERS[rule.source];
    // An author-free rule with no marker here reads the whole pre-filter, from anyone.
    parts.push(marker != null ? like(body, `%${marker}%`) : anyLike(body, SECURITY_ALERT_PREFILTER));
  }
  return parts.length > 0 ? or(...parts)! : null;
}

/**
 * Live automation ALERTS naming a known advisory, for the given open PRs. DB-only, no GitHub call.
 * Every live alert per PR, newest first, uncapped here — the card builder slices what it shows and
 * carries the full count beside it.
 *
 * ⚠ TENANCY: `pr_comments` / `reviews` / `review_comments` carry no account_id. Every read here is
 * keyed by `pr_id IN (prIds)`, and the ONLY caller passes the fold's account-scoped `openPrIds`.
 * Never export a variant that takes ids from a request.
 */
export async function deriveSecurityAlerts(
  prIds: readonly number[],
  automatedIds: ReadonlySet<number>,
  kindOf: ReadonlyMap<number, AutomatedReviewerKind>,
): Promise<Map<number, SecurityAlert[]>> {
  if (prIds.length === 0) return new Map();
  const ids = [...prIds];
  const threadBody = sql<string>`coalesce(${reviewComments.body}, ${reviewComments.excerpt})`;

  // The tools' own accounts among the automated authors. `users` is GLOBAL — read by id only.
  const automatedLogins =
    automatedIds.size > 0
      ? await db
          .select({ id: users.id, login: users.githubLogin })
          .from(users)
          .where(inArray(users.id, [...automatedIds]))
          .execute()
      : [];
  const toolIdsFor = (surface: 'comment' | 'review'): number[] =>
    automatedLogins
      .filter((u) =>
        SECURITY_ALERT_RULES.some(
          (r) =>
            r.author !== null && r.surfaces.includes(surface) && r.author(normalizeBotLogin(u.login)),
        ),
      )
      .map((u) => u.id);
  const commentWhere = surfaceCandidates(
    'comment',
    prComments.authorId,
    prComments.body,
    toolIdsFor('comment'),
  );
  const reviewWhere = surfaceCandidates(
    'review',
    reviews.authorId,
    reviews.body,
    toolIdsFor('review'),
  );

  const [commentRows, reviewRows, threadRows] = await Promise.all([
    commentWhere == null
      ? []
      : db
          .select({
            id: prComments.id,
            prId: prComments.prId,
            authorId: prComments.authorId,
            body: prComments.body,
            createdAt: prComments.createdAt,
          })
          .from(prComments)
          .where(and(inArray(prComments.prId, ids), commentWhere))
          .execute(),
    reviewWhere == null
      ? []
      : db
          .select({
            id: reviews.id,
            prId: reviews.prId,
            authorId: reviews.authorId,
            body: reviews.body,
            createdAt: reviews.submittedAt,
          })
          .from(reviews)
          // A 'pending' review is an unsubmitted draft — it has said nothing yet.
          .where(and(inArray(reviews.prId, ids), ne(reviews.state, 'pending'), reviewWhere))
          .execute(),
    db
      .select({
        id: reviewComments.id,
        prId: reviewComments.prId,
        authorId: reviewComments.authorId,
        body: threadBody,
        createdAt: reviewComments.createdAt,
        threadId: reviewComments.threadId,
        isResolved: reviewThreads.isResolved,
        derivedState: reviewThreads.derivedState,
      })
      .from(reviewComments)
      .innerJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
      .where(and(inArray(reviewComments.prId, ids), anyLike(threadBody, SECURITY_ALERT_PREFILTER)))
      .execute(),
  ]);

  // WHICH candidate is its thread's ROOT — the earliest (created_at, id) of the WHOLE thread, not
  // of the candidates (a reply can pass the pre-filter while the root does not). One extra read over
  // the candidate threads, on `rc_thread_idx`; no correlated subquery, so it stays portable.
  const threadIds = [...new Set(threadRows.map((r) => r.threadId))];
  const rootIdOf = new Map<number, number>();
  if (threadIds.length > 0) {
    const all = await db
      .select({ id: reviewComments.id, threadId: reviewComments.threadId })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, threadIds))
      .orderBy(asc(reviewComments.createdAt), asc(reviewComments.id))
      .execute();
    // Ordered (created_at, id), so the first row seen per thread is its root.
    for (const r of all) if (!rootIdOf.has(r.threadId)) rootIdOf.set(r.threadId, r.id);
  }

  // Logins, for the rules that name their tool's account. `users` is GLOBAL — read by id only.
  const authorIds = [
    ...new Set(
      [...commentRows, ...reviewRows, ...threadRows]
        .map((r) => r.authorId)
        .filter((id): id is number => id != null),
    ),
  ];
  const loginOf = new Map<number, string>();
  if (authorIds.length > 0) {
    for (const u of await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.id, authorIds))
      .execute())
      loginOf.set(u.id, u.login);
  }
  const login = (id: number | null): string | null => (id != null ? loginOf.get(id) ?? null : null);

  const rows: AlertCandidateRow[] = [
    ...commentRows.map(
      (r): AlertCandidateRow => ({
        surface: 'comment',
        rowId: r.id,
        prId: r.prId,
        authorId: r.authorId,
        authorLogin: login(r.authorId),
        body: r.body ?? '',
        createdAt: r.createdAt,
        threadId: null,
        isRoot: false,
        threadResolved: false,
        threadState: null,
      }),
    ),
    ...reviewRows.map(
      (r): AlertCandidateRow => ({
        surface: 'review',
        rowId: r.id,
        prId: r.prId,
        authorId: r.authorId,
        authorLogin: login(r.authorId),
        body: r.body ?? '',
        createdAt: r.createdAt,
        threadId: null,
        isRoot: false,
        threadResolved: false,
        threadState: null,
      }),
    ),
    ...threadRows.map(
      (r): AlertCandidateRow => ({
        surface: 'thread',
        rowId: r.id,
        prId: r.prId,
        authorId: r.authorId,
        authorLogin: login(r.authorId),
        body: r.body ?? '',
        createdAt: r.createdAt,
        threadId: r.threadId,
        isRoot: rootIdOf.get(r.threadId) === r.id,
        threadResolved: r.isResolved,
        threadState: r.derivedState,
      }),
    ),
  ];

  const out = new Map<number, SecurityAlert[]>();
  for (const [prId, alerts] of evaluateSecurityAlerts(rows, automatedIds)) {
    out.set(
      prId,
      alerts.map((a) => ({
        source: a.source,
        authorId: a.authorId,
        vendorKind: kindOf.get(a.authorId) ?? null,
        surface: a.surface,
        threadId: a.threadId,
        advisoryIds: a.advisoryIds,
        at: a.at.toISOString(),
      })),
    );
  }
  return out;
}
