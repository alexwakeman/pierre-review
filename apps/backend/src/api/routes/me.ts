import type { FastifyInstance } from 'fastify';
import type {
  AiKindStatus,
  AiRunKind,
  BlastRadiusConfigBody,
  BlastRadiusConfigResponse,
  LargePrThresholdBody,
  LargePrThresholdResponse,
  MeResponse,
  MyTurnDismissResponse,
  MyTurnDismissTarget,
  MyTurnSettingsBody,
  MyTurnSettingsResponse,
} from '@pierre-review/shared';
import { MY_TURN_TOGGLES, validateMyTurnSettings } from '@pierre-review/shared';
import { config } from '../../config.js';
import {
  accountToLocalUser,
  setBlastRadiusConfig,
  setLargePrCodeLocThreshold,
  setMyTurnSettings,
} from '../../auth/account.js';
import { resolveLargePrThreshold } from '../../db/code-loc.js';
import { exportAccountData } from '../../db/export-account.js';
import { accountIdOf } from '../plugins/auth.js';
import { getAuthNotices } from '../../sync/auth-notices.js';
import { isMlScoringAvailable } from '../../ml/scorer.js';
import { getMlStatus } from '../../ml/runtime.js';
import { activeRuntimeStatus } from '../../ai/active-runtime.js';
import { codexKindStatus, detectClaudeAuth, NO_CLAUDE_AUTH_MESSAGE } from '../../review/auth.js';
import { resolveAiCredential } from '../../ai/credentials.js';
import { codexDetailCached } from '../../ai/codex/detect.js';
import {
  aiProviderSettingStatus,
  ALL_RUN_KINDS,
  CODEX_NOT_AVAILABLE_MESSAGE,
  CODEX_RUNNABLE,
  getActiveProvider,
} from '../../ai/provider.js';
import { getMyTurn } from '../../db/queries.js';
import { clearDailyBriefCountsFor } from '../../db/daily-brief.js';
import { dismissMyTurn, restoreMyTurn } from '../../db/my-turn-dismissals.js';

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

// The MY TURN settings. `settings: null` RESETS to the product defaults — a union, not an optional
// key, like the two settings above.
//
// ⚠ EVERY PROPERTY IS DECLARED, down to each `show` key (built from `MY_TURN_TOGGLES`, the one list).
// Fastify's ajv STRIPS an undeclared key silently rather than rejecting it (the contact-form
// honeypot defect), so a key missing here would be a switch that saves as nothing. The schema
// checks SHAPE only; MEANING — a known type, no repeats, weights in steps of 10 summing to 100 — is
// `validateMyTurnSettings`, whose sentence the Settings form shows before it ever sends.
const myTurnSettingsSchema = {
  body: {
    type: 'object',
    required: ['settings'],
    additionalProperties: false,
    properties: {
      settings: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          show: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(MY_TURN_TOGGLES.map((k) => [k, { type: 'boolean' }])),
          },
          trunkScope: { type: 'string', maxLength: 32 },
          order: {
            type: 'array',
            maxItems: 15,
            items: { type: 'string', maxLength: 32 },
          },
          weights: {
            type: 'object',
            additionalProperties: false,
            properties: {
              proximity: { type: 'integer' },
              stall: { type: 'integer' },
              relevance: { type: 'integer' },
            },
          },
        },
      },
    },
  },
};

/**
 * `MeResponse.ai`. `enabled` is the ONE agentic switch (config.aiEnabled: not LIMN_AI_DISABLED) — the same value that decides whether `registerAgenticRoutes` registers
 * anything. `runtime` is the ACTIVE provider's one-time download (ai/active-runtime.ts: Claude's SDKs, or
 * the Codex program under Codex). `providerSetting` is the Settings → AI choice and who made it
 * (LIMN_AI_PROVIDER wins). `auth` is `detectClaudeAuth`'s
 * disk check (a credentials file or a signed-in `oauthAccount`, never a bare `~/.claude`): it decides only whether a Run button or the one
 * "Sign in to Claude Code or set ANTHROPIC_API_KEY" line shows, never whether the feature is
 * visible — the run itself is the authoritative check. Under Codex it answers for Codex's own install
 * and sign-in (review/auth.ts). Disabled ⇒ the other fields are inert.
 *
 * `kinds` is the SAME pre-flight asked PER RUN KIND (every agent kind, and 'complete' for the one-shot
 * features): under Claude every entry repeats `auth`; under Codex a kind it can run reads 'ok' while
 * the top-level `auth` (no kind = "any agent") stays 'none' until every kind can.
 */
