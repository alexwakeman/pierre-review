import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema, runTransaction, type Executor } from '../db/client.js';
import { TREND_DAYS } from '../db/branch-queries.js';
import {
  getGraphqlClientFor,
  graphqlTolerant,
  withGithubRetry,
  type GraphqlClient,
} from '../github/client.js';
import { gateBudget } from '../github/rate-budget.js';
import {
  buildCommitChecksQuery,
  COMMIT_CHECKS_ALIAS_CAP,
  DEFAULT_BRANCH_QUERY,
  DEFAULT_BRANCH_HISTORY_QUERY,
  type CommitChecksResponse,
  type DefaultBranchResponse,
  type DefaultBranchHistoryResponse,
  type GqlAssociatedPr,
  type GqlBranchCheckContext,
  type GqlBranchCommit,
} from '../github/branch-queries.js';
// One shared mapper: GitHub's `StatusState` enum is identical on a Commit's rollup and on a PR
// head's, so this reuses sync/upsert.ts's rather than keeping a second copy that could drift.
// `checkContextState` + `parseActionsIds` are shared for the same reason one level down: a
// failing check on trunk must be the same object as a failing check on a PR.
import { checkContextState, ciStatusFrom, parseActionsIds } from './upsert.js';
import type { BranchCheckRun, CiStatus } from '@pierre-review/shared';

const { repos, users, branchCommits } = schema;

// How many trunk commits the LIVE snapshot fetches per repo — GitHub's page maximum — and the
// unconditional floor of the trim below (the newest this-many rows are never deleted, however
// old). Rows beyond it survive only inside the TREND_DAYS window; they come from the one-time
// history backfill (`backfillBranchHistory`), whose ciStatus is final by the time it runs, so
// the live walk not re-observing them is by design rather than a staleness hole.
//
// Cost of the widening (20 → 100): phase 1's node budget is N + 3N (the history page plus its
// nested associatedPullRequests(first: 3)), scored ceil(total/100) — so N=100 is 400 nodes ⇒
// 4 rate-limit points per repo per sync, where N=20 was 1. An ACCEPTED cost: the wider window is
// what feeds the branch-trends charts (90 days of trunk CI + what landed), and it rides the
// per-repo sync, not every adaptive tick.
export const BRANCH_COMMIT_WINDOW = 100;

// The trim is a HYBRID bound: the newest BRANCH_COMMIT_WINDOW rows are kept UNCONDITIONALLY,
// and rows below that survive as long as they sit inside the TREND_DAYS window (which is what
// lets the one-time history backfill's deeper rows live — a pure count bound would delete them
// on the very next sync tick). The unconditional half is a landmine guard, not a nicety: an
// age bound applied to ALL rows would mean a repo whose newest trunk commit is older than the
// cutoff (dormant repo, or an active one whose committer dates were backdated by a
// rebase/import) has its ENTIRE set inserted and deleted in the same transaction on every sync
// — the strip row reads "never synced", the expander is permanently disabled, and the walk
// burns its 4 points writing rows it immediately destroys. The trends read
// (db/branch-queries.ts getBranchTrends) applies its own `committedAt >= now - 90d` filter,
// which is where the "no year-old bars" promise actually lives.

// Which rollup states earn the SECOND round trip for failing-check detail. A green commit is
// skipped entirely — that is what keeps the common case at the ~1 point this file's query header
// promises. 'pending' is included because GitHub reports the ROLLUP as PENDING while other checks
// are still running even after one has already FAILED: that is the classic amber-with-a-real-
// failure case, and without it an amber commit could never get a caret.
const DETAIL_STATES = new Set<CiStatus>(['failure', 'error', 'pending']);

// The rollup states that are a POSITIVE statement that nothing is failing, and therefore the only
// ones allowed to CLEAR stored detail. See the partial-response policy below for why 'unknown'
// (which is also what a nulled-by-partial-error rollup maps to) is deliberately not in here.
const CLEAR_STATES = new Set<CiStatus>(['success', 'expected']);

