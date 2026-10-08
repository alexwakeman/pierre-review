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
  getWorkspaceMetricsDetail,
  getWorkspaceMetricsForScope,
  resolveWorkspaceScope,
} from '../../db/queries.js';
import { getWorkspaceRepoActivity } from '../../db/repo-activity.js';
import { getWorkspaceMergedReach } from '../../db/merged-reach.js';
import { getReportingWindow, reportingWindowInfo } from '../../db/reporting-window.js';
import { buildPendingBoard } from '../../db/pending-tabs.js';
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
  // THE REPORTING WINDOW (db/reporting-window.ts) is resolved ONCE here and handed to every fold
  // below — the tiles, the per-repo activity and the merged-in-window reach — and echoed as
  // `window`, so every card in the section measures and names the same window: this sprint so far
  // when the workspace has a sprint cadence, else the trailing 7/14 days. The "Right now" tiles
  // (open PRs, red checks) and the 12-week trend band are the labelled exceptions.
  //
  // It also carries `repoActivity` and `reach` — the "where is the work happening?" pair under the
  // same heading. RIDING THIS RESPONSE RATHER THAN A ROUTE OF ITS OWN IS THE DECISION: the same
  // scope and window resolved once, painted in the same section, and neither multiplies by
  // anything (indexed window scans, the lane resolver's fixed handful, one co-change lookup), so
  // `/api/workspace-metrics` keeps the `read` fall-through that api/plugins/rate-limit.ts records
  // for it.
  app.get('/api/workspace-metrics', async (req): Promise<WorkspaceMetricsResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const nowMs = Date.now();
    const window = await getReportingWindow(accountId, scope.workspaceId, nowMs);
    const [metrics, repoActivity, reach] = await Promise.all([
      getWorkspaceMetricsForScope(accountId, scope.repoIds, window),
      getWorkspaceRepoActivity(accountId, scope, nowMs, window),
      getWorkspaceMergedReach(accountId, scope, nowMs, window),
    ]);
    // `workspaceId` is the scope echo every scoped response owes the client (docs/API.md) — this
    // route was the one that never sent it, so a SPA holding a stale `?workspace=` had no way to
    // learn it had been resolved to Default.
    return {
      metrics,
      workspaceId: scope.workspaceId,
      window: reportingWindowInfo(window, nowMs),
      ...(repoActivity != null ? { repoActivity } : {}),
      ...(reach != null ? { reach } : {}),
    };
  });

  // The PR lists behind each flow-metric tile (the tile drill-down) — also CORE/free, so a Feed
  // tile opens the same drill-down for everyone. Mirrors the Pro route's `{enabled, detail}` shape
  // (enabled always true here). Same workspace resolution as its sibling above.
  app.get('/api/workspace-metrics/detail', async (req): Promise<WorkspaceMetricsDetailResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    // The SAME reporting window the tiles were measured over, or a tile and its drill-down would
    // list two different windows' pull requests.
    const window = await getReportingWindow(accountId, scope.workspaceId);
    const detail = await getWorkspaceMetricsDetail(accountId, window, scope.repoIds);
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
  // SERVED AS SIX TABS (`db/pending-tabs.ts`), each a scored list with its uncapped count — My
  // turn grouped by the reader's type order and Dependencies by kind (security, then bumps) — free
  // on every tier. The rank is code, with the reader's weights; only the Pro plan's NARRATION is
  // paid.
  //
  // ⚠ THE TABS ARE AN ALLOW-LIST (`PENDING_TABS`), so a NEW InsightKind reaches this board only
  // once it is given a tab — otherwise it is folded, counted and never listed. pending-tabs.test.ts
  // fails when a non-bot kind has no tab, rather than letting it vanish quietly.
  app.get('/api/attention', async (req): Promise<AttentionCardsResponse> => {
    const q = req.query as { workspace?: string };
    // THE ONE FOLD (`buildPendingBoard`, db/pending-tabs.ts) — the Pro Slack digest reads the same
    // function through `ProHostQueries.getPendingBoard`, so the two cannot drift. `live: true` is
    // THIS route only: failing-check names on red cards (the brief, the work plan and the Pro
    // payloads render no names, and must not pay for them or hash them) and suggested reviewers
    // for the top "Needs a reviewer" cards.
    const { workspaceId: _ws, ...board } = await buildPendingBoard(accountIdOf(req), q.workspace, {
      live: true,
    });
    return board;
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
