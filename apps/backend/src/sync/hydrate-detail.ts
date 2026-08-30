// On-demand text hydration for cloud "lean storage" mode.
//
// In cloud mode the sync pipeline does NOT persist bulky user-authored text
// (comment/review/PR bodies, review-comment diff hunks, commit messages, the
// per-job checkRuns JSON) — see config.persistBodies and sync/upsert.ts. That text
// is regenerable from GitHub, so it's fetched on demand when a PR/thread detail is
// opened and overlaid onto the stored metadata, then cached in the browser.
//
// Matching is by GitHub node id (the GraphQL `id`/`fullDatabaseId`, stored on each
// row) and, for commits, by sha. The stored local ids, derived thread state, and
// triage are preserved — only the text fields are filled in.
//
// NOTE ON MODES — this used to say "in LOCAL mode config.persistBodies is true, so these
// functions are no-ops", which was WRONG and hid a cost bug. `persistBodies` defaults to
// FALSE in BOTH modes (config.ts: `process.env.PERSIST_BODIES === 'true'`), so local installs
// hydrate on every PR open too, spending the user's own `gh` token's rate limit. Only an
// explicit PERSIST_BODIES=true makes these no-ops. See the hydration cache below.
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type {
  AuthNotice,
  CheckRun,
  CommentDetail,
  PrCommentDetail,
  PrDetail,
  PrFileChange,
  ReviewDetail,
  ThreadDetail,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import {
  getGraphqlClientFor,
  graphqlChecksHint,
  graphqlTolerant,
  isRateLimitError,
  isSamlBlock,
  summarizeGraphqlErrors,
} from '../github/client.js';
import { isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import { PR_DETAIL_QUERY, type PrDetailResponse } from '../github/queries.js';
import { drainDetailThreads } from './drain-review-threads.js';
import { checkRunsFrom } from './upsert.js';

const { reviews, reviewComments, prComments, reviewThreads, pullRequests, repos } =
  schema;

// Hydration has no request-scoped logger (it is reached from routes, the plugin seam and the
// SPA's poll alike), so its diagnostics have always gone straight to console with a
// `[hydrate]` tag. This adapts that to the sync `Logger` shape the thread drain takes.
const hydrateLog = {
  info: (m: string): void => console.log(`[hydrate] ${m}`),
  warn: (m: string): void => console.warn(`[hydrate] ${m}`),
  error: (m: string): void => console.error(`[hydrate] ${m}`),
};

// Parsed GitHub text for one PR, keyed for overlay onto stored rows.
interface GhPrText {
  prBody: string | null;
  checkRuns: CheckRun[];
  reviewBodyByNode: Map<string, string | null>;
  reviewCommentByNode: Map<string, { body: string; diffHunk: string | null }>;
  prCommentBodyByNode: Map<string, string>;
  commitMessageBySha: Map<string, string>;
  // Diff size — overlaid fresh so the LOC label + "Changes" tab populate on open
  // even for PRs synced before these columns existed (incremental sync won't
  // re-fetch an unchanged PR to backfill them).
  additions: number;
  deletions: number;
  changedFiles: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
}

// GitHub anchors a file in the PR "Files changed" diff by sha256(path) (matches
// db/queries.ts's diffAnchorId).
function diffAnchorId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

function splitRepoFullName(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf('/');
  if (slash < 0) return { owner: fullName, name: '' };
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

// Fetch the single PR's text from GitHub. `data` is null on any failure (deleted PR, lost
// access, network) so callers degrade gracefully to the stored metadata. `samlBlocked` is true
// when the failure was GitHub's SAML-SSO wall — the token isn't authorized for the repo owner's
// org — which the callers surface to the SPA (it's an authorization gap, not a bug).
// ---- Short-TTL hydration cache ----
// `GET /api/prs/:id` is the hottest read in the app, and because lean storage is the DEFAULT
// IN BOTH MODES (config.persistBodies is false unless PERSIST_BODIES=true — the module comment
// above used to claim otherwise), every single call ran PR_DETAIL_QUERY against GitHub. The
// only cache was the browser's IndexedDB, so nothing server-side stopped one request from
// becoming one GitHub GraphQL request: a loop over PR ids burned the tenant's 5,000 points/hour
// in under a minute, after which their sync, repo search and write actions all failed for the
// rest of the hour (and locally, the burned quota is the user's own `gh` token, so their CLI
// throttles too).
//
// Two cheap defences here, plus a dedicated rate-limit tier on the route:
//   • a 60s TTL — short enough that "on demand" still means fresh (the whole point of lean
//     storage), long enough that re-opening a PR, a StrictMode double-render or the SPA's
//     refetch-on-focus costs nothing;
//   • an in-flight map — a burst of concurrent opens of the SAME PR shares ONE upstream call
//     instead of racing N identical ones.
const HYDRATE_TTL_MS = 60_000;
// Bounded so a walk over many PRs cannot grow this without limit; well above the number of
// PRs anyone opens inside one TTL window.
const HYDRATE_CACHE_MAX = 500;

type HydrateResult = { data: GhPrText | null; samlBlocked: boolean };
const hydrateCache = new Map<string, { at: number; value: HydrateResult }>();
// The in-flight entry carries the epoch it started in, so a fetch issued before an
// invalidation is never shared with a reader who arrived after it, plus a serial id so a
// finishing fetch can tell its own slot from a newer one's.
interface HydrateInFlight {
  id: number;
  epoch: number;
  promise: Promise<HydrateResult>;
}
const hydrateInFlight = new Map<string, HydrateInFlight>();
let hydrateFetchSeq = 0;

// Keyed per ACCOUNT (a token's visibility differs per tenant, so one tenant's result must
// never satisfy another's). One spelling, used by both the fetch and the invalidator, so
// the two can't drift.
const hydrateKey = (
  accountId: number,
  owner: string,
  name: string,
  number: number,
): string => `${accountId}:${owner}/${name}#${number}`;

// Monotonic invalidation epoch per cache key. A write path (a just-posted inline comment)
// has to guarantee that the NEXT hydration is fresh, and deleting the cache entry alone is
// not enough: a hydration that started BEFORE the write is still in flight and would cache
// its pre-write snapshot the moment it resolves. Bumping the epoch makes that in-flight
// result un-cacheable — it still gets returned to whoever is already awaiting it (they
// asked before the write), but it cannot poison the next reader.
const hydrateEpoch = new Map<string, number>();

/**
 * Drop any cached hydration for ONE PR and revoke any in-flight fetch's right to cache.
 * Call after writing to that PR on GitHub and BEFORE responding, so the client's follow-up
 * `GET /api/prs/:id` runs a fresh PR_DETAIL_QUERY and sees the new text. Every other PR's
 * cached hydration, and the TTL/FIFO machinery, are untouched.
 *
 * This matters even when a resync has already stored the new row: `diffHunk` is
 * lean-gated (sync writes null unless PERSIST_BODIES=true), so hydration is the ONLY
 * source of a new thread's code anchor — a ≤60s-old snapshot has no entry for the new
 * comment's node id and the thread would render with no code context.
 */
export function invalidatePrHydration(
  accountId: number,
  owner: string,
  name: string,
  number: number,
): void {
  const key = hydrateKey(accountId, owner, name, number);
  hydrateCache.delete(key);
  hydrateEpoch.set(key, (hydrateEpoch.get(key) ?? 0) + 1);
}

/** Cached + coalesced wrapper around fetchGhPrTextUncached. */
async function fetchGhPrText(
  owner: string,
  name: string,
  number: number,
  accountId: number,
): Promise<HydrateResult> {
  const key = hydrateKey(accountId, owner, name, number);
  // Snapshot the epoch at fetch START; if an invalidation lands while we're in flight the
  // result is stale by definition and must not be cached.
  const epoch = hydrateEpoch.get(key) ?? 0;
  const now = Date.now();

  const hit = hydrateCache.get(key);
  if (hit && now - hit.at < HYDRATE_TTL_MS) return hit.value;

  // Share an in-flight fetch only when it STARTED in the current epoch. A fetch issued
  // before an invalidation is reading pre-write state, so a reader who arrived after the
  // write must not be handed its result — that's the same staleness the cache guard above
  // rejects, one step earlier.
  const pending = hydrateInFlight.get(key);
  if (pending && pending.epoch === epoch) return pending.promise;

  const fetchId = ++hydrateFetchSeq;
  const promise = (async () => {
    try {
      const value = await fetchGhPrTextUncached(owner, name, number, accountId);
      // Only cache a SUCCESS: caching a failure would pin a transient error (or a
      // mid-re-auth SAML block) for a minute, and the failure path is already cheap
      // because it returns the stored metadata. And only when no invalidation landed
      // while we were in flight (see hydrateEpoch).
      if (value.data && (hydrateEpoch.get(key) ?? 0) === epoch) {
        if (hydrateCache.size >= HYDRATE_CACHE_MAX) {
          // Oldest-inserted first (Map preserves insertion order) — a plain FIFO trim is
          // sufficient here; the TTL does the real work.
          const oldest = hydrateCache.keys().next().value;
          if (oldest !== undefined) hydrateCache.delete(oldest);
        }
        hydrateCache.set(key, { at: Date.now(), value });
      }
      return value;
    } finally {
      // Only clear the slot if it is still OURS: with the epoch check above, two fetches
      // for one key can overlap across an invalidation, and the older one finishing must
      // not evict the newer one's entry (that would cost a third upstream call).
      if (hydrateInFlight.get(key)?.id === fetchId) hydrateInFlight.delete(key);
    }
  })();
  hydrateInFlight.set(key, { id: fetchId, epoch, promise });
  return promise;
}

async function fetchGhPrTextUncached(
  owner: string,
  name: string,
  number: number,
  accountId: number,
): Promise<{ data: GhPrText | null; samlBlocked: boolean }> {
  let resp: PrDetailResponse;
  let samlBlocked = false;
  // Hoisted out of the try because the thread drain below needs it too. Still resolved
  // INSIDE the try, so `fetchReviewCommentHunks`' "never throws" contract stays structural:
  // a token failure lands on the same catch it always did.
  let token: string;
  try {
    token = await getAccessToken(accountId);
    const client = getGraphqlClientFor(token);
    // Tolerate partial errors: if the token is FORBIDDEN one sub-field (e.g. `statusCheckRollup`
    // check runs on a private repo it can't reach), that used to throw away the ENTIRE hydration
    // (PR body, comments, diff hunks, commit messages) even though all of those came back fine.
    // Now we keep them; only the forbidden field (CI checks) stays empty (and we log why). A SAML
    // block forbids the whole `repository` node, so `data` ends up null but we flag it.
    resp = await graphqlTolerant<PrDetailResponse>(
      client,
      PR_DETAIL_QUERY,
      { owner, name, number },
      (errors) => {
        if (isSamlBlock(errors)) samlBlocked = true;
        console.warn(
          `[hydrate] partial GraphQL for ${owner}/${name}#${number} — continuing with available fields${graphqlChecksHint(errors)}. ${summarizeGraphqlErrors(errors)}`,
        );
      },
    );
  } catch (err) {
    // A rate-limited hydration must TELL the budget, not just fail quietly. Hydration is one
    // of the app's hottest GitHub spenders (every PR open, plus every annotation run), and it
    // used to be completely invisible to `github/rate-budget.ts` — so the sync's `gateBudget`
    // stood down while this kept firing. Same classification the compare seam uses.
    const rl = isRateLimitError(err);
    if (rl.limited) noteLimited(accountId, rl.resumeAt);
    console.error(
      `[hydrate] PR detail fetch failed for ${owner}/${name}#${number}; returning stored metadata. ${err instanceof Error ? err.message : String(err)}`,
    );
    return { data: null, samlBlocked: false };
  }
  // The budget observation this query ALREADY paid for. PR_DETAIL_QUERY selects
  // `rateLimit { remaining resetAt cost }` and hydration used to discard it outright.
  // ⚠ `noteBudget` must not clear `limitedUntil` — see rate-budget.ts.
  noteBudget(accountId, {
    remaining: resp.rateLimit?.remaining ?? null,
    resetAt: resp.rateLimit?.resetAt != null ? new Date(resp.rateLimit.resetAt) : null,
  });
  const pr = resp.repository?.pullRequest;
  if (!pr) return { data: null, samlBlocked };

  // Drain the review-thread tail before building the overlay maps. Hydration matches stored
  // rows by node id, so a thread past the first page is not "a comment with no hunk" — it is
  // a comment GitHub was never asked about, and the two are indistinguishable downstream once
  // the map is built. One extra point per overflow page, nothing at all for a PR that fits.
  await drainDetailThreads(pr.reviewThreads, {
    owner,
    name,
    number,
    accountId,
    token,
    log: hydrateLog,
  });

  const reviewBodyByNode = new Map<string, string | null>();
  for (const r of pr.reviews.nodes) reviewBodyByNode.set(r.id, r.body);

  const reviewCommentByNode = new Map<
    string,
    { body: string; diffHunk: string | null }
  >();
  for (const t of pr.reviewThreads.nodes) {
    for (const c of t.comments.nodes) {
      reviewCommentByNode.set(c.id, { body: c.body, diffHunk: c.diffHunk });
    }
  }

  const prCommentBodyByNode = new Map<string, string>();
  for (const c of pr.comments.nodes) prCommentBodyByNode.set(c.id, c.body);

  const commitMessageBySha = new Map<string, string>();
  for (const c of pr.commits.nodes) commitMessageBySha.set(c.commit.oid, c.commit.message);

  return {
    data: {
      prBody: pr.body,
      checkRuns: checkRunsFrom(pr.headCommit?.nodes[0]?.commit),
      reviewBodyByNode,
      reviewCommentByNode,
      prCommentBodyByNode,
      commitMessageBySha,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changedFiles ?? 0,
      files: (pr.files?.nodes ?? []).map((f) => ({
        path: f.path,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      })),
    },
    samlBlocked,
  };
}

// ---- Legacy NULL-body write-back ----
//
// Rows synced during the lean-storage window (2026-06-07 → 2026-07-01, when comment/review
// bodies were not persisted) still hold `body IS NULL`, and nothing repairs them: incremental
// sync only re-walks PRs whose GitHub `updatedAt` moves, and these live on old, closed PRs.
// That population is invisible to the ML candidate query AND its pending count — the user sees
// the full hydrated text with no badge, while coverage reads 100%. Bodies are persisted-always
// now (sync/upsert.ts), so filling the NULLs from a hydration we already paid for re-aligns the
// stored rows with current policy; the pull-based enrichment worker then labels them on its
// next tick with no further hook.
//
// POSITIVE-STATEMENT RULE: `graphqlTolerant` hands back partial data with forbidden selections
// NULLED, so only a real string may be written — never null-over-null as a "change", and the
// `body IS NULL` in each WHERE means a concurrent sync's write is never clobbered. `diffHunk`
// stays untouched: it is lean-gated on purpose. Plain awaited UPDATEs, deliberately in NO
// transaction — holding the single sqlite write lock across anything slow is the landmine
// `persistPr` documents, and each statement is independently idempotent anyway.
async function writeBackNullBodies(prId: number, gh: GhPrText): Promise<number> {
  let updated = 0;

  const fill = async (
    table: typeof reviewComments | typeof prComments | typeof reviews,
    bodyFor: (nodeId: string) => string | null | undefined,
  ): Promise<void> => {
    const rows = await db
      .select({ id: table.id, nodeId: table.githubNodeId })
      .from(table)
      .where(and(eq(table.prId, prId), isNull(table.body)))
      .execute();
    for (const row of rows) {
      const body = bodyFor(row.nodeId);
      if (typeof body !== 'string') continue;
      updated += (
        await db
          .update(table)
          .set({ body })
          .where(and(eq(table.id, row.id), isNull(table.body)))
          .returning({ id: table.id })
          .execute()
      ).length;
    }
  };

  await fill(reviewComments, (nodeId) => gh.reviewCommentByNode.get(nodeId)?.body);
  await fill(prComments, (nodeId) => gh.prCommentBodyByNode.get(nodeId));
  await fill(reviews, (nodeId) => gh.reviewBodyByNode.get(nodeId));
  return updated;
}

/**
 * Repair entry for scripts/backfill-null-bodies.ts: hydrate ONE PR through the normal cached
 * path and write its legacy NULL bodies back. Returns rows updated, or null when the PR is
 * unknown to this account or the GitHub fetch failed (deleted PR, lost access) — the caller
 * logs and moves on. Idempotent: the write-back only ever fills NULLs.
 */
export async function backfillPrNullBodies(
  prId: number,
  accountId: number,
): Promise<number | null> {
  const ctx = (
    await db
      .select({ owner: repos.owner, name: repos.name, number: pullRequests.number })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!ctx) return null;
  const { data: gh } = await fetchGhPrText(ctx.owner, ctx.name, ctx.number, accountId);
  if (!gh) return null;
  return writeBackNullBodies(prId, gh);
}

// localId -> githubNodeId for a set of rows of the given table on this PR.
async function nodeIdMap(
  table: typeof reviews | typeof reviewComments | typeof prComments,
  prId: number,
): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: table.id, nodeId: table.githubNodeId })
    .from(table)
    .where(eq(table.prId, prId))
    .execute();
  return new Map(rows.map((r) => [r.id, r.nodeId]));
}

