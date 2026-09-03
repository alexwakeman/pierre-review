import type { FastifyInstance } from 'fastify';
import type {
  AiUsageResponse,
  LargePrThresholdBody,
  LargePrThresholdResponse,
  MeResponse,
  MyTurnDismissBody,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import {
  accountToLocalUser,
  setBenchmarkConsent,
  setLargePrCodeLocThreshold,
} from '../../auth/account.js';
import { resolveLargePrThreshold } from '../../db/code-loc.js';
import { aiCreditStatus, monthStartMs } from '../../db/credits.js';
import { eraseAccountData } from '../../db/erase-account.js';
import { exportAccountData } from '../../db/export-account.js';
import { runBenchmarkRollupForAccount } from '../../sync/benchmark-rollup.js';
import { accountIdOf } from '../plugins/auth.js';
import {
  EMPTY_CAPABILITIES,
  entitledProCapabilities,
} from '../../pro/contract.js';
import { getAuthNotices } from '../../sync/auth-notices.js';
import { isSeverityApiConfigured } from '../../ml/severity-client.js';
import {
  dismissMyTurn,
  getCompletedDismissals,
  getMyTurn,
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

// The LARGE-PR FLAG's threshold. `null` is a first-class value meaning "reset to the product
// default", so the type is the union — NOT an optional key, which would make "clear it" and
// "don't change it" the same request. The bounds are validation, not taste: `minimum: 1` because a
// threshold of 0 flags literally every pull request, and an upper bound because an unbounded
// integer is a number nobody could ever hit, i.e. a setting that silently means "off" while
// looking like it is on. `multipleOf: 1` rejects 1500.5 (ajv's `integer` already does, but the
// column is an INTEGER in both dialects and the intent is worth spelling).
const largePrThresholdSchema = {
  body: {
    type: 'object',
    required: ['threshold'],
    additionalProperties: false,
    properties: {
      threshold: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: 1_000_000,
        multipleOf: 1,
      },
    },
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
    // Per-account entitlement: local = full capabilities; cloud = full only when the
    // account's plan isn't 'free' (Stripe billing seam) — used for the `pro` passthrough.
    const entitled = req.account
      ? entitledProCapabilities(req.account)
      : EMPTY_CAPABILITIES;
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
      // NOTE: this response deliberately carries NO My-Turn counts. It used to return a
      // `counts` object (a whole `getMyTurn` fold) plus `feedLastSeenAt`/`newFeedItems` (a
      // second fold over the feed) for the Welcome-back banner. The banner is now
      // per-workspace and reads standing `my_turn` card counts off the daily brief, so all
      // three had no reader left and were pure per-request work on the SPA's first call.
      // If you need a count here again, prefer the brief's fold over re-adding one.
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
      // The LARGE-PR FLAG's threshold, RESOLVED (stored value, else the product default) so no
      // renderer has to know about the null. TOP-LEVEL and not inside `pro` above: the flag is
      // free, and `entitledProCapabilities` zeroes that object for free cloud accounts — exactly
      // this feature's audience (the `mlSeverity` argument, verbatim).
      largePrCodeLocThreshold: resolveLargePrThreshold(
        req.account?.largePrCodeLocThreshold ?? null,
      ),
      largePrCodeLocThresholdIsDefault: req.account?.largePrCodeLocThreshold == null,
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

  // The LARGE-PR FLAG's threshold — ONE PER-ACCOUNT SETTING, in lines of CODE churn (the
  // docs/config/lockfile/generated churn is excluded before the sum; see db/code-loc.ts).
  //
  // Deliberately NOT per-workspace and not per-repo: a second grain would need a resolver, and
  // "which grain am I reading?" is the question the reviewer object spent migration 0045 removing.
  // `threshold: null` RESETS to the product default rather than storing 1500 — the two states are
  // "the user has an opinion" and "the user does not", so a future change to the default still
  // reaches everyone who never overrode it.
  //
  // Available in BOTH modes and on every tier: the flag is free, so its setting must be too.
  // Rate tier: the schema-validated single-column UPDATE falls through `tierFor` to the blanket
  // `read` bucket, which is DECIDED (and pinned in rate-limit.test.ts), not inherited — it reaches
  // no GitHub API and no model, exactly like POST /api/me/benchmark-consent beside it.
  app.post(
    '/api/me/large-pr-threshold',
    { schema: largePrThresholdSchema },
    async (req, reply) => {
      const accountId = accountIdOf(req);
      const { threshold } = req.body as LargePrThresholdBody;
      // Belt and braces over the JSON schema: `Number.isInteger` also rejects NaN/Infinity, which
      // a hand-rolled body validator elsewhere could let through as `type: 'integer'` never sees.
      if (threshold !== null && !(Number.isInteger(threshold) && threshold > 0)) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'threshold must be a positive whole number of lines, or null to reset.',
        });
      }
      await setLargePrCodeLocThreshold(accountId, threshold);
      const body: LargePrThresholdResponse = {
        status: 'ok',
        largePrCodeLocThreshold: resolveLargePrThreshold(threshold),
        largePrCodeLocThresholdIsDefault: threshold == null,
      };
      return body;
    },
  );

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
