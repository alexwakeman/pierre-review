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
  // The six surviving routes (list / create / rename+reassign / delete / move-one-repo-in /
  // PUT :id/pending-mute) are pure local database work: a membership upsert on (account_id,
  // repo_id), a rename, a re-home of repos and reviewer rows to Default, and — since the Pending
  // mute — one boolean UPDATE on `workspaces` plus a bounded delete/insert over
  // `pending_muted_repos` inside the workspace's own membership. Nothing behind any of them calls
  // GitHub and nothing behind them calls an LLM — assignment still writes ONE membership row and
  // nothing else (`repos.inbox_watch` is dropped; there is no second visibility column left to
  // set, and the mute is not one: it changes no screen's population, only whether a row may claim
  // the reader's turn), and the sync scheduler picks the repo up on its own cron rather than on
  // this request. So `read` is the same
  // answer the fall-through at the bottom of this function would give, and it is spelled out
  // anyway: the two documented mistakes in this file were both a route whose tier was never
  // decided, only inherited. An explicit line makes the next reader's question "is this still
  // true?" instead of "did anyone look?".
  //
  // Written as an exact match plus a `/`-terminated prefix, NOT a bare
  // `startsWith('/api/workspaces')` and emphatically not `startsWith('/api/workspace')`:
  // the `/api/workspace-metrics` family is a SIBLING vocabulary, and a loose prefix over two
  // sibling vocabularies is precisely how one silently swallows the other.
  if (path === '/api/workspaces' || path.startsWith('/api/workspaces/')) return [TIERS.read];

  // ---- Per-account settings writes: `read`, RECORDED rather than inherited ----
  //
  // POST /api/me/large-pr-threshold — the large-PR flag's code-churn threshold. One schema-
  // validated UPDATE of one integer column on one row. No GitHub call, no model call, no fold:
  // following the token, there is no token. `read` is the same answer the fall-through at the
  // bottom of this function would give, and it is spelled out anyway for this file's stated
  // reason — the two documented mistakes here were both a route whose tier was never decided,
  // only inherited. Its sibling POST /api/me/benchmark-consent still takes the fall-through
  // because it DOES have a leg worth thinking about (a fire-and-forget rollup on opt-in), and
  // pinning it here would hide that.
  //
  // EXACT `===`. `/api/me` is a family with an export, an account deletion and a data-subject
  // GET in it, so a `startsWith('/api/me/')` would sweep all of them into one bucket — and a
  // `startsWith('/api/me')` is worse still: it ALSO matches `/api/mention-candidates`, a live
  // sibling vocabulary. That is this file's recorded near-miss failure, one character away.
  if (path === '/api/me/large-pr-threshold') return [TIERS.read];

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
  //                               flag, PLUS the "By workspace" axis (C4): 2 windows ×
  //                               N workspaces × getPeriodMetrics — the one cost in the family
  //                               that MULTIPLIES by workspace count, which is the exact shape
  //                               that put the deleted /api/workspace-metrics/compare on the
  //                               60/min `search` bucket. Same tier here, same reason. Still DB
  //                               only — it must NEVER grow a generation leg (the
  //                               `GET /api/pro/prs/:id/annotations` precedent).
  // Anchored on the exact family prefix so no sibling `/api/pro/insights/*` route is swept in.
  if (path === '/api/pro/insights/reports' || path.startsWith('/api/pro/insights/reports/')) {
    if (mutating && (path.endsWith('/generate') || path.endsWith('/chat'))) {
      return [TIERS.ai, TIERS.aiHourly];
    }
    // The one-report GET carries the by-workspace axis (N × getPeriodMetrics per window) —
    // `search`, not the 600/min blanket. Anchored at both ends so ONLY `…/reports/:periodKey`
    // matches: the list root and a GET spelling of `…/generate` stay on the plain read bucket.
    if (/^\/api\/pro\/insights\/reports\/[^/]+$/.test(path)) return [TIERS.search, TIERS.read];
    return [TIERS.read];
  }

  // GET /api/pro/insights/month-to-date — the OPEN calendar month, computed live on every read
  // (Reports → Month grain). DECIDED, not inherited: it does NOT match the `…/insights/reports`
  // family block above, so without this line it would fall through to the `/api/pro/` catch-all's
  // GET→`read` branch and sit on the 600/min blanket bucket. It costs SIX indexed scans per call
  // — the headline metric vector, two `repos.createdAt` coverage reads, the lane breakdown, and
  // both sides of the elapsed-slice comparison — which is the one-report GET's shape of cost, on a
  // surface the SPA re-reads whenever the pane regains focus (an open period's figures move, so
  // there is nothing to cache for long). Same 60/min `search` bucket, same argument. It NEVER
  // generates and NEVER writes a row, so it must never move to the AI tier either.
  if (!mutating && path === '/api/pro/insights/month-to-date') {
    return [TIERS.search, TIERS.read];
  }

  // ---- 1:1 prep (must sit ABOVE the /api/pro/ AI-tier catch-all) ----
  // GET /api/pro/insights/person/:userId — the person-period vector (plan P4.2). DECIDED, not
  // inherited from the catch-all's GET→read branch: per request it runs the lane resolver, the
  // one-fold first-human-review scan and the request→review scan (two capped candidate walks)
  // plus ~10 person-scoped aggregates — the reports-GET shape of cost (this event loop and this
  // database, no GitHub, no Anthropic), so it borrows the same 60/min `search` bucket rather
  // than the 600/min blanket. Fired once per 1:1 section mount / period switch. The narration
  // POST is NOT here — it rides the /api/pro/synthesis pair above (kind 'person'). The
  // `?evidence=1` variant (the People report) is the same event-loop shape — ~8 additional
  // capped `ORDER BY … LIMIT` selects on the same fold — so it sits on the same tier.
  if (!mutating && path.startsWith('/api/pro/insights/person/')) {
    return [TIERS.search, TIERS.read];
  }

  // GET /api/bot-authoring — the authoring-automation vector, the bot-shaped twin of the person
  // route above and DECIDED for the identical reason: it runs the lane resolver, a capped
  // merged-PR walk (AUTOMATION_MERGED_PR_CAP) whose ids then travel as bind parameters into two
  // more scans, plus ~6 windowed aggregates. It is CORE and free, so it never reaches the
  // /api/pro/ AI catch-all — without this line it would silently inherit the 600/min blanket
  // `read` bucket, which is the wrong answer for a fold this size (the "follow the token" rule:
  // 'DB-only' is not the same as 'cheap').
  if (!mutating && path === '/api/bot-authoring') return [TIERS.search, TIERS.read];

  // ---- Bot behaviour depth (must sit ABOVE the /api/pro/ AI-tier catch-all) ----
  // GET /api/pro/bot-behaviour — the workspace behaviour rollup, MOVED from core's
  // /api/bot-behaviour behind the `botDepth` entitlement (plan P0.2). DECIDED, not inherited from
  // the /api/pro/ catch-all's GET→read branch: per request it computes every bot's TTFR /
  // follow-up / week×hour heatmap plus trends, anomalies, overlap and the ML label fold over the
  // whole window — the same shape of cost as the flagging/volume family
  // beside it (this process's event loop and this database, not GitHub quota and not Anthropic),
  // so it borrows the same 60/min `search` bucket rather than the 600/min blanket one. (In core
  // it sat on the blanket `read` fall-through — that was the inherited tier this file warns
  // about, corrected in the move.) The SPA fires it once per Bots view on the 5-min sync cadence.
  if (!mutating && path === '/api/pro/bot-behaviour') return [TIERS.search, TIERS.read];

  // ---- The peer-cohort benchmark (must sit ABOVE the /api/pro/ AI-tier catch-all) ----
  // GET /api/pro/bot-benchmark — the plugin's projection of the bundled distribution artifact.
  //
  // FOLLOWING THE TOKEN, NOT THE SENTENCE. "This route is DB-only" is not even true in the
  // reassuring direction here: it touches no database, no GitHub and no Anthropic, which makes the
  // naive read "it is free, put it on the 600/min blanket". It is not free, and the cost sits
  // somewhere unusual — THE RESPONSE BODY IS THE WORK. MEASURED against today's corpus: the
  // manifest alone is 16 KB, a 24-cell request of refused cells is 44 KB, and a FITTED cell is
  // ~10 KB, so a capped request at full panel size is ~260 KB of JSON.stringify on the event loop
  // and straight onto the socket (no @fastify/compress is registered in this backend, so the JSON
  // size IS the wire size for whatever the edge does not gzip). At 600/min that is ~150 MB/min
  // from one account; at 60/min it is 15 MB/min — the same order as the flagging/volume/behaviour
  // reads beside it, and the same shape of cost, so the same bucket by the identical argument.
  //
  // The CELL CAP bounds the work per request; this tier bounds the request count. Complementary,
  // neither a substitute — and the cap is part of THIS decision, not a separate nicety: without
  // it a single request can name every cell in the artifact and the arithmetic above is wrong by
  // an order of magnitude.
  //
  // EXACT `===`, never a prefix. The family has one member and must keep one: a `startsWith`
  // on `/api/pro/bot-b…` is one sibling away from swallowing `/api/pro/bot-behaviour`, which is
  // the near-miss failure this file has already recorded three times.
  //
  // ⚠ STANDING INVARIANT, WRITTEN BEFORE THE FOLD EXISTS: if this route ever grows a customer-side
  // PLACEMENT leg (a per-repo × vendor read of the tenant's own PRs), the tier must be re-decided
  // IN THAT SAME CHANGE. `/api/attention` moved its tier only after the fold had landed.
  //
  // THE FOLD LANDED, AND IT LANDED AS A SIBLING PATH RATHER THAN A LEG — so the invariant is
  // honoured by the line BELOW, decided here, in the same change. Both stay EXACT `===` matches
  // (see the near-miss note above); an `===` on the parent cannot swallow the child, and a
  // `startsWith` on either would be one sibling away from the failure this file has recorded three
  // times.
  if (!mutating && path === '/api/pro/bot-benchmark') return [TIERS.search, TIERS.read];

  // GET /api/pro/bot-benchmark/placement — the CUSTOMER side: the caller's own (repository ×
  // vendor) metric vector, folded over the corpus's populations, placed in an activity band and
  // compared against the cell.
  //
  // FOLLOWING THE TOKEN. Its parent route's cost is its RESPONSE BODY; this one's cost is a
  // DATABASE FOLD, and the two arguments are unrelated — which is exactly why the tier is spelled
  // separately instead of being read across from the line above. Per request it reads, for up to
  // BOT_BENCHMARK_MAX_PLACEMENT_REPOS (12) repositories: one windowed merged-PR count, up to
  // `walk_budget` (≤150) pull-request rows, and every review thread, review comment, PR comment
  // and review body hanging off them — then folds thirteen metrics per (repository × automated
  // reviewer) pair. That is the same shape of cost as the flagging/volume/bot-behaviour family
  // beside it (this process's event loop and this database, not GitHub quota and not Anthropic),
  // so it takes the same 60/min `search` bucket by the identical argument, and emphatically NOT
  // the `/api/pro/` catch-all's 600/min GET→read branch, which is what it would silently inherit.
  //
  // The REPOSITORY CAP bounds the work per request; this tier bounds the request count.
  // Complementary, neither a substitute — and the cap is part of THIS decision, not a separate
  // nicety: without it one request folds an entire workspace and the arithmetic above is wrong by
  // whatever a tenant's repository count happens to be.
  //
  // It must NEVER grow a GENERATION leg (the `GET /api/pro/prs/:id/annotations` precedent) — there
  // is no model anywhere in this feature and its anomaly sentences are templated.
  if (!mutating && path === '/api/pro/bot-benchmark/placement') {
    return [TIERS.search, TIERS.read];
  }

  // ---- Synthesis (must sit ABOVE the /api/pro/ AI-tier catch-all) ----
  // ONE endpoint, two verbs, two costs (plan P2.1):
  //   POST /api/pro/synthesis  the generate path — one Haiku call behind a payload-hash $0 cache,
  //                            plus the input fold below. The catch-all's `generates` branch
  //                            would land it on `ai` anyway; spelled here so the family's two
  //                            tiers are DECIDED together (this file's failure mode is a tier
  //                            nobody re-examined).
  //   GET  /api/pro/synthesis  the free cached read — but it recomputes the payload hash from
  //                            `getSynthesisInput`, i.e. it re-runs the drill-down's own
  //                            population fold (the flagging kind's ≤50k-row label scan, the
  //                            volume kind's merged-PR walk). That is the flagging/volume/
  //                            bot-behaviour shape of cost — this process's event loop and this
  //                            database, not GitHub and not Anthropic — so it borrows the same
  //                            60/min `search` bucket, NOT the catch-all's 600/min GET→read
  //                            branch. It must NEVER grow a generation leg (the
  //                            `GET /api/pro/prs/:id/annotations` precedent).
  if (path === '/api/pro/synthesis') {
    if (mutating) return [TIERS.ai, TIERS.aiHourly];
    return [TIERS.search, TIERS.read];
  }

  // ---- The work plan (must sit ABOVE the /api/pro/ AI-tier catch-all) ----
  // ONE endpoint, two verbs, two costs — the synthesis shape exactly, and tiered by copying it:
  //   POST /api/pro/work-plan  the generate path — one Haiku call behind a payload-hash $0 cache,
  //                            plus the evidence fold below. The catch-all's `generates` branch
  //                            would land it on `ai` anyway; spelled here so the family's two
  //                            tiers are DECIDED together (this file's failure mode is a tier
  //                            nobody re-examined).
  //   GET  /api/pro/work-plan  the free cached read — but it re-runs the whole `getWorkPlan`
  //                            evidence fold to recompute the payload hash for the `stale` probe,
  //                            and that fold reaches getWorkspaceInsights (the stalled-review /
  //                            untouched-thread / reviewer-load / merge / update_branch cards).
  //                            That is the synthesis / bot-behaviour shape of cost — this
  //                            process's event loop and this database, not GitHub quota and not
  //                            Anthropic — so it takes the same 60/min `search` bucket, NOT the
  //                            catch-all's 600/min GET→read branch. The narration now decorates
  //                            the Pending board, so this GET fires whenever that board is
  //                            mounted. It must NEVER grow a generation leg (the
  //                            `GET /api/pro/prs/:id/annotations` precedent).
  if (path === '/api/pro/work-plan') {
    if (mutating) return [TIERS.ai, TIERS.aiHourly];
    return [TIERS.search, TIERS.read];
  }

  // ---- The Slack digest family (must sit ABOVE the /api/pro/ AI-tier catch-all) ----
  // TWO paths under one prefix with OPPOSITE costs, which is exactly the shape the catch-all gets
  // wrong: it tiers on the VERB, so both of these are mutating and both would land on the 20/min
  // `ai` bucket — right for one of them and wrong for the other.
  //
  //   PUT/DELETE
  //   /api/pro/slack/target       ONE workspace's delivery config (plugin 0030; narrowed to a
  //                               single workspace when the picker was removed). A `?workspace=`
  //                               resolution plus ONE upsert or ONE delete on one small table. No
  //                               model, no GitHub: following the token, there is no token.
  //                               `read`, decided — it is a SETTINGS WRITE, and the file already
  //                               records that a settings write is a settings write at every depth
  //                               (the `/api/pro/settings/workspace` note below). ⚠ THE PATH IS
  //                               SINGULAR NOW. The plural `/targets` is DELETED; a stale client
  //                               calling it 404s, which is the catch-all's problem, not a tier's.
  //   POST /api/pro/slack/test    "Send test" — and it is NOT a probe. It runs the SAME billed
  //                               path the cron does: `refreshSprintReport` (one Haiku call unless
  //                               the payload hash is unchanged) plus the account-wide repo-digest
  //                               refresh, then an outbound POST to a user-supplied host. It stays
  //                               on `ai` + `aiHourly` — where the catch-all would have put it
  //                               anyway, spelled here so the family's two tiers are DECIDED
  //                               together rather than one of them being inherited. ⚠ It takes ONE
  //                               `?workspace=` and must never fan out over the whole selection: a
  //                               test button that generated twelve reports would be the most
  //                               expensive control in the app.
  //
  // Anchored on exact paths. A `startsWith('/api/pro/slack')` would be one sibling away from
  // swallowing whatever this family grows next — the near-miss failure this file has recorded
  // three times.
  if (path === '/api/pro/slack/target') return [TIERS.read];
  if (mutating && path === '/api/pro/slack/test') return [TIERS.ai, TIERS.aiHourly];

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
    // ⚠ THE SETTINGS EXEMPTIONS ARE A LIST, NOT A SUFFIX. `endsWith('/settings')` covered
    // `PUT /api/pro/settings` and nothing beneath it, so `PUT /api/pro/settings/workspace` — the
    // per-workspace sprint cadence, one DB upsert, no model and no GitHub quota — would have landed
    // on the 20/min AI bucket purely because of where its path sits. A settings write is a settings
    // write at every depth; the "follow the token" rule cuts BOTH ways.
    const isSettingsWrite =
      path === '/api/pro/settings' || path.startsWith('/api/pro/settings/');
    const generates =
      mutating &&
      !path.endsWith('/cancel') &&
      !path.endsWith('/key') &&
      !path.endsWith('/budget') &&
      !isSettingsWrite;
    if (generates) return [TIERS.ai, TIERS.aiHourly];
    return [TIERS.read];
  }

  // ---- GitHub-quota spenders ----
  if (path.startsWith('/api/repos/search')) return [TIERS.search, TIERS.read];
  if (path === '/api/repos/suggested') return [TIERS.search, TIERS.read];
  // (GET /api/workspace-metrics/compare — the old N × getWorkspaceMetrics comparison whose cost
  // multiplied by workspace count, which is what earned it the `search` tier — was DELETED with
  // the Compare rail entry (C4). The multiplication survives in the Reports "By workspace" axis,
  // which is why `GET /api/pro/insights/reports/:periodKey` sits on `search` in the family block
  // above. Its two siblings `/api/workspace-metrics` and `/api/workspace-metrics/detail` remain
  // ordinary single-window reads on the `read` fall-through — they do not multiply by anything.)
  // (GET /api/bot-severity — the standalone ML-severity rollup — was REMOVED on the C7 cut list;
  // its `search` tier entry left with it.)
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
  // free, but its backlog half is a bot-set resolve plus three unlabelled-count joins PER
  // WORKSPACE, so it belongs in the same 60/min `search` bucket, not the blanket read one. The
  // route caches the scan for a few seconds precisely because the tier bounds request COUNT and
  // not the work each request does — the two are complementary, neither is a substitute.
  if (path.startsWith('/api/ml-status')) return [TIERS.search, TIERS.read];
  // GET /api/daily-brief — the free counts strip (plan P3.1/P3.3). No GitHub, no LLM, but one
  // call folds the consolidated feed + the insights cards + the resolve backlog, and `?rollup=1`
  // multiplies that by the account's workspace count — the compare-route cost shape, so the same
  // DELIBERATE 60/min `search` bucket rather than the 600/min blanket. The route's 5-min TTL
  // cache bounds the work per request; the tier bounds request COUNT — complementary, neither a
  // substitute (the ml-status rationale verbatim).
  if (!mutating && path.startsWith('/api/daily-brief')) return [TIERS.search, TIERS.read];
  // GET /api/attention — the Pending board. RE-TIERED off the 600/min blanket `read` when it
  // absorbed the ranked head: one request now runs `getWorkspaceInsights` (including the
  // maintained-repo resolution, which the merge-card emitter makes effectively unconditional)
  // AND `rankWorkPlan` on top of it — the approvals fold, the untouched-thread group-by and a
  // narrow PR select. Same cost shape as the daily brief above, same 60/min bucket.
  // ⚠ "This route is DB-only" is exactly the sentence this file exists to distrust: the fold
  // moved into it, so the tier moves with it. The board mounts on navigation and refetches on a
  // 5-minute cadence, so request COUNT is genuinely bounded and 60/min is comfortable.
  if (!mutating && path === '/api/attention') return [TIERS.search, TIERS.read];
  // POST /api/attention/liveness — the board's batched GitHub sweep. The sibling GET above is
  // DB-only; this one is not, and the tier follows the TOKEN, not the URL family. One call is two
  // `nodes(ids:)` GraphQL requests (measured 2 points, ~7s wall for a 90-PR board), so it is
  // exactly the `POST /api/reactions/lookup` shape — a mutating VERB carrying a target LIST with a
  // GET's cost — and takes the same 60/min `prDetail` bucket the other client-driven
  // GitHub-hydrating reads do. The SPA sweeps on mount, on focus and on a 60s interval, which is
  // ~2/min: 60 leaves room for several tabs while a script in a loop hits the wall in seconds.
  //
  // Spelled as an EXACT match, ABOVE the `if (mutating)` block, for the reason this file has now
  // recorded four times: it would otherwise fall through to the 600/min blanket `read` bucket,
  // and it is NOT in the `hitsGithub` alternation below because that regex is anchored to
  // `/api/prs/\d+/` — adding `liveness` there would match nothing and merely look like coverage.
  // (`githubWrite` would also be the wrong bucket regardless: this route writes nothing to
  // GitHub, it reads.)
  if (mutating && path === '/api/attention/liveness') return [TIERS.prDetail, TIERS.read];
  // GET /api/flow-findings — the Chronology tab (PAID `periodReports`, deterministic, no model and
  // no GitHub — the route 402s before it touches the DB). The TIER is unaffected by that gate and
  // must stay where it is: an entitled account still runs the whole fold, and the tier answers
  // "what does one accepted request cost", never "who may make it". DECIDED, not inherited: "this
  // route is DB-only" is the sentence this file exists to distrust, and one call here runs the
  // lane resolver, the shared first-human-review fold (two
  // capped candidate walks), a thread-path scan, an in-window review scan, a merged-PR walk plus
  // its approving reviews, an open-PR snapshot with the approvals fold, and the round-trip
  // comment join. That is strictly the daily-brief / attention shape of cost — this event loop
  // and this database — so it takes the same 60/min `search` bucket rather than the 600/min
  // blanket. The tab mounts on navigation and refetches on the sync cadence, so request COUNT is
  // genuinely bounded; the engine's own scan caps bound the work per request. Complementary,
  // neither a substitute.
  if (!mutating && path === '/api/flow-findings') return [TIERS.search, TIERS.read];
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