/**
 * Fill the text fields of a PrDetail from GitHub when they weren't stored (cloud
 * lean mode). No-op in local mode. Always returns a usable PrDetail — on fetch
 * failure the stored metadata (incl. review-comment excerpts) is returned as-is.
 */
export async function hydratePrDetail(
  detail: PrDetail,
  accountId: number,
): Promise<PrDetail> {
  if (config.persistBodies) return detail;

  const { owner, name } = splitRepoFullName(detail.repoFullName);
  const { data: gh, samlBlocked } = await fetchGhPrText(
    owner,
    name,
    detail.number,
    accountId,
  );
  const authNotice: AuthNotice | null = samlBlocked
    ? { kind: 'saml_sso', org: owner }
    : null;
  // Blocked or otherwise unfetchable → keep the stored metadata, but tell the SPA WHY the
  // description/checks are blank when it was an org authorization wall (so it can guide the fix).
  if (!gh) return authNotice ? { ...detail, authNotice } : detail;

  // Repair pass for lean-window legacy rows (see writeBackNullBodies). Swallowed on failure:
  // the write-back must never cost the hydration that just succeeded.
  try {
    const updated = await writeBackNullBodies(detail.id, gh);
    if (updated > 0) {
      console.info(
        `[hydrate] backfilled ${updated} legacy NULL bod${updated === 1 ? 'y' : 'ies'} for ${detail.repoFullName}#${detail.number}`,
      );
    }
  } catch (err) {
    console.warn(
      `[hydrate] NULL-body write-back failed for ${detail.repoFullName}#${detail.number}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const [reviewNodes, reviewCommentNodes, prCommentNodes] = await Promise.all([
    nodeIdMap(reviews, detail.id),
    nodeIdMap(reviewComments, detail.id),
    nodeIdMap(prComments, detail.id),
  ]);

  const fillComment = (c: CommentDetail): CommentDetail => {
    const nodeId = reviewCommentNodes.get(c.id);
    const gc = nodeId ? gh.reviewCommentByNode.get(nodeId) : undefined;
    return gc
      ? { ...c, body: gc.body, diffHunk: gc.diffHunk }
      : c;
  };

  const threads: ThreadDetail[] = detail.threads.map((t) => ({
    ...t,
    comments: t.comments.map(fillComment),
  }));

  const reviewsOut: ReviewDetail[] = detail.reviews.map((r) => {
    const nodeId = reviewNodes.get(r.id);
    const body = nodeId ? gh.reviewBodyByNode.get(nodeId) : undefined;
    return body !== undefined ? { ...r, body } : r;
  });

  const commentsOut: PrCommentDetail[] = detail.comments.map((c) => {
    const nodeId = prCommentNodes.get(c.id);
    const body = nodeId ? gh.prCommentBodyByNode.get(nodeId) : undefined;
    return body !== undefined ? { ...c, body } : c;
  });

  const commitsOut = detail.commits.map((c) => {
    const message = gh.commitMessageBySha.get(c.sha);
    return message !== undefined ? { ...c, message } : c;
  });

  // Overlay fresh diff size + per-file breakdown (with GitHub deep links).
  const filesOut: PrFileChange[] = gh.files.map((f) => ({
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
    githubUrl: `${detail.githubUrl}/files#diff-${diffAnchorId(f.path)}`,
  }));

  return {
    ...detail,
    body: gh.prBody,
    checkRuns: gh.checkRuns,
    threads,
    reviews: reviewsOut,
    comments: commentsOut,
    commits: commitsOut,
    additions: gh.additions,
    deletions: gh.deletions,
    changedFilesCount: gh.changedFiles,
    files: filesOut,
    authNotice,
  };
}

