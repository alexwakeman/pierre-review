import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config.js';

// ---------------------------------------------------------------------------
// Per-account (cloud) / per-instance (local) request rate limiting.
//
// The point is NOT generic DoS protection — Railway sits in front of this — it is
// COST. Several routes here spend real money on someone else's meter on every call:
// an Anthropic completion, an agentic review, a GitHub GraphQL backfill. Those are
// already individually capped (a per-run USD ceiling, a concurrency gate, a credit
// meter, a payload-hash cache), but nothing stopped a caller from issuing the same
// capped request in a loop and multiplying it. This is that missing outer bound.
//
// Hand-rolled rather than @fastify/rate-limit for the same reason as the security
// headers: a new runtime dependency would have to be added to the curated release
// manifest (scripts/build-release.mjs) and the pinned lockfile, and the useful part
// of that plugin is ~40 lines. There is no Redis here and no need for one: local
// mode is a single process, and the cloud deployment is a single Railway service.
// If it is ever scaled horizontally these buckets become per-instance — i.e. the
// effective limit multiplies by the instance count, which is a soft failure, not a
// hole. The per-run USD caps and the credit meter remain the hard ceilings.
// ---------------------------------------------------------------------------

interface Bucket {
  /** Window start, ms since epoch. */
  start: number;
  count: number;
}

