import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { isLikelyBot } from './bot-detection.js';
import {
  deriveThreadState,
  type CommitInput,
} from './derive-thread-state.js';
import type {
  GqlActor,
  GqlCheckContext,
  GqlHeadCommit,
  GqlPullRequest,
} from '../github/queries.js';
import type { CheckRun, CheckRunState } from '@gh-team-monitor/shared';

const {
  repos,
  users,
  pullRequests,
  reviews,
  reviewThreads,
  reviewComments,
  prComments,
  commits,
  events,
  reviewRequests,
} = schema;

function toDate(iso: string | null | undefined): Date | null {
  return iso ? new Date(iso) : null;
}

function maxDate(dates: (Date | null)[]): Date | null {
  let max: Date | null = null;
  for (const d of dates) {
    if (d && (!max || d > max)) max = d;
  }
  return max;
}

function minDate(dates: (Date | null)[]): Date | null {
  let min: Date | null = null;
  for (const d of dates) {
    if (d && (!min || d < min)) min = d;
  }
  return min;
}

/** Resolves GraphQL actors to local user ids, caching by login within a run. */
export function createUserResolver() {
  const cache = new Map<string, number>();
  return {
    resolve(actor: GqlActor | null | undefined): number | null {
      const login = actor?.login;
      if (!login) return null;
      const cached = cache.get(login);
      if (cached !== undefined) return cached;

      const row = db
        .insert(users)
        .values({
          githubLogin: login,
          githubNodeId: actor?.id ?? null,
          displayName: actor?.name ?? null,
          avatarUrl: actor?.avatarUrl ?? null,
          isBot: isLikelyBot(login),
        })
        .onConflictDoUpdate({
          target: users.githubLogin,
          set: {
            githubNodeId: sql`coalesce(excluded.github_node_id, ${users.githubNodeId})`,
            displayName: sql`coalesce(excluded.display_name, ${users.displayName})`,
            avatarUrl: sql`coalesce(excluded.avatar_url, ${users.avatarUrl})`,
            // Never clobber a manual is_bot override.
            isBot: sql`case when ${users.isBotOverridden} = 1 then ${users.isBot} else excluded.is_bot end`,
          },
        })
        .returning({ id: users.id })
        .get();

      cache.set(login, row.id);
      return row.id;
    },
  };
}

export type UserResolver = ReturnType<typeof createUserResolver>;

/** Upsert a repo by its GitHub node id; returns the local repo id. */
export function upsertRepo(
  owner: string,
  name: string,
  githubNodeId: string,
  defaultBranch?: string | null,
): number {
  // Only overwrite default_branch when we actually know it (the add-repo path
  // calls without it via the lightweight REPO_ID_QUERY) so we never null out a
  // value a prior sync populated.
  const set: { owner: string; name: string; defaultBranch?: string } = { owner, name };
  if (defaultBranch != null) set.defaultBranch = defaultBranch;
  const row = db
    .insert(repos)
    .values({ owner, name, githubNodeId, defaultBranch: defaultBranch ?? null })
    .onConflictDoUpdate({
      target: repos.githubNodeId,
      set,
    })
    .returning({ id: repos.id })
    .get();
  return row.id;
}

function prState(s: GqlPullRequest['state']): 'open' | 'merged' | 'closed' {
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return 'open';
}

type CiStatus =
  | 'success'
  | 'failure'
  | 'pending'
  | 'error'
  | 'expected'
  | 'unknown';