/**
 * Fill the comment bodies + diff hunks of a single ThreadDetail from GitHub (cloud
 * lean mode). No-op in local mode; graceful on failure.
 */
export async function hydrateThreadDetail(
  thread: ThreadDetail,
  accountId: number,
): Promise<ThreadDetail> {
  if (config.persistBodies) return thread;

  // Resolve the parent PR's coordinates + this thread's node id.
  const ctx = (
    await db
      .select({
        owner: repos.owner,
        name: repos.name,
        number: pullRequests.number,
        threadNodeId: reviewThreads.githubNodeId,
      })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(eq(reviewThreads.id, thread.id))
      .limit(1)
      .execute()
  )[0];
  if (!ctx) return thread;

  const { data: gh } = await fetchGhPrText(ctx.owner, ctx.name, ctx.number, accountId);
  if (!gh) return thread;

  const commentNodes = await nodeIdMap(reviewComments, thread.prId);
  const comments: CommentDetail[] = thread.comments.map((c) => {
    const nodeId = commentNodes.get(c.id);
    const gc = nodeId ? gh.reviewCommentByNode.get(nodeId) : undefined;
    return gc ? { ...c, body: gc.body, diffHunk: gc.diffHunk } : c;
  });
  return { ...thread, comments };
}

// ---- anchor hunks for the annotation platform --------------------------------------------------

