/**
 * Draining the review-thread tail off a PR whose threads overflow one GraphQL page.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------------------
 * `reviewThreads(first: 50)` in the fat sync queries is not a page — it was a silent cliff.
 * GitHub returns review threads OLDEST FIRST (verified live), so a PR with more than fifty
 * threads stored the fifty oldest and dropped everything after, permanently: nothing in the
 * walk ever asked for the rest, and an incremental re-sync re-fetched the same first fifty.
 * The half that vanished was the NEWEST review round — the unresolved bot findings this
 * product exists to surface — and it vanished on exactly the bot-flooded PRs the feature is
 * about. Measured on this repo's own corpus at the time of writing: 64 PRs pinned at exactly
 * 50 stored threads, whose true counts ran 55, 56, 69, 71, 90, 108. Better than half of the
 * largest one was invisible.
 *
 * ---------------------------------------------------------------------------------------
 * WHY A DRAIN AND NOT A BIGGER CAP
 * ---------------------------------------------------------------------------------------
 * Because GitHub prices the DECLARED shape, not the returned rows — see the measured table
 * on PR_NODE_FIELDS' `reviewThreads`. Raising the walk's cap to 100 costs +87% on every page
 * of every repo forever (15 → 28 points), is charged identically on repos with no threads at
 * all, and STILL truncates the 108-thread PR. A continuation costs 1 point and is issued only
 * by the PRs that actually overflow — 2.6% of PRs with threads in the same corpus. The cheap
 * thing and the correct thing are the same thing here, which is rare enough to write down.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS IS SAFE TO DO MID-SYNC
 * ---------------------------------------------------------------------------------------
 * The drain appends into `pr.reviewThreads.nodes` BEFORE `persistPr` ever sees the PR, so the
 * persistence path keeps receiving one complete list and needs no notion of pages. That
 * matters more than it looks: `persistPr` reads the PR's prior thread rows ONCE, up front,
 * to decide which unresolved→resolved flips it is witnessing (`nextResolvedAt`). Persisting
 * page 1 and then page 2 as two separate calls would make page 2's read observe page 1's own
 * writes; merging first keeps that snapshot honest.
 *
 * A partial drain is also safe, which is why every failure path below just stops and keeps
 * what it has. Threads and review comments upsert on a COMPOSITE conflict target
 * (`(prId, githubNodeId)`) and NOTHING anywhere prunes a stored thread that is missing from a
 * payload — so a tail that half-arrives is strictly more data than before, never a deletion,
 * and the next sync retries the rest.
 *
 * ---------------------------------------------------------------------------------------
 * BUDGET POSTURE
 * ---------------------------------------------------------------------------------------
 * This is an ADDITIVE enrichment on top of a walk that has already been paid for, so it never
 * blocks and never throws: it declines to start when the account is in a known hard limit,
 * feeds every response's `rateLimit` back into the per-account budget so the caller's own
 * pre-emptive gate sees the spend, reports a limit it runs into via `noteLimited`, and
 * otherwise degrades to the truncated-but-valid first page. It must NOT wait out a limit
 * window itself — the walk's `pauseForBudget` owns that decision, and a drain that blocked
 * would turn a 15-point page into a stall while holding no useful state.
 */
