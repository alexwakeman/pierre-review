import type { FastifyInstance } from 'fastify';
import type {
  AttentionCardsResponse,
  AttentionLivenessBody,
  AttentionLivenessResponse,
  InsightsResponse,
  RepoAnalytics,
  WorkspaceMetricsDetailResponse,
  WorkspaceMetricsResponse,
} from '@pierre-review/shared';
import {
  getInsights,
  getRepoAnalytics,
  getWorkspaceInsights,
  getWorkspaceMetricsDetail,
  getWorkspaceMetricsForScope,
  resolveWorkspaceScope,
} from '../../db/queries.js';
import { getWorkspaceRepoActivity } from '../../db/repo-activity.js';
import { doNextCardIds, rankWorkPlan } from '../../db/work-plan.js';
import {
  PR_LIVENESS_MAX_IDS,
  sweepPrLiveness,
} from '../../sync/pr-liveness-sweep.js';
import { accountIdOf } from '../plugins/auth.js';

// The liveness body. `maxItems` is a coarse guard only — the real cap is applied in the handler
// AFTER de-duplication (a board legitimately renders several cards for one PR), and it 400s
// rather than truncating.
const livenessSchema = {
  querystring: {
    type: 'object',
    properties: { workspace: { type: 'string' } },
  },
  body: {
    type: 'object',
    required: ['prIds'],
    additionalProperties: false,
    properties: {
      prIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        minItems: 1,
        maxItems: 400,
      },
    },
  },
};