/** What `fetchReviewCommentHunks` could not do, when it could not. Null on a normal answer. */
export type HunkFetchReason =
  /** PERSIST_BODIES=true — the stored column is authoritative and nothing was fetched. */
  | 'persisted'
  /** The account's token is in a known hard limit; nothing was asked of GitHub. */
  | 'rate_limited'
  /** GitHub's SAML-SSO org wall forbade the repository node. */
  | 'saml_sso'
  /** Deleted PR, lost access, or a network failure. */
  | 'unavailable';

export interface PrReviewCommentHunks {
  ok: boolean;
  /** GitHub review-comment node id → its anchor diff hunk. A missing key = not in the snapshot. */
  hunkByNodeId: Map<string, string>;
  /**
   * How many review comments GitHub's snapshot carried. Load-bearing for the UI's deterministic
   * explanation: "GitHub's snapshot didn't include this thread" is a different sentence from
   * "there is no code context", and the caller can only tell them apart by this count.
   *
   * PR_DETAIL_QUERY still asks for `reviewThreads(first: 50)` — the cap is priced per request,
   * not per row, so widening it would tax every PR for the sake of a few — but the tail is now
   * DRAINED (`drainDetailThreads`), so on a bot-flooded PR this is the true comment count
   * rather than the first fifty threads' worth. It can still fall short of the truth when the
   * drain is cut off by a rate limit or a partial response, which is exactly why the caller
   * must keep treating a missing key as "not in the snapshot" rather than as "no hunk exists".
   */
  commentsSeen: number;
  reason: HunkFetchReason | null;
}

