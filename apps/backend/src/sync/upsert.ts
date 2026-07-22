import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema, runTransaction, type Executor } from '../db/client.js';
import { config } from '../config.js';
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
import type { CheckRun, CheckRunState } from '@pierre-review/shared';

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
  ciStatusEvents,
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

// Short single-line preview of a comment body. Stored even in lean mode (where the
// full body is dropped) so the triage path (getMyTurn/getThreadsAwaiting) and
// graceful UI degradation work without hydrating from GitHub.
function excerptOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine;
}

/** Resolves GraphQL actors to local user ids, caching by login within a run. */
export function createUserResolver() {
  const cache = new Map<string, number>();
  return {
    async resolve(
      exec: Executor,
      actor: GqlActor | null | undefined,
    ): Promise<number | null> {
      const login = actor?.login;
      if (!login) return null;
      const cached = cache.get(login);
      if (cached !== undefined) return cached;

      const nodeId = actor?.id ?? null;

      // The GitHub node id is the STABLE identity; the login is NOT. The same
      // account can surface under two different logins — even inside one sync
      // payload: a bot's Bot-typed author field reads `dependabot[bot]` while its
      // commit-author field reads the bare `dependabot`, both carrying the same
      // node id; and humans get renamed. Because BOTH `github_login` AND
      // `github_node_id` are UNIQUE, the login-keyed upsert below is unsafe when a
      // DIFFERENT row already owns this node id: matching the login (or inserting a
      // new one) while `coalesce`-stamping the node raises "UNIQUE constraint
      // failed: users.github_node_id". So when we have a node id, resolve on it
      // FIRST and reuse the row that owns it — the colliding insert/update is never
      // issued. Only a brand-new (or absent) node id falls through to the
      // login-keyed upsert, where stamping the node can't collide.
      if (nodeId) {
        const owner = (
          await exec
            .select({
              id: users.id,
              isBot: users.isBot,
              isBotOverridden: users.isBotOverridden,
            })
            .from(users)
            .where(eq(users.githubNodeId, nodeId))
            .limit(1)
            .execute()
        )[0];
        if (owner) {
          // Refresh volatile metadata but NEVER rewrite the login: the row already
          // holds a canonical login for this node id, and rewriting it would risk the
          // github_login UNIQUE (when the incoming login belongs to another live row)
          // and thrash a bot that alternates login forms across a single sync. Only
          // set fields the actor actually carries (a commit-author resolve has no
          // name/avatar/typename) so we never clobber a known value with null — the
          // same "coalesce" intent as the upsert below, via plain portable value
          // binds (a raw `sql` boolean can't bind on sqlite; a bare null param can
          // confuse pg type inference). isBot honours a manual override.
          const set: {
            displayName?: string;
            avatarUrl?: string;
            githubType?: string;
            isBot: boolean;
          } = { isBot: owner.isBotOverridden ? owner.isBot : isLikelyBot(login) };
          if (actor?.name != null) set.displayName = actor.name;
          if (actor?.avatarUrl != null) set.avatarUrl = actor.avatarUrl;
          if (actor?.__typename != null) set.githubType = actor.__typename;
          await exec.update(users).set(set).where(eq(users.id, owner.id)).execute();
          cache.set(login, owner.id);
          return owner.id;
        }
      }

      const row = (
        await exec
          .insert(users)
          .values({
            githubLogin: login,
            githubNodeId: nodeId,
            displayName: actor?.name ?? null,
            avatarUrl: actor?.avatarUrl ?? null,
            // GraphQL __typename ('User'|'Bot'|…) when the actor carried it (the fat
            // activity query selects it on every author); null for locally-synthesized
            // actors (commit authors / review requests). Feeds the bot-triage classifier.
            githubType: actor?.__typename ?? null,
            isBot: isLikelyBot(login),
          })
          .onConflictDoUpdate({
            target: users.githubLogin,
            set: {
              githubNodeId: sql`coalesce(excluded.github_node_id, ${users.githubNodeId})`,
              displayName: sql`coalesce(excluded.display_name, ${users.displayName})`,
              avatarUrl: sql`coalesce(excluded.avatar_url, ${users.avatarUrl})`,
              // Never overwrite a known github_type with null (a later {login,id}-only
              // resolve of the same actor must not wipe the type captured from GraphQL).
              githubType: sql`coalesce(excluded.github_type, ${users.githubType})`,
              // Never clobber a manual is_bot override.
              isBot: sql`case when ${users.isBotOverridden} = true then ${users.isBot} else excluded.is_bot end`,
            },
          })
          .returning({ id: users.id })
          .execute()
      )[0]!;

      cache.set(login, row.id);
      return row.id;
    },
  };
}

