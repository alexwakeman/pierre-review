import type { FastifyInstance } from 'fastify';
import type {
  BotAnalyticsResponse,
  BotBehaviourResponse,
  BotOnlyPrsResponse,
  ResolvableThreadPrsResponse,
  BotVendorPrsResponse,
  BotWindowKind,
  DetectedReviewersResponse,
  ResolveBotThreadsResult,
  ReviewerCostBody,
  ReviewerIdentity,
  ReviewerIdentityBody,
  RepoReviewerJudgementBody,
  ScopeResolveBotThreadsBody,
} from '@pierre-review/shared';
import {
  getBotAnalytics,
  getBotBehaviourAnalytics,
  getBotOnlyPrs,
  getBotVendorPrs,
  getBotDedupClusters,
  getResolvableBotThreadPrs,
  getResolvableBotThreadsForScope,
  listDetectedReviewers,
  resetRepoReviewerJudgement,
  resetReviewerIdentity,
  resolveScopeRepoIds,
  setRepoReviewerJudgement,
  setReviewerCost,
  setReviewerIdentity,
  SCOPE_RESOLVE_THREAD_CAP,
} from '../../db/queries.js';
import { resolveThreadsOnGitHub } from '../../bot-triage/resolve.js';
import { accountIdOf } from '../plugins/auth.js';

// Parse a comma-separated id list into a positive-int array, or null when empty/absent (so
// the query layer treats it as "all repos"). Mirrors the parser in activity.ts.
function parseIntList(raw?: string): number[] | null {
  if (raw == null || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

// ── THE WRITE SURFACE IS SPLIT BY KEY, MIRRORING THE READ SHAPE ─────────────────────────────
// THREE routes at TWO grains, and the grain of each is the thing to hold onto:
//
//   PATCH /api/bot-reviewers/:userId          RepoReviewerJudgementBody   per (repo, actor)
//   PATCH /api/bot-reviewers/:userId/identity ReviewerIdentityBody        per actor
//   PUT   /api/bot-reviewers/:userId/cost     ReviewerCostBody            per actor
//
// …and TWO RESETS, one per grain, which mirror the first two exactly:
//
//   DELETE /api/bot-reviewers/:userId/judgement?repoId=  back to auto, ONE repo
//   DELETE /api/bot-reviewers/:userId/identity           back to auto, the actor EVERYWHERE
//
// ⚠ THE RESETS ARE NOT OPTIONAL POLISH. A manual write pins the row against re-derivation, and
// flipping the value back by hand leaves it just as pinned — so without a way back to auto, every
// edit here is permanent. That is also what makes the role-only patch's `source: 'manual'` stamp
// (which pins `automated` for that repo as a side effect) the right trade rather than a trap: the
// pin is visible AND undoable in the same place. `RepoReviewer.isManualOverride` and
// `ReviewerIdentity.identitySource` exist to drive exactly these two affordances.
//
// ⚠ DO NOT MERGE THEM BACK INTO ONE BODY WITH A `repoId`. That was the predecessor: identity was
// WRITTEN per repo and READ per actor, so clicking "Not a bot" on ONE repo nulled the kind, that
// row was the most recently updated, identity resolution reported kind=null account-wide, and
// CodeRabbit lost its brand colour and vendor name on the repos the user never touched — with no
// surface anywhere to undo it. A most-recently-updated tie-break picks a winner but cannot make
// the losing rows editable or even visible. Two small bodies keyed differently make the whole
// class unrepresentable, and the SEPARATION IS ENFORCED IN THE HANDLERS (each calls exactly one
// query-layer function, and each of those writes exactly one table), not merely documented.

// PATCH /api/bot-reviewers/:userId — the per-repo JUDGEMENT.
//
// `repoId` is REQUIRED: the row IS the object, so a judgement with no repo has no row to land on.
// It rides in the BODY rather than the query string because it is part of the row's identity. The
// query layer verifies the repo belongs to the caller and 404s otherwise (the composite FK
// `(repo_id, account_id) → repos(id, account_id)` would also reject it, but a constraint
// violation is a 500 and this must be a 404).
//
// `role` IS a closed 2-value set, so it is enumerated (an unknown role would land in a NOT NULL
// column the metric split branches on). Both fields are OPTIONAL — absent means "leave the stored
// value alone", so an old client that only knows `automated` cannot silently un-mark a quality
// check — but the handler rejects a body carrying NEITHER (there would be nothing to write).
//
// ⚠ THERE IS NO `kind` / `label` / `costMonthlyUsd` HERE, and `additionalProperties:false` is not
// what keeps them out — Fastify's ajv runs with `removeAdditional:true`, so unknown keys are
// STRIPPED, not rejected. What keeps them out is that the handler calls
// `setRepoReviewerJudgement`, which issues no statement against `account_reviewers` at all.
const judgementSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['repoId'],
    properties: {
      repoId: { type: 'integer', minimum: 1 },
      automated: { type: 'boolean' },
      role: { type: 'string', enum: ['review', 'quality_check'] },
    },
  },
};

