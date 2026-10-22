// The verification loop's plugin half: resolve ANCHORS (config-event log — which already
// includes merged advisor PRs via store.promoteMergedPrs) and hand a timestamp to the core
// math. Decoupling is structural: ctx.queries.getBotEffectPanel never sees a recommendation,
// so a 'user_reported' anchor measures a change Limn never authored exactly like one it did.
import type { AdvisorEffectPanel, AdvisorEffectResponse } from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../../contract.js';
import { listConfigEvents } from '../store.js';

export async function getEffectResponse(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  botUserId: number,
): Promise<AdvisorEffectResponse> {
  const events = await listConfigEvents(ctx, accountId, scope.workspaceId, botUserId);
  // The MOST RECENT anchor splits the panel; older anchors ride along for the UI's timeline.
  // No anchors → null ⇒ the core query runs unattributed changepoint detection.
  const anchorMs = events[0]?.occurredAtMs ?? null;
  const panel = (await ctx.queries.getBotEffectPanel(
    accountId,
    scope,
    botUserId,
    anchorMs,
  )) as AdvisorEffectPanel;
  return {
    enabled: true,
    panel,
    anchors: events.map((e) => ({
      ms: e.occurredAtMs,
      source: e.source,
      description: e.description,
    })),
  };
}
