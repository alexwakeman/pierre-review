import type { FastifyInstance } from 'fastify';
import type { PeriodGrain, PeriodSeriesResponse } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { resolveSprintCadence } from '../settings/store.js';
import { resolveRequestScope } from './workspace-request.js';
import { buildPeriodSeries, periodGrid } from './period-report.js';

// Reports → Period reports. ONE route, CODE ONLY (docs/PERIOD-REPORTING.md § The series):
//
//   GET /api/pro/insights/period-series?workspace=&grain=   every completed period of the last
//       12 weeks (sprint) / 6 months (month) over one repo set, live, DB only, never stored.
//
// The stored-report family (`GET …/insights/reports`, `GET …/reports/:periodKey`, `GET
// …/insights/month-to-date`, `POST …/reports/:periodKey/generate`) was REMOVED 2026-11-08 with the
// AI write-up; nothing in reporting calls a model.
//
// ⚠ `?workspace=` resolves through `resolveRequestScope`: absent / unknown / another tenant's id all
// degrade to the account's DEFAULT workspace, never a 404. ⚠ The rate-limit tier is explicit in
// core `tierFor` (`[search, read]`): up to 12 metric scans and 12 lane scans per read.

/**
 * ⚠ THE GRAIN IS A READING CHOICE ON THE REQUEST, NEVER A STORED SETTING. An unrecognised value
 * degrades to `'sprint'` rather than 400ing, matching how `?workspace=` degrades.
 */
function parseGrain(raw: string | undefined): PeriodGrain {
  return raw === 'month' ? 'month' : 'sprint';
}

export function registerPeriodReportRoutes(app: FastifyInstance, ctx: ProContext): void {
  app.get<{ Querystring: { workspace?: string; grain?: string } }>('/api/pro/insights/period-series', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const grain = parseGrain(req.query.grain);
    const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
    // ⚠ THE GRID IS PER-WORKSPACE (the workspace's own cadence). At month grain the cadence is
    // ignored and the grid never refuses: the calendar needs no setting. At sprint grain no cadence
    // means no grid — the setup prompt, never a silent rolling fortnight.
    const cadence = await resolveSprintCadence(ctx, accountId, scope.workspaceId);
    const grid = periodGrid(cadence, Date.now(), grain);
    if (grid == null) {
      const resp: PeriodSeriesResponse = {
        enabled: true,
        workspaceId: scope.workspaceId,
        grain,
        cadenceConfigured: false,
        cadenceDays: null,
        periods: [],
        repos: { measured: 0, total: scope.repoIds.length },
        next: null,
        forecasts: [],
        forecastDisclosure: null,
      };
      return reply.send(resp);
    }
    const series = await buildPeriodSeries(ctx, accountId, scope, grid);
    const resp: PeriodSeriesResponse = { enabled: true, workspaceId: scope.workspaceId, cadenceConfigured: true, ...series };
    return reply.send(resp);
  });
}