import {
  getGraphqlClientFor,
  graphqlChecksHint,
  graphqlTolerant,
  isRateLimitError,
  summarizeGraphqlErrors,
  type GraphqlClient,
} from '../github/client.js';
import { isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import {
  PR_DETAIL_THREADS_PAGE_QUERY,
  PR_REVIEW_THREADS_PAGE_QUERY,
  type GqlDetailThread,
  type GqlReviewThread,
  type GqlThreadPage,
  type ThreadsPageResponse,
} from '../github/queries.js';
import type { Logger } from './sync-repo.js';

/**
 * Hard stop on continuation pages for ONE pull request, so a pathological thread count (or a
 * server that keeps saying `hasNextPage` without advancing) can never turn one PR into an
 * unbounded spend. 20 pages × 50 = 1050 threads, against a real-world observed maximum of 108.
 * Hitting it is logged at WARN precisely because it should not happen; if it starts happening
 * routinely, that is a finding about the corpus, not a number to quietly raise.
 */
const MAX_CONTINUATION_PAGES = 20;

/** What a drain did, for the caller's log line. `pages` is GraphQL points spent. */
export interface ThreadDrainResult {
  /** Threads appended to the first page. 0 whenever nothing overflowed (the common case). */
  added: number;
  /** Continuation requests actually issued — one GraphQL point each. */
  pages: number;
  /** True when the drain stopped with threads still unread (cap, cancel, error, limit). */
  incomplete: boolean;
}

const NOTHING: ThreadDrainResult = { added: 0, pages: 0, incomplete: false };

export interface DrainOptions {
  owner: string;
  name: string;
  /** The PR NUMBER, not its local id — the continuation addresses GitHub, not the DB. */
  number: number;
  /** Whose budget is spent, and whose limit flags are honoured. */
  accountId: number;
  token: string;
  log?: Logger;
  /**
   * Polled between continuation pages. A cancelled walk must not keep spending on a PR whose
   * persist it is about to skip; the partial tail already fetched is simply dropped.
   */
  shouldCancel?: () => boolean;
}

/**
 * Append every remaining review thread onto the SYNC-shaped first page, in place.
 *
 * A no-op — no request, no cost — unless GitHub positively said there is more
 * (`hasNextPage === true` with a string cursor). An absent `pageInfo` is the pre-drain
 * behaviour by construction: hand-built fixtures and tolerant-salvaged partials both land
 * there, and both should truncate exactly as they did before rather than guess.
 */
export async function drainReviewThreads(
  page: GqlThreadPage<GqlReviewThread>,
  opts: DrainOptions,
): Promise<ThreadDrainResult> {
  return drain(page, PR_REVIEW_THREADS_PAGE_QUERY, opts);
}

/** The hydration-shaped twin — same loop, text-only thread nodes. */
export async function drainDetailThreads(
  page: GqlThreadPage<GqlDetailThread>,
  opts: DrainOptions,
): Promise<ThreadDrainResult> {
  return drain(page, PR_DETAIL_THREADS_PAGE_QUERY, opts);
}

async function drain<TNode>(
  page: GqlThreadPage<TNode>,
  query: string,
  opts: DrainOptions,
): Promise<ThreadDrainResult> {
  const { owner, name, number, accountId, token, log, shouldCancel } = opts;

  let cursor = nextCursor(page);
  if (cursor === null) return NOTHING;

  let added = 0;
  let pages = 0;
  /**
   * Every exit rewrites the connection's OWN `pageInfo` to describe what it now holds — next
   * cursor if the drain stopped short, `hasNextPage: false` when it finished. Without this the
   * object keeps advertising the first page's cursor after the tail has been appended, so a
   * second drain of the same object would re-fetch from the top and DOUBLE every thread it
   * already has. Nothing re-drains today; this makes the mutation self-consistent so nothing
   * ever can, and makes an interrupted drain resumable for free.
   */
  const finish = (at: string | null): ThreadDrainResult => {
    page.pageInfo = { hasNextPage: at !== null, endCursor: at };
    return { added, pages, incomplete: at !== null };
  };

  // Pre-empt rather than spend: the first page is already in hand and is a valid (if
  // truncated) answer, so a token in a known limit window should keep its remaining budget
  // for the walk itself.
  if (isLimited(accountId)) {
    log?.warn(
      `drainReviewThreads ${owner}/${name}#${number}: rate-limited — keeping the first ` +
        `${page.nodes.length} thread(s) of ${page.totalCount ?? '?'}`,
    );
    return finish(cursor);
  }

  const client: GraphqlClient = getGraphqlClientFor(token);

  while (cursor !== null) {
    if (shouldCancel?.()) return finish(cursor);
    if (pages >= MAX_CONTINUATION_PAGES) {
      log?.warn(
        `drainReviewThreads ${owner}/${name}#${number}: stopped at the ` +
          `${MAX_CONTINUATION_PAGES}-page cap with ${page.nodes.length} of ` +
          `${page.totalCount ?? '?'} thread(s) — investigate before raising this`,
      );
      return finish(cursor);
    }

    let resp: ThreadsPageResponse<TNode>;
    try {
      resp = await graphqlTolerant<ThreadsPageResponse<TNode>>(
        client,
        query,
        { owner, name, number, cursor },
        (errors) => {
          log?.warn(
            `drainReviewThreads ${owner}/${name}#${number}: partial GraphQL — keeping what ` +
              `arrived${graphqlChecksHint(errors)}. ${summarizeGraphqlErrors(errors)}`,
          );
        },
      );
    } catch (err) {
      // A limit hit HERE must be reported even though we swallow the error, or the walk's
      // next pre-emptive gate stands down while this keeps firing (the exact bug
      // hydrate-detail.ts documents).
      const rl = isRateLimitError(err);
      if (rl.limited) noteLimited(accountId, rl.resumeAt);
      log?.warn(
        `drainReviewThreads ${owner}/${name}#${number} failed after ${pages} page(s); ` +
          `keeping ${page.nodes.length} thread(s). ` +
          `${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
      return finish(cursor);
    }
    pages += 1;

    if (resp.rateLimit) {
      // ⚠ noteBudget must not clear `limitedUntil` — see github/rate-budget.ts.
      noteBudget(accountId, {
        remaining: resp.rateLimit.remaining ?? null,
        resetAt: resp.rateLimit.resetAt ? new Date(resp.rateLimit.resetAt) : null,
      });
    }

    const more = resp.repository?.pullRequest?.reviewThreads;
    // The PR went away mid-drain (deleted, access lost), or a partial nulled the node. The
    // first page is still a valid answer; stop rather than retry into the same wall.
    if (!more) return finish(cursor);

    // ⚠ `nodes` is DECLARED as a list and ARRIVES NULLABLE, which is why it is re-typed here
    // rather than trusted. It is the `graphqlTolerant` three-state rule (CLAUDE.md): a partial
    // hands back the errored selection NULLED with its key still present, so "GitHub says the
    // continuation is empty" and "the thread list never reached us" are indistinguishable by
    // type. Reading it unguarded — outside the try that wraps the request — is the ONE way
    // this module can throw, and it throws on precisely the shape it exists to survive: the
    // walk's catch stamps the whole repo `lastSyncStatus='error'` and discards every remaining
    // PR on the page, and the hydration path escapes `fetchReviewCommentHunks`' "never throws"
    // contract as a 500 on GET /api/prs/:id. Both are strictly worse than the truncated-but-
    // valid first page the header promises. So: no list = no continuation data arrived. Stop,
    // keep what we hold, and leave `cursor` in place so the next sync retries this same page.
    const arrived: (TNode | null)[] | null | undefined = more.nodes;
    if (!Array.isArray(arrived)) return finish(cursor);

    // A null ELEMENT is the same partial one level down — GitHub nulls the individual node
    // whose error propagated, which is the likelier of the two shapes. Dropping it is not
    // tidiness: `persistPr` and both callers' own `.filter((t) => !t.isResolved)` walk this
    // list unguarded, so ONE null smuggled into the tail is the same whole-repo failure as a
    // null list — and counting it in `added` would report a thread that was never appended.
    let dropped = 0;
    for (const node of arrived) {
      if (node == null) {
        dropped += 1;
        continue;
      }
      page.nodes.push(node);
      added += 1;
    }
    if (dropped > 0) {
      log?.warn(
        `drainReviewThreads ${owner}/${name}#${number}: dropped ${dropped} null thread node(s) ` +
          `from a partial continuation — keeping ${page.nodes.length} of ` +
          `${page.totalCount ?? '?'} thread(s)`,
      );
    }

    const next = nextCursor(more);
    // A server that says "more" but hands back the SAME cursor would spin forever. GitHub does
    // not do this; the guard costs one comparison and removes the possibility. Compare BEFORE
    // reassigning — comparing after would make every healthy advance look like a stall.
    const stalled = next !== null && next === cursor;
    if (stalled) {
      log?.warn(`drainReviewThreads ${owner}/${name}#${number}: cursor did not advance — stopping`);
      return finish(cursor);
    }
    cursor = next;
  }

  if (added > 0) {
    log?.info(
      `drainReviewThreads ${owner}/${name}#${number}: +${added} thread(s) over ${pages} ` +
        `continuation page(s) (${page.nodes.length} total)`,
    );
  }
  return finish(null);
}

/**
 * The cursor to continue from, or null to stop. Deliberately demands a POSITIVE
 * `hasNextPage === true` and a non-empty string: `undefined`/`null` anywhere in that chain
 * means "GitHub did not tell us there is more", which is the same thing as "stop" and NOT the
 * same thing as "ask again from the beginning".
 */
function nextCursor(page: { pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null }): string | null {
  const info = page.pageInfo;
  if (!info || info.hasNextPage !== true) return null;
  return typeof info.endCursor === 'string' && info.endCursor.length > 0 ? info.endCursor : null;
}