function agenticAiStatus(): MeResponse['ai'] {
  const provider = getActiveProvider().id;
  if (!config.aiEnabled) {
    return {
      enabled: false,
      runtime: 'absent',
      runtimeMessage: null,
      auth: 'none',
      authMessage: null,
      kinds: kindsStatus(() => ({ auth: 'none', message: null })),
      provider,
      providerSetting: aiProviderSettingStatus(),
      providers: {
        claude: { auth: 'none', route: 'none', message: null },
        codex: {
          runtime: 'absent',
          runtimeMessage: null,
          auth: 'none',
          route: 'none',
          signedIn: false,
          plan: null,
          available: false,
          message: null,
          kinds: kindsStatus(() => ({ auth: 'none', message: null })),
        },
      },
    };
  }
  // The ACTIVE provider's download (ai/active-runtime.ts): under Codex, the Codex program — never
  // Claude's — so "Set up AI" and every Run gate ask about what the next run needs.
  const rt = activeRuntimeStatus();
  const auth = detectClaudeAuth();
  // Each provider's OWN facts, whichever is active. Codex's are read from the CACHED `account/read`
  // (a stale cache kicks the background probe; this request never waits on a process).
  const claudeRoute = resolveAiCredential().route;
  const codex = codexDetailCached();
  return {
    enabled: true,
    runtime: rt.runtime,
    runtimeMessage: rt.runtimeMessage,
    auth: auth.status === 'ok' ? 'ok' : 'none',
    authMessage: auth.status === 'ok' ? null : auth.message,
    kinds: kindsStatus((kind) => {
      const r = detectClaudeAuth(kind);
      return r.status === 'ok' ? { auth: 'ok', message: null } : { auth: 'none', message: r.message };
    }),
    provider,
    providerSetting: aiProviderSettingStatus(),
    providers: {
      claude: {
        auth: claudeRoute === 'none' ? 'none' : 'ok',
        route: claudeRoute,
        message: claudeRoute === 'none' ? NO_CLAUDE_AUTH_MESSAGE : null,
      },
      codex: {
        runtime: codex.runtime,
        runtimeMessage: codex.runtimeMessage,
        // ⚠ Only a ChatGPT sign-in can run Codex: the API-key route is refused until it can be priced
        // (its message is ai/codex/detect.ts CODEX_API_KEY_NOT_AVAILABLE_MESSAGE).
        // ⚠ …and only one KNOWN to be ChatGPT: a sign-in no probe has confirmed is not 'ok' yet.
        auth: codex.runnable ? 'ok' : 'none',
        route: codex.route,
        signedIn: codex.signedIn,
        plan: codex.plan,
        available: CODEX_RUNNABLE && codex.runnable,
        message: codex.message ?? (CODEX_RUNNABLE ? null : CODEX_NOT_AVAILABLE_MESSAGE),
        // Codex's OWN answer per run kind, whichever provider is active: a kind no stream has ported
        // yet says so in its own sentence (Phase 3 left `plan` out until a live run passes).
        kinds: kindsStatus((kind) => {
          const r = codexKindStatus(kind);
          return r.status === 'ok' ? { auth: 'ok', message: null } : { auth: 'none', message: r.message };
        }),
      },
    },
  };
}

