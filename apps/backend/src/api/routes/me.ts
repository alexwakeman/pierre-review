import type { FastifyInstance } from 'fastify';
import type { AiUsageResponse, MeResponse, MyTurnDismissBody } from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountToLocalUser, setBenchmarkConsent } from '../../auth/account.js';
import { aiCreditStatus, monthStartMs } from '../../db/credits.js';
import { eraseAccountData } from '../../db/erase-account.js';
import { exportAccountData } from '../../db/export-account.js';
import { runBenchmarkRollupForAccount } from '../../sync/benchmark-rollup.js';
import { accountIdOf } from '../plugins/auth.js';
import {
  EMPTY_CAPABILITIES,
  entitledProCapabilities,
} from '../../pro/contract.js';
import { countNewMyTurnFeedItems } from '../../feed/my-turn.js';
import { getAuthNotices } from '../../sync/auth-notices.js';
import { isSeverityApiConfigured } from '../../ml/severity-client.js';
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

// Erasure requires the caller to retype their own GitHub login. maxLength bounds the string
// (every GitHub login is ≤ 39 chars) so the body can't be used to push a large payload.
const deleteAccountSchema = {
  body: {
    type: 'object',
    required: ['confirmLogin'],
    additionalProperties: false,
    properties: { confirmLogin: { type: 'string', minLength: 1, maxLength: 64 } },
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
    // Month-to-date AI balances, computed CORE-side (the plan/allowance rules live in db/credits)
    // so the SPA has the spend baseline on the very first authenticated call — no separate Pro
    // fetch needed on login. Split by seam: summary is metered by TURN count, agent by CREDITS.
    let aiUsage: AiUsageResponse | null = null;
    if (req.account) {
      const nowMs = Date.now();
      const c = await aiCreditStatus(req.account, nowMs);
      aiUsage = {
        enabled: true,
        monthStart: new Date(monthStartMs(nowMs)).toISOString(),
        summaryTurnsUsed: c.summaryTurnsUsed,
        summaryTurnLimit: c.summaryTurnLimit,
        summaryTurnsRemaining: c.summaryTurnsRemaining,
        agentCreditsUsed: c.agentCreditsUsed,
        agentAllowanceCredits: c.agentAllowanceCredits,
        agentCreditsRemaining: c.agentCreditsRemaining,
      };
    }
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
      // ML severity/category enrichment of bot comments — FREE TIER, so a TOP-LEVEL field and
      // NOT part of `pro` above: `entitledProCapabilities` returns all-false for a cloud
      // account on the free plan, which would hide this from exactly the users it is for.
      // True iff a severity-api is reachable for this deployment; false under `npx`.
      mlSeverity: isSeverityApiConfigured(),
      // Cross-org benchmark consent (cloud-only; always false in local). Drives the Settings toggle.
      benchmarkOptIn: config.isCloud ? req.account?.benchmarkOptIn ?? false : false,
      // Orgs currently SAML-blocked for this account (empty in the normal case + in local).
      authNotices: getAuthNotices(accountId),
      aiUsage,
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

  // ---- Data-subject rights (UK/EU GDPR Arts. 15, 17, 20; CCPA/CPRA) ----
  //
  // Both are SELF-SERVICE by design. A privacy policy that says "email us to be deleted" is a
  // promise backed by a human remembering to run SQL; these two routes are the promise backed
  // by code, and they are what the policy at /privacy §9 points at.

  // Access + portability: the whole account as one JSON document. The sealed GitHub token is
  // excluded (see db/export-account.ts) — an export is a file people email to themselves.
  app.get('/api/me/export', async (req, reply) => {
    const accountId = accountIdOf(req);
    const data = await exportAccountData(accountId);
    if (!data) {
      return reply.code(404).send({ error: 'NotFound', message: 'Account not found' });
    }
    // Content-Disposition so the browser saves a file rather than rendering a huge JSON blob;
    // the date in the name makes successive exports distinguishable.
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header(
      'content-disposition',
      `attachment; filename="pierre-export-${data.account.githubLogin ?? accountId}-${stamp}.json"`,
    );
    reply.type('application/json');
    return data;
  });

  // Erasure. Irreversible, and deliberately requires the caller to type their own GitHub login
  // into `confirmLogin` — not as security (the session already proves who they are) but as
  // INTENT: this destroys every synced repository and cannot be undone, so a mis-click or a
  // stray fetch must not be sufficient. The cross-origin guard already blocks a foreign page
  // from issuing it at all.
  app.delete(
    '/api/me/account',
    { schema: deleteAccountSchema },
    async (req, reply) => {
      const account = req.account;
      if (!account) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Sign in first.' });
      }
      const { confirmLogin } = req.body as { confirmLogin: string };
      if (
        !account.githubLogin ||
        confirmLogin.trim().toLowerCase() !== account.githubLogin.toLowerCase()
      ) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'confirmLogin must match your GitHub username exactly.',
        });
      }
      // A local install is a single implicit account synthesized from `gh api user` at every
      // startup — deleting it would be recreated seconds later, and the user's actual delete
      // action is removing the SQLite file. Refuse rather than pretend.
      if (account.isLocal) {
        return reply.code(400).send({
          error: 'BadRequest',
          message:
            'This is a local install: there is no hosted account to delete. Remove the ' +
            'database file (see `pierre --help` for its location) to erase everything.',
        });
      }

      req.log.warn({ accountId: account.id }, 'account erasure requested');
      const result = await eraseAccountData(account.id);
      req.log.warn(
        { accountId: account.id, reposDeleted: result.reposDeleted },
        'account erased',
      );
      // Drop the session too, or the browser keeps presenting a cookie for an account that no
      // longer exists (which resolves to `null` and 401s confusingly).
      try {
        req.session.delete();
      } catch {
        /* no session plugin in local mode — unreachable here, but harmless */
      }
      return { status: 'deleted', reposDeleted: result.reposDeleted };
    },
  );

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
