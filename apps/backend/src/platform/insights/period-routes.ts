import type { FastifyInstance } from 'fastify';
import type {
  PeriodGrain,
  PeriodReportGenerateResponse,
  PeriodReportModelInfo,
  PeriodReportResponse,
  PeriodReportsListResponse,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import {
  makeReportClient,
  REPORT_MODELS,
  resolveReportModel,
  type ReportModel,
} from '../llm/seam.js';
import { readSettingsRow, reportModelOf, resolveSprintCadence } from '../settings/store.js';
import { resolveRequestScope } from './workspace-request.js';
import {
  buildMonthToDate,
  byWorkspaceAxis,
  generatePeriodReport,
  grainOfKey,
  listPeriods,
  loadArchivedReport,
  loadStoredReport,
  parseArchivedKey,
  periodGrid,
  quoteFor,
  windowForKey,
  type PeriodWindow,
} from './period-report.js';

// The Insights → Reports routes (spec §8; the `…/:periodKey/chat` turn was REMOVED 2026-10-22):
//
//   GET  /api/pro/insights/reports?workspace=&grain=       list stored periods (free)
//   GET  /api/pro/insights/month-to-date?workspace=        the OPEN month, live (free)
//   GET  /api/pro/insights/reports/:periodKey?workspace=   one report (free, cached, no generation)
//   POST /api/pro/insights/reports/:periodKey/generate     manual, credit-gated, model-selectable
//
// Registered UNCONDITIONALLY and self-gated on DIGEST_ENABLED inside each handler (the house
// pattern): a flag-less build answers `enabled: false` rather than 404ing, so the SPA can tell
// "off" from "missing".
//
// ⚠ RATE LIMITS ARE EXPLICIT IN CORE, NOT INHERITED. `apps/backend/src/api/plugins/rate-limit.ts`
// carries an `/api/pro/insights/reports` family block ABOVE the `/api/pro/` catch-all — nothing
// under `/api/pro/` reaches the predicates below it, and that catch-all would put the two free
// GETs on the 20/min AI bucket purely because the family also contains a POST. The POST
// gets [ai, aiHourly]; the list GET gets [read]; the one-report GET gets [search, read] because it
// carries the "By workspace" axis, whose cost multiplies by workspace count (2 windows × N ×
// getPeriodMetrics — the deleted /api/workspace-metrics/compare's tier, inherited for the same
// reason). Every case is pinned in rate-limit.test.ts.
//
// ⚠ `?workspace=` resolves through `resolveRequestScope`: absent / unknown / another tenant's id
// all degrade to the account's DEFAULT workspace, never a 404. Same for an unknown `:periodKey` —
// the response shape is identical with `report: null`, so neither is an existence oracle.

// `modelInfo` (both GETs) and `spend` (generate) are declared on the shared wire types themselves,
// so the SPA reads the pre-flight quote and the receipt off the response instead of holding its own
// copy of the price table and the token envelope — which it did once, and which quoted a different
// number of credits for the same click. Both fields are OPTIONAL there, so a host serving an older
// plugin still type-checks.
function modelInfoFor(model: ReportModel): PeriodReportModelInfo {
  return { model, estimates: REPORT_MODELS.map(quoteFor) };
}

interface KeyParams {
  periodKey: string;
}

interface ScopeQuery {
  workspace?: string;
}

interface ListQuery extends ScopeQuery {
  /** `'sprint'` (default) or `'month'` — see `PeriodGrain`. */
  grain?: string;
}

/**
 * ⚠ THE GRAIN IS A READING CHOICE ON THE REQUEST, NEVER A STORED SETTING, and it is only ever
 * spelled out on the LIST. Every other route in this family is handed a period KEY, whose shape
 * already says which grid it belongs to (`grainOfKey`) — so there is no second parameter that
 * could disagree with the key beside it, and no route can be asked to read `month-2026-08` off a
 * sprint grid.
 *
 * An unrecognised value degrades to `'sprint'` rather than 400ing, matching how `?workspace=`
 * degrades: this is a view selector, not an assertion, and a typo should show the default view.
 */
function parseGrain(raw: string | undefined): PeriodGrain {
  return raw === 'month' ? 'month' : 'sprint';
}

interface GenerateBody {
  /** Per-run override; unrecognised — and now RETIRED — values fall back to the account default
   *  rather than 400ing, and the store already refuses to persist anything outside REPORT_MODELS.
   *  With one selectable model the SPA stops sending this field at all (the picker is hidden), so
   *  in practice every run takes the account default; the field stays because it is the seam a
   *  second model would arrive through, and because an OLD client may still send `claude-sonnet-5`
   *  — which must land on Haiku, not on a meter. */
  model?: string;
}

/**
 * The shared prologue: the workspace scope, the cadence grid and the account's model.
 * `grid == null` is the ONE hard refusal in this feature (§6.1) — no sprint cadence configured
 * means no period the user chose, and there is deliberately NO silent fallback to a rolling
 * fortnight: a period nobody picked is not an artifact they will forward.
 */
async function context(
  ctx: ProContext,
  accountId: number,
  workspace: string | undefined,
  grain: PeriodGrain = 'sprint',
): Promise<{
  scope: BotScopeWire;
  grid: ReturnType<typeof periodGrid>;
  model: ReportModel;
  cadenceSource: 'workspace' | 'account';
}> {
  const [scope, row] = await Promise.all([
    resolveRequestScope(ctx, accountId, workspace),
    readSettingsRow(ctx, accountId),
  ]);
  // ⚠ THE GRID IS PER-WORKSPACE. The cadence comes from `resolveSprintCadence` — the workspace's
  // own row when it has one, the account default otherwise — so the scope MUST be resolved before
  // it. Reading `row.sprintCadenceDays` here (as this did) gridded every workspace on one team's
  // fortnight; the narration model, which genuinely IS account-wide, still comes off `row`.
  //
  // ⚠ AT MONTH GRAIN THE CADENCE IS IRRELEVANT AND THE GRID NEVER REFUSES. The calendar is not a
  // setting: a workspace that has never chosen a sprint length still has an August. It is still
  // resolved (one indexed read) because the grid needs it at sprint grain, and branching the read
  // would fork this function for no gain.
  const cadence = await resolveSprintCadence(ctx, accountId, scope.workspaceId);
  return {
    scope,
    grid: periodGrid(cadence, Date.now(), grain),
    model: reportModelOf(row),
    // ⚠ ALWAYS 'workspace' SINCE PLUGIN MIGRATION 0031 removed the account-level fallback — every
    // cadence IS the workspace's own, so there is no other answer left to give. Still emitted
    // because the SPA's disclosure branches on it and reads correctly on this value; the field and
    // that branch get deleted together, not one without the other.
    cadenceSource: 'workspace',
  };
}

export function registerPeriodReportRoutes(app: FastifyInstance, ctx: ProContext): void {
  // ---- list (free) ----
  app.get<{ Querystring: ListQuery }>('/api/pro/insights/reports', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const grain = parseGrain(req.query.grain);
    const { scope, grid, model, cadenceSource } = await context(
      ctx,
      accountId,
      req.query.workspace,
      grain,
    );
    // `listPeriods` returns TWO lists: the live periods on this workspace's grid, and the stored
    // artifacts the grid cannot name (a retired cadence, or aged past the horizon). The split is
    // what stops a cadence change leaving most of the history clickable-but-blank — see the
    // function's own note.
    const listing = grid == null ? null : await listPeriods(ctx, accountId, scope, grid);
    const resp: PeriodReportsListResponse = {
      enabled: true,
      workspaceId: scope.workspaceId,
      // ⚠ AT MONTH GRAIN THIS IS ALWAYS TRUE and the SPA must never show the sprint setup prompt:
      // the calendar needs no configuration, so "you have not chosen a cadence yet" would be a
      // setup instruction for a screen that already works.
      cadenceConfigured: grid != null,
      periods: listing?.periods ?? [],
      modelInfo: modelInfoFor(model),
      // The sprint length this list was gridded on. NULL at month grain — the months are 28-31
      // days and no single number describes them, so there is nothing honest to put here.
      cadenceDays: grid != null && grid.grain === 'sprint' ? grid.cadenceDays : null,
      cadenceSource,
      grain,
      ...(listing != null && listing.archived.length > 0 ? { archived: listing.archived } : {}),
    };
    return reply.send(resp);
  });

  // ---- one report (free, cached — NEVER generates) ----
  app.get<{ Params: KeyParams; Querystring: ScopeQuery }>(
    '/api/pro/insights/reports/:periodKey',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      // ⚠ THE GRAIN COMES OFF THE KEY, not off a query parameter. `sprint-2026-08-18` and
      // `month-2026-08` are disjoint shapes, so the key that names the document also names the
      // grid it lives on — which is what makes a forwarded `?report=` link unambiguous and makes
      // it impossible for a grain parameter to disagree with the key beside it.
      const archivedParse = parseArchivedKey(req.params.periodKey);
      const keyGrain =
        grainOfKey(archivedParse?.periodKey ?? req.params.periodKey) ?? 'sprint';
      const { scope, grid, model } = await context(
        ctx,
        accountId,
        req.query.workspace,
        keyGrain,
      );
      // An ARCHIVED key (`sprint-…@cad14`) reads a preserved artifact whose window the current grid
      // cannot name. It is served FROZEN — no staleness probe, no by-workspace axis (both describe
      // a live period), and `archived: true` on the report so the SPA captions it as kept rather
      // than as refreshable. It needs no grid at all, so it is answered before the grid is
      // consulted: an archived report stays readable even from a workspace whose cadence is
      // currently unset.
      if (archivedParse != null) {
        const archivedResp: PeriodReportResponse = {
          enabled: true,
          workspaceId: scope.workspaceId,
          report: await loadArchivedReport(ctx, accountId, scope, req.params.periodKey, model),
          modelInfo: modelInfoFor(model),
        };
        return reply.send(archivedResp);
      }
      const window: PeriodWindow | null =
        grid == null ? null : windowForKey(grid, req.params.periodKey);
      // ⚠ THE OPEN MONTH IS SERVED LIVE FROM THIS ROUTE TOO, not only from `…/month-to-date`.
      // `windowForKey` refuses the in-progress period by design (a stored row for it would read
      // stale forever), so without this a forwarded `?report=month-2026-09` link would render the
      // ordinary "this period has not been generated yet" box — for a period that CANNOT be
      // generated, and whose figures are one live read away. One key space, one link, both routes.
      const isOpenMonth =
        grid != null &&
        grid.grain === 'month' &&
        req.params.periodKey === `month-${new Date().toISOString().slice(0, 7)}`;
      // A key off the cadence grid, in the future, or naming the in-progress period reads as
      // "nothing stored" — the same renderable empty state as a period nobody has generated.
      const report = isOpenMonth
        ? await buildMonthToDate(ctx, accountId, scope, Date.now())
        : window == null
          ? null
          : await loadStoredReport(ctx, accountId, scope, window, model);
      // The "By workspace" axis (C4): computed LIVE, additive/optional on the wire — a stored
      // report keeps rendering without it, an older client ignores it. Only computed when there
      // is a report to hang it on (grid != null is implied by window != null), and it returns
      // null for a single-workspace account (one row compares nothing).
      // Never on an open period: the axis compares two COMPLETED windows of every workspace, and
      // hanging it off a month-to-date would put a part-month column beside a whole-month one.
      const byWorkspace =
        window == null || grid == null || report == null || report.inProgress === true
          ? null
          : await byWorkspaceAxis(ctx, accountId, grid, window);
      const resp: PeriodReportResponse = {
        enabled: true,
        workspaceId: scope.workspaceId,
        report,
        modelInfo: modelInfoFor(model),
        ...(byWorkspace == null ? {} : { byWorkspace }),
      };
      return reply.send(resp);
    },
  );

  // ---- generate (the ONE billing path) ----
  app.post<{ Params: KeyParams; Querystring: ScopeQuery; Body?: GenerateBody }>(
    '/api/pro/insights/reports/:periodKey/generate',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const { scope, grid, model: accountModel } = await context(
        ctx,
        accountId,
        req.query.workspace,
        grainOfKey(req.params.periodKey) ?? 'sprint',
      );
      if (grid == null) {
        // §6.1: refuse, and say WHY, so the surface can point at the sprint setting instead of
        // rendering an empty card.
        const resp: PeriodReportGenerateResponse = {
          enabled: true,
          workspaceId: scope.workspaceId,
          report: null,
          generated: false,
          cadenceMissing: true,
        };
        return reply.send(resp);
      }
      const window = windowForKey(grid, req.params.periodKey);
      if (window == null) {
        const resp: PeriodReportGenerateResponse = {
          enabled: true,
          workspaceId: scope.workspaceId,
          report: null,
          generated: false,
        };
        return reply.send(resp);
      }
      // Per-run override → the account default (which itself already falls back to the
      // PRO_REPORT_MODEL config default). NEVER a raw body string: this id is handed to the
      // metered Anthropic path, so it goes through the allowlist first and an unrecognised value
      // silently means "use my default" rather than 400ing a report the user wanted.
      const model = resolveReportModel(req.body?.model) ?? accountModel;
      const outcome = await generatePeriodReport(
        ctx,
        makeReportClient(ctx, model),
        accountId,
        scope,
        grid,
        window,
        model,
      );
      const resp: PeriodReportGenerateResponse = {
        enabled: true,
        workspaceId: scope.workspaceId,
        report: outcome.report,
        generated: outcome.generated,
        ...(outcome.creditsExhausted ? { creditsExhausted: true } : {}),
        ...(outcome.spend ? { spend: outcome.spend } : {}),
      };
      return reply.send(resp);
    },
  );

  // ---- month to date (free, LIVE, never stored) ----
  //
  // ⚠ IT SPENDS NOTHING AND STORES NOTHING, AND IT IS NOT A `…/reports/:key` SIBLING BY ACCIDENT.
  // Its own path keeps it structurally outside the generate family — there is no verb here
  // that could bill, and no row this could ever upsert (see `buildMonthToDate` for the two
  // mechanisms that make an open period unstorable).
  //
  // ⚠ IT CARRIES ITS OWN RATE-LIMIT TIER IN CORE. `/api/pro/insights/month-to-date` does not match
  // the `…/insights/reports` family block, so without an explicit entry it would fall through to
  // the `/api/pro/` catch-all's GET→`read` branch and sit on the 600/min blanket bucket — while
  // costing SIX indexed scans (headline metrics, two coverage reads, lanes, and both sides of the
  // elapsed-slice comparison) on a surface the SPA re-reads whenever the pane regains focus. It is
  // pinned on `search` in `api/plugins/rate-limit.ts` and in `rate-limit.test.ts`.
  app.get<{ Querystring: ScopeQuery }>('/api/pro/insights/month-to-date', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const { scope } = await context(ctx, accountId, req.query.workspace, 'month');
    const resp: PeriodReportResponse = {
      enabled: true,
      workspaceId: scope.workspaceId,
      report: await buildMonthToDate(ctx, accountId, scope, Date.now()),
      // No `modelInfo`: there is no generation to quote a price for, and offering one would be an
      // invitation to a button that must not exist here.
    };
    return reply.send(resp);
  });
}
