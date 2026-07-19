import type { FastifyInstance } from 'fastify';
import type {
  BotAnalyticsResponse,
  BotOnlyPrsResponse,
  BotResolvableThread,
  BotResolvableThreadGroup,
  BotResolvableThreadsResponse,
  BotVendorPrsResponse,
  BotMuteRule,
  BotMuteRuleInput,
  BotMuteRulesResponse,
  BotWindowKind,
  DetectedReviewersResponse,
  ResolveBotThreadsResult,
  ReviewerOverrideBody,
  ScopeResolveBotThreadsBody,
} from '@pierre-review/shared';
import {
  addBotMuteRule,
  deleteBotMuteRule,
  getBotAnalytics,
  getBotOnlyPrs,
  getBotVendorPrs,
  getBotDedupClusters,
  getResolvableBotThreadsForScope,
  listBotMuteRules,
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

// POST /api/bot-mute-rules — `action` is a closed enum; `autoResolveDays` is floored at 1 so a
// 0/negative-day auto-resolve rule (which would immediately clear everything) is rejected.
const muteRuleSchema = {
  body: {
    type: 'object',
    required: ['action'],
    additionalProperties: false,
    properties: {
      vendorKind: { type: ['string', 'null'] },
      pathGlob: { type: ['string', 'null'] },
      severity: { type: ['string', 'null'] },
      action: { type: 'string', enum: ['hide', 'auto_resolve'] },
      autoResolveDays: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
    },
  },
};

const ruleIdParamSchema = {
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
// per-PR cross-bot dedup, and the mute / auto-triage rule store. Every handler is account-
// scoped via accountIdOf(req); id-addressed reads/writes verify ownership → 404. No AI.
export async function botTriageRoutes(app: FastifyInstance): Promise<void> {
  // Every distinct reviewer in the account (human + automated), classified, with 90-day
  // volume + a sample body — powers the Settings "Review bots" detected-reviewers table.
  app.get('/api/bot-reviewers', async (req) => {
    const resp: DetectedReviewersResponse = await listDetectedReviewers(accountIdOf(req));
    return resp;
  });

  // Two-way manual override: force a reviewer automated (with kind/label) or back to human.
  // Upserts a source='manual' classification the auto resolver never overwrites. 404 when the
  // user id is unknown to this account's synced data.
  app.patch('/api/bot-reviewers/:userId', { schema: overrideSchema }, async (req, reply) => {
    const { userId } = req.params as { userId: number };
    const body = req.body as ReviewerOverrideBody;
    const classification = await setReviewerOverride(accountIdOf(req), userId, body);
    if (!classification) {
      reply.status(404);
      return { error: 'NotFound', message: `Reviewer ${userId} not found` };
    }
    return classification;
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
    const resp: BotAnalyticsResponse = await getBotAnalytics(accountId, window, scopeRepoIds);
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
    const { window: win, prs } = await getBotOnlyPrs(accountId, window, scopeRepoIds);
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
    const resp: BotVendorPrsResponse = await getBotVendorPrs(accountId, target, window, scopeRepoIds);
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

  // The account's mute / auto-triage rules.
  app.get('/api/bot-mute-rules', async (req) => {
    const rules = await listBotMuteRules(accountIdOf(req));
    const resp: BotMuteRulesResponse = { rules };
    return resp;
  });

  app.post('/api/bot-mute-rules', { schema: muteRuleSchema }, async (req) => {
    const input = req.body as BotMuteRuleInput;
    const rule: BotMuteRule = await addBotMuteRule(accountIdOf(req), input);
    return rule;
  });

  app.delete('/api/bot-mute-rules/:id', { schema: ruleIdParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const ok = await deleteBotMuteRule(accountIdOf(req), id);
    if (!ok) {
      reply.status(404);
      return { error: 'NotFound', message: `Mute rule ${id} not found` };
    }
    reply.status(204);
    return null;
  });

  // The scope-wide review list: every `likely_addressed` automated-reviewer thread across the
  // account (or a repo scope), grouped by PR, capped + newest-first, with `totalEligible` so the
  // UI can say "showing the N most recent". Read-only; the client reviews it before resolving.
  app.get('/api/bot-threads/resolvable', { schema: resolvableSchema }, async (req) => {
    const { scope, repoIds } = req.query as { scope?: string; repoIds?: string };
    const accountId = accountIdOf(req);
    const explicit = parseIntList(repoIds);
    const scopeRepoIds = explicit ?? (scope ? await resolveScopeRepoIds(accountId, scope) : null);
    const { threads, totalEligible, botCountsByPr } = await getResolvableBotThreadsForScope(
      accountId,
      scopeRepoIds,
    );

    // Group by PR, preserving the query's newest-thread-first order (first-seen PR wins the slot).
    const byPr = new Map<number, BotResolvableThreadGroup>();
    for (const t of threads) {
      let g = byPr.get(t.prId);
      if (!g) {
        g = {
          prId: t.prId,
          prNumber: t.prNumber,
          prTitle: t.prTitle,
          repoFullName: t.repoFullName,
          githubUrl: t.prGithubUrl,
          authorId: t.authorId,
          ciStatus: t.ciStatus,
          openedAt: t.openedAt,
          updatedAt: t.updatedAt,
          botThreadCounts: botCountsByPr.get(t.prId) ?? {
            resolved: 0,
            likely_addressed: 0,
            replied_unresolved: 0,
            untouched: 0,
          },
          threads: [],
        };
        byPr.set(t.prId, g);
      }
      const thread: BotResolvableThread = {
        threadId: t.threadId,
        path: t.path,
        excerpt: t.excerpt,
        botLabel: t.botLabel,
      };
      g.threads.push(thread);
    }
    const resp: BotResolvableThreadsResponse = {
      groups: [...byPr.values()],
      totalEligible,
      shown: threads.length,
      generatedAt: new Date().toISOString(),
    };
    return resp;
  });

  // The confirm-gated scope-wide resolve. NEVER blind: the server RE-DERIVES the eligible set
  // (owned + automated-reviewer-originated + `likely_addressed` + unresolved) ∩ the client's
  // explicit reviewed ids, scoped to `repoIds`, then resolves each via the SAME shared helper the
  // per-PR route + the standing auto-triage job use. An empty list is a no-op (not an error);
  // per-thread failures are reported, not fatal. The re-derive path passes `threadIds` so the
  // page cap is bypassed — no requested-and-eligible id is silently dropped.
  app.post('/api/bot-threads/resolve', { schema: scopeResolveSchema }, async (req) => {
    const { threadIds, repoIds } = req.body as ScopeResolveBotThreadsBody;
    const accountId = accountIdOf(req);
    if (threadIds.length === 0) {
      const noop: ResolveBotThreadsResult = { resolved: 0, failed: 0, results: [] };
      return noop;
    }
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