export type UserResolver = ReturnType<typeof createUserResolver>;

/** Upsert a repo by its GitHub node id; returns the local repo id. */
export async function upsertRepo(
  owner: string,
  name: string,
  githubNodeId: string,
  defaultBranch: string | null | undefined,
  accountId: number,
  viewerPermission?: string | null,
): Promise<number> {
  // default_branch: only overwrite when known (a branch is never revoked, and the
  // lightweight add-repo path omits it) so we never null a synced value.
  // viewer_permission: the activity sync ALWAYS fetches it (passing null when
  // GitHub reports no permission, i.e. access was revoked), so `undefined` means
  // "not fetched" (add path → preserve) while `null`/string is authoritative and
  // overwrites — otherwise a revoked-to-null permission would stay stale-elevated.
  const set: {
    owner: string;
    name: string;
    defaultBranch?: string;
    viewerPermission?: string | null;
  } = { owner, name };
  if (defaultBranch != null) set.defaultBranch = defaultBranch;
  if (viewerPermission !== undefined) set.viewerPermission = viewerPermission;
  const row = (
    await db
      .insert(repos)
      .values({
        accountId,
        owner,
        name,
        githubNodeId,
        defaultBranch: defaultBranch ?? null,
        viewerPermission: viewerPermission ?? null,
      })
      .onConflictDoUpdate({
        target: [repos.accountId, repos.githubNodeId],
        set,
      })
      .returning({ id: repos.id })
      .execute()
  )[0]!;
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

// A GitHub Actions check's detailsUrl is .../actions/runs/<runId>/job/<jobId> — parse
// the two ids so the frontend can fetch that job's logs on demand. Third-party CI
// (StatusContext / external CheckRuns) has a detailsUrl pointing elsewhere; no match →
// null, and the UI keeps it as a plain external link (logs aren't retrievable).
const ACTIONS_JOB_RE = /\/actions\/runs\/(\d+)\/job\/(\d+)/;
function parseActionsIds(url: string | null): { runId: number | null; jobId: number | null } {
  const m = url ? ACTIONS_JOB_RE.exec(url) : null;
  if (!m) return { runId: null, jobId: null };
  return { runId: Number(m[1]), jobId: Number(m[2]) };
}

export function checkRunsFrom(head: GqlHeadCommit['commit'] | null | undefined): CheckRun[] {
  const nodes = head?.statusCheckRollup?.contexts?.nodes ?? [];
  const mapped = nodes.map((c): CheckRun => {
    const url = c.__typename === 'CheckRun' ? c.detailsUrl : c.targetUrl;
    const { runId, jobId } =
      c.__typename === 'CheckRun' ? parseActionsIds(url) : { runId: null, jobId: null };
    return {
      name: c.__typename === 'CheckRun' ? c.name : c.context,
      state: checkContextState(c),
      url,
      runId,
      jobId,
    };
  });

  // GitHub's `statusCheckRollup.contexts` returns EVERY check attached to the head
  // commit's check suites — it does NOT collapse to "latest per check name" the way the
  // PR UI does. When a head commit is covered by more than one workflow RUN (a re-run,
  // or a workflow fired by both the `push` and `pull_request` events — classic for
  // Dependabot), each run contributes its own same-named CheckRun, so the same check
  // appears two+ times. Dedupe by display name, keeping the NEWEST run (Actions run ids
  // increase monotonically, so the highest runId is the most recent — matching the PR
  // UI); a real CheckRun (has a runId) beats a same-named StatusContext (runId null).
  // Map preserves first-insertion order, so distinct checks keep their order.
  const byName = new Map<string, CheckRun>();
  for (const c of mapped) {
    const prev = byName.get(c.name);
    if (!prev || (c.runId ?? -1) > (prev.runId ?? -1)) byName.set(c.name, c);
  }
  return [...byName.values()];
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

// Lifecycle transitions GitHub exposes no discrete event for, detected by comparing the
// PR's prior persisted row (`prev`) against the incoming sync (`next`). Returns the
// event types to emit: draft→ready (`pr_ready_for_review`) and closed→open
// (`pr_reopened`). `prev` is null on a PR's first sight, so nothing is emitted then —
// we never observed it as draft/closed, so there's no transition to report.
export function lifecycleTransitions(
  prev: { isDraft: boolean; state: string } | null,
  next: { isDraft: boolean; state: 'open' | 'merged' | 'closed' },
): ('pr_ready_for_review' | 'pr_reopened')[] {
  const out: ('pr_ready_for_review' | 'pr_reopened')[] = [];
  if (prev?.isDraft === true && next.isDraft === false) out.push('pr_ready_for_review');
  if (prev?.state === 'closed' && next.state === 'open') out.push('pr_reopened');
  return out;
}

async function upsertEvent(
  exec: Executor,
  row: {
    accountId: number;
    repoId: number;
    actorId: number | null;
    prId: number;
    type: (typeof schema.events.$inferInsert)['type'];
    occurredAt: Date;
    refTable: string | null;
    refId: number | null;
    dedupeKey: string;
  },
): Promise<void> {
  await exec
    .insert(events)
    .values(row)
    .onConflictDoUpdate({
      target: [events.accountId, events.dedupeKey],
      set: {
        actorId: row.actorId,
        occurredAt: row.occurredAt,
        refTable: row.refTable,
        refId: row.refId,
      },
    })
    .execute();
}

/**
 * Persist a single PR and all its nested entities idempotently, derive thread
 * states, and emit timeline events. `commitFilesBySha` must already be
 * populated for any commits relevant to unresolved-thread derivation.
 */
// Decide a review thread's resolvedAt on this sync. We can't read GitHub's true resolution time,
// so we approximate it by the sync that FIRST observes the thread flip unresolved→resolved:
//  • a prior stamp is preserved (idempotent — never moves once set),
//  • a witnessed unresolved→resolved transition stamps `observedAt`,
//  • a thread already resolved the first time we see it (no prior row, or prior already resolved
//    with a null stamp) stays null — its true resolution time is unknowable, so it's excluded
//    from the resolution-latency metric rather than counted with a bogus (deploy-time) latency.
export function nextResolvedAt(
  prior: { isResolved: boolean; resolvedAt: Date | null } | undefined,
  isResolved: boolean,
  observedAt: Date,
): Date | null {
  if (prior?.resolvedAt != null) return prior.resolvedAt;
  if (isResolved && prior != null && !prior.isResolved) return observedAt;
  return null;
}

export async function persistPr(
  pr: GqlPullRequest,
  repoId: number,
  resolver: UserResolver,
  commitFilesBySha: Map<string, string[]>,
  accountId: number,
): Promise<void> {
  await runTransaction(async (tx) => {
    const authorId = await resolver.resolve(tx, pr.author);
    // The actual merger (null for non-merged PRs / when GitHub omits the actor).
    const mergedById = await resolver.resolve(tx, pr.mergedBy);
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
    // Diff size — always stored (small metadata, not bulky text), so the PR-detail
    // LOC label + "Changes" tab work in every mode straight from the DB. The files
    // list is capped at 100 by the query; changedFiles keeps the true total.
    const additions = pr.additions ?? 0;
    const deletions = pr.deletions ?? 0;
    const changedFiles = pr.changedFiles ?? 0;
    const files = (pr.files?.nodes ?? []).map((f) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }));

    // The PR's prior draft/state, read BEFORE the upsert below, so we can emit the
    // lifecycle transitions GitHub doesn't expose as discrete events (draft → ready,
    // reopened). null on first sight of a PR → no transition event.
    const prev =
      (
        await tx
          .select({ isDraft: pullRequests.isDraft, state: pullRequests.state })
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.accountId, accountId),
              eq(pullRequests.githubNodeId, pr.id),
            ),
          )
          .execute()
      )[0] ?? null;

    const prRow = (
      await tx
      .insert(pullRequests)
      .values({
        accountId,
        githubNodeId: pr.id,
        repoId,
        number: pr.number,
        title: pr.title,
        // Lean mode (cloud): the PR description and the per-job checkRuns JSON are
        // not stored — hydrated on demand. ciStatus (the summary enum) is kept.
        body: config.persistBodies ? (pr.body ?? null) : null,
        authorId,
        mergedById,
        baseRefName: pr.baseRefName ?? null,
        headRefName: pr.headRefName ?? null,
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
        checkRuns: config.persistBodies ? checkRuns : null,
        additions,
        deletions,
        changedFiles,
        files,
      })
      .onConflictDoUpdate({
        target: [pullRequests.accountId, pullRequests.githubNodeId],
        set: {
          title: pr.title,
          body: config.persistBodies ? (pr.body ?? null) : null,
          authorId,
          mergedById,
          baseRefName: pr.baseRefName ?? null,
          headRefName: pr.headRefName ?? null,
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
          checkRuns: config.persistBodies ? checkRuns : null,
          additions,
          deletions,
          changedFiles,
          files,
        },
      })
      .returning({ id: pullRequests.id })
      .execute()
    )[0]!;
    const prId = prRow.id;

    // ---- CI status transition log (DORA-ish CI metrics) ----
    // Record a row whenever this PR head's CI rollup / failing-check set / head SHA
    // differs from the last snapshot — an append-only transition log (not a per-tick
    // dump). Uses the fresh GraphQL checkRuns (populated even in lean mode, unlike the
    // stored column), so the failing check NAMES are the stage-level failure reasons.
    if (headSha != null && ciStatus !== 'unknown') {
      const failing = [
        ...new Set(
          checkRuns
            .filter((c) => c.state === 'failure' || c.state === 'error')
            .map((c) => c.name),
        ),
      ].sort();
      const lastCi = (
        await tx
          .select({
            status: ciStatusEvents.status,
            headSha: ciStatusEvents.headSha,
            failingChecks: ciStatusEvents.failingChecks,
          })
          .from(ciStatusEvents)
          .where(and(eq(ciStatusEvents.accountId, accountId), eq(ciStatusEvents.prId, prId)))
          .orderBy(desc(ciStatusEvents.observedAt))
          .limit(1)
          .execute()
      )[0];
      const changed =
        lastCi == null ||
        lastCi.status !== ciStatus ||
        lastCi.headSha !== headSha ||
        JSON.stringify([...(lastCi.failingChecks ?? [])].sort()) !== JSON.stringify(failing);
      if (changed) {
        await tx
          .insert(ciStatusEvents)
          .values({
            accountId,
            repoId,
            prId,
            headSha,
            status: ciStatus,
            failingChecks: failing,
            observedAt: new Date(),
          })
          .execute();
      }
    }

    // ---- review requests (outstanding) — reconcile by delete + reinsert ----
    await tx.delete(reviewRequests).where(eq(reviewRequests.prId, prId)).execute();
    for (const rr of pr.reviewRequests?.nodes ?? []) {
      const reviewer = rr.requestedReviewer;
      if (!reviewer) continue;
      if (reviewer.__typename === 'User') {
        const userId = await resolver.resolve(tx, {
          login: reviewer.login,
          id: reviewer.id,
        });
        await tx.insert(reviewRequests).values({ prId, userId, teamName: null }).execute();
      } else if (reviewer.__typename === 'Team') {
        await tx
          .insert(reviewRequests)
          .values({ prId, userId: null, teamName: reviewer.name })
          .execute();
      }
    }

    // ---- lifecycle events ----
    await upsertEvent(tx, {
      accountId,
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
      await upsertEvent(tx, {
        accountId,
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
      await upsertEvent(tx, {
        accountId,
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
    // Transitions GitHub gives no discrete event for (draft→ready, reopened): emitted
    // only when THIS sync observed the flip (`prev` is the pre-upsert row), so a PR
    // first seen already ready/open emits nothing. dedupeKey is keyed on the PR (one
    // ready / one reopened per PR) — re-toggling re-emits at most once. occurredAt =
    // updatedAt is the closest available signal (GitHub gives no ready-at/reopened-at).
    for (const type of lifecycleTransitions(prev, {
      isDraft: pr.isDraft,
      state: prState(pr.state),
    })) {
      await upsertEvent(tx, {
        accountId,
        repoId,
        actorId: authorId,
        prId,
        type,
        occurredAt: new Date(pr.updatedAt),
        refTable: 'pull_requests',
        refId: prId,
        dedupeKey: `${type}:${pr.id}`,
      });
    }

    // ---- reviews ----
    for (const r of pr.reviews.nodes) {
      const reviewerId = await resolver.resolve(tx, r.author);
      const submittedAt = toDate(r.submittedAt);
      if (!submittedAt) continue; // pending reviews have no timestamp
      const reviewRow = (
        await tx
        .insert(reviews)
        .values({
          githubNodeId: r.id,
          prId,
          authorId: reviewerId,
          state: reviewState(r.state),
          // Review bodies are always persisted (Feed renders them; also drives
          // substantive-review detection) regardless of lean storage.
          body: r.body ?? null,
          databaseId: r.fullDatabaseId ?? null,
          submittedAt,
        })
        .onConflictDoUpdate({
          target: [reviews.prId, reviews.githubNodeId],
          set: {
            state: reviewState(r.state),
            body: r.body ?? null,
            databaseId: r.fullDatabaseId ?? null,
            submittedAt,
          },
        })
        .returning({ id: reviews.id })
        .execute()
      )[0]!;
      if (isSubstantiveReview(reviewState(r.state), r.body)) {
        await upsertEvent(tx, {
          accountId,
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

    // Prior resolved-state per thread (this PR) so we can stamp resolvedAt on a WITNESSED
    // unresolved→resolved flip only. A thread already resolved the first time we see it keeps a
    // null resolvedAt (its true resolution time is unknown). Read once, before the upserts.
    const priorThreads = new Map<string, { isResolved: boolean; resolvedAt: Date | null }>();
    for (const row of await tx
      .select({
        nodeId: reviewThreads.githubNodeId,
        isResolved: reviewThreads.isResolved,
        resolvedAt: reviewThreads.resolvedAt,
      })
      .from(reviewThreads)
      .where(eq(reviewThreads.prId, prId))
      .execute())
      priorThreads.set(row.nodeId, { isResolved: row.isResolved, resolvedAt: row.resolvedAt });
    const observedAt = new Date();

    for (const t of pr.reviewThreads.nodes) {
      const commentNodes = t.comments.nodes;
      const originalCommenterId = await resolver.resolve(tx, commentNodes[0]?.author);

      const resolvedByLogin = t.resolvedBy?.login ?? null;
      // Preserve a prior stamp; set it fresh only when we observe unresolved→resolved this sync.
      const resolvedAt = nextResolvedAt(priorThreads.get(t.id), t.isResolved, observedAt);
      const { state: derivedState, addressedConfidence, addressedReason } =
        deriveThreadState(
          {
            isResolved: t.isResolved,
            path: t.path,
            isOutdated: t.isOutdated,
            resolvedByLogin,
            comments: commentNodes.map((c) => ({
              author: c.author ? { login: c.author.login } : null,
              createdAt: c.createdAt,
              body: c.body ?? null,
            })),
          },
          commitInputs,
          commitFilesBySha,
        );

      const threadRow = (
        await tx
        .insert(reviewThreads)
        .values({
          githubNodeId: t.id,
          prId,
          path: t.path,
          line: t.line,
          isResolved: t.isResolved,
          isOutdated: t.isOutdated,
          derivedState,
          addressedConfidence,
          addressedReason,
          resolvedByLogin,
          resolvedAt,
          originalCommenterId,
          createdAt: commentNodes[0]
            ? new Date(commentNodes[0].createdAt)
            : new Date(pr.createdAt),
        })
        .onConflictDoUpdate({
          target: [reviewThreads.prId, reviewThreads.githubNodeId],
          set: {
            isResolved: t.isResolved,
            isOutdated: t.isOutdated,
            derivedState,
            addressedConfidence,
            addressedReason,
            resolvedByLogin,
            resolvedAt,
            line: t.line,
          },
        })
        .returning({ id: reviewThreads.id })
        .execute()
      )[0]!;

      for (const c of commentNodes) {
        const commenterId = await resolver.resolve(tx, c.author);
        const createdAt = new Date(c.createdAt);
        await tx
          .insert(reviewComments)
          .values({
            githubNodeId: c.id,
            threadId: threadRow.id,
            prId,
            authorId: commenterId,
            // Review-comment bodies are always persisted (Feed renders them); only
            // the large diff hunk stays lean-gated. Excerpt kept for triage.
            body: c.body,
            excerpt: excerptOf(c.body),
            diffHunk: config.persistBodies ? (c.diffHunk ?? null) : null,
            databaseId: c.fullDatabaseId ?? null,
            createdAt,
          })
          .onConflictDoUpdate({
            target: [reviewComments.prId, reviewComments.githubNodeId],
            set: {
              body: c.body,
              excerpt: excerptOf(c.body),
              diffHunk: config.persistBodies ? (c.diffHunk ?? null) : null,
              databaseId: c.fullDatabaseId ?? null,
            },
          })
          .execute();
        await upsertEvent(tx, {
          accountId,
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
      const commenterId = await resolver.resolve(tx, c.author);
      const createdAt = new Date(c.createdAt);
      const commentRow = (
        await tx
        .insert(prComments)
        .values({
          githubNodeId: c.id,
          prId,
          authorId: commenterId,
          // PR-comment bodies are always persisted (Feed renders them).
          body: c.body ?? null,
          databaseId: c.fullDatabaseId ?? null,
          createdAt,
        })
        .onConflictDoUpdate({
          target: [prComments.prId, prComments.githubNodeId],
          set: {
            body: c.body ?? null,
            databaseId: c.fullDatabaseId ?? null,
          },
        })
        .returning({ id: prComments.id })
        .execute()
      )[0]!;
      await upsertEvent(tx, {
        accountId,
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
      const commitAuthorId = await resolver.resolve(
        tx,
        c.author?.user
          ? { login: c.author.user.login, id: c.author.user.id }
          : null,
      );
      const committerId = await resolver.resolve(
        tx,
        c.committer?.user
          ? { login: c.committer.user.login, id: c.committer.user.id }
          : null,
      );
      const committedAt = new Date(c.committedDate);
      // Upsert (not DoNothing) so we always get the row id back to point the
      // timeline event at — the marker modal resolves the commit via ref_id.
      const commitRow = (
        await tx
        .insert(commits)
        .values({
          sha: c.oid,
          prId,
          authorId: commitAuthorId,
          committerId,
          message: config.persistBodies ? c.message : null,
          committedAt,
        })
        .onConflictDoUpdate({
          target: [commits.sha, commits.prId],
          set: { message: config.persistBodies ? c.message : null, committedAt },
        })
        .returning({ id: commits.id })
        .execute()
      )[0]!;
      await upsertEvent(tx, {
        accountId,
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
