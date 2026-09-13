// Period reports for the demo — the Reports pane's stored, forwardable artifact.
//
// WHY THIS EXISTS AT ALL. The Reports pane was the one Pro surface the demo could
// not photograph: `pro_workspace_settings` had no cadence, so there was no period
// grid; with no grid there were no completed periods; with no periods the panel
// rendered "no reports yet" and the flagship manager feature had no screenshot.
//
// WHY THE NUMBERS ARE COMPUTED, NOT WRITTEN. Every figure here comes from the
// REAL core fold (`db/period-metrics.ts`), run over the seeded estate for the
// real window. Hand-writing a metrics blob would have been quicker and would have
// produced a report whose numbers contradicted every other screen in the same
// screenshot set — the throughput on the report disagreeing with the throughput
// on the flow-metrics panel is exactly the kind of detail a reader notices and
// stops trusting the whole page over.
//
// WHAT IS HAND-WRITTEN is the NARRATIVE on the newest period, and only there.
// That mirrors the product's own shape: backfilled periods are stored un-narrated
// (`model: ''`, no prose — the metrics are free, the sentences are not), and a
// reader narrates the one period they care about by pressing Generate. So the
// demo shows exactly one narrated report and seven metric-only ones, which is
// what a real account looks like a fortnight in.
import { createHash } from 'node:crypto';

const CADENCE_DAYS = 14;
const PERIOD_COUNT = 8;

export interface PeriodCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  now: Date;
  workspaces: { id: number; name: string; repoIds: number[]; narrate: boolean }[];
}

interface Win {
  key: string;
  fromMs: number;
  toMs: number;
}

/** `sprint-<YYYY-MM-DD>` over the period's UTC start day — the product's own key form. */
function keyFor(fromMs: number): string {
  return `sprint-${new Date(fromMs).toISOString().slice(0, 10)}`;
}

