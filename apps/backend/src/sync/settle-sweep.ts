// THE SETTLE SWEEP — finding updatedAt-SILENT changes for ~1 GraphQL point per repo, instead of
// re-walking blind (docs/REALTIME-SYNC.md § The settle sweep).
//
// THE BLIND SPOT. The probe and the walk both key on a PR's `updatedAt`, and GitHub does not bump
// it when CI finishes, when a review thread is resolved, or when the trunk moves under an open PR.
// The old answer was a forced re-walk every 30 minutes — which used the SAME `since` window and so
// re-read exactly the PRs that had not changed, for ~15 points a repo, and never the ones that had.
//
// THE SWEEP. Every 5 minutes for hot and warm repos, 15 for cold ones (adaptive.ts
// `isSettleDue`), ONE aliased query per ≤10 repos lists every open PR's head, CI rollup state,
// review-thread resolutions, draft flag, review decision and `updatedAt`, plus the default
// branch's head (github/settle-query.ts; measured 9 points for 9 repos). Each PR is compared with
// its stored row:
//   • GitHub lists a PR the DB lacks, or one NEWER than stored → the walk will pick it up: the
//     repo is marked DIRTY (adaptive.ts `markDirty`; walked as soon as the walk cap allows). A PR
//     older than the walk's own `since` window is synced by number instead — the walk would never
//     reach it.
//   • Head, CI, unresolved-thread count, draft or review decision differ → `syncOnePr` for that PR
//     ONLY (~1 point), at most `syncSettleMaxPrSyncs` (20) per sweep; the rest still differ next
//     sweep and go then.
//   • A stored OPEN PR missing from a COMPLETE open list → synced by number (GitHub's full open
//     list is a positive statement that it is not open; the single-PR read records what it is).
//   • The trunk head moved (or was first seen) → the existing trunk-moved recheck
//     (sync/unsettled-prs.ts): merge state for ≤25 open PRs per request, twice. Mergeability is
//     NEVER asked for in the sweep itself — see the 502 rule in docs/REALTIME-SYNC.md.
//
// ⚠ NOTHING HERE WRITES A COLUMN. Every write goes through `syncOnePr` → `persistPr` or the
// recheck's `applyPrLiveness`, whose "cleared only on a positive statement" guards stay exactly
// as they are. A field the response did not carry (a nulled selection, a missing commit node, a
// thread list longer than one page) is UNOBSERVED and compares as equal — never as "changed".
// ⚠ LIMN'S OWN `limn/…` LINES ARE NOT CI. A head carrying one has its rollup recomputed without
// them (sync/limn-ci.ts `fetchRollupsWithoutLimn`, ~1 point per 10 heads) only when the raw state
// could hide a real change: PENDING (a pending Limn line masks CI finishing), or SUCCESS while the
// stored CI is neither success nor unknown.
// ⚠ LOOP-PROOF. A PR is re-synced at most once per distinct GitHub observation (`actedOn`): if
// the stored row still differs after the single-PR read (a field persistPr reads differently),
// the sweep waits for GitHub to say something new rather than paying a point every five minutes.
// ⚠ RATE LIMITS ARE PRE-EMPTED, never errors: a limited account is skipped (its repos are not
// stamped, so they are read as soon as the window lifts); a limit discovered by the query notes
// the shared budget and ends the account's sweep quietly. Any other failure is a warn line and the
// repos are stamped, so a GitHub fault is not re-asked every ten seconds.
// ⚠ ONE SWEEP AT A TIME, process-wide: a synchronous claim released in a `finally`.
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { isLimnStatusContext } from '@pierre-review/shared';
import { getAccessToken } from '../auth/account.js';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import {
  getGraphqlClientFor,
  graphqlTolerant,
  isRateLimitError,
  withGithubRetry,
  type GraphqlClient,
} from '../github/client.js';
import { isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import {
  buildSettleSweepQuery,
  SETTLE_REPOS_PER_QUERY,
  type GqlSettlePr,
  type GqlSettleRepo,
  type SettleSweepResponse,
} from '../github/settle-query.js';
import { isSettleDue, markDirty, noteSettle } from './adaptive.js';
import { fetchRollupsWithoutLimn } from './limn-ci.js';
import { syncOnePr } from './sync-one-pr.js';
import { scheduleTrunkMovedRecheck } from './unsettled-prs.js';
import { ciStatusFrom, reviewDecisionFrom } from './upsert.js';
import type { Logger } from './sync-repo.js';

const { repos, syncState, pullRequests, reviewThreads } = schema;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Pages of a repo's open list read per sweep (50 PRs each). Past this the list is incomplete. */
const SETTLE_MAX_PAGES = 4;
/** Bounded memory for the per-PR "already acted on this observation" map and the trunk heads. */
const ACTED_MAX = 5_000;
const TRUNK_MAX = 2_000;

type CiStatus = ReturnType<typeof ciStatusFrom>;
type ReviewDecision = 'approved' | 'changes_requested' | 'review_required';

/** One open PR as GitHub described it. `undefined` = not received — never compared. */
export interface SettleObservedPr {
  number: number;
  updatedAtMs: number | undefined;
  isDraft: boolean | undefined;
  reviewDecision: ReviewDecision | null | undefined;
  headOid: string | undefined;
  /** GitHub's raw rollup state (null = no checks). `undefined` when no head commit arrived. */
  rawCi: string | null | undefined;
  /** The head carries one of Limn's own `limn/…` status lines. */
  hasLimnLine: boolean;
  /** Unresolved review threads — only when the whole thread list arrived on one page. */
  unresolvedThreads: number | undefined;
}

/** The stored row the observation is compared with. */
export interface SettleStoredPr {
  id: number;
  number: number;
  state: 'open' | 'merged' | 'closed';
  updatedAt: Date;
  headSha: string | null;
  ciStatus: string | null;
  isDraft: boolean;
  reviewDecision: string | null;
  unresolvedThreads: number;
}

export type SettleReason =
  | 'missing'
  | 'updated'
  | 'reopened'
  | 'head'
  | 'ci'
  | 'threads'
  | 'draft'
  | 'review_decision'
  | 'absent';

export type SettleVerdict =
  /** GitHub has activity a walk will pick up — mark the repo dirty. */
  | { kind: 'walk' }
  /** Re-sync this PR by number. */
  | { kind: 'sync'; reasons: SettleReason[] }
  /** Stored row agrees with everything GitHub said. */
  | { kind: 'same' };

/** Fold one PR node; null when it carries no number (nothing to match a row on). Pure. */
export function foldSettlePr(node: GqlSettlePr | null | undefined): SettleObservedPr | null {
  if (!node || typeof node.number !== 'number') return null;
  const updatedAtMs = node.updatedAt ? Date.parse(node.updatedAt) : Number.NaN;
  const commitNode = node.commits?.nodes?.[node.commits.nodes.length - 1] ?? null;
  const commit = commitNode?.commit ?? null;
  const headOid = commit?.oid ?? undefined;
  const threads = node.reviewThreads;
  const threadNodes = threads?.nodes ?? null;
  const threadsComplete =
    threadNodes != null &&
    typeof threads?.totalCount === 'number' &&
    threadNodes.length === threads.totalCount &&
    threadNodes.every((t) => t != null && typeof t.isResolved === 'boolean');
  return {
    number: node.number,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : undefined,
    isDraft: typeof node.isDraft === 'boolean' ? node.isDraft : undefined,
    // Null is GitHub SAYING "no review decision" (the repo requires none) — the value persistPr
    // stores from the same answer. It is a statement only because the PR fragment landed.
    reviewDecision:
      node.reviewDecision === undefined ? undefined : reviewDecisionFrom(node.reviewDecision),
    headOid,
    // Only a received head commit says anything about CI; a null rollup on it is "no checks",
    // which persistPr stores as 'unknown' from the same answer.
    rawCi: headOid ? (commit?.statusCheckRollup?.state ?? null) : undefined,
    hasLimnLine: (commit?.status?.contexts ?? []).some((c) =>
      isLimnStatusContext(c?.context ?? null),
    ),
    unresolvedThreads: threadsComplete
      ? threadNodes.filter((t) => t?.isResolved === false).length
      : undefined,
  };
}

const LIMN_MASKABLE = new Set(['SUCCESS', 'PENDING']);

/**
 * Must this PR's CI be recomputed without Limn's lines before it can be judged? Only when the
 * head carries a Limn line, the head is the one we stored (a new head is re-synced anyway), and
 * the raw state could hide a real change: PENDING always (a pending Limn line masks CI
 * finishing), SUCCESS only when the stored CI is neither success nor unknown (an all-green rollup
 * means the Limn-free answer is success, or "no other CI", which persistPr stores as unknown).
 */
export function needsCiRecompute(stored: SettleStoredPr, obs: SettleObservedPr): boolean {
  if (!obs.hasLimnLine || obs.rawCi == null || obs.headOid !== stored.headSha) return false;
  const raw = obs.rawCi.toUpperCase();
  if (!LIMN_MASKABLE.has(raw)) return false;
  if (raw === 'PENDING') return true;
  return stored.ciStatus !== 'success' && stored.ciStatus !== 'unknown';
}

/**
 * The CI GitHub reports for this head, as persistPr would store it — or undefined when it cannot
 * be known from this response (no head commit, or a Limn line whose recompute is not to hand).
 */
function observedCi(
  stored: SettleStoredPr,
  obs: SettleObservedPr,
  ciWithoutLimn: CiStatus | undefined,
): CiStatus | undefined {
  if (obs.rawCi === undefined) return undefined;
  if (obs.hasLimnLine && obs.rawCi != null && LIMN_MASKABLE.has(obs.rawCi.toUpperCase())) {
    if (ciWithoutLimn !== undefined) return ciWithoutLimn;
    // An all-green rollup agrees with a stored success / "no other CI" (see needsCiRecompute).
    if (
      obs.rawCi.toUpperCase() === 'SUCCESS' &&
      (stored.ciStatus === 'success' || stored.ciStatus === 'unknown')
    ) {
      return stored.ciStatus as CiStatus;
    }
    return undefined;
  }
  return ciStatusFrom(obs.rawCi);
}

/**
 * Compare one observed open PR with its stored row. Pure.
 * `walkWindowStartMs` is where the repo's next incremental walk starts reading
 * (`lastIncrementalSyncAt − SYNC_OVERLAP_MINUTES`): a PR the walk will reach is left to it, one
 * older than that is synced by number.
 */
export function judgeSettledPr(
  stored: SettleStoredPr | undefined,
  obs: SettleObservedPr,
  walkWindowStartMs: number,
  ciWithoutLimn?: CiStatus,
): SettleVerdict {
  const walkReaches = obs.updatedAtMs != null && obs.updatedAtMs >= walkWindowStartMs;
  if (!stored) return walkReaches ? { kind: 'walk' } : { kind: 'sync', reasons: ['missing'] };
  if (obs.updatedAtMs != null && obs.updatedAtMs > stored.updatedAt.getTime()) {
    return walkReaches ? { kind: 'walk' } : { kind: 'sync', reasons: ['updated'] };
  }
  const reasons: SettleReason[] = [];
  if (stored.state !== 'open') reasons.push('reopened');
  if (obs.headOid !== undefined && obs.headOid !== stored.headSha) reasons.push('head');
  const ci = observedCi(stored, obs, ciWithoutLimn);
  if (ci !== undefined && ci !== (stored.ciStatus ?? 'unknown')) reasons.push('ci');
  if (obs.unresolvedThreads !== undefined && obs.unresolvedThreads !== stored.unresolvedThreads) {
    reasons.push('threads');
  }
  if (obs.isDraft !== undefined && obs.isDraft !== stored.isDraft) reasons.push('draft');
  if (obs.reviewDecision !== undefined && obs.reviewDecision !== (stored.reviewDecision ?? null)) {
    reasons.push('review_decision');
  }
  return reasons.length > 0 ? { kind: 'sync', reasons } : { kind: 'same' };
}

/** The observation's identity for the loop guard: a re-sync is paid once per distinct answer. */
function observationSig(obs: SettleObservedPr, ciWithoutLimn: CiStatus | undefined): string {
  return [
    obs.updatedAtMs ?? '',
    obs.headOid ?? '',
    obs.rawCi ?? '',
    ciWithoutLimn ?? '',
    obs.unresolvedThreads ?? '',
    obs.isDraft ?? '',
    obs.reviewDecision ?? '',
  ].join('|');
}

// `account:pr` → the observation signature the sweep last re-synced this PR for. Bounded FIFO.
const actedOn = new Map<string, string>();
function rememberActed(key: string, sig: string): void {
  if (actedOn.has(key)) actedOn.delete(key);
  else if (actedOn.size >= ACTED_MAX) {
    const oldest = actedOn.keys().next().value;
    if (oldest !== undefined) actedOn.delete(oldest);
  }
  actedOn.set(key, sig);
}

// `account:repo` → the default branch head the sweep last saw. Bounded FIFO.
const trunkHeads = new Map<string, string>();
function trunkMoved(key: string, oid: string): boolean {
  const prev = trunkHeads.get(key);
  if (prev === oid) return false;
  if (prev !== undefined) trunkHeads.delete(key);
  else if (trunkHeads.size >= TRUNK_MAX) {
    const oldest = trunkHeads.keys().next().value;
    if (oldest !== undefined) trunkHeads.delete(oldest);
  }
  trunkHeads.set(key, oid);
  return true;
}

let sweepInFlight = false;

interface SweepRepo {
  id: number;
  owner: string;
  name: string;
  accountId: number;
  lastIncrementalSyncAt: Date;
}

interface RepoRead {
  repo: SweepRepo;
  trunkOid: string | undefined;
  prs: GqlSettlePr[];
  /** The whole open list arrived (no further page) — absence from it is a statement. */
  complete: boolean;
}

interface PlannedSync {
  accountId: number;
  repoId: number;
  prId: number | null;
  number: number;
  sig: string;
  reasons: SettleReason[];
}

export interface SettleSweepResult {
  /** Another sweep was already running: nothing was done. */
  skipped: boolean;
  /** Repos read from GitHub this sweep. */
  repos: number;
  /** Open PRs compared with their stored rows. */
  compared: number;
  /** PRs re-synced by number (≤ syncSettleMaxPrSyncs). */
  prSyncs: number;
  /** PRs that differ but were left for the next sweep (the per-sweep cap). */
  deferred: number;
  /** Repos marked dirty for a walk. */
  walksMarked: number;
  /** Repos whose trunk moved (merge-state recheck scheduled). */
  trunkMoves: number;
  /** GraphQL points the sweep's own reads reported (rateLimit.cost). */
  cost: number;
  /** An account was skipped or cut short by a rate limit. Never an error. */
  paused: boolean;
}

function emptyResult(): SettleSweepResult {
  return {
    skipped: false,
    repos: 0,
    compared: 0,
    prSyncs: 0,
    deferred: 0,
    walksMarked: 0,
    trunkMoves: 0,
    cost: 0,
    paused: false,
  };
}

/** Repos the sweep may read: incrementally synced (a first backfill has nothing to compare). */
async function listSweepRepos(): Promise<SweepRepo[]> {
  const rows = await db
    .select({
      id: repos.id,
      owner: repos.owner,
      name: repos.name,
      accountId: repos.accountId,
      lastIncrementalSyncAt: syncState.lastIncrementalSyncAt,
    })
    .from(repos)
    .innerJoin(syncState, eq(syncState.repoId, repos.id))
    .where(isNotNull(syncState.lastIncrementalSyncAt))
    .execute();
  return rows.filter((r): r is SweepRepo => r.lastIncrementalSyncAt != null);
}

/**
 * The stored rows to compare with: the repo's open PRs plus any row GitHub listed by number
 * (a stored closed PR that is open again). ACCOUNT-SCOPED: `(accountId, repoId)` both bind.
 */
export async function getSettleStoredPrs(
  accountId: number,
  repoId: number,
  numbers: readonly number[],
): Promise<SettleStoredPr[]> {
  const scope = [eq(pullRequests.accountId, accountId), eq(pullRequests.repoId, repoId)];
  const rows = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      state: pullRequests.state,
      updatedAt: pullRequests.updatedAt,
      headSha: pullRequests.headSha,
      ciStatus: pullRequests.ciStatus,
      isDraft: pullRequests.isDraft,
      reviewDecision: pullRequests.reviewDecision,
    })
    .from(pullRequests)
    .where(
      and(
        ...scope,
        numbers.length > 0
          ? or(eq(pullRequests.state, 'open'), inArray(pullRequests.number, [...numbers]))
          : eq(pullRequests.state, 'open'),
      ),
    )
    .execute();
  if (rows.length === 0) return [];
  const counts = await db
    .select({ prId: reviewThreads.prId, n: sql<number>`count(*)` })
    .from(reviewThreads)
    .where(
      and(
        inArray(
          reviewThreads.prId,
          rows.map((r) => r.id),
        ),
        eq(reviewThreads.isResolved, false),
      ),
    )
    .groupBy(reviewThreads.prId)
    .execute();
  const unresolved = new Map(counts.map((c) => [c.prId, Number(c.n)]));
  return rows.map((r) => ({ ...r, unresolvedThreads: unresolved.get(r.id) ?? 0 }));
}

