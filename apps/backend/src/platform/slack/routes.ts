import type { FastifyInstance } from 'fastify';
import type { WorkspaceSlackTargetResponse, WorkspaceSlackTargetUpdate } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { resolveRequestWorkspaceId } from '../insights/workspace-request.js';
import { buildSlackReport } from './report.js';
import { postToSlack } from './send.js';
import {
  SlackTargetBadWebhookError,
  SlackTargetCapError,
  SlackTargetMissingWebhookError,
  deleteTarget,
  readTarget,
  readTargetRow,
  writeTarget,
} from './targets.js';

// ── GET/PUT/DELETE /api/pro/slack/target + POST /api/pro/slack/test ──────────────────────────
//
// The Slack delivery configuration for ONE workspace — the one named by `?workspace=`.
//
// ⚠ THERE IS NO WORKSPACE PICKER AND NO LIST ENDPOINT. `GET/PUT /api/pro/slack/targets` (plural)
// is DELETED. Settings are for the CURRENT workspace, so the scope arrives the way it does on
// every other scoped route — a query parameter resolved by `resolveRequestWorkspaceId`, where
// absent / unparseable / unknown / ANOTHER TENANT'S id all degrade to the account's DEFAULT
// workspace and never 404 (no existence oracle). That resolution is the whole tenancy story on
// this route now: the id never arrives in a body, and the named composite FK
// `workspace_slack_targets_workspace_account_fk` is still the structural backstop underneath it.
//
// ⚠ THE WEBHOOK URL IS WRITE-ONLY. The GET returns `configured`, never the URL. Do not add it to
// the response "so the field can be prefilled" — that turns every read of this route into a secret
// disclosure.
//
// ⚠ DELETE IS THE OFF SWITCH, AND IT IS A VERB. Under the old whole-selection PUT, "stop sending
// to this workspace" was expressed by OMITTING it from a submitted list — which meant any client
// bug that shortened the list silently cancelled deliveries. `cadence: 'off'` pauses and keeps the
// channel; DELETE removes the row and frees a slot under the cap.

const updateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // ⚠ EVERY FIELD MUST BE LISTED. ajv runs with `removeAdditional` and this schema is
    // `additionalProperties: false`, so an unlisted property is SILENTLY STRIPPED and the request
    // still answers 200 — the exact way `comparisonMode`, `reportModel` and `startDate` each
    // nearly shipped as a setting that never saved.
    webhookUrl: { type: 'string', maxLength: 500 },
    cadence: { type: 'string', enum: ['off', 'daily', 'twice_daily'] },
    hour1: { type: 'integer', minimum: 0, maximum: 23 },
    hour2: { type: 'integer', minimum: 0, maximum: 23 },
    timezone: { type: ['string', 'null'], maxLength: 100 },
    // ⚠ MUST BE LISTED, same reason as every field above — this one is the newest (plugin
    // migration 0033) and therefore the likeliest to be forgotten. Include the deterministic
    // "Review bots" block in THIS delivery; omitted = unchanged.
    botDigest: { type: 'boolean' },
    // ⚠ MUST BE LISTED — the two event signals (plugin migration 0040). Omitted = unchanged.
    notifyReviews: { type: 'boolean' },
    notifyMerges: { type: 'boolean' },
  },
} as const;

export function registerSlackRoutes(
  app: FastifyInstance,
  ctx: ProContext,
  llm: LlmClient,
): void {

  app.get<{ Querystring: { workspace?: string } }>(
    '/api/pro/slack/target',
    async (req): Promise<WorkspaceSlackTargetResponse> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      return readTarget(ctx, accountId, workspaceId);
    },
  );

  app.put<{ Querystring: { workspace?: string }; Body: WorkspaceSlackTargetUpdate }>(
    '/api/pro/slack/target',
    { schema: { body: updateSchema } },
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      try {
        await writeTarget(ctx, accountId, workspaceId, req.body ?? {});
      } catch (err) {
        // Three shaped refusals, all 400 with a message the UI shows verbatim. ⚠ THE CAP REFUSES
        // RATHER THAN SILENTLY ACCEPTING: every configured workspace is its own billed report on
        // every send, so admitting one past the bound would be a bill nobody agreed to.
        if (
          err instanceof SlackTargetCapError ||
          err instanceof SlackTargetMissingWebhookError ||
          err instanceof SlackTargetBadWebhookError
        ) {
          return reply.code(400).send({ message: err.message });
        }
        throw err;
      }
      return reply.send(await readTarget(ctx, accountId, workspaceId));
    },
  );

  app.delete<{ Querystring: { workspace?: string } }>(
    '/api/pro/slack/target',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      await deleteTarget(ctx, accountId, workspaceId);
      // Answers with the same shape as GET/PUT (`target: null`), so one client cache key holds the
      // result of all three verbs and the UI never has to invent the post-delete state.
      return reply.send(await readTarget(ctx, accountId, workspaceId));
    },
  );

  // Manual "Send test" — build ONE workspace's report fresh and POST it to that workspace's
  // webhook now.
  //
  // ⚠ IT IS THE SAME BILLED PATH THE CRON TAKES (`refreshSprintReport` + the account-wide digest
  // refresh), which is why it sits on the AI rate-limit tier in the host's `tierFor`. It has always
  // taken ONE workspace; now that every route in this family does, the reason is worth restating —
  // a "test" that generated twelve reports would be the most expensive button in the app.
  //
  // `?workspace=` resolves through `resolveRequestWorkspaceId` — absent / unparseable / unknown /
  // another tenant's id all degrade to the account's DEFAULT workspace, never a 404 (no existence
  // oracle), the same rule every scoped route follows.
  app.post<{ Querystring: { workspace?: string } }>('/api/pro/slack/test', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
    const row = await readTargetRow(ctx, accountId, workspaceId);
    if (row == null || row.webhookUrl.trim() === '') {
      return reply
        .code(400)
        .send({ sent: false, message: 'No Slack webhook configured for this workspace.' });
    }
    const message = await buildSlackReport(ctx, llm, accountId, workspaceId);
    if (message == null) {
      return reply.send({
        sent: false,
        message: 'Nothing to report yet — add repos / let a sync run.',
      });
    }
    try {
      await postToSlack(row.webhookUrl, message);
      return reply.send({ sent: true });
    } catch (err) {
      // Log the real error for the operator; return a GENERIC message to the caller. Echoing
      // `err.message` back made this route an SSRF read primitive: the webhook URL is
      // user-supplied, so whatever the target replied came straight back in the response body.
      // postToSlack now validates the host and withholds the body, and this is the second half
      // of that fix — the caller learns "it didn't work", not what the target said.
      // ⚠ AND THE URL ITSELF IS NEVER LOGGED. Account + workspace locate the row.
      ctx.log.warn({ err, accountId, workspaceId }, 'slack test send failed');
      return reply.code(502).send({
        sent: false,
        message:
          'Slack rejected the message. Check the webhook URL is a current ' +
          'https://hooks.slack.com/services/… URL and try again.',
      });
    }
  });
}