/** One entry per run kind, in `ALL_RUN_KINDS` order. */
function kindsStatus(of: (kind: AiRunKind) => AiKindStatus): Record<AiRunKind, AiKindStatus> {
  return Object.fromEntries(ALL_RUN_KINDS.map((k) => [k, of(k)])) as Record<AiRunKind, AiKindStatus>;
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (req): Promise<MeResponse> => {
    const accountId = accountIdOf(req);
    const user = accountToLocalUser(req.account);
    const mlStatus = getMlStatus();
    return {
      user,
      // NOTE: this response deliberately carries NO My-Turn counts. It used to return a
      // `counts` object (a whole `getMyTurn` fold) plus `feedLastSeenAt`/`newFeedItems` (a
      // second fold over the feed) for the Welcome-back banner. The banner is now
      // per-workspace and reads standing `my_turn` card counts off the daily brief, so all
      // three had no reader left and were pure per-request work on the SPA's first call.
      // If you need a count here again, prefer the brief's fold over re-adding one.
      // THE AGENTIC FEATURES — Claude Review (+ chat, follow-up, ticket check, auto review),
      // AI Fix.
      ai: agenticAiStatus(),
      // ML severity/category enrichment of bot comments. True iff something can score bot comments right now: the local model once it is set
      // up, or a configured severity-api.
      mlSeverity: isMlScoringAvailable(),
      // The local scorer's one-time download, when this deployment can run one at all.
      ...(config.mlLocalEnabled ? { ml: { state: mlStatus.state, message: mlStatus.message } } : {}),
      // The in-app merge conflict resolver. Always registered — so this is a constant, kept on the wire because the SPA gates its "Resolve conflicts"
      // button on it and a field that disappears is a field every caller has to re-learn.
      // ⚠ NOT a git-version probe: /api/me does not shell out on every SPA boot. A git too old
      // for `merge-tree --write-tree` is refused by the OPEN route with `git_too_old`.
      conflictResolver: true,
      // Chronology's default working-hours zone for a workspace that never set one.
      workTimeZone: config.defaultWorkTimezone,
      // The LARGE-PR FLAG's threshold, RESOLVED (stored value, else the product default) so no
      // renderer has to know about the null.
      largePrCodeLocThreshold: resolveLargePrThreshold(
        req.account?.largePrCodeLocThreshold ?? null,
      ),
      largePrCodeLocThresholdIsDefault: req.account?.largePrCodeLocThreshold == null,
      // The BLAST-RADIUS reading settings, RAW and nullable — the one place this response does
      // NOT resolve a default, and deliberately. The defaults are an 18-number table across
      // three dial positions living in `packages/shared`, which is types-only on this side
      // (PACKAGING); resolving here would mean hand-mirroring it forever. The SPA's one
      // `resolveBlastConfig()` imports that table as a real value instead, so `null` travels and
      // nothing is duplicated.
      blastRadius: req.account?.blastRadiusConfig ?? null,
      // The MY TURN settings, RAW and nullable (the stored overrides) — the `blastRadius` rule: the
      // SPA resolves them through the ONE `resolveMyTurnSettings`, so nothing is duplicated here.
      myTurnSettings: req.account?.myTurnSettings ?? null,
      // Orgs currently SAML-blocked for this account (empty in the normal case).
      authNotices: getAuthNotices(accountId),
    };
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
  // Rate tier: the schema-validated single-column UPDATE falls through `tierFor` to the blanket
  // `read` bucket, which is DECIDED (and pinned in rate-limit.test.ts), not inherited — it reaches
  // no GitHub API and no model.
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

  // The MY TURN settings — the third ONE-PER-ACCOUNT setting on this route: which card types count
  // as your turn, the order My turn groups them in, and the Do next weights every Pending tab
  // ranks by. Account-grained because one account is one reader, in every workspace.
  //
  // A PUT (the body is the WHOLE settings object, replacing the stored one). ⚠ ECHOES WHAT WAS
  // STORED: `setMyTurnSettings` compacts to overrides only, so a sent default is not stored and
  // Settings must render what the database holds, not what it sent.
  //
  // No 404: the target is the caller's own account (an unauthenticated cloud call is a 401 at the
  // gate). Both modes, every tier — the feature is free. Rate tier `read`, DECIDED and pinned in
  // rate-limit.test.ts: one validated UPDATE, no GitHub and no model.
  app.put('/api/me/my-turn-settings', { schema: myTurnSettingsSchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { settings } = req.body as MyTurnSettingsBody;
    if (settings !== null) {
      const problem = validateMyTurnSettings(settings);
      if (problem != null) {
        return reply.code(400).send({ error: 'InvalidMyTurnSettings', message: problem });
      }
    }
    const stored = await setMyTurnSettings(accountId, settings);
    // The brief's roll-up counts are cached for five minutes; a save that switched a type off
    // must not leave "Elsewhere" lines counting it until the TTL runs out.
    clearDailyBriefCountsFor(accountId);
    const body: MyTurnSettingsResponse = { status: 'ok', myTurnSettings: stored };
    return body;
  });

  // Access + portability: the whole account as one JSON document (db/export-account.ts). Erasure
  // is deleting the local database file.
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

  // The account-wide inbox. Unscoped on purpose (see `getMyTurn`): the browser-notification
  // watcher reads exactly this call — and without `onePerPr`, which is the board's rule.
  app.get('/api/my-turn', async (req) => getMyTurn(accountIdOf(req)));

  // DISMISS / BRING BACK one My Turn subject — a pull request (`pr`) or, for a red default branch,
  // a repository (`repo`). ⚠ NOT the "Done" routes 0060 deleted: a dismissal lasts only until
  // something newer happens on the subject, and a subject that leaves your plate discharges it
  // (db/my-turn-dismissals.ts). DB-only, both modes, free.
  //
  // The id is in the PATH; ownership is checked (→ 404, so the family is no existence oracle) and
  // the composite FK refuses a cross-account pair in the database regardless.
  app.put('/api/my-turn/dismissals/:kind/:id', async (req, reply) => {
    const target = parseDismissTarget(req.params);
    if (target == null) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Unknown My Turn entry.' });
    }
    const accountId = accountIdOf(req);
    const at = await dismissMyTurn(accountId, target);
    if (at == null) return reply.code(404).send({ error: 'NotFound', message: 'Not found' });
    // The brief's roll-up counts are cached for five minutes; a dismissed item must not go on
    // being counted in the "Elsewhere" lines until the TTL runs out.
    clearDailyBriefCountsFor(accountId);
    const body: MyTurnDismissResponse = { target, dismissedAt: at.toISOString() };
    return body;
  });

  app.delete('/api/my-turn/dismissals/:kind/:id', async (req, reply) => {
    const target = parseDismissTarget(req.params);
    if (target == null) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Unknown My Turn entry.' });
    }
    const accountId = accountIdOf(req);
    // Scoped on the row itself, so another account's id deletes nothing — and answers 404.
    if (!(await restoreMyTurn(accountId, target))) {
      return reply.code(404).send({ error: 'NotFound', message: 'Not found' });
    }
    clearDailyBriefCountsFor(accountId);
    return reply.code(204).send();
  });
}

/** `:kind/:id` → a target, or null for anything else (a non-integer id, an unknown kind). */
export function parseDismissTarget(params: unknown): MyTurnDismissTarget | null {
  const p = (params ?? {}) as { kind?: unknown; id?: unknown };
  if (p.kind !== 'pr' && p.kind !== 'repo') return null;
  const raw = typeof p.id === 'string' ? p.id : '';
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? { kind: p.kind, id } : null;
}