type ReadOutcome =
  | { kind: 'ok'; reads: RepoRead[] }
  | { kind: 'limited' }
  | { kind: 'failed' };

/** Read ≤ SETTLE_REPOS_PER_QUERY repos' open lists, following pages up to SETTLE_MAX_PAGES. */
async function readRepos(
  client: GraphqlClient,
  accountId: number,
  chunk: SweepRepo[],
  log: Logger,
  result: SettleSweepResult,
): Promise<ReadOutcome> {
  const reads = new Map<number, RepoRead>();
  let pending = chunk.map((repo) => ({ repo, cursor: null as string | null, pages: 0 }));
  while (pending.length > 0) {
    if (isLimited(accountId)) return { kind: 'limited' };
    const variables: Record<string, unknown> = {};
    pending.forEach((p, i) => {
      variables[`o${i}`] = p.repo.owner;
      variables[`n${i}`] = p.repo.name;
      variables[`a${i}`] = p.cursor;
    });
    let res: SettleSweepResponse;
    try {
      res = await withGithubRetry(() =>
        graphqlTolerant<SettleSweepResponse>(
          client,
          buildSettleSweepQuery(pending.length),
          variables,
          () => log.warn('settle sweep: partial GraphQL response (continuing)'),
        ),
      );
    } catch (err) {
      const rl = isRateLimitError(err);
      if (rl.limited) {
        noteLimited(accountId, rl.resumeAt);
        return { kind: 'limited' };
      }
      log.warn(`settle sweep: read failed (non-fatal): ${errMsg(err)}`);
      return { kind: 'failed' };
    }
    const rate = res.rateLimit as SettleSweepResponse['rateLimit'];
    if (rate) {
      result.cost += rate.cost ?? 0;
      const resetAt = rate.resetAt ? new Date(rate.resetAt) : null;
      noteBudget(accountId, {
        remaining: rate.remaining ?? null,
        resetAt: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null,
      });
    }
    const next: typeof pending = [];
    pending.forEach((p, i) => {
      const node = res[`r${i}`] as GqlSettleRepo | null | undefined;
      const list = node?.pullRequests;
      // A repo GitHub would not show, or whose list was nulled: nothing is known about it.
      if (!node || !list || !Array.isArray(list.nodes)) {
        reads.delete(p.repo.id);
        return;
      }
      const read = reads.get(p.repo.id) ?? {
        repo: p.repo,
        trunkOid: node.defaultBranchRef?.target?.oid ?? undefined,
        prs: [],
        complete: false,
      };
      for (const pr of list.nodes) if (pr) read.prs.push(pr);
      const pages = p.pages + 1;
      const more = list.pageInfo?.hasNextPage === true;
      const cursor = list.pageInfo?.endCursor ?? null;
      read.complete = list.pageInfo?.hasNextPage === false;
      reads.set(p.repo.id, read);
      if (more && cursor && pages < SETTLE_MAX_PAGES) next.push({ repo: p.repo, cursor, pages });
    });
    pending = next;
  }
  return { kind: 'ok', reads: [...reads.values()] };
}