// PATCH /api/bot-reviewers/:userId/identity — WHO this actor is, account-wide. NO `repoId`.
//
// `kind` is left an open nullable string rather than an enum: AutomatedReviewerKind lives in the
// types-only shared package the backend cannot import at runtime, and the query layer coerces an
// unknown kind to a sensible default, so pinning the vendor list here would only add drift.
// Both fields accept null — that is "clear it" (still a human statement, so `identity_source`
// still becomes 'manual', or the next classification pass reinstates the kind the user rejected).
const identitySchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: ['string', 'null'] },
      label: { type: ['string', 'null'] },
    },
  },
};

// DELETE /api/bot-reviewers/:userId/judgement?repoId= — return ONE repo row to auto.
//
// `repoId` rides in the QUERY STRING rather than a body: a DELETE body is stripped by enough
// intermediaries (and by some fetch implementations) that it is not a place to put a required
// field. It is required for the same reason it is required on the PATCH — the row is the object,
// and a reset with no repo has no row to land on. Blast radius: ONE repo, which is why this and
// the identity reset below are separate routes rather than one with an optional `repoId`.
const judgementResetSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['repoId'],
    properties: { repoId: { type: 'integer', minimum: 1 } },
  },
};

// DELETE /api/bot-reviewers/:userId/identity — return the ACTOR's identity to auto. NO `repoId`
// and no query string at all: identity is a singleton per actor, so there is nothing to scope.
const identityResetSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
};

// PUT /api/bot-reviewers/:userId/cost — what this actor costs, account-wide.
//
// `monthlyUsd` is REQUIRED and NULLABLE precisely so `undefined` is not a third meaning: a number
// sets the price (0 is real — "we pay nothing"), null clears it.
//
// ⚠ THE BOUNDS ARE NOT COSMETIC. Storage is int4 CENTS in both dialects, and 21474836.47 is where
// the dialects STOP AGREEING: Postgres RAISES `integer out of range` (a 500) above it while
// SQLite's 64-bit integers accept the value happily — so an unbounded field means the same
// request succeeds locally and 500s in cloud, leaving a number cloud can never represent.
// (Measured: monthlyUsd 99999999999 stored 2147483647 on pg and 9999999999900 on sqlite.) ajv
// 400s out-of-range here; the query layer ALSO clamps, as the backstop for every other caller.
//
// `multipleOf: 0.01` rejects a fractional-cent price like $1.005, which nothing downstream can
// print and which the two rounding paths were measured disagreeing about. (Non-finite values
// cannot survive JSON.parse, and `type: number` rejects them anyway.)
const costSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['monthlyUsd'],
    properties: {
      monthlyUsd: {
        type: ['number', 'null'],
        minimum: 0,
        maximum: 21474836.47,
        multipleOf: 0.01,
      },
    },
  },
};

