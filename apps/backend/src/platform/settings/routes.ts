import type { FastifyInstance } from 'fastify';
import type {
  ProSettings,
  WorkspaceProSettings,
  WorkspaceProSettingsUpdate,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { REPORT_MODELS } from '../llm/seam.js';
import { resolveRequestWorkspaceId } from '../insights/workspace-request.js';
import {
  readProSettings,
  readWorkspaceProSettings,
  writeProSettings,
  writeWorkspaceSettings,
  type ProSettingsPatch,
} from './store.js';

// Fastify body schema for the PATCH. Every section + field is optional (a partial patch); the
// store re-validates/clamps too. Enums are enforced here so bad values 400 before reaching the DB.
const updateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sprint: {
      type: 'object',
      additionalProperties: false,
      // ⚠ THE WHOLE SECTION IS EMPTY, AND THAT IS THE POINT. `cadenceDays` / `startDate` moved to
      // the WORKSPACE grain in plugin migration 0031 and `comparisonMode` in plugin 0032 — none of
      // the three has an account-level default beneath it. A stale client still sending any of them
      // has the key SILENTLY STRIPPED by `additionalProperties: false` + ajv `removeAdditional` and
      // still gets a 200 — nothing changes, which is right, but silent, hence written down. Their
      // replacement is `PUT /api/pro/settings/workspace` (`{sprint, issue, comparisonMode}`).
      //
      // The empty object is KEPT rather than deleted so a stale `{sprint: {...}}` body is stripped
      // to `{}` rather than 400'ing the whole patch and losing the sections beside it.
      properties: {},
    },
    // (NO `slack` SECTION. The digest moved to the WORKSPACE grain in plugin migration 0030 —
    // `GET/PUT/DELETE /api/pro/slack/target?workspace=`, one row per (account, workspace) in
    // `workspace_slack_targets`. A stale client still sending `{slack: {...}}` here is SILENTLY
    // STRIPPED by `additionalProperties: false` + ajv's `removeAdditional` and still gets a 200:
    // the right outcome — nothing changes — but silent, hence written down.)
    // The period report's narrating model, per account. TOP-LEVEL rather than inside a section
    // because `ProSettingsUpdate` (the settled wire type) declares no `reports` section and this
    // slice does not own that file — see `ProSettingsPatch` in store.ts.
    //
    // MUST BE LISTED, for the reason spelled out on `comparisonMode` above and again on the
    // `bots` section below: `additionalProperties: false` STRIPS an unlisted property and still
    // answers 200, so a missing entry here reads as "the setting silently never saves".
    // The enum is derived from REPORT_MODELS — the SELECTION allowlist, deliberately not the
    // pricing table, which is wider because it still prices models that narrated stored reports.
    // Today that makes this a single-value enum (Haiku): a PUT naming the retired Sonnet 400s,
    // and a row that ALREADY holds it degrades to the default on read rather than erroring, which
    // is `resolveReportModel`'s job. `null` clears back to the PRO_REPORT_MODEL default; the store
    // re-validates either way.
    reportModel: { type: ['string', 'null'], enum: [...REPORT_MODELS, null] },
    // (No `aiUpdate` section — the AI-summary update policy was removed. A stale client still
    // sending one is stripped by `additionalProperties: false` and the PUT still 200s.)
    // (NO `issue` SECTION. The Jira/Linear tracker moved to the WORKSPACE grain in plugin
    // migration 0031 — `GET/PUT /api/pro/settings/workspace` with `{issue: {...}}`, which is also
    // where the new title-only / title+branch match scope lives. Same silent-strip failure mode as
    // the retired `sprint` fields above.)
    // Bot-Triage Platform (WS8). REQUIRED here — additionalProperties:false strips any section the
    // schema omits, so without this the whole `bots` patch is silently dropped before the store.
    bots: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // The five detection fields (inhouseDetect / autoTagHighConfidence / loginAllowlist /
        // deepDetect / aiTiebreak) and the two Limn-attribution ones (tagPierreReviews /
        // pierreFooter) are GONE from the wire; their columns are dormant. A stale client sending
        // them gets a 200 with the keys stripped, not a 400 — see ProSettingsUpdate.
        // NO `slackDigest`. The "Review bots" block became a property of the DELIVERY in plugin
        // migration 0033 (`workspace_slack_targets.bot_digest`, written through
        // `PUT /api/pro/slack/target?workspace=`), so a stale client still sending it here is
        // SILENTLY STRIPPED and still gets a 200 — the standing failure mode for every field
        // retired from this patch.
        autoResolve: { type: 'boolean' },
        autoResolveDays: { type: 'integer', minimum: 1, maximum: 90 },
        cost: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['login', 'monthlyUsd'],
            properties: {
              login: { type: 'string', maxLength: 100 },
              monthlyUsd: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    },
  },
} as const;