/** Compare one repo's read with the DB; returns the PRs to re-sync. Marks dirty / trunk moves. */
async function judgeRepo(
  client: GraphqlClient,
  read: RepoRead,
  now: number,
  log: Logger,
  result: SettleSweepResult,
): Promise<PlannedSync[]> {
  const { repo } = read;
  const { accountId } = repo;
  if (read.trunkOid && trunkMoved(`${accountId}:${repo.id}`, read.trunkOid)) {
    result.trunkMoves += 1;
    scheduleTrunkMovedRecheck(accountId, repo.id, log);
  }
  const observed = read.prs.map(foldSettlePr).filter((o): o is SettleObservedPr => o != null);
  const stored = await getSettleStoredPrs(
    accountId,
    repo.id,
    observed.map((o) => o.number),
  );
  const byNumber = new Map(stored.map((s) => [s.number, s]));
  const walkWindowStartMs =
    repo.lastIncrementalSyncAt.getTime() - config.syncOverlapMinutes * 60_000;

  // Heads whose CI must be recomputed without Limn's lines (rare: only with "Mark auto reviews
  // on GitHub" on). One aliased read per 10 heads; a failure leaves their CI unjudged.
  const recompute = new Map<string, CiStatus>();
  const shas = observed
    .filter((o) => {
      const s = byNumber.get(o.number);
      return s != null && needsCiRecompute(s, o);
    })
    .map((o) => o.headOid!)
    .filter((sha, i, all) => all.indexOf(sha) === i);
  if (shas.length > 0 && !isLimited(accountId)) {
    try {
      const { bySha, cost } = await fetchRollupsWithoutLimn(client, repo.owner, repo.name, shas);
      result.cost += cost;
      for (const [sha, state] of bySha) recompute.set(sha, ciStatusFrom(state));
    } catch (err) {
      const rl = isRateLimitError(err);
      if (rl.limited) noteLimited(accountId, rl.resumeAt);
      else log.warn(`settle sweep ${repo.owner}/${repo.name}: CI recompute failed: ${errMsg(err)}`);
    }
  }

  const planned: PlannedSync[] = [];
  let walk = false;
  const plan = (stored: SettleStoredPr | undefined, number: number, sig: string, reasons: SettleReason[]): void => {
    const key = `${accountId}:${stored?.id ?? `${repo.id}#${number}`}`;
    if (actedOn.get(key) === sig) return; // already re-synced on exactly this answer
    planned.push({ accountId, repoId: repo.id, prId: stored?.id ?? null, number, sig, reasons });
  };
  const seen = new Set<number>();
  for (const obs of observed) {
    seen.add(obs.number);
    result.compared += 1;
    const s = byNumber.get(obs.number);
    const ciWithoutLimn = obs.headOid ? recompute.get(obs.headOid) : undefined;
    const verdict = judgeSettledPr(s, obs, walkWindowStartMs, ciWithoutLimn);
    if (verdict.kind === 'walk') walk = true;
    else if (verdict.kind === 'sync') {
      plan(s, obs.number, observationSig(obs, ciWithoutLimn), verdict.reasons);
    }
  }
  // A stored OPEN PR that a COMPLETE open list does not contain is not open any more — the one
  // positive statement absence can make. The single-PR read records what it became.
  if (read.complete) {
    for (const s of stored) {
      if (s.state === 'open' && !seen.has(s.number)) plan(s, s.number, 'absent', ['absent']);
    }
  }
  if (walk) {
    markDirty(repo.id, now);
    result.walksMarked += 1;
  }
  return planned;
}

