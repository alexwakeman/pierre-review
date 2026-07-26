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
import { eq } from 'drizzle-orm';
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
  isSamlBlock,
  summarizeGraphqlErrors,
} from '../github/client.js';
import { PR_DETAIL_QUERY, type PrDetailResponse } from '../github/queries.js';
import { checkRunsFrom } from './upsert.js';

const { reviews, reviewComments, prComments, reviewThreads, pullRequests, repos } =
  schema;

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
const hydrateInFlight = new Map<string, Promise<HydrateResult>>();

/** Cached + coalesced wrapper around fetchGhPrTextUncached. Keyed per ACCOUNT (a token's
 *  visibility differs per tenant, so one tenant's result must never satisfy another's). */
async function fetchGhPrText(
  owner: string,
  name: string,
  number: number,
  accountId: number,
): Promise<HydrateResult> {
  const key = `${accountId}:${owner}/${name}#${number}`;
  const now = Date.now();

  const hit = hydrateCache.get(key);
  if (hit && now - hit.at < HYDRATE_TTL_MS) return hit.value;

  const pending = hydrateInFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await fetchGhPrTextUncached(owner, name, number, accountId);
      // Only cache a SUCCESS: caching a failure would pin a transient error (or a
      // mid-re-auth SAML block) for a minute, and the failure path is already cheap
      // because it returns the stored metadata.
      if (value.data) {
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
      hydrateInFlight.delete(key);
    }
  })();
  hydrateInFlight.set(key, promise);
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
  try {
    const token = await getAccessToken(accountId);
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
    console.error(
      `[hydrate] PR detail fetch failed for ${owner}/${name}#${number}; returning stored metadata. ${err instanceof Error ? err.message : String(err)}`,
    );
    return { data: null, samlBlocked: false };
  }
  const pr = resp.repository?.pullRequest;
  if (!pr) return { data: null, samlBlocked };

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