// GET/PUT /api/pro/settings — per-account Pro config for the header settings modal. Account-scoped
// via ctx.accountIdOf (never trusts a client id).
//
// ⚠ WHAT IS LEFT HERE IS SMALL, AND THAT IS THE POINT. FIVE per-workspace facts have moved out:
// the Slack digest (plugin 0030 → `/api/pro/slack/target?workspace=`), the sprint cadence + the
// Jira/Linear tracker (plugin 0031 → `/api/pro/settings/workspace?workspace=`, below), the
// comparison-window MODE (plugin 0032, same route — it COMPOSES with the cadence, so one account
// setting produced two different window SHAPES) and the "Review bots" digest block (plugin 0033,
// onto the row that IS the delivery). NONE of them kept an account-level default: two states, no
// chain. What remains genuinely does not fork per team — the narration model and the two vestigial
// `bot_auto_resolve*` toggles. Registered whenever the plugin loads; the SPA gates each modal section on the relevant capability, so an OSS build (no plugin,
// no route) simply shows no settings entry.
export function registerSettingsRoutes(app: FastifyInstance, ctx: ProContext): void {
  app.get('/api/pro/settings', async (req): Promise<ProSettings> => {
    return readProSettings(ctx, ctx.accountIdOf(req));
  });

  app.put<{ Body: ProSettingsPatch }>(
    '/api/pro/settings',
    { schema: { body: updateSchema } },
    async (req): Promise<ProSettings> => {
      return writeProSettings(ctx, ctx.accountIdOf(req), req.body ?? {});
    },
  );

  // ---- The PER-WORKSPACE Pro config: sprint cadence + comparison mode -----------------------
  // (The issue tracker left this route at apiVersion 23 — core `/api/workspaces/:id/tracker`.)
  //
  // ONE route, ONE row (`pro_workspace_settings`), ONE writer. Both settings are per-WORKSPACE and
  // neither has an account-level default beneath it any more (plugin migration 0031).
  //
  // `?workspace=` resolves through `resolveRequestWorkspaceId`: absent / unparseable / unknown /
  // ANOTHER TENANT'S id all degrade to the account's DEFAULT workspace, never a 404 — the same
  // rule every scoped route follows, so this is not an existence oracle either. That resolution is
  // also the FIRST tenancy guard on the write; the SECOND is structural, in the database: plugin
  // migration 0029's named composite FK `pro_workspace_settings_workspace_account_fk` makes the
  // (workspace_id, account_id) PAIR the thing that must exist, so a cross-account pair fails in
  // Postgres/SQLite rather than in whichever handler remembered to check.
  //
  // ⚠ THE PATCH IS PARTIAL AND SECTIONED. The Settings modal has one Save per section, so a
  // `{sprint}` patch must leave the tracker untouched and vice versa — `mergeWorkspace` seeds every
  // column from the stored row for exactly that reason.
  app.get<{ Querystring: { workspace?: string } }>(
    '/api/pro/settings/workspace',
    async (req): Promise<WorkspaceProSettings> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      return readWorkspaceProSettings(ctx, accountId, workspaceId);
    },
  );

  app.put<{ Querystring: { workspace?: string }; Body: WorkspaceProSettingsUpdate }>(
    '/api/pro/settings/workspace',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sprint: {
              type: 'object',
              additionalProperties: false,
              // `cadenceDays` is REQUIRED WITHIN THE SECTION precisely so "clear the cadence" is an
              // explicit ask and never the accidental result of an omitted field.
              required: ['cadenceDays'],
              properties: {
                // `null` CLEARS the cadence — it NULLS the pair; the row survives because it also
                // holds the issue tracker.
                cadenceDays: { type: ['integer', 'null'], minimum: 1, maximum: 90 },
                // ⚠ MUST BE LISTED. ajv runs with `removeAdditional` and this schema is
                // `additionalProperties: false`, so an unlisted property is SILENTLY STRIPPED and
                // the request still answers 200 — the exact way `comparisonMode` and `reportModel`
                // each nearly shipped as a setting that never saved.
                startDate: { type: ['string', 'null'] },
              },
            },
            // (NO `issue` section since apiVersion 23: the tracker moved to CORE —
            // `PUT /api/workspaces/:id/tracker`. A stale client's key is STRIPPED by
            // `additionalProperties: false` and the PUT still 200s; nothing is written.)
            // ⚠ MUST BE LISTED, and it is the NEWEST field on this route (plugin migration 0032)
            // and therefore the likeliest to be forgotten: ajv runs with `removeAdditional` and
            // this schema is `additionalProperties: false`, so an unlisted property is SILENTLY
            // STRIPPED and the PUT still answers 200 — a setting that never saves, with no error
            // anywhere. TOP-LEVEL rather than inside `sprint` because that section declares
            // `cadenceDays` REQUIRED (so clearing a cadence is always explicit), which would make a
            // mode-only patch impossible to express.
            comparisonMode: { type: 'string', enum: ['rolling_7', 'rolling_14', 'sprint'] },
            // (NO `jira` section either — same move, same route, same silent strip.)
            // (NO `autoReview` section: auto Claude review moved to core with Claude Review —
            // `PUT /api/workspaces/:id/auto-review`. A stale client's key is STRIPPED by
            // `additionalProperties: false` and the PUT still 200s.)
          },
        },
      },
    },
    async (req): Promise<WorkspaceProSettings> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      const body = req.body ?? {};
      return writeWorkspaceSettings(ctx, accountId, workspaceId, body);
    },
  );
}