/**
 * One settle sweep over every repo whose settle interval is due. Called fire-and-forget from the
 * scheduler tick (sync-manager.ts). NEVER THROWS.
 *
 * `isBusy` names repos a walk is running for (or queued): skipped and NOT stamped, so the next
 * tick reads them once the walk is done.
 */
export async function runSettleSweep(args: {
  log: Logger;
  isBusy?: (repoId: number) => boolean;
  now?: number;
}): Promise<SettleSweepResult> {
  const result = emptyResult();
  if (sweepInFlight) return { ...result, skipped: true };
  sweepInFlight = true;
  const { log } = args;
  try {
    const now = args.now ?? Date.now();
    const due = (await listSweepRepos()).filter(
      (r) => isSettleDue(r.id, now) && !(args.isBusy?.(r.id) ?? false),
    );
    if (due.length === 0) return result;

    const byAccount = new Map<number, SweepRepo[]>();
    for (const r of due) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);

    const planned: PlannedSync[] = [];
    for (const [accountId, accountRepos] of byAccount) {
      if (isLimited(accountId)) {
        result.paused = true;
        continue;
      }
      let token: string;
      try {
        token = await getAccessToken(accountId);
      } catch (err) {
        log.warn(`settle sweep: no token for account ${accountId}: ${errMsg(err)}`);
        continue;
      }
      const client = getGraphqlClientFor(token);
      for (let i = 0; i < accountRepos.length; i += SETTLE_REPOS_PER_QUERY) {
        const chunk = accountRepos.slice(i, i + SETTLE_REPOS_PER_QUERY);
        const outcome = await readRepos(client, accountId, chunk, log, result);
        if (outcome.kind === 'limited') {
          result.paused = true;
          break; // the rest of this account waits for the window; nothing stamped
        }
        // Stamp the chunk whether it read or failed: a GitHub fault is not re-asked every tick.
        for (const r of chunk) noteSettle(r.id, now, outcome.kind === 'ok');
        if (outcome.kind === 'failed') continue;
        result.repos += outcome.reads.length;
        for (const read of outcome.reads) {
          try {
            planned.push(...(await judgeRepo(client, read, now, log, result)));
          } catch (err) {
            log.warn(
              `settle sweep ${read.repo.owner}/${read.repo.name}: compare failed (non-fatal): ${errMsg(err)}`,
            );
          }
        }
      }
    }

    // Re-sync the PRs that differ, newest-listed first per repo, at most the per-sweep cap. The
    // rest still differ on the next sweep and go then. Sequential: ~1 point and a few seconds each.
    const cap = Math.max(0, config.syncSettleMaxPrSyncs);
    for (const p of planned) {
      if (result.prSyncs >= cap || isLimited(p.accountId)) {
        result.deferred += 1;
        continue;
      }
      result.prSyncs += 1;
      await syncOnePr(p.repoId, p.number, log);
      // Remembered whatever syncOnePr returned: a stand-down means another sync is reading it now,
      // and a failure must not cost a point every five minutes until GitHub says something new.
      rememberActed(`${p.accountId}:${p.prId ?? `${p.repoId}#${p.number}`}`, p.sig);
    }

    if (result.prSyncs > 0 || result.walksMarked > 0 || result.trunkMoves > 0 || result.deferred > 0) {
      log.info(
        `settle sweep: read ${result.repos} repo(s), ${result.compared} open PR(s), ${result.cost} pt(s); ` +
          `re-synced ${result.prSyncs}${result.deferred ? ` (+${result.deferred} next sweep)` : ''}, ` +
          `${result.walksMarked} walk(s) marked, ${result.trunkMoves} trunk move(s)`,
      );
    }
    return result;
  } catch (err) {
    log.warn(`settle sweep failed (non-fatal): ${errMsg(err)}`);
    return result;
  } finally {
    sweepInFlight = false;
  }
}

/** Test-only: clear the loop guard, the trunk heads and the in-flight claim. */
export function __resetSettleSweep(): void {
  actedOn.clear();
  trunkHeads.clear();
  sweepInFlight = false;
}