function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  // Per-repo sprint stats for the Insights panel. Scoped to the account; `repoIds` narrows to the
  // repos the CALLER names. NOT workspace-scoped: it is a per-repo snapshot the caller already
  // names its repos for, so there is no scope for a workspace to decide.
  app.get('/api/insights', async (req): Promise<InsightsResponse> => {
    const q = req.query as { repoIds?: string };
    return getInsights({
      accountId: accountIdOf(req),
      repoIds: parseIntList(q.repoIds),
    });
  });

  // Workspace flow-metric header (DORA-ish tiles + trend charts) — CORE/free. It sits under the
  // "Flow metrics" heading on the REPORTS rail entry, not the Feed: a workspace-wide survey on top
  // of a chronological stream pushed the feed two screens down, and it is precisely why the Reports
  // entry is ungated on every tier.
  //
  // `?workspace=<id>` is the ONE scope parameter: `resolveWorkspaceScope` resolves an absent,
  // unparseable, unknown or foreign id to the account's DEFAULT workspace (never a 404 — every id
  // yields the same response shape, so it is not an existence oracle, and the resolved id is always
  // one the caller owns). Its `repoIds` are that workspace's membership, and `[]` — a workspace
  // with no repos — is a legal state that yields `metrics: null`, NOT "every repo in the account".
  // NO `narrow` is passed: Reports covers every repo in the workspace (the repo picker is
  // Timeline-only), so this route takes no `?repoIds=` and must not gain one.
  //
  // It also carries `repoActivity` — the "where is the work happening?" per-repo breakdown under
  // the same heading. RIDING THIS RESPONSE RATHER THAN A ROUTE OF ITS OWN IS THE DECISION: it is
  // the same scope resolved once, the same 14-day window, painted in the same section by the same
  // component, and it multiplies by nothing (two indexed scans plus the lane resolver's fixed
  // handful), so `/api/workspace-metrics` keeps the `read` fall-through that api/plugins/
  // rate-limit.ts records for it. A second route would have re-resolved the scope, doubled the
  // round trips for one panel, and needed a tier decision to say the same thing.
  app.get('/api/workspace-metrics', async (req): Promise<WorkspaceMetricsResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const [metrics, repoActivity] = await Promise.all([
      getWorkspaceMetricsForScope(accountId, scope.repoIds),
      getWorkspaceRepoActivity(accountId, scope, Date.now()),
    ]);
    // `workspaceId` is the scope echo every scoped response owes the client (docs/API.md) — this
    // route was the one that never sent it, so a SPA holding a stale `?workspace=` had no way to
    // learn it had been resolved to Default.
    return {
      metrics,
      workspaceId: scope.workspaceId,
      ...(repoActivity != null ? { repoActivity } : {}),
    };
  });

  // The PR lists behind each flow-metric tile (the tile drill-down) — also CORE/free, so a Feed
  // tile opens the same drill-down for everyone. Mirrors the Pro route's `{enabled, detail}` shape
  // (enabled always true here). Same workspace resolution as its sibling above.
  app.get('/api/workspace-metrics/detail', async (req): Promise<WorkspaceMetricsDetailResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const detail = await getWorkspaceMetricsDetail(accountId, undefined, scope.repoIds);
    return { enabled: true, detail };
  });

  // (GET /api/workspace-metrics/compare was DELETED with the "Compare workspaces" rail entry —
  // cross-workspace comparison now lives inside Reports as the plugin-served "By workspace" axis,
  // which rides the window-pure getPeriodMetricsForWorkspaces seam instead of the snapshot
  // WorkspaceMetrics matrix.)

  // The attention cards (your turn / red builds that are yours / stalled reviews / untouched
  // threads / reviewer load / needs-a-reviewer / ready-to-land / behind-trunk) — CORE/free (the
  // same cards Pro Insights computes in core getWorkspaceInsights), for the **Pending** rail
  // entry. The bot cards are excluded (they live in the free Bots console).
  //
  // IT ALSO SERVES THE RANKED "DO NEXT" HEAD, free on every tier — `doNextIds`, the card ids in
  // `db/work-plan.ts`'s deterministic score order. The rank is code; only its NARRATION is Pro.
  //
  // ⚠ THIS FILTER IS A DENY-LIST OF EXACTLY TWO KINDS, and it must stay one: a new InsightKind
  // ships here by default, which is the behaviour every non-bot kind wants. It is also one of the
  // two hand-maintained spellings of "which kinds count" — the other is computeBriefCounts' if/else
  // chain — and `daily-brief.test.ts` compares them per kind so a kind added to one and not the
  // other fails rather than reproducing "header 5, list 3".
  //
  // It passes the whole `BotScope`, not just the repo ids: getWorkspaceInsights needs the
  // workspaceId to know who counts as an automated reviewer for its bot cards. Those two cards are
  // filtered out here, but the scope is what the getter's signature is about and splitting it would
  // put a second, differently-shaped answer to "which workspace" on this route.
  app.get('/api/attention', async (req): Promise<AttentionCardsResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const insights = await getWorkspaceInsights(accountId, undefined, scope);
    const cards = insights.cards.filter(
      (c) => c.kind !== 'bot_signal' && c.kind !== 'bot_only_review',
    );
    // ⚠ ONE FOLD, RANKED — `rankWorkPlan` takes the insights we already have rather than
    // re-folding them. Two folds in one request would be two populations one refresh apart,
    // which is precisely the defect the Pending consolidation removed.
    const evidence = await rankWorkPlan(accountId, scope, insights);
    // ⚠ THE HEAD MUST BE A STRICT SUBSET OF WHAT THE BOARD RENDERS. No work-plan row can be a bot
    // card today, so this filter is belt-and-braces — but if one ever could, an id here with no
    // card behind it would silently cost the board a head slot rather than erroring.
    const rendered = new Set(cards.map((c) => c.id));
    const doNextIds = doNextCardIds(evidence).filter((id) => rendered.has(id));
    return { cards, users: insights.users, doNextIds };
  });

  // POST /api/attention/liveness — THE BOARD'S ONE GITHUB QUESTION.
  //
  // The route above is DB-only and must stay that way: it is the board's paint path, and a
  // GitHub call inside it would be the 200-calls-to-render-fifty-cards failure the board exists
  // to avoid. This is its sibling — one batched `nodes(ids:)` sweep for the WHOLE board, so a PR
  // merged by somebody else stops being a card within seconds instead of within an adaptive
  // bucket (2-15 min). Cost is 2 GraphQL points per sweep, measured; the mechanics and the
  // measured wall-time cliff that forces two passes are in sync/pr-liveness-sweep.ts and
  // github/queries.ts's PR_LIVENESS_NODES_QUERY header.
  //
  // ⚠ IT RETURNS COUNTS, NEVER CARDS. `changed > 0` tells the SPA to refetch the board and the
  // brief TOGETHER; it must never splice a card out locally (that breaks `capFor`'s
  // `shown === count` guard and silently deletes the cap disclosure). Keeping cards out of this
  // response is what makes that structural rather than a rule someone has to remember.
  //
  // ⚠ A POST WITH A GET'S COST, deliberately: the id list is a body (a query string of 90 ids is
  // a header-size question nobody should have), and a POST puts it behind the cross-origin guard
  // in cloud. That is the `POST /api/reactions/lookup` shape exactly, and it takes the same
  // `prDetail` tier — spelled as an EXACT match in tierFor, because nothing else would catch it.
  //
  // Rate-limit PAUSES are reported, never thrown: `paused` is a fact about the tenant's GitHub
  // window, and the board renders its synced rows through it.
  app.post(
    '/api/attention/liveness',
    { schema: livenessSchema },
    async (req, reply): Promise<AttentionLivenessResponse> => {
      const q = req.query as { workspace?: string };
      const { prIds } = req.body as AttentionLivenessBody;
      const accountId = accountIdOf(req);
      // ⚠ 400 ON OVER-CAP, NEVER A TRUNCATION (the peer benchmark's `?cells=` rule): a caller
      // whose tail was silently dropped believes its whole board was freshened. `additionalItems`
      // in the schema cannot express "dedupe then count", so the cap is checked here after the
      // dedupe the client is asked to do anyway.
      const unique = [...new Set(prIds)];
      if (unique.length > PR_LIVENESS_MAX_IDS) {
        return reply.code(400).send({
          error: 'TooManyIds',
          message: `At most ${PR_LIVENESS_MAX_IDS} PR ids per liveness sweep (received ${unique.length}).`,
        }) as never;
      }
      // `?workspace=` is THE scope parameter — absent/unknown/foreign resolves to the account's
      // DEFAULT workspace, never a 404, and the resolved id is echoed. Its `repoIds` are what
      // bound the id resolve below, so a PR the caller owns in ANOTHER workspace is not swept
      // here: the board that asked is the board that gets refreshed.
      const scope = await resolveWorkspaceScope(accountId, q.workspace);
      const swept = await sweepPrLiveness({
        accountId,
        repoIds: scope.repoIds,
        prIds: unique,
        log: req.log,
      });
      // null = a sweep for this account is already in flight (two tabs, or an interval overlapping
      // its own focus refetch). A no-op report, not an error: the running sweep is about to
      // produce this very answer, and the caller's next tick will see its effect.
      if (!swept) {
        return {
          workspaceId: scope.workspaceId,
          checked: 0,
          mergeStateChecked: 0,
          changed: 0,
          leftOpenSet: 0,
          paused: null,
        };
      }
      return { workspaceId: scope.workspaceId, ...swept };
    },
  );

  // Heavier per-repo analytics for the drill-down chart panel — loaded on demand.
  // Ownership-scoped: a repo not owned by the account 404s.
  app.get('/api/insights/:repoId/analytics', async (req, reply): Promise<RepoAnalytics> => {
    const { repoId } = req.params as { repoId: string };
    const id = Number.parseInt(repoId, 10);
    const data = Number.isFinite(id)
      ? await getRepoAnalytics(accountIdOf(req), id)
      : null;
    if (!data) return reply.code(404).send({ error: 'repo not found' }) as never;
    return data;
  });
}