// Defensive cap on the stored array. The whole point of this column is that it is tiny; a
// pathological repo with 300 failing contexts must not write a fat row per commit.
export const MAX_FAILING_CHECKS_PER_COMMIT = 20;

export interface BranchSyncLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

export interface SyncBranchStatusOptions {
  owner: string;
  name: string;
  repoId: number;
  accountId: number;
  token: string;
  log?: BranchSyncLogger;
}

const DAY_MS = 86_400_000;

// How many pages the one-time history backfill will walk (at BRANCH_COMMIT_WINDOW commits and
// ~4 rate-limit points each). 10 pages = 1000 trunk commits — deeper than 90 days of all but
// the busiest repos; on those the strip's oldest days simply stay unpopulated, disclosed by
// the `truncated` flag in the result (and the caller's log line), never silently.
export const BRANCH_BACKFILL_MAX_PAGES = 10;

export interface BranchStatusSyncResult {
  branchName: string | null;
  headSha: string | null;
  ciStatus: CiStatus;
  commitCount: number;
  // How many commits in the window earned a phase-2 detail fetch. Reported so the two-phase cost
  // claim is MEASURED from a log line rather than trusted from an estimate.
  failingCommitCount: number;
  rateLimitCost: number;
}

// ---- The partial-response policy, applied identically to BOTH new columns ------------------
//
// `graphqlTolerant` returns GitHub's PARTIAL data when a token may read most of a query but is
// forbidden one sub-field — the forbidden field arrives NULLED. So "the response says null" and
// "we never received that selection" look the same at the JSON level, and the two demand opposite
// writes: the first should clear the column, the second must leave it alone. Writing
// unconditionally would NULL yesterday's good detail on every tick for such a token, and a red
// commit would permanently lose its caret (and a chip would blink out) for a reason no user can
// see. Writing conditionally on non-null would instead leave a stale value alive forever after a
// re-run turned a check green.
//
// The resolution, used by both `failingChecksToWrite` and `prNumberToWrite`: a value is written
// ONLY when the response actually CARRIED the selection it is derived from —
//   • `undefined` ⇒ not received / not knowable ⇒ omit the column from the write entirely.
//   • `null` / `[]` ⇒ GitHub positively stated there is nothing ⇒ write it, clearing any
//     previously stored value.
// For failing checks the positive statement is a green (or 'expected') ROLLUP from phase 1, or a
// phase-2 response that actually contained a `contexts` list. For the PR reference it is an
// `associatedPullRequests.nodes` ARRAY (an empty one means "this commit came from no PR" — a
// direct push, which is a legitimate steady state, not a gap).

/**
 * The FAILING checks among a commit's rollup contexts — never the passing ones.
 *
 * Reuses the PR side's `checkContextState` + `parseActionsIds` verbatim so a trunk failure and a
 * PR failure are the same object, then dedupes by display name keeping the newest Actions run:
 * `contexts` returns EVERY check suite attached to the commit and does NOT collapse to
 * latest-per-name the way GitHub's own PR UI does (a re-run, or a workflow fired by both `push`
 * and `pull_request`, contributes a second same-named CheckRun). Actions run ids increase
 * monotonically, so the highest runId is the most recent.
 */
export function failingChecksFrom(
  nodes: (GqlBranchCheckContext | null)[],
): BranchCheckRun[] {
  const byName = new Map<string, BranchCheckRun>();
  for (const c of nodes) {
    if (c == null) continue;
    const state = checkContextState(c);
    if (state !== 'failure' && state !== 'error') continue;
    const url = c.__typename === 'CheckRun' ? c.detailsUrl : c.targetUrl;
    const { runId, jobId } =
      c.__typename === 'CheckRun' ? parseActionsIds(url) : { runId: null, jobId: null };
    const item: BranchCheckRun = {
      // Third-party text (a check's name is whatever the CI vendor chose), so it is length-capped
      // here rather than trusted; the frontend renders it as a plain text node.
      name: (c.__typename === 'CheckRun' ? c.name : c.context).slice(0, 200),
      state,
      url,
      runId,
      jobId,
      workflowName:
        c.__typename === 'CheckRun'
          ? (c.checkSuite?.workflowRun?.workflow?.name ?? null)
          : null,
    };
    const prev = byName.get(item.name);
    if (!prev || (item.runId ?? -1) > (prev.runId ?? -1)) byName.set(item.name, item);
  }
  return [...byName.values()].slice(0, MAX_FAILING_CHECKS_PER_COMMIT);
}

