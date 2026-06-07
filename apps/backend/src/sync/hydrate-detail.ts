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
// In LOCAL mode config.persistBodies is true, so these functions are no-ops and the
// detail is returned exactly as read from SQLite (instant, fully offline).
import { eq } from 'drizzle-orm';
import type {
  CheckRun,
  CommentDetail,
  PrCommentDetail,
  PrDetail,
  ReviewDetail,
  ThreadDetail,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { getGraphqlClientFor } from '../github/client.js';
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
}

function splitRepoFullName(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf('/');
  if (slash < 0) return { owner: fullName, name: '' };
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

// Fetch the single PR's text from GitHub. Returns null on any failure (deleted PR,
// lost access, network) so callers degrade gracefully to the stored metadata.
async function fetchGhPrText(
  owner: string,
  name: string,
  number: number,
  accountId: number,
): Promise<GhPrText | null> {
  let resp: PrDetailResponse;
  try {
    const token = await getAccessToken(accountId);
    const client = getGraphqlClientFor(token);
    resp = await client<PrDetailResponse>(PR_DETAIL_QUERY, { owner, name, number });
  } catch {
    return null;
  }
  const pr = resp.repository?.pullRequest;
  if (!pr) return null;

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
    prBody: pr.body,
    checkRuns: checkRunsFrom(pr.headCommit?.nodes[0]?.commit),
    reviewBodyByNode,
    reviewCommentByNode,
    prCommentBodyByNode,
    commitMessageBySha,
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
  const gh = await fetchGhPrText(owner, name, detail.number, accountId);
  if (!gh) return detail;

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

  return {
    ...detail,
    body: gh.prBody,
    checkRuns: gh.checkRuns,
    threads,
    reviews: reviewsOut,
    comments: commentsOut,
    commits: commitsOut,
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

  const gh = await fetchGhPrText(ctx.owner, ctx.name, ctx.number, accountId);
  if (!gh) return thread;

  const commentNodes = await nodeIdMap(reviewComments, thread.prId);
  const comments: CommentDetail[] = thread.comments.map((c) => {
    const nodeId = commentNodes.get(c.id);
    const gc = nodeId ? gh.reviewCommentByNode.get(nodeId) : undefined;
    return gc ? { ...c, body: gc.body, diffHunk: gc.diffHunk } : c;
  });
  return { ...thread, comments };
}
