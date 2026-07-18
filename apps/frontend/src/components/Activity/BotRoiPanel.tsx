import { useMemo } from 'react';
import type {
  AutomatedReviewerKind,
  BotTuningSuggestion,
  BotVendorAnalytics,
  BotVerdict,
  BotWindowKind,
} from '@pierre-review/shared';
import { useBotAnalytics, useAddBotMuteRule } from '../../hooks/useBotTriage.js';
import { useProSettings, useHasProSettings } from '../../hooks/useProSettings.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { automatedReviewerMeta } from '../../lib/ui.js';
import { LineChart } from '../charts/LineChart.js';
import { ChartCard, ChartEmpty, type Series } from '../charts/common.js';

// Bot ROI / utilisation panel — CORE/FREE (rendered in the Bots rail console). The analytics
// route is CORE + deterministic (no AI): a per-vendor signal-to-noise table + a 12-week
// thread-volume trend + keep/tune/kill verdicts, plus the deterministic tuning suggestions with
// one-click mute-rule creation. The ONLY plugin-backed bit is the per-vendor $ cost overlay
// (entered in Settings → Review bots, stored in pro_settings, overlaid CLIENT-side here since
// getBotAnalytics returns cost fields null); its fetch is gated on plugin presence so the pure
// OSS path never calls /api/pro/settings (the cost column just shows "—").

const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

const VERDICT_META: Record<BotVerdict, { label: string; className: string; title: string }> = {
  keep: {
    label: 'Keep',
    className:
      'bg-green-500/10 text-green-700 dark:text-green-300 border border-green-500/30',
    title: 'Healthy signal-to-noise — worth keeping on.',
  },
  tune: {
    label: 'Tune',
    className:
      'bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30',
    title: 'A lot of comments go untouched — consider muting the noisy paths/severities.',
  },
  kill: {
    label: 'Kill',
    className: 'bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30',
    title: 'High volume, low acted-on, high untouched — probably not paying for itself.',
  },
};

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

function usd(v: number | null): string {
  if (v == null) return '—';
  return `$${v.toFixed(2)}`;
}

// Overlay the per-vendor monthly cost (from Pro settings) onto the analytics rows, deriving
// $/acted-on-comment client-side. getBotAnalytics returns cost fields null by design (core
// can't read pro_settings), so this is where the ROI figure actually lands.
function withCost(
  vendors: BotVendorAnalytics[],
  costByKind: Map<string, number>,
): BotVendorAnalytics[] {
  return vendors.map((v) => {
    const monthly = costByKind.get(v.kind) ?? null;
    const perActedOn = monthly != null && v.actedOn > 0 ? monthly / v.actedOn : null;
    return { ...v, costMonthlyUsd: monthly, costPerActedOnUsd: perActedOn };
  });
}

// One multi-series line chart of weekly thread volume per vendor, over a unified weekly
// x-axis (the union of every vendor's trend weekStarts, oldest→newest, last 12). A vendor
// with no threads in a given week reads as a gap (null), mirroring the toolkit's semantics.
function TrendChart({ vendors }: { vendors: BotVendorAnalytics[] }): JSX.Element {
  const { labels, series } = useMemo(() => {
    const weekSet = new Set<string>();
    for (const v of vendors) for (const p of v.trend) weekSet.add(p.weekStart);
    const labels = Array.from(weekSet).sort().slice(-12);
    const series: Series[] = vendors
      .filter((v) => v.trend.length > 0)
      .map((v) => {
        const byWeek = new Map(v.trend.map((p) => [p.weekStart, p.threads]));
        return {
          key: v.kind,
          label: v.label,
          color: automatedReviewerMeta(v.kind).color,
          values: labels.map((w) => byWeek.get(w) ?? null),
        };
      });
    return { labels, series };
  }, [vendors]);

  if (labels.length < 2 || series.length === 0) {
    return <ChartEmpty label="Not enough weekly history yet" />;
  }
  return <LineChart labels={labels} series={series} height={140} curved />;
}