/** Well above either annotation cap (validity 2000 / addressed 1600); the caller re-clamps. */
const DEFAULT_MAX_HUNK_CHARS = 4000;

/**
 * The anchor `diffHunk` of every review comment on one PR, hydrated on demand.
 *
 * WHY THIS EXISTS. Under lean storage (`PERSIST_BODIES` unset — the DEFAULT in BOTH modes)
 * `review_comments.diff_hunk` is NULL for ~97% of rows, so any judgement that reads the stored
 * column sees no code at all and can only answer "unclear — I can't see the surrounding code",
 * while the SPA renders the hunk directly above that verdict from this very cache.
 *
 * ONE GraphQL call covers the WHOLE PR, and it is the SAME cached + coalesced call the SPA
 * already makes when the PR is opened (`fetchGhPrText`, 60s TTL) — so a "Check review" click on
 * a PR the user is looking at is normally free. It is NOT guaranteed free: `refresh-pr.ts` busts
 * the cache on every walk it performs, up to ~twice a minute while a PR pane is open. Budget it
 * as one PR_DETAIL_QUERY, not as zero.
 *
 * NEVER THROWS — the token is resolved inside `fetchGhPrTextUncached`'s own try, so the
 * "never throws" contract is structural rather than a convention the caller must trust.
 * Every failure comes back `ok:false` with a `reason` the caller can state to the user.
 *
 * ⚠ REPO-AUTHORED, therefore ATTACKER-AUTHORED text. Fence it before a model sees it, and it is
 * PROMPT CONTEXT ONLY: it must NEVER enter a payload hash. The hash must keep seeing the stored
 * (null) column, or the free cached GET — which recomputes every row's hash on every PR open —
 * would disagree with the run forever, marking every judgement stale and re-billing it.
 */
