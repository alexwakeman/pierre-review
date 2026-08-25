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

// The advisor block sits ABOVE the /api/pro/ catch-all, and every path family is spelled
// exactly (the five-silent-routes lesson: the catch-all is silently wrong for anything it
// swallows — a DB-only dismiss would ride the 20/min AI bucket, a GitHub-writing config-PR
// would ride it too and misname its cost).
describe('tierFor — Bot Tuning Advisor', () => {
  it('the three GitHub-writing outputs sit on github_write, not ai', () => {
    expect(tiers('POST', '/api/pro/advisor/config-pr')).toEqual(['github_write']);
    expect(tiers('POST', '/api/pro/advisor/bots/12/manifest-pr')).toEqual(['github_write']);
    expect(tiers('POST', '/api/pro/advisor/recommendations/k1/issue')).toEqual(['github_write']);
    expect(tiers('POST', '/api/pro/advisor/config-pr')).not.toContain('ai');
  });

  it('refine is the one LLM route and bills like generation', () => {
    expect(tiers('POST', '/api/pro/advisor/refine')).toEqual(['ai', 'ai_hourly']);
  });

  it('findings ride the expensive aggregation bucket, discovery the GitHub-read bucket', () => {
    expect(tiers('GET', '/api/pro/advisor/findings')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/pro/advisor/bots/12/discovery')).toEqual(['pr_detail', 'read']);
  });

  it('preview (the config-pr dry-run) reads GitHub but writes nothing — discovery tier, not github_write', () => {
    expect(tiers('POST', '/api/pro/advisor/preview')).toEqual(['pr_detail', 'read']);
  });

  it('DB-only advisor routes stay on the blanket read bucket — POSTs included', () => {
    expect(tiers('GET', '/api/pro/advisor/recommendations')).toEqual(['read']);
    expect(tiers('GET', '/api/pro/advisor/brief')).toEqual(['read']);
    expect(tiers('GET', '/api/pro/advisor/bots/12/effect')).toEqual(['read']);
    // The mutating-but-DB-only family the /api/pro/ catch-all would have mis-tiered onto ai:
    expect(tiers('POST', '/api/pro/advisor/recommendations/k1/dismiss')).toEqual(['read']);
    expect(tiers('PUT', '/api/pro/advisor/bots/12/profile')).toEqual(['read']);
    expect(tiers('POST', '/api/pro/advisor/config-events')).toEqual(['read']);
  });
});

// The period-report family sits ABOVE the /api/pro/ catch-all, which tiers on the VERB alone.
//
// ⚠ MUTATION-TESTED, AND MOST OF THIS BLOCK IS INTENT RATHER THAN GUARD — said out loud because
// "a new isolation check can be VACUOUS" is a lesson this repo has already paid for. Disabling
// the family block in tierFor fails EXACTLY ONE assertion below: `POST …/reports` (the list root),
// which the catch-all would bill as generation. Every other answer here is one the catch-all
// happens to give too. They are asserted anyway because the catch-all's agreement is a
// COINCIDENCE of its suffix heuristic (`/cancel`, `/key`, `/budget`, `/settings`), not a decision
// about this family: add `/generate` to that suffix list, or add a fifth route here, and the
// coincidence breaks silently. These assertions are what turns that into a failing test.
describe('tierFor — period reports', () => {
  it('bills the two POSTs as generation (minute AND hour windows)', () => {
    expect(tiers('POST', '/api/pro/insights/reports/sprint-2026-08-18/generate')).toEqual([
      'ai',
      'ai_hourly',
    ]);
    expect(tiers('POST', '/api/pro/insights/reports/sprint-2026-08-18/chat')).toEqual([
      'ai',
      'ai_hourly',
    ]);
  });

  it('keeps the list GET on read and puts the one-report GET on the search bucket', () => {
    expect(tiers('GET', '/api/pro/insights/reports')).toEqual(['read']);
    // The one-report GET carries the "By workspace" axis (C4): 2 windows × N workspaces ×
    // getPeriodMetrics — the same multiplies-by-workspace-count shape that put the deleted
    // /api/workspace-metrics/compare on `search`. 60/min, never the 600/min blanket.
    expect(tiers('GET', '/api/pro/insights/reports/sprint-2026-08-18')).toEqual([
      'search',
      'read',
    ]);
    // ...and neither free GET may be swept onto the AI bucket by the family block above them.
    expect(tiers('GET', '/api/pro/insights/reports')).not.toContain('ai');
    expect(tiers('GET', '/api/pro/insights/reports/sprint-2026-08-18')).not.toContain('ai');
  });

  // The catch-all below this block treats every non-cancel/key/budget/settings POST as generation,
  // so a GET spelling of a generate path must stay cheap and a POST to the list root must not
  // become free. Both directions pinned.
  it('does not let the verb alone decide inside the family', () => {
    expect(tiers('GET', '/api/pro/insights/reports/sprint-2026-08-18/generate')).toEqual(['read']);
    expect(tiers('POST', '/api/pro/insights/reports')).toEqual(['read']);
  });

  // The prefix is anchored on the exact family: a sibling under /api/pro/insights/ must keep
  // falling through to the catch-all, which is what gives `/ask` its AI tier.
  it('does not sweep in the neighbouring insights routes', () => {
    expect(tiers('POST', '/api/pro/insights/ask')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('GET', '/api/pro/insights/chat-history')).toEqual(['read']);
    expect(tiers('GET', '/api/pro/insights')).toEqual(['read']);
    // A path that merely STARTS the same must not be captured by the family prefix.
    expect(tiers('POST', '/api/pro/insights/reports-export/generate')).toEqual(['ai', 'ai_hourly']);
  });
});

// GET /api/pro/insights/person/:userId (plan P4.2 — the 1:1-prep vector). DECIDED onto `search`:
// per request it runs the lane resolver + two capped review scans + ~10 person-scoped aggregates,
// the one-report GET's shape of cost — never the 600/min blanket read the catch-all would hand a
// GET. The narration spend is NOT this route: it rides POST /api/pro/synthesis (kind 'person'),
// whose ai tier is pinned in the synthesis block above.
describe('tierFor — 1:1 person period', () => {
  it('puts the person GET on the search bucket, never the blanket read or ai', () => {
    expect(tiers('GET', '/api/pro/insights/person/42')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/pro/insights/person/42')).not.toContain('ai');
  });

  it('leaves a (nonexistent) mutating spelling to the catch-all rather than blessing it', () => {
    expect(tiers('POST', '/api/pro/insights/person/42')).toEqual(['ai', 'ai_hourly']);
  });
});

describe('tierFor — GitHub quota spenders', () => {
  it('throttles live repo search separately', () => {
    expect(tiers('GET', '/api/repos/search')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/repos/suggested')).toEqual(['search', 'read']);
  });

  // The ML label surface spends NO GitHub quota and NO Anthropic credit — the model is called
  // only by the background worker, and the per-PR badge index is two indexed reads, so it stays
  // on `read`. (GET /api/bot-severity — the expensive rollup this test used to separate it
  // from — was REMOVED on the C7 cut list.)
  it('keeps the cheap per-PR label index on read', () => {
    expect(tiers('GET', '/api/prs/42/ml-labels')).toEqual(['read']);
    // ...and the label index must NOT be swept into the GitHub-hydrating PR-detail bucket.
    expect(tiers('GET', '/api/prs/42/ml-labels')).not.toContain('pr_detail');
  });

  // GET /api/pro/bot-behaviour — the workspace behaviour rollup, MOVED from core's
  // /api/bot-behaviour behind the botDepth entitlement (plan P0.2). Every-bot heatmaps + trends +
  // anomalies + overlap + the ML fold per request — the same DB-heavy shape as the flagging/volume family —
  // so it must sit on the 60/min `search` bucket, NOT inherit the /api/pro/ catch-all's GET→read
  // branch (in core it sat on the blanket read fall-through; the move is where that got decided).
  it('puts the moved pro bot-behaviour rollup on the expensive bucket, not the pro GET default', () => {
    expect(tiers('GET', '/api/pro/bot-behaviour')).toEqual(['search', 'read']);
  });

  // /api/pro/synthesis (P2.1) — one endpoint, two verbs, two DECIDED tiers. The POST is a real
  // model spend (Haiku behind a payload-hash $0 cache) → the `ai` pair, same as every generator.
  // The free GET recomputes the payload hash via getSynthesisInput, i.e. it re-runs the
  // drill-down's own population fold (the flagging label scan / the volume merged-PR walk) — the
  // bot-behaviour shape of cost — so it must sit on `search`, not inherit the /api/pro/
  // catch-all's 600/min GET→read branch.
  it('tiers the synthesis endpoint per verb: POST on the AI pair, GET on the expensive read bucket', () => {
    expect(tiers('POST', '/api/pro/synthesis')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('GET', '/api/pro/synthesis')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/pro/synthesis')).not.toContain('ai');
  });

  // /api/pro/bot-themes — the revived Bots "What they're flagging" panel. Both tiers land via
  // the /api/pro/ catch-all and are pinned here so the family's placement is explicit: the POST
  // /refresh is a real model spend (Haiku behind a payload-hash $0 cache) → the `ai` pair; the
  // GET is a PURE cache read of one indexed row, DELIBERATELY without a stale probe (a probe
  // would re-run the whole getBotReviewComments corpus fold per Bots-tab open — the exact cost
  // that puts its synthesis sibling's GET on `search`), so unlike that sibling it stays on the
  // plain read bucket.
  it('tiers the bot-themes pair per verb: refresh POST on the AI pair, the cached GET on read', () => {
    expect(tiers('POST', '/api/pro/bot-themes/refresh')).toEqual(['ai', 'ai_hourly']);
    expect(tiers('GET', '/api/pro/bot-themes')).toEqual(['read']);
    expect(tiers('GET', '/api/pro/bot-themes')).not.toContain('search');
  });

  // /api/ml-status is POLLED every few seconds while a sync round is open (it is what lets the
  // progress UI represent the model pass rather than stopping at the GitHub walk). Its backlog
  // half is the rollup's unlabelled-count joins repeated PER WORKSPACE, so the 600/min blanket
  // `read` bucket would be the wrong answer for a route a client hits on a timer.
  it('puts the polled enrichment-status route on the expensive bucket, not the blanket read one', () => {
    expect(tiers('GET', '/api/ml-status')).toEqual(['search', 'read']);
  });

  // GET /api/daily-brief (P3.1/P3.3) — free counts, but ONE call folds the consolidated feed +
  // the insights cards + the resolve backlog, and `?rollup=1` multiplies by workspace count (the
  // compare-route cost shape). A DELIBERATE `search` entry — the TTL cache bounds work per
  // request, the tier bounds request count; neither substitutes for the other.
  it('puts the daily-brief fold on the expensive bucket, not the blanket read one', () => {
    expect(tiers('GET', '/api/daily-brief')).toEqual(['search', 'read']);
  });

  // The comments drill-down ships comment BODIES (up to 3000/source) plus a three-way label
  // join per request — the same shape of cost as the rollup — while its /prs sibling is PR
  // metadata only and stays on the blanket bucket. Both pinned so neither drifts into the other.
  it('puts the bot-comments drill-down on the expensive bucket, its /prs sibling on read', () => {
    expect(tiers('GET', '/api/bot-analytics/vendor/u12/comments')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/bot-analytics/vendor/pierre/comments')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/bot-analytics/vendor/u12/prs')).toEqual(['read']);
  });

  // The flagging drill-down re-runs the strip's whole 50k-row label scan (or the whole windowed
  // thread scan + clustering) on EVERY page, because the population is a JS fold over a JSON
  // column and the offset is a slice over it — and an IntersectionObserver fires it repeatedly
  // while the user scrolls. Nothing above it in `tierFor` matches an `/api/bot-analytics/*` path,
  // so without an explicit predicate it would fall through to the 600/min blanket bucket: this
  // file's documented failure mode, now three times over.
  it('puts the flagging drill-down on the expensive bucket, not the blanket read one', () => {
    expect(tiers('GET', '/api/bot-analytics/flagging')).toEqual(['search', 'read']);
    // ...and it must not sweep in the always-loaded panel it drills into, nor its other sibling.
    expect(tiers('GET', '/api/bot-analytics')).toEqual(['read']);
    expect(tiers('GET', '/api/bot-analytics/bot-only-prs')).toEqual(['read']);
  });

  // The volume family walks every merged PR in the window (up to 5000) plus three grouped comment
  // counts over that population on EVERY request — the `/prs` offset is a slice over the fold, so
  // paging re-runs the scan. All three sub-paths are spelled into one both-ends-anchored regex;
  // without it they would land on the 600/min blanket bucket with no error anywhere, this file's
  // documented failure mode.
  it('puts the bot-comment-volume family on the expensive bucket', () => {
    expect(tiers('GET', '/api/bot-analytics/volume')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/bot-analytics/volume/prs')).toEqual(['search', 'read']);
    expect(tiers('GET', '/api/bot-analytics/volume/scatter')).toEqual(['search', 'read']);
    // ...and the anchoring must not sweep in a neighbour or a path that merely starts the same.
    expect(tiers('GET', '/api/bot-analytics')).toEqual(['read']);
    expect(tiers('GET', '/api/bot-analytics/volumes')).toEqual(['read']);
    expect(tiers('GET', '/api/bot-analytics/volume/prs/extra')).toEqual(['read']);
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

  // Emoji reactions. NEITHER route lives under /api/prs/<id>/, so neither is reachable from the
  // `hitsGithub` alternation — they are matched by exact string ABOVE the mutating block, and
  // these assertions are what stops that from rotting. Both spend GitHub GraphQL quota: the
  // lookup converts 1:1 into a `nodes(ids:)` call, the toggle is an ordinary mutation.
  it('puts the batched reaction lookup on the detail bucket, not the blanket read', () => {
    expect(tiers('POST', '/api/reactions/lookup')).toEqual(['pr_detail', 'read']);
    // The whole point of the explicit line: it must not be the bare fall-through.
    expect(tiers('POST', '/api/reactions/lookup')).not.toEqual(['read']);
  });

  it('throttles the reaction toggle as the GitHub write it is', () => {
    expect(tiers('POST', '/api/reactions')).toEqual(['github_write']);
    // ...and the two must not collapse into one bucket: a read-shaped 60/min ceiling on the
    // write, or a write ceiling on the poll-shaped read, would each be wrong in its own way.
    expect(tiers('POST', '/api/reactions')).not.toEqual(tiers('POST', '/api/reactions/lookup'));
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
