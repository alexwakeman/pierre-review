import type { FastifyInstance } from 'fastify';
import {
  STORY_REPORT_WINDOW_CHOICES,
  parseStoryReportWindow,
  type StartStoryReportResponse,
  type StoryReportErrorBody,
  type StoryReportResponse,
  type StoryReportsResponse,
  type StoryReportWindowChoice,
} from '@pierre-review/shared';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { loadStorySelection, type StorySelection } from '../../db/story-selection.js';
import { reportsEntitled } from '../../api/routes/insights.js';
import type { AgentContext } from '../agent-context.js';
import { fingerprintPickOf, storyReportFingerprint } from './fingerprint.js';
import {
  cancelStoryReport,
  claimStoryReportSlot,
  latestStoryReports,
  loadStoryReport,
  releaseStoryReportSlot,
  runningStoryReport,
  startStoryReport,
  storyReportRecordOf,
  storyReportSlotId,
} from './manager.js';

// THE STORY REPORT'S ROUTES (docs/API.md § Story report; docs/CLAUDE-REVIEW.md § Story report).
// Registered ONLY through `registerAgenticRoutes` — its explicit `isCloud` check is the cloud
// guarantee (the routes 404 there). Pro with the rest of Reports: `reportsEntitled` false → 402
// BEFORE any DB work, identical for every id/workspace (no oracle). The workspace always goes
// through `resolveWorkspaceScope`: an unknown or another tenant's id degrades to the caller's
// Default, never a 404, and every response echoes the workspace used.
//
//   GET  /api/story-reports?workspace=&window=   picks + figures NOW (code) + stored runs   → read
//   POST /api/story-reports {workspaceId, window} the ONLY path that runs the model         → ai + ai_hourly
//   GET  /api/story-reports/:id                  one run (the SPA polls while in flight)    → read
//   POST /api/story-reports/:id/cancel           abort; spends nothing                      → read

const PRO_REQUIRED = { error: 'pro required' } as const;

const fingerprintOf = (choice: StoryReportWindowChoice, sel: StorySelection): string =>
  storyReportFingerprint(
    choice,
    sel.candidates.flatMap((c) => {
      const s = sel.internalsByKey.get(c.key);
      return s != null ? [fingerprintPickOf(s)] : [];
    }),
  );

const parseId = (raw: unknown): number | null => {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function registerStoryReportRoutes(app: FastifyInstance, ctx: AgentContext): void {
  /** A succeeded run's currency against today's picks for its own workspace + window. */
  const currencyOf = async (
    accountId: number,
    row: { status: string; workspaceId: number; windowChoice: string; fingerprint: string },
  ): Promise<'current' | 'stale' | null> => {
    if (row.status !== 'succeeded') return null;
    const scope = await resolveWorkspaceScope(accountId, row.workspaceId);
    const choice = parseStoryReportWindow(row.windowChoice);
    const sel = await loadStorySelection(accountId, scope, choice, Date.now());
    return fingerprintOf(choice, sel) === row.fingerprint ? 'current' : 'stale';
  };

  app.get('/api/story-reports', async (req, reply): Promise<StoryReportsResponse | { error: string }> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return PRO_REQUIRED;
    }
    const q = req.query as { workspace?: string; window?: string };
    const accountId = ctx.accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const choice = parseStoryReportWindow(q.window);
    const sel = await loadStorySelection(accountId, scope, choice, Date.now());
    const { latest, report } = await latestStoryReports(accountId, scope.workspaceId, choice);
    return {
      workspaceId: scope.workspaceId,
      window: choice,
      range: sel.range,
      trackerOn: sel.trackerOn,
      latest: latest ? storyReportRecordOf(latest) : null,
      report: report ? storyReportRecordOf(report) : null,
      currency: report ? (fingerprintOf(choice, sel) === report.fingerprint ? 'current' : 'stale') : null,
      running: await runningStoryReport(accountId),
      candidates: sel.candidates,
      population: sel.population,
    };
  });

  app.post(
    '/api/story-reports',
    async (req, reply): Promise<StartStoryReportResponse | StoryReportErrorBody | { error: string }> => {
      if (!reportsEntitled(req)) {
        reply.status(402);
        return PRO_REQUIRED;
      }
      const body = (req.body ?? {}) as { workspaceId?: unknown; window?: unknown };
      if (
        typeof body.workspaceId !== 'number' ||
        !Number.isSafeInteger(body.workspaceId) ||
        typeof body.window !== 'string' ||
        !(STORY_REPORT_WINDOW_CHOICES as readonly string[]).includes(body.window)
      ) {
        reply.status(400);
        return { error: 'bad_request', message: 'Send a workspaceId and a window (reporting, 30, 60 or 90).' };
      }
      const choice = body.window as StoryReportWindowChoice;
      const accountId = ctx.accountIdOf(req);
      // ⚠ THE SLOT IS CLAIMED HERE, BEFORE THE FIRST AWAIT — two POSTs cannot both start a run.
      if (!claimStoryReportSlot(accountId)) {
        // Name only a run whose row is still queued/running. A CANCELLED run keeps the slot until
        // its SDK call has actually stopped (the slot also serialises the auth-env mutation, so it
        // must not be released early) — its row already reads 'cancelled', so naming it would point
        // the card at a run it no longer shows.
        const running = await runningStoryReport(accountId);
        const stopping = running == null && storyReportSlotId(accountId) != null;
        reply.status(409);
        return {
          error: 'busy',
          message: stopping
            ? 'The cancelled story report is still stopping. Try again in a moment.'
            : 'A story report is already being written.',
          ...(running != null ? { runningId: running.id } : {}),
        };
      }
      let handedOff = false;
      try {
        const scope = await resolveWorkspaceScope(accountId, body.workspaceId);
        const sel = await loadStorySelection(accountId, scope, choice, Date.now());
        if (!sel.trackerOn) {
          reply.status(400);
          return { error: 'no_tracker', message: 'This workspace has no issue tracker.' };
        }
        if (sel.candidates.length === 0) {
          reply.status(422);
          return { error: 'no_candidates', message: 'No stories to report on in this window.' };
        }
        const record = await startStoryReport(ctx, {
          accountId,
          workspaceId: scope.workspaceId,
          choice,
          range: sel.range,
          candidates: sel.candidates,
          population: sel.population,
          internalsByKey: sel.internalsByKey,
          fingerprint: fingerprintOf(choice, sel),
        });
        handedOff = true;
        reply.status(202);
        return { report: record };
      } finally {
        if (!handedOff) releaseStoryReportSlot(accountId);
      }
    },
  );

  app.get('/api/story-reports/:id', async (req, reply): Promise<StoryReportResponse | { error: string }> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return PRO_REQUIRED;
    }
    const id = parseId((req.params as { id?: string }).id);
    const accountId = ctx.accountIdOf(req);
    const row = id != null ? await loadStoryReport(accountId, id) : null;
    if (row == null) {
      reply.status(404);
      return { error: 'not_found' };
    }
    return { report: storyReportRecordOf(row), currency: await currencyOf(accountId, row) };
  });

  app.post('/api/story-reports/:id/cancel', async (req, reply): Promise<StoryReportResponse | { error: string }> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return PRO_REQUIRED;
    }
    const id = parseId((req.params as { id?: string }).id);
    const accountId = ctx.accountIdOf(req);
    const row = id != null ? await cancelStoryReport(accountId, id) : null;
    if (row == null) {
      reply.status(404);
      return { error: 'not_found' };
    }
    return { report: storyReportRecordOf(row), currency: await currencyOf(accountId, row) };
  });
}