function TuningSuggestions({
  suggestions,
}: {
  suggestions: BotTuningSuggestion[];
}): JSX.Element | null {
  const addRule = useAddBotMuteRule();
  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 dark:border-amber-500/30 dark:bg-amber-950/20">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        Tuning suggestions
      </div>
      <ul className="space-y-1.5">
        {suggestions.map((s, i) => {
          const meta = automatedReviewerMeta(s.vendorKind);
          const pending = addRule.isPending;
          return (
            <li
              key={`${s.vendorKind}:${s.pathGlob ?? '*'}:${s.severity ?? '*'}:${i}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
            >
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium"
                style={{ color: meta.color, background: `${meta.color}1a` }}
              >
                🤖 {meta.label}
              </span>
              <span className="text-gray-600 dark:text-gray-300">{s.rationale}</span>
              <button
                type="button"
                onClick={() =>
                  addRule.mutate({
                    vendorKind: s.vendorKind,
                    pathGlob: s.pathGlob,
                    severity: s.severity,
                    action: 'hide',
                  })
                }
                disabled={pending}
                className="ml-auto shrink-0 rounded border border-amber-400 px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30"
                title="Hide this vendor's matching threads from the feed"
              >
                {pending ? 'Adding…' : 'Create mute rule'}
              </button>
            </li>
          );
        })}
      </ul>
      {addRule.isError && (
        <div className="mt-1 text-[11px] text-red-500">
          {(addRule.error as Error)?.message ?? 'Couldn’t create the rule.'}
        </div>
      )}
    </div>
  );
}

function VendorTable({
  vendors,
  onOpenVendor,
}: {
  vendors: BotVendorAnalytics[];
  onOpenVendor: (kind: AutomatedReviewerKind) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="w-full min-w-[680px] border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-800 dark:text-gray-400">
            <th className="px-2 py-1.5 font-medium">Vendor</th>
            <th className="px-2 py-1.5 text-right font-medium">Threads</th>
            <th className="px-2 py-1.5 text-right font-medium">Comments</th>
            <th
              className="px-2 py-1.5 text-right font-medium"
              title="A later commit likely addressed the thread, it was resolved, or a human replied/resolved after the bot"
            >
              Acted on
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Threads with no reply and no follow-up commit">
              Untouched
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Untouched threads' oldest age">
              Oldest
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Low-value / untouched share — the noise floor">
              Noise
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Monthly vendor cost ÷ acted-on threads (from Pro settings)">
              $/acted-on
            </th>
            <th className="px-2 py-1.5 text-center font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {vendors.map((v) => {
            const meta = automatedReviewerMeta(v.kind);
            const verdict = VERDICT_META[v.verdict];
            return (
              <tr
                key={v.kind}
                className="border-b border-gray-100 last:border-0 dark:border-gray-800/60"
              >
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => onOpenVendor(v.kind)}
                    title="View this bot's PRs"
                    className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:underline"
                    style={{ color: meta.color, background: `${meta.color}1a` }}
                  >
                    🤖 {v.label}
                  </button>
                  {v.reviewers > 1 && (
                    <span className="ml-1 text-gray-400">×{v.reviewers}</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{v.threads}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {v.comments}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  <span className="text-gray-700 dark:text-gray-200">{v.actedOn}</span>
                  <span className="ml-1 text-gray-400">{pct(v.actedOnPct)}</span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  <span
                    className={
                      v.untouched > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'
                    }
                  >
                    {v.untouched}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {v.oldestUntouchedDays != null ? `${v.oldestUntouchedDays}d` : '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {pct(v.noiseRatioPct)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500" title={v.costMonthlyUsd != null ? `$${v.costMonthlyUsd}/mo` : 'Set a monthly cost in Settings → Review bots'}>
                  {usd(v.costPerActedOnUsd)}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${verdict.className}`}
                    title={verdict.title}
                  >
                    {verdict.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BotRoiPanel(): JSX.Element | null {
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const openBotPrsDetail = useFilters((s) => s.openBotPrsDetail);
  // Respect the team-scope selector — scope is in the query key so a scope change refetches.
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const { data, isLoading, isError } = useBotAnalytics(window, true, scope);
  // Cost overlay is the one plugin-backed bit — gate the fetch on plugin presence so the OSS
  // path never hits /api/pro/settings (which 404s without the plugin).
  const { data: settings } = useProSettings(useHasProSettings());

  const costByKind = useMemo(
    () => new Map((settings?.bots.cost ?? []).map((c) => [c.kind, c.monthlyUsd])),
    [settings?.bots.cost],
  );
  const vendors = useMemo(
    () => (data ? withCost(data.vendors, costByKind) : []),
    [data, costByKind],
  );

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Review-bot ROI</h3>
      <div className="ml-auto inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
        {WINDOWS.map((wOpt) => (
          <button
            key={wOpt.key}
            type="button"
            onClick={() => setWindow(wOpt.key)}
            className={`px-2 py-0.5 text-[11px] font-medium ${
              window === wOpt.key
                ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            {wOpt.label}
          </button>
        ))}
      </div>
    </div>
  );

  let body: JSX.Element;
  if (isLoading) {
    body = (
      <div className="h-28 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
    );
  } else if (isError) {
    body = <div className="text-sm text-red-500">Couldn’t load bot analytics.</div>;
  } else if (!data || vendors.length === 0) {
    body = (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
        No automated-reviewer activity in this window.
        <div className="mt-1 text-[11px]">
          When review bots (CodeRabbit, Copilot, in-house AI…) comment on your PRs, their
          signal-to-noise lands here.
        </div>
      </div>
    );
  } else {
    const t = data.totals;
    body = (
      <div className="space-y-3">
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-200">
            {t.threads}
          </span>{' '}
          bot thread{t.threads === 1 ? '' : 's'} · {t.comments} comment
          {t.comments === 1 ? '' : 's'} ·{' '}
          <span className="tabular-nums">{pct(t.actedOnPct)}</span> acted on ·{' '}
          <span className="tabular-nums text-amber-600 dark:text-amber-400">
            {t.untouched}
          </span>{' '}
          untouched ·{' '}
          <span
            title="PRs whose only reviews/comments came from bots — no human review or comment since they opened"
            className="cursor-help"
          >
            <b className="tabular-nums text-gray-700 dark:text-gray-200">{t.botOnlyPrs}</b>{' '}
            bot-only PR{t.botOnlyPrs === 1 ? '' : 's'}
          </span>
        </div>
        <VendorTable vendors={vendors} onOpenVendor={openBotPrsDetail} />
        <ChartCard title="Weekly thread volume" note="last 12 weeks">
          <TrendChart vendors={vendors} />
        </ChartCard>
        <TuningSuggestions suggestions={data.suggestions} />
        <div className="text-[11px] text-gray-400">
          “Acted on” = a later commit likely addressed the thread, it was resolved, or a human
          replied/resolved after the bot (approximate). Verdicts + cost are deterministic — no
          AI. Set per-vendor monthly cost in Settings → Review bots to see $/acted-on.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="bot-roi-panel">
      {header}
      {body}
    </div>
  );
}