export async function fetchReviewCommentHunks(
  accountId: number,
  owner: string,
  name: string,
  number: number,
  opts: { maxHunkChars?: number } = {},
): Promise<PrReviewCommentHunks> {
  const empty = (reason: HunkFetchReason | null, ok: boolean): PrReviewCommentHunks => ({
    ok,
    hunkByNodeId: new Map(),
    commentsSeen: 0,
    reason,
  });
  if (owner === '' || name === '' || !Number.isFinite(number)) return empty('unavailable', false);
  // Nothing to hydrate: the stored column already holds the real hunk.
  if (config.persistBodies) return empty('persisted', true);
  // Pre-empt rather than spend: the caller degrades to the stored column either way, and a
  // request issued into a known hard limit only deepens it.
  if (isLimited(accountId)) return empty('rate_limited', false);

  const { data, samlBlocked } = await fetchGhPrText(owner, name, number, accountId);
  if (data == null) return empty(samlBlocked ? 'saml_sso' : 'unavailable', false);

  const cap = opts.maxHunkChars ?? DEFAULT_MAX_HUNK_CHARS;
  const hunkByNodeId = new Map<string, string>();
  let commentsSeen = 0;
  for (const [nodeId, c] of data.reviewCommentByNode) {
    commentsSeen += 1;
    // A null hunk is a real answer from GitHub (a file-level comment has none) — store only
    // what exists, so a missing key means "no anchor", not "we failed".
    if (c.diffHunk == null || c.diffHunk === '') continue;
    hunkByNodeId.set(nodeId, c.diffHunk.length > cap ? c.diffHunk.slice(0, cap) : c.diffHunk);
  }
  return { ok: true, hunkByNodeId, commentsSeen, reason: null };
}
