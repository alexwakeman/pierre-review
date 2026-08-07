// Rate-limit unit tests: the TIER CLASSIFICATION (which bucket a route lands in) and the
// fixed-window counter. Classification is the part most likely to rot — a new expensive route
// silently falling into the generous `read` tier is exactly the failure this file exists to
// catch, and it is invisible at runtime until a bill arrives.
import { beforeEach, describe, expect, it } from 'vitest';
import { __testing } from './rate-limit.js';

const { TIERS, tierFor, consume, buckets } = __testing;

/** The tier NAMES a (method, path) resolves to, in order. */
const tiers = (method: string, path: string): string[] =>
  tierFor(method, path).map((t) => t.name);

describe('tierFor — AI generation', () => {
  it('puts the Pro generators in the ai tier (minute AND hour windows)', () => {
    expect(tiers('POST', '/api/pro/activity/digests/refresh')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('POST', '/api/pro/insights/ask')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('POST', '/api/pro/sprint-report/refresh')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('POST', '/api/pro/prs/12/ai-fix')).toEqual(['ai', 'ai_hourly']);
    // The surviving per-ITEM addressed checks (one thread / one PR comment). The PR-WIDE twins
    // (`/api/pro/prs/:id/addressed/check` and its SSE stream) were removed — they were a second
    // whole-PR sweep billing one call per target, up to 50.
    expect(tiers('POST', '/api/pro/threads/12/addressed/check')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('POST', '/api/pro/pr-comments/12/addressed/check')).toEqual(['ai', 'ai_hourly']);
    // The comment-annotations platform: the run POST is the ONLY billing path, and now the only
    // AI entry point the whole feature has (its SSE twin went with the PR-wide sweep bar), so it
    // must not be left uncovered.
    expect(tiers('POST', '/api/pro/prs/12/annotations/run')).toEqual(['ai', 'ai_hourly']);
  });

  // Load-bearing: Claude Review kept its PRE-PLUGIN paths for frontend compatibility, so it does
  // NOT sit under /api/pro/. A classifier that only matched that prefix would leave the single
  // most expensive route in the product on the 600/min read tier.
  it('catches the Claude Review routes despite them not being under /api/pro/', () => {
    expect(tiers('POST', '/api/prs/42/claude-review')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('POST', '/api/claude-reviews/7/post')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('PATCH', '/api/claude-findings/3')).toEqual(['ai', 'ai_hourly']);
  });

  it('treats reads of stored AI results as cheap reads, not generation', () => {
    expect(tiers('GET', '/api/pro/insights')).toEqual(['read']);
    expect(tiers('GET', '/api/prs/42/claude-review')).toEqual(['read']);
    expect(tiers('GET', '/api/prs/42/claude-review/status')).toEqual(['read']);
    expect(tiers('GET', '/api/claude-reviews')).toEqual(['read']);
    // Reading stored annotations is a pure cache hit — it must NOT land on the ai tier, or
    // simply opening a PR would burn the 20/min generation budget.
    expect(tiers('GET', '/api/pro/prs/12/annotations')).toEqual(['read']);
  });

  it('does not bill cancels or config writes as generation', () => {
    expect(tiers('POST', '/api/prs/42/claude-review/cancel')).toEqual(['read']);
    expect(tiers('PUT', '/api/claude-review/key')).toEqual(['read']);
    expect(tiers('PUT', '/api/claude-review/budget')).toEqual(['read']);
    expect(tiers('PUT', '/api/pro/settings')).toEqual(['read']);
  });
});