interface Tier {
  /** Human-readable name, used in the log line + the 429 body. */
  name: string;
  /** Max requests per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

// A fixed window (not a sliding one) is deliberate: it is O(1) in memory per key,
// and the worst case — 2× the limit across a window boundary — is irrelevant when
// the limits are this far above normal human use.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---- The tiers ----
//
// Sized so a person driving the UI hard never sees a 429, while a script in a loop
// hits one within seconds. Every number is overridable via env for a deployment that
// needs to tune (RATE_LIMIT_<TIER>_PER_MIN).
function tier(name: string, perWindow: number, windowMs: number): Tier {
  const raw = process.env[`RATE_LIMIT_${name.toUpperCase().replace(/-/g, '_')}`];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return {
    name,
    limit: Number.isFinite(n) && n > 0 ? n : perWindow,
    windowMs,
  };
}

const TIERS = {
  // Anthropic-spending generation. A digest refresh, a sprint report, an Insights
  // chat turn, a themes rebuild, a PR summary, an agentic review or fix. The most
  // expensive thing in the app and the tightest bucket.
  ai: tier('ai', 20, MINUTE),
  // A second, longer window on the same routes: 20/min would still be 1200/hour.
  aiHourly: tier('ai_hourly', 120, HOUR),
  // Writes that hit the GitHub API — posting a review, resolving threads, approving,
  // merging, commenting. Bounded by the tenant's GitHub quota, which is shared and
  // exhaustible, so worth a bucket of its own.
  githubWrite: tier('github_write', 60, MINUTE),
  // Sync triggers. A full backfill is minutes of GraphQL; adding a repo starts one.
  sync: tier('sync', 20, MINUTE),
  // Live GitHub repo search — one upstream call per keystroke burst.
  search: tier('search', 60, MINUTE),
  // GET /api/prs/:id. Looks like a plain read, but under lean storage (the DEFAULT in both
  // modes) each call runs PR_DETAIL_QUERY against GitHub to hydrate the bodies — so a loop
  // over PR ids converts HTTP requests 1:1 into GraphQL requests and drains the tenant's
  // 5,000 points/hour, breaking their sync and write actions for the rest of the hour. A
  // person opens a handful of PRs a minute; 60 leaves enormous headroom while keeping the
  // hourly worst case inside the GitHub budget. Paired with the 60s hydration cache +
  // in-flight coalescing in sync/hydrate-detail.ts, which make repeats free.
  prDetail: tier('pr_detail', 60, MINUTE),
  // Everything else under /api. A generous blanket backstop that also catches a
  // runaway polling loop in the frontend before it becomes a support ticket.
  read: tier('read', 600, MINUTE),
  // Sign-in. Unauthenticated, so keyed by IP; the callback makes two GitHub calls.
  auth: tier('auth', 30, MINUTE),
  // Signed webhooks. Legitimately bursty (a busy org pushing), so high — but not
  // unbounded, since each delivery can enqueue a sync.
  webhook: tier('webhook', 600, MINUTE),
} as const;

// ---- Route → tier classification ----
//
// Matched on the raw path, cheapest checks first. Kept as explicit predicates rather
// than a regex table so each decision is readable and greppable from the route file
// it refers to.
function tierFor(method: string, path: string): readonly Tier[] {
  const mutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  // Signed server-to-server posts.
  if (path === '/api/webhooks/github' || path === '/api/billing/webhook') {
    return [TIERS.webhook];
  }
  if (path.startsWith('/api/auth/')) return [TIERS.auth];

  // ---- Workspace CRUD: `read`, RECORDED rather than inherited ----
  //
  // The five surviving routes (list / create / rename+reassign / delete / move-one-repo-in) are
  // pure local database work: a membership upsert on (account_id, repo_id), a rename, a re-home
  // of repos and reviewer rows to Default. Nothing behind them calls GitHub and nothing behind
  // them calls an LLM — assignment writes ONE membership row and nothing else (`repos.inbox_watch`
  // is dropped; there is no second visibility column left to set), and the sync scheduler picks
  // the repo up on its own cron rather than on this request. So `read` is the same
  // answer the fall-through at the bottom of this function would give, and it is spelled out
  // anyway: the two documented mistakes in this file were both a route whose tier was never
  // decided, only inherited. An explicit line makes the next reader's question "is this still
  // true?" instead of "did anyone look?".
  //
  // Written as an exact match plus a `/`-terminated prefix, NOT a bare
  // `startsWith('/api/workspaces')` and emphatically not `startsWith('/api/workspace')`:
  // `/api/workspace-metrics/compare` sits on a DIFFERENT tier a few lines below, and a loose
  // prefix over two sibling vocabularies is precisely how one silently swallows the other.
  if (path === '/api/workspaces' || path.startsWith('/api/workspaces/')) return [TIERS.read];

  // ---- Bot Tuning Advisor (must sit ABOVE the /api/pro/ AI-tier catch-all) ----
  // "Follow the token": most advisor routes are DB-only reads/writes, but the generic
  // /api/pro/ branch below puts every mutating POST on the 20/min AI bucket — which would
  // throttle a plain `dismiss` like an LLM call, while the three GitHub-writing outputs
  // (config-pr / manifest-pr / issue) genuinely spend GitHub quota and the one LLM route
  // (refine) genuinely spends model dollars. Each path family is spelled exactly and pinned
  // in rate-limit.test.ts. Staying under /api/pro/ keeps the automatic 402 entitlement gate.
  if (path.startsWith('/api/pro/advisor/')) {
    if (mutating && path.endsWith('/config-pr')) return [TIERS.githubWrite];
    if (mutating && path.endsWith('/manifest-pr')) return [TIERS.githubWrite];
    if (mutating && path.endsWith('/issue')) return [TIERS.githubWrite];
    if (mutating && path.endsWith('/refine')) return [TIERS.ai, TIERS.aiHourly];
    // findings = a full-corpus aggregation (the compare-tier precedent); discovery and
    // preview = a few GitHub contents-API reads (the pr-detail hydration precedent —
    // preview is the config-pr dry-run: it fetches the config files but writes nothing).
    if (!mutating && path.endsWith('/findings')) return [TIERS.search, TIERS.read];
    if (!mutating && path.endsWith('/discovery')) return [TIERS.prDetail, TIERS.read];
    if (mutating && path.endsWith('/preview')) return [TIERS.prDetail, TIERS.read];
    // dismiss / profiles / config-events / recommendations / brief / effect: DB-only.
    return [TIERS.read];
  }

  // ---- Period reports (must sit ABOVE the /api/pro/ AI-tier catch-all) ----
  // The Insights → Reports family is two free GETs and two spending POSTs under ONE path prefix,
  // which is exactly the shape the catch-all below gets wrong in both directions: it tiers on the
  // VERB, so `GET …/reports` (a list of stored rows — no model call, no GitHub) would inherit the
  // 600/min blanket read bucket by accident rather than by decision, while a future GET that
  // happened to be a POST would land on `ai` for free. Spelling the family out here also means
  // the next reader sees the four routes and their costs together:
  //   POST …/:periodKey/generate  an Anthropic completion (Haiku OR Sonnet — the one route in the
  //                               app whose per-call price the USER picks) plus, on a first run,
  //                               a bounded 8-period metrics backfill: ~20 indexed scans.
  //   POST …/:periodKey/chat      one grounded Anthropic completion per turn.
  //   GET  …/reports              stored rows + a bounded per-period coverage read. DB only.
  //   GET  …/reports/:periodKey   one stored row + ONE metric-vector recompute for the staleness
  //                               flag. DB only — it must NEVER grow a generation leg (the
  //                               `GET /api/pro/prs/:id/annotations` precedent, which is on
  //                               `read` for the same reason and for the same fragile reason).
  // Anchored on the exact family prefix so no sibling `/api/pro/insights/*` route is swept in.
  if (path === '/api/pro/insights/reports' || path.startsWith('/api/pro/insights/reports/')) {
    if (mutating && (path.endsWith('/generate') || path.endsWith('/chat'))) {
      return [TIERS.ai, TIERS.aiHourly];
    }
    return [TIERS.read];
  }

  // ---- AI generation ----
  // ⚠ RE-DECIDED, not inherited: `POST /api/pro/prs/:id/annotations/run` now spends GITHUB quota
  // as well as model tokens — one PR_DETAIL_QUERY per uncached PR for the anchor hunks
  // (sync/hydrate-detail.ts) on top of the two-sha compares. It stays on `ai` (20/min), which is
  // TIGHTER than `prDetail`'s 60/min, so the GitHub exposure is already bounded more
  // conservatively than a plain `GET /api/prs/:id`. Nothing to change — but the decision is
  // recorded, because this file's failure mode is a tier nobody re-examined.
  // The PAIRED `GET /api/pro/prs/:id/annotations` must STAY on `read`: it is a pure DB read fired
  // on every PR open, and it must never grow a hydration leg (see the prDetail note above for
  // what that cost the first time).
  //
  // Two shapes: the Pro plugin's /api/pro/* generators, and the Claude Review
  // family, which for back-compat kept the pre-plugin paths (/api/prs/:id/
  // claude-review, /api/claude-reviews/*, /api/claude-findings/*) and so does NOT
  // sit under /api/pro/. Both are matched here.
  const isClaudeReviewPath =
    path.includes('/claude-review') ||
    path.startsWith('/api/claude-reviews') ||
    path.startsWith('/api/claude-findings');
  if (isClaudeReviewPath || path.startsWith('/api/pro/')) {
    // A GET is a cheap read of a stored result (poll status, load history) — only
    // the generation verbs spend. `/refresh` and `/ask` are POSTs; so are the
    // review/fix starts. The one GET that generates is a `…/stream` SSE subscribe,
    // which attaches to an already-started run, so it stays a read.
    const generates =
      mutating &&
      !path.endsWith('/cancel') &&
      !path.endsWith('/key') &&
      !path.endsWith('/budget') &&
      !path.endsWith('/settings');
    if (generates) return [TIERS.ai, TIERS.aiHourly];
    return [TIERS.read];
  }

  // ---- GitHub-quota spenders ----
  if (path.startsWith('/api/repos/search')) return [TIERS.search, TIERS.read];
  if (path === '/api/repos/suggested') return [TIERS.search, TIERS.read];
  // GET /api/workspace-metrics/compare — the one route in the app whose cost multiplies by the
  // number of workspaces. It runs N × getWorkspaceMetrics, each a twelve-week PR window over that
  // workspace's repos, and it takes NO narrowing parameters at all: it always compares every
  // workspace the account owns. The spend is not GitHub quota and not Anthropic — it is this
  // process's event loop and this database — which is exactly why it would otherwise have landed
  // on the 600/min blanket bucket by default and made a loop over it a self-inflicted DoS.
  // `search` is borrowed as the nearest correctly-sized 60/min bucket rather than inventing a
  // tier for a single route; the SPA only fires it while the Compare-workspaces rail line is
  // open, so 60/min is orders of magnitude above any human use.
  //
  // Its two siblings `/api/workspace-metrics` and `/api/workspace-metrics/detail` are ordinary
  // single-window reads over one workspace's repos and are deliberately left on `read` via the
  // fall-through — they do not multiply by anything. Matched as a prefix rather than an exact
  // string because no other route shares it, so over-matching costs nothing while under-matching
  // costs the bucket.
  if (path.startsWith('/api/workspace-metrics/compare')) return [TIERS.search, TIERS.read];
  // GET /api/bot-severity — the Bots ML-severity rollup. DB-only (the model is called by the
  // background worker, never on a request), but it reads a whole workspace's label corpus into
  // memory to aggregate it, capped at 50k rows, plus three unlabelled-count joins. Same shape of
  // cost as `/compare` above — this process's event loop, not GitHub quota and not Anthropic —
  // so it borrows the same 60/min `search` bucket rather than sitting on the 600/min blanket one.
  // The SPA fires it once per Bots-tab view.
  if (path.startsWith('/api/bot-severity')) return [TIERS.search, TIERS.read];
  // GET /api/bot-analytics/vendor/<key>/comments — the per-bot comments drill-down: up to 3000
  // comment BODIES per source plus a three-way ml_comment_labels join, per request. Same shape
  // of cost as the rollup above (this process, not GitHub and not Anthropic), so the same
  // 60/min bucket. Its `/prs` sibling stays on `read` DELIBERATELY — that list is PR metadata
  // only, no bodies. Anchored at both ends so the sibling cannot be swept in.
  if (!mutating && /^\/api\/bot-analytics\/vendor\/[^/]+\/comments$/.test(path)) {
    return [TIERS.search, TIERS.read];
  }
  // GET /api/bot-analytics/flagging — the "what the bots are flagging" drill-down. Per request it
  // re-runs the strip's WHOLE 50k-row label scan (the page offset is a JS slice over a fold of a
  // JSON column that no portable SQL predicate can express, so there is no cheaper page to fetch)
  // or the window's whole thread scan plus the ±3-line clustering, and then hydrates a page of
  // comment BODIES on top. Strictly more work than the vendor-comments route beside it, and an
  // IntersectionObserver fires it repeatedly as the user scrolls — so `search`, never the 600/min
  // blanket. Anchored at both ends like its neighbour: `/api/bot-analytics` itself and
  // `/api/bot-analytics/bot-only-prs` are ordinary reads and must keep falling through.
  if (!mutating && /^\/api\/bot-analytics\/flagging$/.test(path)) {
    return [TIERS.search, TIERS.read];
  }
  // GET /api/bot-analytics/volume[/prs|/scatter] — the bot-comment-volume family. Per request each
  // walks EVERY merged PR in the window (up to 5000) plus three grouped comment counts over that
  // population, then folds the whole thing in JS; the `/prs` page offset is a slice over that
  // fold, so a cursor walk re-runs the scan per page and an IntersectionObserver fires it again
  // on every scroll. Same shape of cost as its two neighbours above — this process's event loop,
  // not GitHub quota and not Anthropic — so the same 60/min bucket rather than the 600/min
  // blanket one. Anchored at BOTH ends with the sub-paths spelled out, so `/api/bot-analytics`
  // itself and `/api/bot-analytics/bot-only-prs` keep falling through to `read`.
  if (!mutating && /^\/api\/bot-analytics\/volume(\/(prs|scatter))?$/.test(path)) {
    return [TIERS.search, TIERS.read];
  }
  // GET /api/prs/<id>/ml-labels — the per-PR badge index. Two indexed reads over
  // ml_comment_labels, no model call, no GitHub. `read` is right, and it is RECORDED here rather
  // than inherited from the fall-through: it sits inside the /api/prs/<id>/ family whose other
  // members are GitHub-hydrating, so the next person to widen `prGithubGet` should have to see
  // that this one was decided, not defaulted.
  if (!mutating && /^\/api\/prs\/\d+\/ml-labels$/.test(path)) return [TIERS.read];
  // GET /api/ml-status — the enrichment worker's live state, POLLED every few seconds while a
  // sync round is open so the progress UI can represent the model pass. Its in-memory half is
  // free, but its backlog half is `/api/bot-severity`'s unlabelled-count joins repeated PER
  // WORKSPACE, so it belongs in the same 60/min `search` bucket, not the blanket read one. The
  // route caches the scan for a few seconds precisely because the tier bounds request COUNT and
  // not the work each request does — the two are complementary, neither is a substitute.
  if (path.startsWith('/api/ml-status')) return [TIERS.search, TIERS.read];
  // ---- Emoji reactions: BOTH routes reach GitHub, and NEITHER lives under /api/prs/<id>/ ----
  //
  // Spelled as two EXACT string matches, above the mutating block, for the reason this file has
  // now recorded three times: a tier that is inherited rather than decided is silently wrong,
  // and both of these would otherwise land on the 600/min blanket `read` bucket. They are NOT
  // in the `hitsGithub` alternation below because that regex is anchored to `/api/prs/\d+/` —
  // adding `reactions` there would match nothing and merely look like coverage.
  //
  //   POST /api/reactions/lookup — the batched read. A mutating VERB with GET-shaped cost (the
  //     `POST /api/prs/:id/refresh` precedent): it carries a target LIST in a body and converts
  //     1:1 into a GraphQL `nodes(ids:)` call, so it belongs on the same 60/min bucket as the
  //     other client-driven GitHub-hydrating reads. Client-side batching means one screenful of
  //     comments is ONE request, so 60/min is far above any human use — while a script looping
  //     it is exactly what drains the tenant's 5,000 points/hour.
  //   POST /api/reactions — the toggle. A GitHub write like any other: `github_write`.
  //
  // Exact matches rather than a `/api/reactions` prefix so the two cannot be swept into one
  // bucket if a third route is ever added under this family.
  if (path === '/api/reactions/lookup') return [TIERS.prDetail, TIERS.read];
  if (path === '/api/reactions') return [TIERS.githubWrite];
  // GET /api/prs/<id> plus the sub-routes that ALSO hydrate live from GitHub rather than reading
  // already-synced rows:
  //   `/merge-options`            repo merge config + mergeability + the merge-queue GraphQL probe
  //                               — up to five upstream calls, strictly MORE than the detail route
  //   `/files`                    the Changes tab's patches
  //   `/checks/<jobId>/logs`      an Actions job log: a REST call that 302s to a signed blob we
  //                               then range-fetch, so up to two upstream requests and megabytes
  //   `/suggested-reviewers`      CODEOWNERS via REST (`ghRestGetContentRaw`) + the team-history
  //                               GraphQL probe. TTL-cached per (account, repo), but a COLD cache
  //                               spends quota, and a cache that only sometimes saves you is not a
  //                               reason to sit on the blanket bucket.
  //
  // This used to be anchored to the bare id "because the sub-routes are DB-only reads" — true when
  // written, quietly false later, which left the most GitHub-expensive GETs in the PR family on the
  // 600/min blanket bucket. The earlier fix of that mistake then repeated it in miniature by
  // asserting in this very comment that `suggested-reviewers` "really is DB-only": it calls
  // `getAccessToken` on line 35 of github/reviewer-suggest.ts. When in doubt, follow the token.
  // Genuinely DB-only and correctly left on `read`: `/bot-behaviour`, `/bot-dedup`,
  // `/mention-candidates`, `/claude-review` (retrieval), `/annotations` (the cached GET).
  const prGithubGet =
    /^\/api\/prs\/\d+(\/(merge-options|files|suggested-reviewers|checks\/[^/]+\/logs))?$/;
  if (!mutating && prGithubGet.test(path)) {
    return [TIERS.prDetail, TIERS.read];
  }
  // GET /api/threads/<id> hydrates the same way.
  if (!mutating && /^\/api\/threads\/\d+$/.test(path)) return [TIERS.prDetail, TIERS.read];
  // POST /api/prs/<id>/refresh — the PrDetail live poll (~every 5s while a PR pane is
  // visible) + its manual Refresh button. A mutating VERB (POST so the cross-origin guard
  // applies) with GET-shaped cost: a quiet tick is one free conditional REST 304, a changed
  // or floor-forced one is a syncOnePr walk + a hydration bust — the same GitHub-cost
  // profile as GET /api/prs/:id, so it shares the `prDetail` bucket (the 5s cadence is
  // 12/min of the 60, leaving room for a second tab plus the user's own detail traffic).
  // NOT `githubWrite` (it writes nothing to GitHub) and NOT the blanket `read` (it can
  // spend a GraphQL walk per call) — spelled EXACTLY, per this file's twice-documented
  // failure mode of a tier inherited instead of decided.
  if (mutating && /^\/api\/prs\/\d+\/refresh$/.test(path)) {
    return [TIERS.prDetail, TIERS.read];
  }
  if (mutating && (path === '/api/repos' || /^\/api\/repos\/\d+\/sync$/.test(path))) {
    return [TIERS.sync];
  }
  if (mutating) {
    // Writes that reach GitHub: thread replies/resolves, PR and inline review comments,
    // approvals, closes, CI re-runs, reviewer requests, merges, merge-queue
    // enqueue/dequeue, auto-merge arm/disarm, branch updates, bulk bot-thread resolves.
    //
    // Every route is listed by its EXACT path segment, because the alternation is matched
    // against the real path and nothing else corrects a spelling mistake here — the failure
    // is silent. This list previously read `comments`/`reviews` (plural) while the routes are
    // `/comment` and `/review-comment`, and omitted `close`, `ci/rerun` and
    // `request-reviewers` outright, so FIVE GitHub-write routes sat on the 600/min blanket
    // `read` bucket. `review-comment` is now the most upstream-expensive write in the family:
    // it fetches the head sha and the file patches to anchor the line, posts, then resyncs the
    // PR and forces a fresh PR_DETAIL_QUERY so the new thread is visible immediately.
    //
    // `merge-queue` and `auto-merge` are spelled out even though `merge` would prefix-match
    // the first (the alternation has no trailing anchor): relying on that coincidence is how
    // a later tightening of the regex silently drops two GitHub-write routes onto the
    // 600/min read tier. `review-comment` is spelled out for the same reason rather than
    // leaning on a `reviews?` prefix. Arming auto-merge is a DB write, but disarm/arm both
    // re-check mergeability against GitHub and the watcher merges on the account's quota, so
    // it belongs in the same bucket as an explicit merge.
    //
    // Deliberately NOT here: `/dismiss` and `/mark-viewed` (pure local bookkeeping).
    const hitsGithub =
      path.startsWith('/api/threads/') ||
      path.startsWith('/api/bot-threads/') ||
      /^\/api\/prs\/\d+\/(review-comment|comments?|approve|close|ci\/rerun|request-reviewers|merge-queue|merge|auto-merge|update-branch|resolve-bot-threads|reviews)/.test(
        path,
      );
    if (hitsGithub) return [TIERS.githubWrite];
  }

  // Everything else, deliberately including the two cross-account GETs `GET /api/auto-merge`
  // (the armed-intent list) and `GET /api/branch-status` (default-branch health): both are pure
  // DB reads off already-synced rows — no GitHub call, no LLM — so the blanket 600/min backstop
  // is the right bucket. If either ever grows a live GitHub fetch it must move to
  // `search`/`prDetail` like the other hydrating reads.
  //
  // The five workspace-scoped CONTENT routes (`/api/timeline`, `/api/activity`,
  // `/api/activity/feed`, `/api/open-prs`, `/api/branch-status`) stay here too. Taking
  // `?workspace=` did not change what they cost: the resolver's membership repair
  // (`ensureRepoMemberships`, a write on essentially every GET) is a local anti-join plus an
  // `ON CONFLICT DO NOTHING` insert of at most the account's unassigned repos, which is cheaper
  // than the feed query it precedes and reaches nothing upstream.
  //
  // `GET /api/bot-reviewers` (its lazy pass classifies any actor with a footprint in the workspace
  // and no stored row) and the two `DELETE /api/bot-reviewers/:userId/{judgement,identity}` resets
  // (each re-derives in the same request) all run `classifyReviewer`, and they stay on `read`.
  //
  // ⚠ THAT USED TO BE A KNOWN COMPROMISE AND IS NOW SIMPLY CORRECT — kept written down because the
  // reasoning is what would have to be re-derived. `classifyReviewer`'s last resort for the
  // medium-confidence band was an opt-in Haiku tie-break (`review/llm.ts cheapComplete`), i.e. a
  // real LLM leg on a `read`-tier route; it was tolerated because the setting gating it defaulted
  // OFF. That code PATH NO LONGER EXISTS — the setting and the tie-break were deleted together, and
  // `sync/reviewer-classify.ts` no longer imports the LLM seam at all — so these three routes are
  // now purely DB-bound and `read` is the right bucket rather than the acceptable one. The rule
  // that produced the earlier caution still stands: FOLLOW THE TOKEN. If anything ever puts a
  // model call or a GitHub fetch back inside `classifyReviewer`, these three need a tier in the
  // SAME change — not as a follow-up.
  return [TIERS.read];
}

// ---- Storage ----
//
// One map per tier, keyed by "<tier>:<account-or-ip>". Swept on an interval so a
// churn of distinct IPs cannot grow it without bound (which would itself be the DoS
// this plugin exists to prevent). MAX_KEYS is a hard backstop: past it, the whole map
// is dropped rather than allowed to consume memory — losing a window of accounting is
// strictly better than an OOM.
const MAX_KEYS = 50_000;
const buckets = new Map<string, Bucket>();

function sweep(now: number): void {
  if (buckets.size > MAX_KEYS) {
    buckets.clear();
    return;
  }
  for (const [k, b] of buckets) {
    // Anything older than the longest window is dead regardless of tier.
    if (now - b.start > HOUR * 2) buckets.delete(k);
  }
}

/** Consume one token. Returns null when allowed, or the seconds to wait when not. */
function consume(key: string, t: Tier, now: number): number | null {
  const existing = buckets.get(key);
  if (!existing || now - existing.start >= t.windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return null;
  }
  existing.count += 1;
  if (existing.count <= t.limit) return null;
  return Math.max(1, Math.ceil((existing.start + t.windowMs - now) / 1000));
}

/**
 * The bucket key. Prefer the account id: it is the thing that spends money, it
 * survives a changing IP, and it cannot be spoofed. Fall back to the client IP for
 * unauthenticated routes (sign-in, webhooks).
 *
 * NOTE the IP fallback only works in cloud because `trustProxy` is enabled there
 * (app.ts) — Railway terminates TLS and forwards, so without it every request would
 * share the proxy's IP and collapse into one bucket. In local mode there is no proxy
 * and exactly one account, so this is always the account key in practice.
 */
function keyFor(req: FastifyRequest, t: Tier): string {
  const accountId = req.account?.id;
  return accountId != null ? `${t.name}:a${accountId}` : `${t.name}:i${req.ip}`;
}

/**
 * Registers the limiter. MUST be registered AFTER registerAccountContext so
 * `req.account` is resolved and buckets can be keyed per tenant rather than per IP.
 *
 * RATE_LIMIT_DISABLED=true turns it off entirely (an escape hatch for a first-run
 * bulk backfill, a load test, or a self-hosted single-user instance that would
 * rather not have the ceiling).
 */
export function registerRateLimit(app: FastifyInstance): void {
  if (process.env.RATE_LIMIT_DISABLED === 'true') {
    app.log.warn('rate limiting DISABLED (RATE_LIMIT_DISABLED=true)');
    return;
  }

  let lastSweep = 0;

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/')) return;
    // The health probe must never 429 — Railway uses it to decide the deploy is up.
    if (path === '/api/health') return;

    const now = Date.now();
    if (now - lastSweep > 5 * MINUTE) {
      lastSweep = now;
      sweep(now);
    }

    for (const t of tierFor(req.method.toUpperCase(), path)) {
      const retryAfter = consume(keyFor(req, t), t, now);
      if (retryAfter != null) {
        req.log.warn(
          { path, method: req.method, tier: t.name, limit: t.limit, accountId: req.account?.id },
          'rate limit exceeded',
        );
        reply.header('Retry-After', String(retryAfter));
        await reply.code(429).send({
          error: 'TooManyRequests',
          message:
            t.name === 'ai' || t.name === 'ai_hourly'
              ? `Too many AI requests (limit ${t.limit} per ${t.windowMs >= HOUR ? 'hour' : 'minute'}). Try again in ${retryAfter}s.`
              : `Too many requests (limit ${t.limit}/min). Try again in ${retryAfter}s.`,
          retryAfter,
        });
        return;
      }
    }
  });

  app.log.info(
    { mode: config.deploymentMode, ai: TIERS.ai.limit, read: TIERS.read.limit },
    'rate limiting active',
  );
}

/** Exposed for the unit test. */
export const __testing = { TIERS, tierFor, consume, buckets };