// GET /api/bot-reviewers?scope=&repoIds= — the bot listing, at both grains. The repo scope
// resolves exactly as the analytics routes do (an explicit `repoIds` wins over `scope`); absent
// = every repo the account watches.
//
// It replaced a `teamId` + opt-in `scoped` pair whose whole design existed to work around the
// team grain (key 0 was both "the No-team scope" and "the inheritance root", so narrowing it
// would have blinded four production callers). Under the repo grain a scope is just a set of
// repos, and the response echoes the ids it covered.
const listReviewersSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: { type: 'string' },
      repoIds: { type: 'string' },
    },
  },
};

// GET /api/bot-analytics?window= — the window is a closed 4-value set, safe to enum + default.
const analyticsSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      window: {
        type: 'string',
        enum: ['rolling_7', 'rolling_14', 'rolling_30', 'sprint'],
        default: 'rolling_14',
      },
      // Team scope: 'all' | 'none' | '<teamId>' (see resolveScopeRepoIds). Absent = all.
      scope: { type: 'string' },
      // Explicit repo scope (comma-separated ids) — the per-repo Bots tab. When present it
      // WINS over `scope` (a specific repo is the more specific selection).
      repoIds: { type: 'string' },
    },
  },
};

// GET /api/bot-analytics/vendor/:key/prs?window= — per-REVIEWER PR drill-down. `key` is the
// analytics-row identity: `u<userId>` (a single reviewer) or the 'pierre' sentinel; the handler
// parses it (anything else → 400). The window reuses the same closed enum/default as /api/bot-analytics.
const vendorPrsSchema = {
  params: {
    type: 'object',
    required: ['key'],
    properties: { key: { type: 'string' } },
  },
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      window: {
        type: 'string',
        enum: ['rolling_7', 'rolling_14', 'rolling_30', 'sprint'],
        default: 'rolling_14',
      },
      scope: { type: 'string' },
      repoIds: { type: 'string' },
    },
  },
};

const prIdParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

// GET /api/bot-threads/resolvable?scope=&repoIds= — the scope-wide review list. Same
// scope/repoIds resolution as the analytics routes (an explicit `repoIds` wins over `scope`).
const resolvableSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: { type: 'string' },
      repoIds: { type: 'string' },
    },
  },
};

// POST /api/bot-threads/resolve — the confirm-gated scope-wide resolve. `threadIds` is the
// explicit reviewed list (required, non-empty allowed to be [] → no-op), capped at
// SCOPE_RESOLVE_THREAD_CAP per request (the client chunks a larger selection); `repoIds` is the
// optional scope the server re-derives eligibility against. maxItems is a hard input guard.
const scopeResolveSchema = {
  body: {
    type: 'object',
    required: ['threadIds'],
    additionalProperties: false,
    properties: {
      threadIds: {
        type: 'array',
        items: { type: 'integer' },
        maxItems: SCOPE_RESOLVE_THREAD_CAP,
      },
      // Bounded like threadIds — an account has ≤100 repos, so 500 is generous headroom; an
      // unbounded array would only ever be a hand-crafted request heading for a DB error.
      repoIds: { type: 'array', items: { type: 'integer' }, maxItems: SCOPE_RESOLVE_THREAD_CAP },
    },
  },
};