function ciStatusFrom(state: string | null | undefined): CiStatus {
  switch ((state ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'PENDING':
      return 'pending';
    case 'ERROR':
      return 'error';
    case 'EXPECTED':
      return 'expected';
    default:
      return 'unknown';
  }
}

function mergeableFrom(
  state: string | null | undefined,
): 'mergeable' | 'conflicting' | 'unknown' {
  switch ((state ?? '').toUpperCase()) {
    case 'MERGEABLE':
      return 'mergeable';
    case 'CONFLICTING':
      return 'conflicting';
    default:
      return 'unknown';
  }
}

const MERGE_STATE_STATUSES = new Set([
  'clean',
  'dirty',
  'unstable',
  'blocked',
  'behind',
  'has_hooks',
  'unknown',
]);

function mergeStateStatusFrom(
  state: string | null | undefined,
):
  | 'clean'
  | 'dirty'
  | 'unstable'
  | 'blocked'
  | 'behind'
  | 'has_hooks'
  | 'unknown' {
  const lower = (state ?? '').toLowerCase();
  return (MERGE_STATE_STATUSES.has(lower) ? lower : 'unknown') as
    | 'clean'
    | 'dirty'
    | 'unstable'
    | 'blocked'
    | 'behind'
    | 'has_hooks'
    | 'unknown';
}

function checkContextState(c: GqlCheckContext): CheckRunState {
  if (c.__typename === 'StatusContext') {
    switch ((c.state ?? '').toUpperCase()) {
      case 'SUCCESS':
        return 'success';
      case 'FAILURE':
        return 'failure';
      case 'ERROR':
        return 'error';
      case 'PENDING':
      case 'EXPECTED':
        return 'pending';
      default:
        return 'unknown';
    }
  }
  // CheckRun: outcome is meaningful only once completed.
  if ((c.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending';
  switch ((c.conclusion ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
    case 'ACTION_REQUIRED':
      return 'failure';
    case 'CANCELLED':
    case 'STALE':
    case 'NEUTRAL':
      return 'neutral';
    case 'SKIPPED':
      return 'skipped';
    default:
      return 'unknown';
  }
}

function checkRunsFrom(head: GqlHeadCommit['commit'] | null | undefined): CheckRun[] {
  const nodes = head?.statusCheckRollup?.contexts?.nodes ?? [];
  return nodes.map((c) => ({
    name: c.__typename === 'CheckRun' ? c.name : c.context,
    state: checkContextState(c),
    url: c.__typename === 'CheckRun' ? c.detailsUrl : c.targetUrl,
  }));
}

const REVIEW_STATES = new Set([
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
  'pending',
]);

export type MappedReviewState =
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'dismissed'
  | 'pending';

function reviewState(s: string): MappedReviewState {
  const lower = s.toLowerCase();
  return (REVIEW_STATES.has(lower) ? lower : 'commented') as MappedReviewState;
}

// A review warrants its own timeline marker only when it's substantive: a
// decision (approved/changes_requested/dismissed) or one carrying a summary
// body. An empty "commented" review is just GitHub's wrapper around inline
// comments — those already show as review_comment markers, so the wrapper would
// duplicate them. See db/cleanup.ts for backfilling existing rows.
export function isSubstantiveReview(
  state: MappedReviewState,
  body: string | null | undefined,
): boolean {
  return state !== 'commented' || !!body?.trim();
}

function upsertEvent(row: {
  repoId: number;
  actorId: number | null;
  prId: number;
  type: (typeof schema.events.$inferInsert)['type'];
  occurredAt: Date;
  refTable: string | null;
  refId: number | null;
  dedupeKey: string;
}): void {
  db.insert(events)
    .values(row)
    .onConflictDoUpdate({
      target: events.dedupeKey,
      set: {
        actorId: row.actorId,
        occurredAt: row.occurredAt,
        refTable: row.refTable,
        refId: row.refId,
      },
    })
    .run();
}

/**
 * Persist a single PR and all its nested entities idempotently, derive thread
 * states, and emit timeline events. `commitFilesBySha` must already be
 * populated for any commits relevant to unresolved-thread derivation.
 */
export function persistPr(
  pr: GqlPullRequest,
  repoId: number,
  resolver: UserResolver,
  commitFilesBySha: Map<string, string[]>,
): void {
  db.transaction(() => {
    const authorId = resolver.resolve(pr.author);
    // The actual merger (null for non-merged PRs / when GitHub omits the actor).
    const mergedById = resolver.resolve(pr.mergedBy);
    const openedAt = new Date(pr.createdAt);
    const mergedAt = toDate(pr.mergedAt);
    const closedAt = toDate(pr.closedAt);

    const commitDates = pr.commits.nodes.map(
      (c) => new Date(c.commit.committedDate),
    );
    const lastCommitAt = maxDate(commitDates);
    const firstReviewAt = minDate(
      pr.reviews.nodes.map((r) => toDate(r.submittedAt)),
    );

    const head = pr.headCommit?.nodes[0]?.commit;
    const headSha = head?.oid ?? null;
    const ciStatus = ciStatusFrom(head?.statusCheckRollup?.state);
    const mergeable = mergeableFrom(pr.mergeable);
    const mergeStateStatus = mergeStateStatusFrom(pr.mergeStateStatus);
    const labels = (pr.labels?.nodes ?? []).map((l) => ({
      name: l.name,
      color: l.color,
    }));
    const checkRuns = checkRunsFrom(head);

    const prRow = db
      .insert(pullRequests)
      .values({
        githubNodeId: pr.id,
        repoId,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? null,
        authorId,
        mergedById,
        baseRefName: pr.baseRefName ?? null,
        state: prState(pr.state),
        isDraft: pr.isDraft,
        openedAt,
        firstReviewAt,
        lastCommitAt,
        mergedAt,
        closedAt,
        updatedAt: new Date(pr.updatedAt),
        headSha,
        ciStatus,
        mergeable,
        mergeStateStatus,
        labels,
        checkRuns,
      })
      .onConflictDoUpdate({
        target: pullRequests.githubNodeId,
        set: {
          title: pr.title,
          body: pr.body ?? null,
          authorId,
          mergedById,
          baseRefName: pr.baseRefName ?? null,
          state: prState(pr.state),
          isDraft: pr.isDraft,
          firstReviewAt,
          lastCommitAt,
          mergedAt,
          closedAt,
          updatedAt: new Date(pr.updatedAt),
          headSha,
          ciStatus,
          mergeable,
          mergeStateStatus,
          labels,
          checkRuns,
        },
      })
      .returning({ id: pullRequests.id })
      .get();
    const prId = prRow.id;

    // ---- review requests (outstanding) — reconcile by delete + reinsert ----
    db.delete(reviewRequests).where(eq(reviewRequests.prId, prId)).run();
    for (const rr of pr.reviewRequests?.nodes ?? []) {
      const reviewer = rr.requestedReviewer;
      if (!reviewer) continue;
      if (reviewer.__typename === 'User') {
        const userId = resolver.resolve({
          login: reviewer.login,
          id: reviewer.id,
        });
        db.insert(reviewRequests).values({ prId, userId, teamName: null }).run();
      } else if (reviewer.__typename === 'Team') {
        db.insert(reviewRequests)
          .values({ prId, userId: null, teamName: reviewer.name })
          .run();
      }
    }

    // ---- lifecycle events ----
    upsertEvent({
      repoId,
      actorId: authorId,
      prId,
      type: 'pr_opened',
      occurredAt: openedAt,
      refTable: 'pull_requests',
      refId: prId,
      dedupeKey: `pr_opened:${pr.id}`,
    });
    if (pr.state === 'MERGED' && mergedAt) {
      upsertEvent({
        repoId,
        actorId: authorId,
        prId,
        type: 'pr_merged',
        occurredAt: mergedAt,
        refTable: 'pull_requests',
        refId: prId,
        dedupeKey: `pr_merged:${pr.id}`,
      });
    } else if (pr.state === 'CLOSED' && closedAt) {
      upsertEvent({
        repoId,
        actorId: authorId,
        prId,
        type: 'pr_closed',
        occurredAt: closedAt,
        refTable: 'pull_requests',
        refId: prId,
        dedupeKey: `pr_closed:${pr.id}`,
      });
    }

    // ---- reviews ----
    for (const r of pr.reviews.nodes) {
      const reviewerId = resolver.resolve(r.author);
      const submittedAt = toDate(r.submittedAt);
      if (!submittedAt) continue; // pending reviews have no timestamp
      const reviewRow = db
        .insert(reviews)
        .values({
          githubNodeId: r.id,
          prId,
          authorId: reviewerId,
          state: reviewState(r.state),
          body: r.body ?? null,
          databaseId: r.fullDatabaseId ?? null,
          submittedAt,
        })
        .onConflictDoUpdate({
          target: reviews.githubNodeId,
          set: {
            state: reviewState(r.state),
            body: r.body ?? null,
            databaseId: r.fullDatabaseId ?? null,
            submittedAt,
          },
        })
        .returning({ id: reviews.id })
        .get();
      if (isSubstantiveReview(reviewState(r.state), r.body)) {
        upsertEvent({
          repoId,
          actorId: reviewerId,
          prId,
          type: 'review_submitted',
          occurredAt: submittedAt,
          refTable: 'reviews',
          refId: reviewRow.id,
          dedupeKey: `review_submitted:${r.id}`,
        });
      }
    }

    // ---- review threads + comments ----
    const commitInputs: CommitInput[] = pr.commits.nodes.map((c) => ({
      oid: c.commit.oid,
      committedDate: c.commit.committedDate,
    }));

    for (const t of pr.reviewThreads.nodes) {
      const commentNodes = t.comments.nodes;
      const originalCommenterId = resolver.resolve(commentNodes[0]?.author);

      const derivedState = deriveThreadState(
        {
          isResolved: t.isResolved,
          path: t.path,
          comments: commentNodes.map((c) => ({
            author: c.author ? { login: c.author.login } : null,
            createdAt: c.createdAt,
          })),
        },
        commitInputs,
        commitFilesBySha,
      );

      const threadRow = db
        .insert(reviewThreads)
        .values({
          githubNodeId: t.id,
          prId,
          path: t.path,
          line: t.line,
          isResolved: t.isResolved,
          isOutdated: t.isOutdated,
          derivedState,
          originalCommenterId,
          createdAt: commentNodes[0]
            ? new Date(commentNodes[0].createdAt)
            : new Date(pr.createdAt),
        })
        .onConflictDoUpdate({
          target: reviewThreads.githubNodeId,
          set: {
            isResolved: t.isResolved,
            isOutdated: t.isOutdated,
            derivedState,
            line: t.line,
          },
        })
        .returning({ id: reviewThreads.id })
        .get();

      for (const c of commentNodes) {
        const commenterId = resolver.resolve(c.author);
        const createdAt = new Date(c.createdAt);
        db.insert(reviewComments)
          .values({
            githubNodeId: c.id,
            threadId: threadRow.id,
            prId,
            authorId: commenterId,
            body: c.body,
            diffHunk: c.diffHunk ?? null,
            databaseId: c.fullDatabaseId ?? null,
            createdAt,
          })
          .onConflictDoUpdate({
            target: reviewComments.githubNodeId,
            set: {
              body: c.body,
              diffHunk: c.diffHunk ?? null,
              databaseId: c.fullDatabaseId ?? null,
            },
          })
          .run();
        upsertEvent({
          repoId,
          actorId: commenterId,
          prId,
          type: 'review_comment',
          occurredAt: createdAt,
          // Point at the thread for in-app navigation.
          refTable: 'review_threads',
          refId: threadRow.id,
          dedupeKey: `review_comment:${c.id}`,
        });
      }
    }

    // ---- general PR comments ----
    for (const c of pr.comments.nodes) {
      const commenterId = resolver.resolve(c.author);
      const createdAt = new Date(c.createdAt);
      const commentRow = db
        .insert(prComments)
        .values({
          githubNodeId: c.id,
          prId,
          authorId: commenterId,
          body: c.body,
          databaseId: c.fullDatabaseId ?? null,
          createdAt,
        })
        .onConflictDoUpdate({
          target: prComments.githubNodeId,
          set: { body: c.body, databaseId: c.fullDatabaseId ?? null },
        })
        .returning({ id: prComments.id })
        .get();
      upsertEvent({
        repoId,
        actorId: commenterId,
        prId,
        type: 'pr_comment',
        occurredAt: createdAt,
        refTable: 'pr_comments',
        refId: commentRow.id,
        dedupeKey: `pr_comment:${c.id}`,
      });
    }

    // ---- commits ----
    for (const node of pr.commits.nodes) {
      const c = node.commit;
      const commitAuthorId = resolver.resolve(
        c.author?.user
          ? { login: c.author.user.login, id: c.author.user.id }
          : null,
      );
      const committerId = resolver.resolve(
        c.committer?.user
          ? { login: c.committer.user.login, id: c.committer.user.id }
          : null,
      );
      const committedAt = new Date(c.committedDate);
      // Upsert (not DoNothing) so we always get the row id back to point the
      // timeline event at — the marker modal resolves the commit via ref_id.
      const commitRow = db
        .insert(commits)
        .values({
          sha: c.oid,
          prId,
          authorId: commitAuthorId,
          committerId,
          message: c.message,
          committedAt,
        })
        .onConflictDoUpdate({
          target: [commits.sha, commits.prId],
          set: { message: c.message, committedAt },
        })
        .returning({ id: commits.id })
        .get();
      upsertEvent({
        repoId,
        actorId: commitAuthorId ?? committerId,
        prId,
        type: 'commit_pushed',
        occurredAt: committedAt,
        refTable: 'commits',
        refId: commitRow.id,
        dedupeKey: `commit_pushed:${pr.id}:${c.oid}`,
      });
    }
  });
}
