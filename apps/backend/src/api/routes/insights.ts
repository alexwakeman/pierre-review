import type { FastifyInstance } from 'fastify';
import type {
  AttentionCardsResponse,
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
import { accountIdOf } from '../plugins/auth.js';

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

  // Workspace flow-metric header (DORA-ish tiles + trend charts) — CORE/free (it sits in the Feed,
  // not the Pro Insights pane).
  //
  // `?workspace=<id>` is the ONE scope parameter: `resolveWorkspaceScope` resolves an absent,
  // unparseable, unknown or foreign id to the account's DEFAULT workspace (never a 404 — every id
  // yields the same response shape, so it is not an existence oracle, and the resolved id is always
  // one the caller owns). Its `repoIds` are that workspace's membership, and `[]` — a workspace
  // with no repos — is a legal state that yields `metrics: null`, NOT "every repo in the account".
  app.get('/api/workspace-metrics', async (req): Promise<WorkspaceMetricsResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    return { metrics: await getWorkspaceMetricsForScope(accountId, scope.repoIds) };
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
  // threads / reviewer load / needs-a-reviewer) — CORE/free (the same cards Pro Insights computes
  // in core getWorkspaceInsights), for the Feed "Needs attention" tab. The bot cards are excluded
  // (they live in the free Bots console).
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
    return { cards, users: insights.users };
  });

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