// Bot-triage platform routes (CORE, always registered). Detection/override, ROI analytics,
// per-PR cross-bot dedup, and the confirm-gated scope-wide bot-thread resolve. Every handler is
// account-scoped via accountIdOf(req); id-addressed reads/writes verify ownership → 404. No AI.
export async function botTriageRoutes(app: FastifyInstance): Promise<void> {
  // The bot listing at BOTH grains: one `rows` entry per (repo, actor) with a footprint in the
  // scoped repos, one `reviewers` entry per distinct actor. Powers the Settings "Review bots"
  // table. ⚠ A vendor on six repos is SIX rows sharing ONE identity — that is the intended
  // display, not a duplicate to collapse.
  app.get('/api/bot-reviewers', { schema: listReviewersSchema }, async (req) => {
    const { scope, repoIds } = req.query as { scope?: string; repoIds?: string };
    const accountId = accountIdOf(req);
    // An explicit repoIds list (the per-repo Bots tab) wins over the team scope — same resolution
    // as every analytics route below, so one selection cannot mean two things.
    const explicit = parseIntList(repoIds);
    const scopeRepoIds = explicit ?? (scope ? await resolveScopeRepoIds(accountId, scope) : null);
    const resp: DetectedReviewersResponse = await listDetectedReviewers(accountId, scopeRepoIds);
    return resp;
  });

  // ── PER-REPO JUDGEMENT ────────────────────────────────────────────────────────────────────
  // Force a reviewer automated, or back to human, IN ONE REPO; and/or set its role there. Upserts
  // a `source='manual'` row the auto resolver never re-derives — for that repo only, so the same
  // actor keeps updating automatically everywhere else.
  //
  // ⚠ IT WRITES NOTHING AT THE ACTOR GRAIN. No kind, no label, no price. That is what stops "Not
  // a bot on web" from blanking CodeRabbit's brand colour on api and infra.
  //
  // 404 covers an unknown user id, an unknown/foreign repo id, AND an actor with no footprint in
  // that repo — deliberately the same status for all three: distinguishing them would turn this
  // route into an existence oracle over another tenant's repo ids and over the GLOBAL users table.
  app.patch('/api/bot-reviewers/:userId', { schema: judgementSchema }, async (req, reply) => {
    const { userId } = req.params as { userId: number };
    const body = req.body as RepoReviewerJudgementBody;
    // An opinion-free patch is a client bug, not a no-op worth a 200: with neither field there is
    // nothing to write, and writing a `source='manual'` row anyway would freeze auto-detection
    // for that repo on the strength of an empty request.
    if (body.automated === undefined && body.role === undefined) {
      reply.status(400);
      return {
        error: 'BadRequest',
        message: 'Patch must carry `automated` and/or `role`',
      };
    }
    const classification = await setRepoReviewerJudgement(accountIdOf(req), userId, body);
    if (!classification) {
      reply.status(404);
      return { error: 'NotFound', message: `Reviewer ${userId} not found in repo ${body.repoId}` };
    }
    return classification;
  });

  // ── PER-REPO JUDGEMENT — RESET ────────────────────────────────────────────────────────────
  // Return ONE repo row to auto: delete the stored judgement so the next classification pass
  // re-derives it from scratch (the listing recreates a pair with no row — see
  // resetRepoReviewerJudgement for why deleting is the right form and what happens when the
  // actor has no footprint left there).
  //
  // ⚠ BLAST RADIUS: ONE REPO. It is the undo for the button on one row, and the UI offers it only
  // where `isManualOverride` is true — a control that resets an already-auto row would appear to
  // do nothing.
  //
  // ⚠ IT TOUCHES NEITHER THE ACTOR'S IDENTITY NOR ITS PRICE. Different table, no statement.
  //
  // Same 404 rule as the PATCH twin, and the same reason: one status for unknown user / unknown
  // or foreign repo / no row to reset, so it is never an existence oracle.
  app.delete(
    '/api/bot-reviewers/:userId/judgement',
    { schema: judgementResetSchema },
    async (req, reply) => {
      const { userId } = req.params as { userId: number };
      const { repoId } = req.query as { repoId: number };
      const ok = await resetRepoReviewerJudgement(accountIdOf(req), userId, repoId);
      if (!ok) {
        reply.status(404);
        return {
          error: 'NotFound',
          message: `No stored judgement for reviewer ${userId} in repo ${repoId}`,
        };
      }
      // 204: the row is GONE, so there is nothing to echo. The client refetches the listing,
      // which is where the re-derived row appears.
      reply.status(204);
      return null;
    },
  );

  // ── ACTOR IDENTITY ────────────────────────────────────────────────────────────────────────
  // WHO this actor is, account-wide: vendor `kind` and display `label`, stamping
  // `identity_source: 'manual'` so the classifier leaves them alone.
  //
  // ⚠ IT WRITES NOTHING AT THE REPO GRAIN — no `automated`, `role`, `source`, `confidence` or
  // `reasons`. Naming a vendor is not a judgement about how it behaves in any given repo, and
  // stamping the row-level `source` from here would freeze auto-classification on every one of
  // that actor's repos.
  //
  // 404 when the actor has no `repo_reviewers` row anywhere in the account. The storage would
  // happily take the write (the two tables are keyed independently) — and the listing is
  // row-driven, so the result would be an identity nothing could ever display, edit or clear.
  app.patch(
    '/api/bot-reviewers/:userId/identity',
    { schema: identitySchema },
    async (req, reply) => {
      const { userId } = req.params as { userId: number };
      const body = req.body as ReviewerIdentityBody;
      if (body.kind === undefined && body.label === undefined) {
        reply.status(400);
        return { error: 'BadRequest', message: 'Patch must carry `kind` and/or `label`' };
      }
      const identity = await setReviewerIdentity(accountIdOf(req), userId, body);
      if (!identity) {
        reply.status(404);
        return { error: 'NotFound', message: `Reviewer ${userId} not found` };
      }
      const resp: ReviewerIdentity = identity;
      return resp;
    },
  );

  // ── ACTOR IDENTITY — RESET ────────────────────────────────────────────────────────────────
  // Hand `kind` + `label` back to detection: clear them, set `identity_source: 'auto'`, and
  // re-derive immediately so the auto answer lands in this response.
  //
  // ⚠ BLAST RADIUS: THE BOT EVERYWHERE. Identity is a singleton per actor, so this changes how it
  // renders in every repo — which is why it is a different control, in a different place, from the
  // per-repo reset above. The UI offers it only when `identitySource === 'manual'`.
  //
  // ⚠ IT KEEPS THE PRICE. The row also carries `monthly_cents`, and a price is not a
  // classification opinion — clearing it because someone un-named a vendor is the coupling the
  // two-table split exists to remove. The UI says so in words, because "reset" reads as "delete
  // everything" otherwise.
  //
  // ⚠ AND IT TOUCHES NO REPO ROW — see resetReviewerIdentity: the re-derivation runs with an
  // empty repo list, so no statement reaches `repo_reviewers`.
  //
  // Same 404 rule as the PATCH twin: no `repo_reviewers` row anywhere in the account.
  app.delete(
    '/api/bot-reviewers/:userId/identity',
    { schema: identityResetSchema },
    async (req, reply) => {
      const { userId } = req.params as { userId: number };
      const identity = await resetReviewerIdentity(accountIdOf(req), userId);
      if (!identity) {
        reply.status(404);
        return { error: 'NotFound', message: `Reviewer ${userId} not found` };
      }
      // Echoed, unlike the judgement reset: the row still exists (it still holds the price), and
      // this is the re-derived identity the caller asked to fall back to.
      const resp: ReviewerIdentity = identity;
      return resp;
    },
  );

  // ── ACTOR COST ────────────────────────────────────────────────────────────────────────────
  // What this actor costs per month, account-wide. A number sets it (0 is real: "we pay
  // nothing"); null CLEARS it — a column write, never a row delete, because the row also carries
  // the vendor identity.
  //
  // ⚠ You buy ONE subscription from a vendor, so this is deliberately NOT per repo: six repos
  // running CodeRabbit is $120, not $720. The rendering rule the schema cannot enforce (dedupe by
  // userId before any total) is the client's, and is restated on `ReviewerIdentity.costMonthlyUsd`.
  //
  // Same 404 rule as the identity route: no `repo_reviewers` row ⇒ no price to attach.
  app.put('/api/bot-reviewers/:userId/cost', { schema: costSchema }, async (req, reply) => {
    const { userId } = req.params as { userId: number };
    const { monthlyUsd } = req.body as ReviewerCostBody;
    const identity = await setReviewerCost(accountIdOf(req), userId, monthlyUsd);
    if (!identity) {
      reply.status(404);
      return { error: 'NotFound', message: `Reviewer ${userId} not found` };
    }
    const resp: ReviewerIdentity = identity;
    return resp;
  });

  // Bot ROI / utilisation over a window (default rolling_14): per-vendor threads/acted-on/
  // untouched + verdict + trend + deterministic tuning suggestions. Cost is SERVER-resolved from
  // the core `account_reviewers.monthly_cents` — a null here is FINAL, and the deprecated Pro
  // per-login blob only ever points at a stranded price now.
  //
  // ⚠ The price is ACTOR-grain on a SCOPED row: never sum it across rows, repos or scopes. A
  // vendor on six repos is $120 of spend seen six ways, not $720.
  app.get('/api/bot-analytics', { schema: analyticsSchema }, async (req) => {
    const { window, scope, repoIds } = req.query as {
      window: BotWindowKind;
      scope?: string;
      repoIds?: string;
    };
    const accountId = accountIdOf(req);
    // An explicit repoIds list (the per-repo Bots tab) wins over the team scope.
    const explicit = parseIntList(repoIds);
    const scopeRepoIds = explicit ?? (scope ? await resolveScopeRepoIds(accountId, scope) : null);
    // ONE scope drives both the metrics AND the "is this login a bot here" judgement — the getter
    // derives the second from the first, so the two cannot disagree. (They could under the
    // previous shape: the classification key was a SEPARATE argument a caller had to remember.)
    const resp: BotAnalyticsResponse = await getBotAnalytics(
      accountId,
      window,
      scopeRepoIds,
    );
    return resp;
  });

  // EXPERIMENTAL bot BEHAVIOUR analytics (CORE, deterministic — no AI). Per bot, over the same
  // window/scope resolution as /api/bot-analytics: time-to-first-review, LoC-to-comments ratio,
  // the week×hour activity heatmap (coverage / rate-limit inference), and post-first-review
  // follow-up behaviour. Powers the Bots "Behaviour" sub-tab, kept separate from the ROI panel.
  app.get('/api/bot-behaviour', { schema: analyticsSchema }, async (req) => {
    const { window, scope, repoIds } = req.query as {
      window: BotWindowKind;
      scope?: string;
      repoIds?: string;
    };
    const accountId = accountIdOf(req);
    const explicit = parseIntList(repoIds);
    const scopeRepoIds = explicit ?? (scope ? await resolveScopeRepoIds(accountId, scope) : null);
    const resp: BotBehaviourResponse = await getBotBehaviourAnalytics(
      accountId,
      window,
      scopeRepoIds,
    );
    return resp;
  });

  // The exact PR list behind the analytics totals.botOnlyPrs count — "only a bot reviewed these".
  // Same window/scope resolution as /api/bot-analytics (a specific `repoIds` wins over `scope`) so
  // the amber caption's number and this expandable list are computed identically and can't drift.
  // Unbounded but small (real bot-only PRs); no pagination.
  app.get('/api/bot-analytics/bot-only-prs', { schema: analyticsSchema }, async (req) => {
    const { window, scope, repoIds } = req.query as {
      window: BotWindowKind;
      scope?: string;
      repoIds?: string;
    };
    const accountId = accountIdOf(req);
    const explicit = parseIntList(repoIds);
    const scopeRepoIds = explicit ?? (scope ? await resolveScopeRepoIds(accountId, scope) : null);
    const { window: win, prs } = await getBotOnlyPrs(
      accountId,
      window,
      scopeRepoIds,
    );
    const resp: BotOnlyPrsResponse = { window: win, prs, generatedAt: new Date().toISOString() };
    return resp;
  });

  // The per-REVIEWER PR drill-down behind one Bot-ROI row: the PRs that one automated reviewer
  // touched in the window (threads/comments/acted-on/untouched/bot-only), newest-activity first.
  // `key` is the analytics row identity — `u<userId>` (a single reviewer) or the 'pierre' sentinel;
  // anything else is a client bug → 400.
  app.get('/api/bot-analytics/vendor/:key/prs', { schema: vendorPrsSchema }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const { window, scope, repoIds } = req.query as {
      window: BotWindowKind;
      scope?: string;
      repoIds?: string;
    };
    const m = /^u(\d+)$/.exec(key);
    const target = m
      ? { userId: Number(m[1]) }
      : key === 'pierre'
        ? ({ kind: 'pierre' } as const)
        : null;
    if (!target) {
      reply.status(400);
      return { error: 'BadRequest', message: `Invalid vendor key: ${key}` };
    }
    const accountId = accountIdOf(req);
    const explicit = parseIntList(repoIds);
    const scopeRepoIds = explicit ?? (scope ? await resolveScopeRepoIds(accountId, scope) : null);
    const resp: BotVendorPrsResponse = await getBotVendorPrs(
      accountId,
      target,
      window,
      scopeRepoIds,
    );
    return resp;
  });

  // Cross-bot dedup clusters for one PR (≥2 automated reviewers on the same path/line window).
  // Ownership-scoped → 404 for a PR this account doesn't own.
  app.get('/api/prs/:id/bot-dedup', { schema: prIdParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const resp = await getBotDedupClusters(id, accountIdOf(req));
    if (!resp) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    return resp;
  });

  // The scope-wide review list: every PR with ≥1 `likely_addressed` automated-reviewer thread
  // across the account (or a repo scope), UNCAPPED, newest-thread-first, each row carrying all
  // its resolvable thread ids + a bot thread-state mix + `totalThreads` (the whole backlog). The
  // client sorts / paginates / "Select all"s across pages and chunks the resolve. Read-only.
  app.get('/api/bot-threads/resolvable', { schema: resolvableSchema }, async (req) => {
    const { scope, repoIds } = req.query as { scope?: string; repoIds?: string };
    const accountId = accountIdOf(req);
    const explicit = parseIntList(repoIds);
    const scopeRepoIds = explicit ?? (scope ? await resolveScopeRepoIds(accountId, scope) : null);
    const { prs, totalThreads } = await getResolvableBotThreadPrs(
      accountId,
      scopeRepoIds,
    );
    const resp: ResolvableThreadPrsResponse = {
      prs,
      totalThreads,
      generatedAt: new Date().toISOString(),
    };
    return resp;
  });

  // The confirm-gated scope-wide resolve. NEVER blind: the server RE-DERIVES the eligible set
  // (owned + automated-reviewer-originated + `likely_addressed` + unresolved) ∩ the client's
  // explicit reviewed ids, scoped to `repoIds`, then resolves each via the SAME shared helper the
  // per-PR route uses. An empty list is a no-op (not an error);
  // per-thread failures are reported, not fatal. The re-derive path passes `threadIds` so the
  // page cap is bypassed — no requested-and-eligible id is silently dropped.
  app.post('/api/bot-threads/resolve', { schema: scopeResolveSchema }, async (req) => {
    const { threadIds, repoIds } = req.body as ScopeResolveBotThreadsBody;
    const accountId = accountIdOf(req);
    if (threadIds.length === 0) {
      const noop: ResolveBotThreadsResult = { resolved: 0, failed: 0, results: [] };
      return noop;
    }
    // The KNOWN GAP this used to carry is CLOSED. Under the team grain the re-derive ran at the
    // account default (`ScopeResolveBotThreadsBody` carries `threadIds`/`repoIds` and no `scope`,
    // and it is a frozen shared type), so a reviewer marked automated only under a per-team
    // override had its threads offered by the listing and then found ineligible here — the route
    // resolved 0. The judgement scope is now derived from `repoIds`, the very field the body
    // already carries, so the listing and the resolve evaluate the same rule by construction.
    const { threads: eligible } = await getResolvableBotThreadsForScope(
      accountId,
      repoIds ?? null,
      threadIds,
    );
    const result = await resolveThreadsOnGitHub(
      accountId,
      eligible.map((t) => ({ id: t.threadId, threadNodeId: t.threadNodeId })),
    );
    req.log.info(
      {
        accountId,
        requested: threadIds.length,
        eligible: eligible.length,
        resolved: result.resolved,
        failed: result.failed,
      },
      'scope-wide bot-thread resolve',
    );
    return result;
  });
}