/**
 * Which single PR number to store for a trunk commit, or null for a direct push.
 *
 * The 0 / 1 / many contract:
 *   0 candidates → a direct push to trunk (the legitimate no-chip case) → null.
 *   1            → the normal squash/merge landing → that number.
 *   2+           → the commit is reachable from several PRs (a branch merged into another open
 *                  PR, a cherry-pick, a revert-then-reland). Store exactly ONE, ranked
 *                  (merged into THIS repo's default branch) > (merged anywhere) > (open), with
 *                  the LOWEST number as a stable tiebreak.
 *
 * Determinism is the whole point: the ranking is ours precisely so a re-sync can never flip the
 * displayed number, which `first: 1` on an unordered connection would.
 *
 * A candidate from another repository is DROPPED: `associatedPullRequests` spans the repo network,
 * so a fork's own PR can appear, and the read layer resolves a number within (accountId, repoId)
 * — a foreign number would resolve to a completely unrelated local PR. A null `nameWithOwner` (a
 * tolerant partial nulled it) is accepted rather than discarding an otherwise good candidate.
 */
export function pickAssociatedPrNumber(
  n: GqlBranchCommit,
  fullName: string,
  defaultBranchName: string | null,
): number | null {
  const cands = (n.associatedPullRequests?.nodes ?? []).filter(
    (p): p is GqlAssociatedPr & { number: number } =>
      p != null &&
      typeof p.number === 'number' &&
      (p.repository?.nameWithOwner == null || p.repository.nameWithOwner === fullName),
  );
  const first = cands[0];
  if (first == null) return null;
  const rank = (p: GqlAssociatedPr): number => {
    if (p.merged !== true) return 2;
    return defaultBranchName != null && p.baseRefName === defaultBranchName ? 0 : 1;
  };
  let best = first;
  for (const p of cands.slice(1)) {
    const d = rank(p) - rank(best);
    if (d < 0 || (d === 0 && p.number < best.number)) best = p;
  }
  return best.number;
}

/**
 * Which commits in the window earn a phase-2 detail fetch: the non-green ones, newest first.
 *
 * `history()` returns newest-first, so slicing to the alias cap keeps the NEWEST failing commits —
 * the ones anyone will actually expand. Exported so the "a green trunk issues no second query"
 * claim is a test rather than a comment.
 */
export function detailTargetShas(nodes: GqlBranchCommit[]): string[] {
  return nodes
    .filter((n) => DETAIL_STATES.has(ciStatusFrom(n.statusCheckRollup?.state)))
    .slice(0, COMMIT_CHECKS_ALIAS_CAP)
    .map((n) => n.oid);
}

/**
 * The failing-checks value to WRITE for one commit, per the partial-response policy above:
 * `undefined` ⇒ omit the column (we did not learn anything), `null` ⇒ positively no failures.
 */
export function failingChecksToWrite(
  n: GqlBranchCommit,
  failingBySha: Map<string, BranchCheckRun[]>,
): BranchCheckRun[] | null | undefined {
  const rollup = ciStatusFrom(n.statusCheckRollup?.state);
  if (CLEAR_STATES.has(rollup)) return null;
  // 'unknown' — either no rollup was received (a partial error nulled it) or GitHub's state isn't
  // one we model. Neither is a statement that nothing is failing, so nothing is cleared.
  if (!DETAIL_STATES.has(rollup)) return undefined;
  const found = failingBySha.get(n.oid);
  // Absent ⇒ past the alias cap, or the contexts selection wasn't received: keep what we have.
  if (found == null) return undefined;
  return found.length > 0 ? found : null;
}

