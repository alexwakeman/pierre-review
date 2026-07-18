import type { FastifyInstance } from 'fastify';
import type { MeResponse, MyTurnDismissBody } from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountToLocalUser, setBenchmarkConsent } from '../../auth/account.js';
import { runBenchmarkRollupForAccount } from '../../sync/benchmark-rollup.js';
import { accountIdOf } from '../plugins/auth.js';
import {
  EMPTY_CAPABILITIES,
  entitledProCapabilities,
} from '../../pro/contract.js';
import { countNewMyTurnFeedItems } from '../../feed/my-turn.js';
import { getAuthNotices } from '../../sync/auth-notices.js';
import {
  dismissMyTurn,
  getCompletedDismissals,
  getFeedLastSeenAt,
  getMyTurn,
  markFeedSeen,
  undismissMyTurn,
} from '../../db/queries.js';

const dismissSchema = {
  body: {
    type: 'object',
    required: ['kind', 'refId'],
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        enum: ['review_request', 'thread', 'watched_repo_pr', 'pr_approved', 'claude_review'],
      },
      refId: { type: 'integer' },
    },
  },
};

const benchmarkConsentSchema = {
  body: {
    type: 'object',
    required: ['optIn'],
    additionalProperties: false,
    properties: { optIn: { type: 'boolean' } },
  },
};

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (req): Promise<MeResponse> => {
    const accountId = accountIdOf(req);
    const user = accountToLocalUser(req.account);
    const myTurn = await getMyTurn(accountId);
    // Feed "seen" marker + how many "My Turn" items are new since. Only counted once a
    // baseline exists (feedLastSeenAt set by the first feed view) so a fresh account never
    // sees a scary first-load number. "My Turn" is CORE / free now, so the count is computed
    // directly (no capability gate) — every tier gets the Welcome-back banner.
    // Per-account entitlement (below): local = full capabilities; cloud = full only when the
    // account's plan isn't 'free' (Stripe billing seam) — used for the `pro` passthrough.
    const entitled = req.account
      ? entitledProCapabilities(req.account)
      : EMPTY_CAPABILITIES;
    const feedLastSeen = await getFeedLastSeenAt(accountId);
    const newFeedItems = feedLastSeen
      ? await countNewMyTurnFeedItems(accountId, feedLastSeen)
      : 0;
    return {
      user,
      counts: {
        awaitingReview: myTurn.awaitingReview.length,
        yourPrsActivity: myTurn.yourPrs.length,
        approvedPrs: myTurn.approvedPrs.length,
        threadsAwaiting: myTurn.threadsAwaiting.length,
        watchedRepoPrs: myTurn.watchedRepoPrs.length,
        claudeReviewsToAction: myTurn.claudeReviewsToAction.length,
      },
      feedLastSeenAt: feedLastSeen ? feedLastSeen.toISOString() : null,
      newFeedItems,
      // Claude Review is now the Pro `claudeReview` capability (in `pro` below).
      deploymentMode: config.deploymentMode,
      pro: entitled,
      // Cross-org benchmark consent (cloud-only; always false in local). Drives the Settings toggle.
      benchmarkOptIn: config.isCloud ? req.account?.benchmarkOptIn ?? false : false,
      // Orgs currently SAML-blocked for this account (empty in the normal case + in local).
      authNotices: getAuthNotices(accountId),
    };
  });

  // Cross-org benchmark consent (CLOUD-ONLY, opt-in). Setting it true seeds the account's
  // contributions immediately (best-effort, in the background); false withdraws + deletes them
  // (handled in setBenchmarkConsent). Available to every cloud account — free or paid — because
  // the network needs volume to be worth anything (viewing the benchmark is the paid part, later).
  app.post('/api/me/benchmark-consent', { schema: benchmarkConsentSchema }, async (req, reply) => {
    if (!config.isCloud) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Benchmark is cloud-only' });
    }
    const accountId = accountIdOf(req);
    const { optIn } = req.body as { optIn: boolean };
    await setBenchmarkConsent(accountId, optIn);
    if (optIn) {
      // Fire-and-forget: don't block the response on the rollup; a failure is logged, not fatal.
      void runBenchmarkRollupForAccount(accountId, req.log).catch((err) =>
        req.log.error({ err, accountId }, 'benchmark seed after opt-in failed'),
      );
    }
    return { status: 'ok', benchmarkOptIn: optIn };
  });

  app.get('/api/my-turn', async (req) => getMyTurn(accountIdOf(req)));

  app.post('/api/my-turn/dismiss', { schema: dismissSchema }, async (req) => {
    const { kind, refId } = req.body as MyTurnDismissBody;
    await dismissMyTurn(accountIdOf(req), kind, refId);
    return { status: 'ok' };
  });

  // The "Done" tab: entries dismissed in the past 90 days (review_request + thread
  // + claude_review).
  app.get('/api/my-turn/done', async (req) =>
    getCompletedDismissals(accountIdOf(req), 90),
  );

  // Un-dismiss: move a completed entry back to the inbox.
  app.post('/api/my-turn/undismiss', { schema: dismissSchema }, async (req) => {
    const { kind, refId } = req.body as MyTurnDismissBody;
    await undismissMyTurn(accountIdOf(req), kind, refId);
    return { status: 'ok' };
  });
}
