// Period-over-period reports (Pro `periodReports`; /api/pro/insights/reports/*) — the Insights
// "Reports" sub-tab.
//
// Every key carries the `ws:<id>` segment and every fetch holds itself idle on `skipToken` while
// `workspaceId === null`: the scope starts unresolved, and a request sent before it lands is
// answered from the account's DEFAULT workspace and then cached under whichever key the store
// eventually settles on. That is the standard rule here (see useAdvisor / useSprintChat); it bites
// harder on this surface than most, because a report is an artifact people forward — one showing
// the wrong workspace's numbers under the right workspace's name is not a stale render, it is a
// wrong document.
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PeriodGrain,
  PeriodReportCostEstimate,
  PeriodReportGenerateResponse,
  PeriodReportModelInfo,
  PeriodReportResponse,
  PeriodReportsListResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';

// ⚠ THE GRAIN IS PART OF THE LIST KEY. Sprint and month are two different lists of two different
// periods from one route; sharing a cache slot would serve fortnights under the Month toggle for
// as long as the entry stayed fresh — a picker whose rows do not match the grain beside it.
export function periodReportsListKey(
  workspaceId: number | null,
  grain: PeriodGrain = 'sprint',
): [string, string, string] {
  return ['period-reports', workspaceKey(workspaceId), grain];
}

export function periodReportKey(
  workspaceId: number | null,
  periodKey: string | null,
): [string, string, string] {
  return ['period-report', workspaceKey(workspaceId), periodKey ?? 'none'];
}

