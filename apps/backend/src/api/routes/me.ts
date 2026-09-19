import type { FastifyInstance } from 'fastify';
import type {
  AiUsageResponse,
  BlastRadiusConfigBody,
  BlastRadiusConfigResponse,
  LargePrThresholdBody,
  LargePrThresholdResponse,
  MeResponse,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import {
  accountToLocalUser,
  setBenchmarkConsent,
  setBlastRadiusConfig,
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
import { getMyTurn } from '../../db/queries.js';

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

// The BLAST-RADIUS reading settings. `config: null` RESETS to the product defaults, the same
// first-class "no opinion" value `threshold: null` is above — a union, not an optional key, so
// "clear it" and "leave it alone" stay different requests.
//
// The schema is deliberately LOOSE where the sanitizer is strict: `surfacesOff` is a bounded
// array of short strings here, and `sanitizeBlastRadiusConfig` is what decides which strings are
// real surfaces (dropping the rest rather than 400-ing the whole write, so an older backend
// reading a newer client degrades to ignoring one opt-out instead of discarding the dial). The
// bounds that ARE here are the ones a validator must own: an enum for the dial, and caps so the
// body cannot be used to push a large payload into a JSON column.
const blastRadiusConfigSchema = {
  body: {
    type: 'object',
    required: ['config'],
    additionalProperties: false,
    properties: {
      config: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['sensitivity'],
        properties: {
          sensitivity: { type: 'string', enum: ['cautious', 'balanced', 'relaxed'] },
          // Show the Pro AI impact note on the PR pane. Absent = shown; only `false` is stored.
          showImpactNote: { type: 'boolean' },
          surfacesOff: {
            type: 'array',
            maxItems: 32,
            items: { type: 'string', maxLength: 32 },
          },
          overrides: {
            type: 'object',
            additionalProperties: false,
            properties: {
              highCodeLoc: { type: 'integer', minimum: 1, maximum: 1_000_000 },
              highCodeFiles: { type: 'integer', minimum: 1, maximum: 100_000 },
              highDirs: { type: 'integer', minimum: 1, maximum: 100_000 },
              highSubsystems: { type: 'integer', minimum: 1, maximum: 100_000 },
              lowCodeLoc: { type: 'integer', minimum: 1, maximum: 1_000_000 },
              lowCodeFiles: { type: 'integer', minimum: 1, maximum: 100_000 },
            },
          },
        },
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
      // The in-app merge conflict resolver. CORE and free, and now registered in BOTH modes —
      // so this is a constant, kept on the wire because the SPA gates its "Resolve conflicts"
      // button on it and a field that disappears is a field every caller has to re-learn.
      // ⚠ NOT a git-version probe: /api/me does not shell out on every SPA boot. A git too old
      // for `merge-tree --write-tree` is refused by the OPEN route with `git_too_old`.
      conflictResolver: true,
      // Chronology's default working-hours zone for a workspace that never set one.
      workTimeZone: config.defaultWorkTimezone,
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
      // The BLAST-RADIUS reading settings, RAW and nullable — the one place this response does
      // NOT resolve a default, and deliberately. The defaults are an 18-number table across
      // three dial positions living in `packages/shared`, which is types-only on this side
      // (PACKAGING); resolving here would mean hand-mirroring it forever. The SPA's one
      // `resolveBlastConfig()` imports that table as a real value instead, so `null` travels and
      // nothing is duplicated. Free feature → top-level, not inside `pro` (the `mlSeverity`
      // argument again).
      blastRadius: req.account?.blastRadiusConfig ?? null,
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

  // The BLAST-RADIUS reading settings — the second ONE-PER-ACCOUNT setting on this route, and
  // account-grained for the same reasons as the threshold above plus one of its own: the
  // comparison it feeds is RENDER-TIME, so it rides /api/me and the vis-timeline tooltip (raw
  // HTML strings, no hooks) can read it off a module cell. A per-workspace value would put a new
  // "workspace not resolved yet" null-state on four surfaces.
  //
  // A PUT rather than a POST because the body is the WHOLE settings object — this replaces the
  // stored blob, it does not merge into it, and the verb should say so.
  //
  // Available in BOTH modes and on every tier: blast radius is free, so its setting must be too.
  // Rate tier: one schema-validated single-column UPDATE, no GitHub and no model — the blanket
  // `read` bucket, DECIDED and pinned in rate-limit.test.ts rather than inherited.
  app.put('/api/me/blast-radius-config', { schema: blastRadiusConfigSchema }, async (req) => {
    const accountId = accountIdOf(req);
    const { config: incoming } = req.body as BlastRadiusConfigBody;
    // ⚠ ECHO WHAT WAS STORED, NOT WHAT WAS SENT. The sanitizer drops unknown surfaces and
    // out-of-range overrides, so returning the request body would let Settings render a choice
    // the database does not hold — the same disagreement `largePrCodeLocThresholdIsDefault`
    // exists to prevent one field over.
    const stored = await setBlastRadiusConfig(accountId, incoming);
    const body: BlastRadiusConfigResponse = { status: 'ok', blastRadius: stored };
    return body;
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

  // THE ONE my-turn ROUTE. Its three siblings — POST /dismiss, GET /done, POST /undismiss — are
  // deleted along with the `my_turn_dismissals` table: an item leaves this inbox when the viewer
  // ACTS on the PR, so there is nothing to mark seen, nothing to list as "done" and nothing to
  // restore. Unscoped on purpose (see `getMyTurn`): the browser-notification watcher reads exactly
  // this call.
  app.get('/api/my-turn', async (req) => getMyTurn(accountIdOf(req)));
}
