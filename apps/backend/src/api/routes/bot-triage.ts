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
  ReviewerOverrideBody,
  ScopeResolveBotThreadsBody,
} from '@pierre-review/shared';
import {
  classificationTeamKey,
  deleteReviewerOverride,
  getBotAnalytics,
  getBotBehaviourAnalytics,
  getBotOnlyPrs,
  getBotVendorPrs,
  getBotDedupClusters,
  getResolvableBotThreadPrs,
  getResolvableBotThreadsForScope,
  listDetectedReviewers,
  resolveScopeRepoIds,
  setReviewerOverride,
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

// PATCH /api/bot-reviewers/:userId — the two-way manual override. `kind`/`label` are left as
// open strings (nullable) rather than an enum: AutomatedReviewerKind is defined in the
// types-only shared package the backend can't import at runtime, and the query layer coerces
// an unknown kind to a sensible default, so pinning the vendor list here would only add drift.
//
// `role` IS a closed 2-value set, so it's enumerated (an unknown role would land in a NOT NULL
// column that the metric split branches on). It is OPTIONAL and absent means "leave the stored
// role alone" — an old client that only knows automated/kind must not be able to silently
// un-mark a quality check.
//
// `teamId` rides in the BODY, not the query string, because it is part of the row's IDENTITY.
// minimum 0 = NO_TEAM_KEY (the account default every team inherits); the query layer verifies
// the id belongs to this account and 404s otherwise.
const overrideSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  body: {
    type: 'object',
    required: ['automated'],
    additionalProperties: false,
    properties: {
      automated: { type: 'boolean' },
      kind: { type: ['string', 'null'] },
      label: { type: ['string', 'null'] },
      role: { type: 'string', enum: ['review', 'quality_check'] },
      teamId: { type: 'integer', minimum: 0 },
    },
  },
};

// GET /api/bot-reviewers?teamId= — which team's classification answers to show. Absent = 0
// (NO_TEAM_KEY, the account default). DELETE /api/bot-reviewers/:userId?teamId= reuses it for
// "Reset to default". A string is used on the wire (query strings are untyped) and coerced by
// the handler; the query layer rejects a non-integer / foreign team.
const teamScopedReviewersSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { teamId: { type: 'integer', minimum: 0 } },
  },
};
const deleteOverrideSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  ...teamScopedReviewersSchema,
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
  // Every distinct reviewer in the account (human + automated), classified, with 90-day
  // volume + a sample body — powers the Settings "Review bots" detected-reviewers table.
  app.get('/api/bot-reviewers', { schema: teamScopedReviewersSchema }, async (req) => {
    const { teamId } = req.query as { teamId?: number };
    const resp: DetectedReviewersResponse = await listDetectedReviewers(
      accountIdOf(req),
      teamId ?? 0,
    );
    return resp;
  });

  // Two-way manual override: force a reviewer automated (with kind/label) or back to human.
  // Upserts a source='manual' classification the auto resolver never overwrites. 404 when the
  // user id is unknown to this account's synced data.
  app.patch('/api/bot-reviewers/:userId', { schema: overrideSchema }, async (req, reply) => {
    const { userId } = req.params as { userId: number };
    const body = req.body as ReviewerOverrideBody;
    // null covers BOTH an unknown user id and an unknown/foreign teamId — the same 404 on
    // purpose: distinguishing them would turn this route into an existence oracle over another
    // tenant's team ids.
    const classification = await setReviewerOverride(accountIdOf(req), userId, body);
    if (!classification) {
      reply.status(404);
      return { error: 'NotFound', message: `Reviewer ${userId} not found` };
    }
    return classification;
  });

  // "Reset to default": drop this reviewer's explicit row for `teamId` so the team inherits the
  // account default (or auto-detection). Idempotent — deleting a row that isn't there is a
  // successful reset. 404 only for an unknown/foreign team.
  app.delete('/api/bot-reviewers/:userId', { schema: deleteOverrideSchema }, async (req, reply) => {
    const { userId } = req.params as { userId: number };
    const { teamId } = req.query as { teamId?: number };
    const ok = await deleteReviewerOverride(accountIdOf(req), userId, teamId ?? 0);
    if (!ok) {
      reply.status(404);
      return { error: 'NotFound', message: `Team ${teamId} not found` };
    }
    reply.status(204);
    return null;
  });

  // Bot ROI / utilisation over a window (default rolling_14): per-vendor threads/acted-on/
  // untouched + verdict + trend + deterministic tuning suggestions. Cost fields are null here
  // (the client overlays per-vendor cost from Pro settings).
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
    // The classification key comes from the SAME scope the repo ids do — a single team id
    // resolves to that team's answers, every union form ('all'/'none'/'teams'/'teams:a,b') to
    // the account default. A repo scope carries no team (teamRepos is many-to-many).
    const resp: BotAnalyticsResponse = await getBotAnalytics(
      accountId,
      window,
      scopeRepoIds,
      classificationTeamKey(scope),
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
      classificationTeamKey(scope),
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
      classificationTeamKey(scope),
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
      classificationTeamKey(scope),
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
      classificationTeamKey(scope),
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
    // KNOWN GAP, deliberate and documented: the re-derive runs at NO_TEAM_KEY (the account
    // default) because `ScopeResolveBotThreadsBody` carries `threadIds`/`repoIds` and no
    // `scope` — it is a frozen shared type. So if a reviewer is marked automated ONLY under a
    // per-team override, the team-scoped listing offers its threads but this route finds them
    // ineligible and resolves 0 (it never resolves something it shouldn't — the failure is
    // conservative). Fixing it properly needs `scope?: string` on that body type.
    const { threads: eligible } = await getResolvableBotThreadsForScope(
      accountId,
      repoIds ?? null,
      threadIds,
      classificationTeamKey(null),
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
