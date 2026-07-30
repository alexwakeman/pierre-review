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

  // ---- AI generation ----
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

  // Everything else, deliberately including the two new cross-account GETs
  // `GET /api/auto-merge` (the armed-intent list) and `GET /api/branch-status` (default-branch
  // health): both are pure DB reads off already-synced rows — no GitHub call, no LLM — so the
  // blanket 600/min backstop is the right bucket. If either ever grows a live GitHub fetch it
  // must move to `search`/`prDetail` like the other hydrating reads.
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