/**
 * The PR-number value to WRITE for one commit, per the same policy. An `associatedPullRequests`
 * that arrived as null (a partial error) yields `undefined` — writing null there would erase a good
 * stored number and make the chip blink out of the UI for a reason the user cannot see.
 */
export function prNumberToWrite(
  n: GqlBranchCommit,
  fullName: string,
  defaultBranchName: string | null,
): number | null | undefined {
  return Array.isArray(n.associatedPullRequests?.nodes)
    ? pickAssociatedPrNumber(n, fullName, defaultBranchName)
    : undefined;
}

/**
 * Phase 2: the failing checks for the given shas, in ONE query.
 *
 * The returned map contains an entry ONLY for a sha whose `contexts` list actually arrived — an
 * absent key means "not received", which the caller must not confuse with "no failures". See the
 * partial-response policy above. Exported for the request-shape unit test.
 */
export async function fetchFailingChecks(
  client: GraphqlClient,
  owner: string,
  name: string,
  shas: string[],
  log?: BranchSyncLogger,
): Promise<{ bySha: Map<string, BranchCheckRun[]>; cost: number }> {
  const variables: Record<string, unknown> = { owner, name };
  shas.forEach((sha, i) => {
    variables[`s${i}`] = sha;
  });
  const resp = await withGithubRetry(() =>
    graphqlTolerant<CommitChecksResponse>(
      client,
      buildCommitChecksQuery(shas.length),
      variables,
      (errors) =>
        log?.warn(
          `branch-status ${owner}/${name}: partial GraphQL on commit checks — ` +
            `keeping previously stored detail for the affected commits`,
          errors,
        ),
    ),
  );

  const bySha = new Map<string, BranchCheckRun[]>();
  shas.forEach((sha, i) => {
    const nodes = resp.repository?.[`c${i}`]?.statusCheckRollup?.contexts?.nodes;
    // `nodes == null` covers all three not-received shapes: the alias resolved to nothing, the
    // rollup was nulled, or the contexts selection itself was forbidden.
    if (nodes == null) return;
    bySha.set(sha, failingChecksFrom(nodes));
  });
  return { bySha, cost: resp.rateLimit?.cost ?? 0 };
}

/**
 * The commit-author logins we already know, resolved in ONE query. Lookup-only on purpose —
 * see the author-mapping note on `syncBranchStatus`: no `users` rows are ever created here.
 */
async function resolveKnownLogins(nodes: GqlBranchCommit[]): Promise<Map<string, number>> {
  const logins = [
    ...new Set(
      nodes
        .map((n) => n.author?.user?.login)
        .filter((l): l is string => typeof l === 'string' && l.length > 0),
    ),
  ];
  const userIdByLogin = new Map<string, number>();
  if (logins.length > 0) {
    const rows = await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.githubLogin, logins))
      .execute();
    for (const r of rows) userIdByLogin.set(r.login, r.id);
  }
  return userIdByLogin;
}

/**
 * Upsert one page of trunk-commit nodes — shared verbatim between the live snapshot and the
 * history backfill so the two walks can never store differently-shaped rows. Idempotent on
 * `(accountId, repoId, sha)`; the observed-key spread implements the partial-response policy
 * above (an omitted key leaves the column at its default on INSERT and untouched on UPDATE,
 * which is exactly what "we did not receive that selection" means).
 */