// The stored periods for a workspace + whether a sprint cadence is configured at all. Free DB
// read. `cadenceConfigured: false` is NOT an error state — it is the setup prompt (§6.1): the
// surface refuses to generate rather than silently falling back to a rolling 14 days, because a
// period the user never chose is not an artifact they will forward.
export function usePeriodReportsList(
  enabled: boolean,
  workspaceId: number | null,
  grain: PeriodGrain = 'sprint',
) {
  return useQuery<PeriodReportsListResponse>({
    queryKey: periodReportsListKey(workspaceId, grain),
    queryFn: workspaceId == null ? skipToken : () => api.periodReports(workspaceId, grain),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// The OPEN calendar month — Reports → Month → "Month to date".
//
// ⚠ IT IS A DIFFERENT KIND OF THING FROM `usePeriodReport` AND MUST NOT BE FOLDED INTO IT. That
// hook reads a STORED, IMMUTABLE artifact and reports a staleness flag; this one recomputes a
// LIVE period on every call. There is no row, no `payload_hash`, no narration, no model and no
// billing — and there must never be a Generate button pointed at it (see the server's
// `buildMonthToDate` for the two mechanisms that make an open period unstorable).
//
// A SHORT `staleTime` on purpose, and no `placeholderData`: the figures move under the reader by
// definition, so holding a minute-old answer under a heading that says "to date" is the one thing
// this view must not do. It is still bounded — the route is on the 60/min `search` bucket.
export function periodMonthToDateKey(workspaceId: number | null): [string, string] {
  return ['period-month-to-date', workspaceKey(workspaceId)];
}

export function usePeriodMonthToDate(enabled: boolean, workspaceId: number | null) {
  return useQuery<PeriodReportResponse>({
    queryKey: periodMonthToDateKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.periodMonthToDate(workspaceId),
    enabled,
    staleTime: 30_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// ONE stored report. Free and cached — this GET never generates. It DOES recompute the data
// fingerprint server-side, which is where `report.stale` comes from: the past moved underneath a
// copy someone may already have sent, so the flag offers regeneration instead of quietly
// rewriting history.
//
// ⚠ NO `placeholderData: keepPreviousData` here, deliberately. Every other paged surface in this
// app keeps the previous page visible while the next loads; a report must not, because the thing
// that changes between two of them is the DATE RANGE IN THE TITLE. Holding the old body under the
// new heading is the exact "stale window's numbers under a new window's caption" bug this codebase
// has already shipped once. Switching periods flashes a skeleton on purpose.
export function usePeriodReport(
  enabled: boolean,
  workspaceId: number | null,
  periodKey: string | null,
) {
  return useQuery<PeriodReportResponse>({
    queryKey: periodReportKey(workspaceId, periodKey),
    queryFn:
      workspaceId == null || periodKey == null
        ? skipToken
        : () => api.periodReport(workspaceId, periodKey),
    enabled: enabled && periodKey != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// Shared across mounts so a run started on one reads as in-flight everywhere (the CiAnalysisCard
// double-bill lesson: per-mount `isPending` reset to "Generate" on a tab switch mid-run, which
// invites a second BILLED POST). Keyed by workspace + period — two different periods may
// legitimately generate at once; the same one may not.
export function periodReportGenerateMutationKey(
  workspaceId: number | null,
  periodKey: string | null,
): [string, string, string] {
  return ['period-report-generate', workspaceKey(workspaceId), periodKey ?? 'none'];
}

export function useGeneratePeriodReport(workspaceId: number | null, periodKey: string | null) {
  const qc = useQueryClient();
  return useMutation<PeriodReportGenerateResponse, Error, { model?: string } | void>({
    mutationKey: periodReportGenerateMutationKey(workspaceId, periodKey),
    // Refuses on an unresolved scope or period rather than posting a request the server would
    // resolve to the Default workspace. The billing path must never guess.
    mutationFn: (vars) => {
      if (workspaceId == null || periodKey == null) {
        return Promise.reject(new Error('No period selected'));
      }
      return api.generatePeriodReport(workspaceId, periodKey, vars ?? {});
    },
    onSuccess: (data) => {
      // Write the fresh report straight into the shared GET slot so the panel updates in place
      // (the response carries the same `PeriodReport` the GET serves). PRESERVE the previous
      // response's `byWorkspace` axis: the generate response does not carry it (it rides only the
      // one-report GET), and dropping it here would blank every open "By workspace" expansion the
      // moment a regenerate lands. The period is unchanged, so the axis is still true.
      qc.setQueryData<PeriodReportResponse>(periodReportKey(workspaceId, periodKey), (old) => ({
        enabled: data.enabled,
        workspaceId: data.workspaceId,
        report: data.report,
        ...(old?.byWorkspace != null ? { byWorkspace: old.byWorkspace } : {}),
        ...(old?.modelInfo != null ? { modelInfo: old.modelInfo } : {}),
      }));
      // A first generate BACKFILLS up to 8 prior periods (metrics-only, no LLM), so the list
      // gains rows the moment this returns — refetch it rather than assuming it is unchanged.
      // ⚠ INVALIDATE THE WHOLE FAMILY, not one grain's key. The backfill writes rows for the grain
      // that was generated, and the reader may have switched grains while it ran; matching on the
      // key PREFIX covers both lists without either having to name the other.
      void qc.invalidateQueries({ queryKey: ['period-reports', workspaceKey(workspaceId)] });
      // A real generation spends the summary-turn budget → refresh the meter and the
      // out-of-credits gate. A `generated: false` cache hit spent nothing, but re-reading a
      // cheap counter is not worth a branch.
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

// `usePeriodReportChat` (the per-report drill-down turn against `POST …/reports/:key/chat`) was
// REMOVED with the panel's old `ReportChat`: the "Ask about this period" section is the ad-hoc
// chat now (AdHocChatPanel + `useSprintChat` with explicit period bounds — see plan C5). The
// server route and its stored `report.suggested` pills still exist and are simply unconsumed.

// ── Model choice + the PRE-FLIGHT cost estimate ──────────────────────────────────────────────
//
// ⚠ THE SELECTABLE MODELS AND THEIR QUOTES ARE SERVED, NOT COMPUTED HERE. Both halves of a quote
// are the server's — the per-token prices (`packages/pro/src/llm/seam.ts`) and the typical prompt
// size — and this hook shipped holding its own copy of both: a second price table and a second
// token envelope (6000/900 against the server's 4000/1100), which quoted 13 and 39 credits for the
// exact clicks the server priced at 12 and 36. Neither figure was far wrong and nothing could ever
// have caught the drift, which is the whole problem with duplicating a constant about money. Both
// free GETs now carry `modelInfo: { model, estimates[] }` and the UI renders it verbatim.
//
// What stays client-side is PRESENTATION ONLY: a friendly label per model id. An id with no entry
// falls back to showing the id, so a model added server-side appears in the picker — priced
// correctly — without a frontend release.
//
// ⚠ THIS TABLE IS A LABEL SET, NOT A CHOICE SET, and the two go out of sync ON PURPOSE. The server
// serves ONE selectable model now (`REPORT_MODELS` in packages/pro/src/llm/seam.ts is Haiku-only),
// so 'claude-sonnet-5' can never reach the picker again — but reports NARRATED by it are stored,
// and the report header, the period list and the transcript captions all name the model that wrote
// what you are reading. Dropping the row would degrade those to a raw id for no gain.
const MODEL_LABELS: Record<string, { label: string; hint: string }> = {
  'claude-haiku-4-5': { label: 'Haiku', hint: 'fast · cheapest' },
  // Retired as a choice, kept as a label — see above. The hint is unreachable (only the picker
  // renders one) and stays for the day it is a choice again.
  'claude-sonnet-5': { label: 'Sonnet', hint: 'more considered prose' },
};

// Presentation-only label for a model id (the chat transcript's per-turn caption names the model
// that actually answered). Raw id fallback for the same reason as the picker: a model added
// server-side names itself without a frontend release.
export function reportModelLabel(model: string): string {
  return MODEL_LABELS[model]?.label ?? model;
}

export interface PeriodReportModelChoice {
  id: string;
  label: string;
  hint: string;
  estimate: PeriodReportCostEstimate;
}

/**
 * The picker's options, in the server's own order (cheapest first).
 *
 * `modelInfo` is optional on the wire — an older plugin build simply omits it — so this returns an
 * EMPTY list rather than inventing prices, and the caller hides the selector instead of quoting a
 * number it made up.
 *
 * ⚠ A ONE-ENTRY LIST IS THE NORMAL CASE NOW and the caller must not render a selector for it (see
 * `choices.length > 1` in PeriodReportsPanel). The server decides how many models are selectable;
 * this stays a plain map so that re-adding one server-side puts the control back with no frontend
 * release — which is also why the length test lives at the mount, not in here.
 */
export function periodReportModelChoices(
  info: PeriodReportModelInfo | undefined,
): PeriodReportModelChoice[] {
  return (info?.estimates ?? []).map((estimate) => ({
    id: estimate.model,
    label: MODEL_LABELS[estimate.model]?.label ?? estimate.model,
    hint: MODEL_LABELS[estimate.model]?.hint ?? '',
    estimate,
  }));
}