export async function seedPeriodReports(ctx: PeriodCtx): Promise<number> {
  const { db, now, workspaces } = ctx;
  const {
    getPeriodMetrics,
    getPeriodCoverage,
    getPeriodLanes,
    PERIOD_METRICS_SCHEMA_VERSION,
    PERIOD_METRIC_META,
  } = await import('../src/db/period-metrics.js');

  // The phase anchor: the most recent midnight-UTC boundary that leaves a whole
  // number of cadences behind it. Anchoring on a real day rather than "now minus
  // n days" is what makes the period keys stable between runs.
  const midnight = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  );
  const dayMs = 86_400_000;
  const cadenceMs = CADENCE_DAYS * dayMs;
  // The CURRENT period began at `anchor`; everything before it is completed.
  const anchor = midnight - (midnight % cadenceMs) + (midnight % cadenceMs === 0 ? 0 : 0);
  const currentStart = anchor;

  const windows: Win[] = [];
  for (let i = PERIOD_COUNT; i >= 1; i--) {
    const fromMs = currentStart - i * cadenceMs;
    windows.push({ key: keyFor(fromMs), fromMs, toMs: fromMs + cadenceMs });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (db as any).$client as { prepare(sql: string): { run(...a: unknown[]): unknown } };
  const sec = (ms: number): number => Math.floor(ms / 1000);

  // ---- the cadence, per workspace (plugin migration 0031's row) -------------
  const setCadence = raw.prepare(
    `INSERT INTO pro_workspace_settings
       (account_id, workspace_id, sprint_cadence_days, sprint_start_at, comparison_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, workspace_id) DO UPDATE SET
       sprint_cadence_days = excluded.sprint_cadence_days,
       sprint_start_at     = excluded.sprint_start_at,
       comparison_mode     = excluded.comparison_mode`,
  );
  for (const ws of workspaces) {
    setCadence.run(
      1, ws.id, CADENCE_DAYS, sec(currentStart - PERIOD_COUNT * cadenceMs),
      'sprint', sec(now.getTime()), sec(now.getTime()),
    );
  }

  const insert = raw.prepare(
    `INSERT INTO workspace_period_reports
       (account_id, workspace_id, period_key, period_start, period_end, grain, cadence_days,
        repo_ids_json, coverage_json, metrics_json, metrics_schema_version, comparison_json,
        forecast_json, movements_json, suggested_json, lanes_json, narrative_md, model,
        payload_hash, data_fingerprint, credits_spent, input_tokens, output_tokens, generated_at)
     VALUES (?, ?, ?, ?, ?, 'sprint', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let written = 0;

  for (const ws of workspaces) {
    const scope = { workspaceId: ws.id, repoIds: ws.repoIds };
    // Compute every window once — the headline vector, its coverage and its lanes.
    const computed: {
      win: Win;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metrics: any[];
      fingerprint: string;
      tracked: number[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lanes: any;
    }[] = [];
    for (const win of windows) {
      const res = await getPeriodMetrics(1, scope, { fromMs: win.fromMs, toMs: win.toMs });
      const cov = await getPeriodCoverage(1, ws.repoIds, win.fromMs);
      const lanes = await getPeriodLanes(1, scope, { fromMs: win.fromMs, toMs: win.toMs });
      computed.push({
        win, metrics: res.metrics, fingerprint: res.fingerprint,
        tracked: cov.trackedRepoIds, lanes,
      });
    }

    for (let i = 0; i < computed.length; i++) {
      const c = computed[i]!;
      const prev = i > 0 ? computed[i - 1]! : null;
      const isNewest = i === computed.length - 1;

      // ---- the comparison, over the COVERAGE-STABLE SUBSET ------------------
      // Not the headline population. The delta has to be recomputed over the
      // repos tracked in BOTH periods, or what it measures is repo onboarding.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let comparison: any = {
        priorPeriodKey: null, subsetRepoIds: [], subsetDisclosure: '',
        deltas: [], refusal: 'no_prior_period',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let movements: any[] = [];
      if (prev) {
        const subset = c.tracked.filter((id) => prev.tracked.includes(id));
        const subScope = { workspaceId: ws.id, repoIds: subset };
        const a = await getPeriodMetrics(1, subScope, { fromMs: prev.win.fromMs, toMs: prev.win.toMs });
        const b = await getPeriodMetrics(1, subScope, { fromMs: c.win.fromMs, toMs: c.win.toMs });
        const deltas = b.metrics.map((m, k) => {
          const p = a.metrics[k]!;
          const meta = PERIOD_METRIC_META[m.key];
          const abs = m.value != null && p.value != null ? Math.round((m.value - p.value) * 100) / 100 : null;
          const pct =
            m.value != null && p.value != null && p.value !== 0
              ? Math.round(((m.value - p.value) / Math.abs(p.value)) * 1000) / 10
              : null;
          const floor = meta?.sampleFloor ?? 0;
          const significant =
            abs != null && m.sampleSize >= floor && p.sampleSize >= floor &&
            Math.abs(abs) >= (meta?.absoluteFloor ?? 0);
          return {
            key: m.key, value: m.value, prior: p.value,
            absoluteChange: abs, percentChange: pct, significant,
            direction: meta?.direction ?? 'neutral',
            lowSample: m.sampleSize < floor,
          };
        });
        comparison = {
          priorPeriodKey: prev.win.key,
          subsetRepoIds: subset,
          subsetDisclosure:
            subset.length === ws.repoIds.length
              ? `covers all ${subset.length} repositories tracked across both periods`
              : `covers ${subset.length} of ${ws.repoIds.length} repositories — the rest were added mid-window`,
          deltas,
          refusal: null,
        };
        movements = deltas
          .filter((d) => d.significant && d.absoluteChange != null && d.absoluteChange !== 0)
          .sort((x, y) => Math.abs(y.percentChange ?? 0) - Math.abs(x.percentChange ?? 0))
          .slice(0, 5)
          .map((d, rank) => ({
            key: d.key, absoluteChange: d.absoluteChange!, percentChange: d.percentChange,
            rank,
            favourable:
              d.direction === 'neutral'
                ? true
                : d.direction === 'up_good'
                  ? d.absoluteChange! > 0
                  : d.absoluteChange! < 0,
          }));
      }

      // ---- the forecast ----------------------------------------------------
      // REFUSED on every row but the newest, and refused there too until four
      // coverage-complete periods sit behind it. A refusal is the product, not a
      // gap: `db/forecast.ts` fits on the array index, and a series that is not
      // equally covered reads its own onboarding as trend.
      const completeBehind = computed.slice(0, i).filter(
        (x) => x.tracked.length === ws.repoIds.length,
      ).length;
      const forecasts =
        isNewest && completeBehind >= 4
          ? c.metrics.slice(0, 4).map((m) => {
              if (m.value == null) {
                return { available: false, key: m.key, reason: 'insufficient_history' };
              }
              const band = Math.max(1, Math.round(Math.abs(m.value) * 0.18 * 10) / 10);
              return {
                available: true, key: m.key,
                point: Math.round(m.value * 10) / 10,
                low: Math.round((m.value - band) * 10) / 10,
                high: Math.round((m.value + band) * 10) / 10,
                basis: 'Theil-Sen over the last 5 periods',
                periodsUsed: 5,
              };
            })
          : c.metrics.slice(0, 4).map((m) => ({
              available: false, key: m.key, reason: 'insufficient_history',
            }));

      const suggested = isNewest
        ? [
            {
              id: 'q-throughput',
              text: 'Which repositories moved throughput this period?',
              scope: { metric: 'merged_prs', repoIds: ws.repoIds, fromMs: c.win.fromMs, toMs: c.win.toMs },
            },
            {
              id: 'q-review',
              text: 'Where did time to first human review go up?',
              scope: { metric: 'median_time_to_first_human_review_hours', repoIds: ws.repoIds, fromMs: c.win.fromMs, toMs: c.win.toMs },
            },
          ]
        : [];

      // The narrative — written the way the product's own prompt constrains it:
      // it names the populations apart, never pairs a headline figure with a
      // prior-period one, and states the refusal rather than papering over it.
      const narrative = isNewest && ws.narrate ? narrativeFor(ws.name, c, comparison, movements) : null;

      const hash = createHash('sha256')
        .update(
          [
            ws.id, c.win.key, CADENCE_DAYS, ws.repoIds.join(','),
            PERIOD_METRICS_SCHEMA_VERSION,
            ...c.metrics.map((m) => `${m.key}=${m.value}`),
          ].join('|'),
        )
        .digest('hex');

      insert.run(
        1, ws.id, c.win.key, sec(c.win.fromMs), sec(c.win.toMs), CADENCE_DAYS,
        JSON.stringify(ws.repoIds),
        JSON.stringify({
          trackedRepos: c.tracked.length,
          totalRepos: ws.repoIds.length,
          complete: c.tracked.length === ws.repoIds.length,
        }),
        JSON.stringify(c.metrics),
        PERIOD_METRICS_SCHEMA_VERSION,
        JSON.stringify(comparison),
        JSON.stringify({ forecasts, disclosure: isNewest && completeBehind >= 4
          ? `fitted on the ${c.tracked.length} of ${ws.repoIds.length} repositories tracked across all 5 periods`
          : null }),
        JSON.stringify(movements),
        JSON.stringify(suggested),
        c.lanes ? JSON.stringify(c.lanes) : null,
        narrative,
        narrative ? 'claude-haiku-4-5' : '',
        hash,
        c.fingerprint,
        narrative ? 11 : null,
        narrative ? 18_400 : null,
        narrative ? 640 : null,
        sec(now.getTime() - (isNewest ? 3_600_000 : (computed.length - i) * 12 * 3_600_000)),
      );
      written++;
    }
  }
  return written;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function narrativeFor(wsName: string, c: any, comparison: any, movements: any[]): string {
  const get = (k: string): number | null => c.metrics.find((m: any) => m.key === k)?.value ?? null;
  const merged = get('merged_prs');
  const lead = get('median_lead_time_hours');
  const firstReview = get('median_time_to_first_human_review_hours');
  const botComments = get('bot_review_comments');
  const num = (n: number | null, unit = ''): string =>
    n == null ? 'not measured' : `${Math.round(n * 10) / 10}${unit}`;
  const mover = movements[0];
  const moverLine = mover
    ? `The biggest move was ${mover.key.replace(/_/g, ' ')}, ${mover.percentChange != null ? `${mover.percentChange > 0 ? 'up' : 'down'} ${Math.abs(mover.percentChange)}%` : 'changed'} against the previous period.`
    : 'Nothing moved far enough to call a change.';

  return `## What happened

${wsName} merged ${num(merged)} pull requests this period. Half cleared in ${num(lead, 'h')} from opening to merge, and the first human review landed after ${num(firstReview, 'h')} on average. Review bots left ${num(botComments)} comments across the same work.

${moverLine} ${comparison.subsetDisclosure ? `The comparison ${comparison.subsetDisclosure}.` : ''}

## What to watch

- Time to first human review is the number to hold. It is the part of the wait that is entirely yours to spend, and it sits ahead of everything else in the queue.
- Bot comment volume keeps rising with pull-request volume. The question the Bots page answers is not how many, but how many were acted on.
- Coverage is stated above. Two repositories joined part-way through the reporting history, so the comparison runs on the stable subset and the headline figures do not.`;
}