async function upsertBranchCommitRows(
  tx: Executor,
  args: { accountId: number; repoId: number; fullName: string; branchName: string | null },
  nodes: GqlBranchCommit[],
  userIdByLogin: Map<string, number>,
  failingBySha: Map<string, BranchCheckRun[]>,
): Promise<void> {
  for (const n of nodes) {
    const login = n.author?.user?.login ?? null;
    const authorUserId = login != null ? userIdByLogin.get(login) ?? null : null;
    const failingChecks = failingChecksToWrite(n, failingBySha);
    const prNumber = prNumberToWrite(n, args.fullName, args.branchName);
    const observed = {
      ...(failingChecks !== undefined ? { failingChecks } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
    };
    await tx
      .insert(branchCommits)
      .values({
        accountId: args.accountId,
        repoId: args.repoId,
        sha: n.oid,
        messageHeadline: n.messageHeadline,
        authorUserId,
        // Prefer the git author name; fall back to the login so a commit by a known GitHub
        // account with a blank git name still shows SOMETHING attributable.
        authorName: n.author?.name ?? login,
        authorAvatarUrl: n.author?.avatarUrl ?? null,
        committedAt: new Date(n.committedDate),
        ciStatus: ciStatusFrom(n.statusCheckRollup?.state),
        ...observed,
      })
      .onConflictDoUpdate({
        target: [branchCommits.accountId, branchCommits.repoId, branchCommits.sha],
        set: {
          messageHeadline: n.messageHeadline,
          authorUserId,
          authorName: n.author?.name ?? login,
          authorAvatarUrl: n.author?.avatarUrl ?? null,
          committedAt: new Date(n.committedDate),
          ciStatus: ciStatusFrom(n.statusCheckRollup?.state),
          ...observed,
        },
      })
      .execute();
  }
}

/**
 * Which of the retained rows the trim deletes, given rows sorted NEWEST-FIRST: anything both
 * below the newest-BRANCH_COMMIT_WINDOW floor AND outside the TREND_DAYS window. Pure and
 * exported so the hybrid bound's two halves are pinned by tests rather than a comment.
 */
export function staleBranchCommitIds(
  rows: { id: number; committedAt: Date }[],
  nowMs: number,
): number[] {
  const cutoffMs = nowMs - TREND_DAYS * DAY_MS;
  return rows
    .filter((r, i) => i >= BRANCH_COMMIT_WINDOW && r.committedAt.getTime() < cutoffMs)
    .map((r) => r.id);
}

/**
 * Snapshot a repo's DEFAULT BRANCH: its head sha + CI rollup onto `repos`, and the most recent
 * `BRANCH_COMMIT_WINDOW` trunk commits (with their own per-commit CI state, the checks that were
 * failing on them, and the PR each landed from) into `branch_commits`.
 *
 * Why this can't come from the existing tables: `commits` is PR-scoped, and a squash-merged PR
 * never appears there under the SHA that actually landed on trunk. So "is main green, and what
 * landed on it" is unanswerable without its own read.
 *
 * Idempotent — commits upsert on `(accountId, repoId, sha)`, so a re-sync of the same window
 * updates each commit's CI state in place (a commit that was `pending` last tick becomes
 * `success` on this one) rather than duplicating rows.
 *
 * Author mapping is deliberately LOOKUP-ONLY: a trunk committer who resolves to an already-known
 * `users` row gets `authorUserId` (so the UI can render their synced avatar + the maintainer
 * shield); anyone else is stored as raw `authorName`/`authorAvatarUrl`. We do NOT insert users
 * here — `users` is a GLOBAL table, and creating rows for every drive-by trunk committer would
 * grow it with identities that appear nowhere else in the account's data.
 */
export async function syncBranchStatus(
  opts: SyncBranchStatusOptions,
): Promise<BranchStatusSyncResult> {
  const { owner, name, repoId, accountId, token } = opts;
  const client = getGraphqlClientFor(token);
  const fullName = `${owner}/${name}`;

  const resp = await withGithubRetry(() =>
    graphqlTolerant<DefaultBranchResponse>(
      client,
      DEFAULT_BRANCH_QUERY,
      { owner, name, first: BRANCH_COMMIT_WINDOW },
      (errors) =>
        opts.log?.warn(
          `branch-status ${fullName}: partial GraphQL — continuing without forbidden fields`,
          errors,
        ),
    ),
  );

  const ref = resp.repository?.defaultBranchRef ?? null;
  const branchName = ref?.name ?? null;
  // `target` is a nullable INTERFACE — a branch whose tip isn't a Commit selects nothing, so
  // every field below is optional even when `target` itself is present.
  const target = ref?.target ?? null;
  const headSha = target?.oid ?? null;
  const headCi = ciStatusFrom(target?.statusCheckRollup?.state);
  const nodes: GqlBranchCommit[] = (target?.history?.nodes ?? []).filter(
    (n): n is GqlBranchCommit => n != null && typeof n.oid === 'string',
  );

  // Resolve the commit authors we already know, in ONE query. GraphQL gives a login only when
  // the commit email maps to a GitHub account; the rest keep their raw git name.
  const userIdByLogin = await resolveKnownLogins(nodes);

  // Phase 2, for the non-green commits only — a green trunk issues no second query at all.
  const detailTargets = detailTargetShas(nodes);
  let failingBySha = new Map<string, BranchCheckRun[]>();
  let detailCost = 0;
  if (detailTargets.length > 0) {
    // LOAD-BEARING try/catch: sync-repo.ts already treats the whole of `syncBranchStatus` as
    // non-fatal, so an unguarded throw here would discard the phase-1 snapshot too — dots,
    // headSha, authors, the entire strip for this repo. Detail failure must degrade to "no
    // carets", never to "no strip".
    try {
      const r = await fetchFailingChecks(client, owner, name, detailTargets, opts.log);
      failingBySha = r.bySha;
      detailCost = r.cost;
    } catch (err) {
      opts.log?.warn(
        `branch-status ${fullName}: failing-check detail failed (non-fatal): ` +
          `${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
  }

  await runTransaction(async (tx) => {
    await upsertBranchCommitRows(
      tx,
      { accountId, repoId, fullName, branchName },
      nodes,
      userIdByLogin,
      failingBySha,
    );

    // Trim IN the same transaction, so the table can never be observed holding an unbounded
    // history. HYBRID bound (see staleBranchCommitIds + the constants' comments): the newest
    // BRANCH_COMMIT_WINDOW rows unconditionally, plus backfilled rows inside the TREND_DAYS
    // window. Done as select-then-delete-by-id rather than a correlated DELETE … LIMIT, which
    // is not portable across sqlite and Postgres.
    const kept = await tx
      .select({ id: branchCommits.id, committedAt: branchCommits.committedAt })
      .from(branchCommits)
      .where(and(eq(branchCommits.accountId, accountId), eq(branchCommits.repoId, repoId)))
      .orderBy(desc(branchCommits.committedAt))
      .execute();
    const stale = staleBranchCommitIds(kept, Date.now());
    // Guard the empty case: `inArray(col, [])` is a degenerate predicate whose behaviour
    // differs by dialect, and there is nothing to delete anyway.
    if (stale.length > 0) {
      await tx.delete(branchCommits).where(inArray(branchCommits.id, stale)).execute();
    }

    await tx
      .update(repos)
      .set({
        defaultBranchName: branchName,
        defaultBranchHeadSha: headSha,
        defaultBranchCiStatus: headCi,
        defaultBranchUpdatedAt: new Date(),
      })
      // Ownership is part of the predicate, not an assumption about the caller.
      .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
      .execute();
  });

  const rateLimitCost = (resp.rateLimit?.cost ?? 0) + detailCost;
  if (detailTargets.length > 0) {
    // The one place the two-phase cost claim is observable. Logged only when phase 2 actually
    // ran, so a healthy repo stays silent.
    opts.log?.info(
      `branch-status ${fullName}: ${detailTargets.length} non-green commit(s), ` +
        `${failingBySha.size} with retrievable checks, ${rateLimitCost} rate-limit point(s)`,
    );
  }

  return {
    branchName,
    headSha,
    ciStatus: headCi,
    commitCount: nodes.length,
    failingCommitCount: detailTargets.length,
    rateLimitCost,
  };
}

export interface BranchHistoryBackfillResult {
  pages: number;
  commitCount: number;
  rateLimitCost: number;
  // True when the walk stopped with history still unread (page cap or cancellation) — the
  // caller logs it so a bounded backfill never silently reads as "covered the whole window".
  truncated: boolean;
}

/**
 * ONE-TIME deepening of the trunk window: walk `history(since: now − TREND_DAYS)` page by page
 * and upsert every commit, so the branch-trends DayStrip spans its whole 90-day read window
 * instead of only the newest BRANCH_COMMIT_WINDOW commits the live snapshot retains. Runs after
 * a repo's first full sync (and a forced deep re-sync) — see sync-manager.ts.
 *
 * Deliberate differences from the live snapshot, all cost-driven:
 *   • NO phase-2 failing-check detail — the trend cells need only `ciStatus`, and per the
 *     partial-response policy an absent detail simply omits the column (`failingChecksToWrite`
 *     returns undefined for a non-green commit with no phase-2 entry), so any detail the live
 *     window already stored is left untouched where the walks overlap.
 *   • NO `repos` head-column write and NO trim — the live snapshot owns both; every row this
 *     walk inserts sits inside the TREND_DAYS window the hybrid trim retains.
 *   • The first page re-reads the live window from the branch tip rather than resuming a stored
 *     cursor — history cursors are position-relative and trunk moves during the PR walk, so a
 *     handed-off cursor could silently skip commits; one duplicate page is 4 points, and the
 *     upsert is idempotent.
 *
 * Old commits' rollups are FINAL for our purposes (a historical re-run that flips one is rarer
 * than the live window's own retro-flips, which docs/MERGE-CI-TRUNK.md already documents), so
 * never re-observing these rows is by design. A commit whose CI never finished stays `pending`
 * and counts as neither pass nor fail in the trends read.
 */
export async function backfillBranchHistory(
  opts: SyncBranchStatusOptions & { shouldCancel?: () => boolean },
): Promise<BranchHistoryBackfillResult> {
  const { owner, name, repoId, accountId, token } = opts;
  const client = getGraphqlClientFor(token);
  const fullName = `${owner}/${name}`;
  const since = new Date(Date.now() - TREND_DAYS * DAY_MS).toISOString();

  let after: string | null = null;
  let pages = 0;
  let commitCount = 0;
  let rateLimitCost = 0;

  while (pages < BRANCH_BACKFILL_MAX_PAGES) {
    if (opts.shouldCancel?.()) break;
    // Shares its token with the account's PR walks: when the budget is low or a limit was
    // observed, wait (cancellably) before spending ~4 points on another history page. A
    // cancel mid-wait breaks like any cancel — the walk stays strictly non-fatal and the
    // result is disclosed as truncated.
    if ((await gateBudget(accountId, { shouldCancel: opts.shouldCancel })) === 'cancelled') {
      break;
    }
    const resp = await withGithubRetry(() =>
      graphqlTolerant<DefaultBranchHistoryResponse>(
        client,
        DEFAULT_BRANCH_HISTORY_QUERY,
        { owner, name, first: BRANCH_COMMIT_WINDOW, since, after },
        (errors) =>
          opts.log?.warn(
            `branch-backfill ${fullName}: partial GraphQL — continuing without forbidden fields`,
            errors,
          ),
      ),
    );
    pages += 1;
    rateLimitCost += resp.rateLimit?.cost ?? 0;

    const ref = resp.repository?.defaultBranchRef ?? null;
    const history = ref?.target?.history ?? null;
    const nodes: GqlBranchCommit[] = (history?.nodes ?? []).filter(
      (n): n is GqlBranchCommit => n != null && typeof n.oid === 'string',
    );
    if (nodes.length > 0) {
      const userIdByLogin = await resolveKnownLogins(nodes);
      const branchName = ref?.name ?? null;
      await runTransaction(async (tx) => {
        await upsertBranchCommitRows(
          tx,
          { accountId, repoId, fullName, branchName },
          nodes,
          userIdByLogin,
          new Map(),
        );
      });
      commitCount += nodes.length;
    }

    // An absent pageInfo is "not received" (tolerant partial), which must stop the walk rather
    // than throw or spin; endCursor null with hasNextPage true is treated the same way.
    const pageInfo = history?.pageInfo ?? null;
    if (pageInfo?.hasNextPage !== true || pageInfo.endCursor == null) {
      return { pages, commitCount, rateLimitCost, truncated: false };
    }
    after = pageInfo.endCursor;
  }
  return { pages, commitCount, rateLimitCost, truncated: true };
}
