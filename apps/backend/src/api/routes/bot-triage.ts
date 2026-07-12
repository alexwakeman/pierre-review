import type { FastifyInstance } from 'fastify';
import type {
  BotAnalyticsResponse,
  BotVendorPrsResponse,
  BotMuteRule,
  BotMuteRuleInput,
  BotMuteRulesResponse,
  BotWindowKind,
  DetectedReviewersResponse,
  ReviewerOverrideBody,
} from '@pierre-review/shared';
import {
  addBotMuteRule,
  deleteBotMuteRule,
  getBotAnalytics,
  getBotVendorPrs,
  getBotDedupClusters,
  listBotMuteRules,
  listDetectedReviewers,
  setReviewerOverride,
} from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

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
    },
  },
};

// GET /api/bot-analytics/:kind/prs?window= — per-vendor PR drill-down. `kind` is left an open
// string (AutomatedReviewerKind is types-only shared, unimportable at runtime; the query layer
// coerces an unknown kind); the window reuses the same closed enum/default as /api/bot-analytics.
const vendorPrsSchema = {
  params: {
    type: 'object',
    required: ['kind'],
    properties: { kind: { type: 'string' } },
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
    const { window } = req.query as { window: BotWindowKind };
    const resp: BotAnalyticsResponse = await getBotAnalytics(accountIdOf(req), window);
    return resp;
  });

  // The per-vendor PR drill-down behind one Bot-ROI row: the PRs that automated reviewer kind
  // touched in the window (threads/comments/acted-on/untouched/bot-only), newest-activity first.
  app.get('/api/bot-analytics/:kind/prs', { schema: vendorPrsSchema }, async (req) => {
    const { kind } = req.params as { kind: string };
    const { window } = req.query as { window: BotWindowKind };
    const resp: BotVendorPrsResponse = await getBotVendorPrs(accountIdOf(req), kind, window);
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
}