describe('tierFor — GitHub quota spenders', () => {
  it('throttles live repo search separately', () => {
    expect(tiers('GET', '/api/repos/search')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/repos/suggested')).toEqual(['search', 'read']);
  });

  // The ML severity surface spends NO GitHub quota and NO Anthropic credit — the model is
  // called only by the background worker. What it does spend is this process: the rollup reads
  // a workspace's whole label corpus (capped at 50k rows) plus three unlabelled-count joins, so
  // it borrows the same 60/min bucket as `/compare`, while the per-PR badge index is two indexed
  // reads and stays on `read`. Both are pinned here so the pair can't drift into each other.
  it('separates the expensive ML rollup from the cheap per-PR label index', () => {
    expect(tiers('GET', '/api/bot-severity')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/prs/42/ml-labels')).toEqual(['read']);
    // ...and the label index must NOT be swept into the GitHub-hydrating PR-detail bucket.
    expect(tiers('GET', '/api/prs/42/ml-labels')).not.toContain('pr_detail');
  });

  // /api/ml-status is POLLED every few seconds while a sync round is open (it is what lets the
  // progress UI represent the model pass rather than stopping at the GitHub walk). Its backlog
  // half is the rollup's unlabelled-count joins repeated PER WORKSPACE, so the 600/min blanket
  // `read` bucket would be the wrong answer for a route a client hits on a timer.
  it('puts the polled enrichment-status route on the expensive bucket, not the blanket read one', () => {
    expect(tiers('GET', '/api/ml-status')).toEqual(['search', 'read']);
  });

  it('throttles sync triggers and repo-add (each starts a backfill)', () => {
    expect(tiers('POST', '/api/repos/5/sync')).toEqual(['sync']);
    expect(tiers('POST', '/api/repos')).toEqual(['sync']);
  });

  // GET /api/prs/:id hydrates bodies from GitHub on every call under lean storage (the default
  // in BOTH modes), so it converts HTTP requests 1:1 into GraphQL requests.
  it('gives PR/thread detail its own tighter bucket', () => {
    expect(tiers('GET', '/api/prs/42')).toEqual(['pr_detail', 'read']);
    expect(tiers('GET', '/api/threads/9')).toEqual(['pr_detail', 'read']);
    // Sub-routes that only read already-synced rows are DB-only — not the hydration path.
    expect(tiers('GET', '/api/prs/42/bot-behaviour')).toEqual(['read']);
    expect(tiers('GET', '/api/prs/42/bot-dedup')).toEqual(['read']);
    expect(tiers('GET', '/api/prs/42/mention-candidates')).toEqual(['read']);
  });

  // merge-options fires up to five live GitHub calls (merge config, mergeability, the
  // merge-queue GraphQL probe) and /files pulls every patch — both spend MORE upstream quota
  // per request than GET /api/prs/:id itself, so they must share its bucket rather than sit on
  // the 600/min blanket backstop just because they happen to have a path segment after the id.
  //
  // `checks/<jobId>/logs` and `suggested-reviewers` joined them later: the first 302s to a signed
  // blob it then range-fetches, the second reads CODEOWNERS over REST plus a team-history GraphQL
  // probe. `suggested-reviewers` was previously asserted HERE as a DB-only `read` route — the
  // assertion pinned a mistake, because github/reviewer-suggest.ts:35 takes an access token. A test
  // that encodes the current behaviour is only evidence of intent when the behaviour is right.
  it('puts the hydrating PR sub-routes on the detail bucket too', () => {
    expect(tiers('GET', '/api/prs/42/merge-options')).toEqual(['pr_detail', 'read']);
    expect(tiers('GET', '/api/prs/42/files')).toEqual(['pr_detail', 'read']);
    expect(tiers('GET', '/api/prs/42/suggested-reviewers')).toEqual(['pr_detail', 'read']);
    expect(tiers('GET', '/api/prs/42/checks/9876543/logs')).toEqual(['pr_detail', 'read']);
  });

  // The bare id must keep matching, and a sibling that is NOT in the alternation must not be
  // swept in by the optional group — the regex has to stay anchored at both ends.
  it('does not widen the detail bucket beyond the listed sub-routes', () => {
    expect(tiers('GET', '/api/prs/42')).toEqual(['pr_detail', 'read']);
    expect(tiers('GET', '/api/prs/42/claude-review')).toEqual(['read']);
    expect(tiers('GET', '/api/prs/42/files/extra')).toEqual(['read']);
  });

  // POST /api/prs/:id/refresh — the PrDetail live poll + its manual Refresh button. A
  // mutating verb with GET-shaped cost (probe-gated; a changed tick spends a syncOnePr
  // walk), so it must share the prDetail bucket: github_write would let the poll starve
  // real writes, and the 600/min blanket read bucket is the file's documented silent
  // failure mode for a route that can spend GitHub quota.
  it('puts the PR refresh poll on the detail bucket, not github_write or the blanket read', () => {
    expect(tiers('POST', '/api/prs/42/refresh')).toEqual(['pr_detail', 'read']);
    // ...and the GET spelling must not exist as a cheap alias.
    expect(tiers('GET', '/api/prs/42/refresh')).toEqual(['read']);
  });

  // The guard on the fix above: `merge` prefix-matches `merge-options`, so a careless widening
  // could steal the merge WRITE verbs out of github_write and hand them a 600/min ceiling.
  it('does not pull any merge WRITE route off github_write', () => {
    expect(tiers('PUT', '/api/prs/42/merge')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/merge')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/merge-queue')).toEqual(['github_write']);
    expect(tiers('DELETE', '/api/prs/42/auto-merge')).toEqual(['github_write']);
  });

  it('throttles writes that reach the GitHub API', () => {
    expect(tiers('POST', '/api/threads/9/reply')).toEqual(['github_write']);
    expect(tiers('POST', '/api/bot-threads/resolve')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/approve')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/merge')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/resolve-bot-threads')).toEqual(['github_write']);
    // Merge queue + Pierre-side auto-merge. Both verbs of each, because a DELETE that fell
    // through to `read` would let a client hammer GitHub's dequeue at 600/min.
    expect(tiers('POST', '/api/prs/42/merge-queue')).toEqual(['github_write']);
    expect(tiers('DELETE', '/api/prs/42/merge-queue')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/auto-merge')).toEqual(['github_write']);
    expect(tiers('DELETE', '/api/prs/42/auto-merge')).toEqual(['github_write']);
  });

  // Every one of these five was falling through to the 600/min blanket `read` bucket: the
  // alternation spelled `comments`/`reviews` in the plural while the routes are singular, and
  // `close` / `ci/rerun` / `request-reviewers` were simply missing. Asserted by their EXACT
  // path so a spelling drift fails here rather than silently un-throttling a GitHub write.
  it('throttles the PR write routes whose exact segment the classifier used to miss', () => {
    // The most upstream-expensive write in the family: head sha + file patches to anchor the
    // line, the post itself, then a resync and a forced fresh PR_DETAIL_QUERY.
    expect(tiers('POST', '/api/prs/42/review-comment')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/comment')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/close')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/ci/rerun')).toEqual(['github_write']);
    expect(tiers('POST', '/api/prs/42/request-reviewers')).toEqual(['github_write']);
  });

  // The widening above must not swallow the two purely-local PR bookkeeping writes, which
  // never touch GitHub and are called on every PR the user so much as looks at.
  it('leaves the local-only view bookkeeping writes on the read tier', () => {
    expect(tiers('POST', '/api/prs/42/mark-viewed')).toEqual(['read']);
    expect(tiers('POST', '/api/prs/42/dismiss')).toEqual(['read']);
    expect(tiers('POST', '/api/prs/mark-all-viewed')).toEqual(['read']);
  });

  // The two new cross-account GETs are pure DB reads off already-synced rows — no GitHub
  // call, no LLM — so the generous backstop is correct. Pinned so that a later change which
  // gives either a live GitHub fetch has to come back here and move it deliberately.
  it('leaves the DB-only armed-merge and branch-status reads on the read tier', () => {
    expect(tiers('GET', '/api/auto-merge')).toEqual(['read']);
    expect(tiers('GET', '/api/branch-status')).toEqual(['read']);
  });
});

describe('tierFor — unauthenticated surface', () => {
  it('buckets sign-in by itself (it is reachable without a session)', () => {
    expect(tiers('GET', '/api/auth/login')).toEqual(['auth']);
    expect(tiers('GET', '/api/auth/callback')).toEqual(['auth']);
  });

  // Webhooks are legitimately bursty (a busy org pushing), so they get a high ceiling — but not
  // an absent one, since each delivery can enqueue a sync.
  it('gives signed webhooks a high but finite ceiling', () => {
    expect(tiers('POST', '/api/webhooks/github')).toEqual(['webhook']);
    expect(tiers('POST', '/api/billing/webhook')).toEqual(['webhook']);
    expect(TIERS.webhook.limit).toBeGreaterThan(TIERS.ai.limit);
  });
});

describe('tier limits are ordered sensibly', () => {
  it('AI is the tightest and read the most generous', () => {
    expect(TIERS.ai.limit).toBeLessThan(TIERS.search.limit);
    expect(TIERS.ai.limit).toBeLessThan(TIERS.githubWrite.limit);
    expect(TIERS.prDetail.limit).toBeLessThan(TIERS.read.limit);
    expect(TIERS.read.limit).toBeGreaterThan(TIERS.githubWrite.limit);
  });

  it('the hourly AI window is stricter than 60× the per-minute one', () => {
    // Otherwise the hour bucket would never bind and the second window would be decoration.
    expect(TIERS.aiHourly.limit).toBeLessThan(TIERS.ai.limit * 60);
  });
});

describe('consume — fixed window', () => {
  beforeEach(() => buckets.clear());

  const tier = { name: 'test', limit: 3, windowMs: 1000 };

  it('allows up to the limit, then reports the wait', () => {
    const now = 1_000_000;
    expect(consume('k', tier, now)).toBeNull();
    expect(consume('k', tier, now)).toBeNull();
    expect(consume('k', tier, now)).toBeNull();
    // Fourth in the same window is refused, with a positive Retry-After.
    const wait = consume('k', tier, now);
    expect(wait).not.toBeNull();
    expect(wait!).toBeGreaterThan(0);
  });

  it('keys are independent (one account cannot exhaust another)', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) consume('a1', tier, now);
    expect(consume('a1', tier, now)).not.toBeNull();
    // A different account still has its full allowance.
    expect(consume('a2', tier, now)).toBeNull();
  });

  it('resets once the window has elapsed', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) consume('k', tier, now);
    expect(consume('k', tier, now)).not.toBeNull();
    expect(consume('k', tier, now + 1001)).toBeNull();
  });
});
