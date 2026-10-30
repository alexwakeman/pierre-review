import { useMemo, useState } from 'react';
import {
  AI_USAGE_GROUP_LABEL,
  formatTokens,
  type AiUsageCostUnit,
  type AiUsageFigures,
  type AiUsagePrRef,
  type AiUsageReportResponse,
  type AiUsageSettingLink,
  type AiUsageStoryRow,
  type AiUsageSuggestion,
} from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useAiUsageReport } from '../../hooks/useAiUsageReport.js';
import { usageCostText } from '../../lib/aiBudget.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { useSettingsModal, type SettingsFocus } from '../../store/settingsModal.js';
import { BarChart } from '../charts/BarChart.js';
import { ChartCard, ChartEmpty, PALETTE } from '../charts/common.js';
import { RepoRows, type RepoRowColumn } from '../charts/RepoRows.js';
import { PullRequestIcon, TicketIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/index.js';
import {
  figuresText,
  PROVIDER_COLOR,
  providerSplitText,
  savingText,
  trendText,
  usageChart,
  type UsageGrain,
} from './aiUsageModel.js';
import { SectionHeading, Segmented } from './reportChrome.js';
import { reportingWindowCaption, windowDates } from './reportingWindowText.js';

// Reports → "AI usage" — where Limn's own AI runs went (GET /api/ai/usage-report).
//
//   • Over time: tokens a day (or a week) over the REPORTING WINDOW, stacked by feature.
//   • Where it goes: tokens and runs per feature, split Claude / Codex.
//   • Top pull requests and top stories: each name opens its PR tab / story tab.
//   • Last 12 weeks: the LABELLED exception to the one window, with its trend.
//   • Ways to use fewer tokens: the server's suggestions (fact, saving, the setting that changes
//     it), then its measured facts.
//
// ⚠ TOKENS ARE THE MEASURE; A COST IS WORDED ONLY THROUGH `usageCostText` (lib/aiBudget.ts): US$ on
// an API key, a share of a week on a subscription. The wire carries no US$ on a subscription.
// ⚠ An AI surface: shown while `me.ai.enabled`. The tab strip hides it otherwise; a bookmarked
// `?insightsTab=ai-usage` lands here and says AI is off.
// ⚠ Every explanation sits behind an ⓘ; the page carries figures and labels.

const MUTED = 'text-ui-mute';

const SETTING_FOCUS: Readonly<Record<AiUsageSettingLink, SettingsFocus>> = {
  'auto-review': 'auto-review',
  'ai-effort': 'ai-effort',
};

const SETTING_LABEL: Readonly<Record<AiUsageSettingLink, string>> = {
  'auto-review': 'Auto review settings',
  'ai-effort': 'Effort settings',
};

function costWord(unit: AiUsageCostUnit | null): string | null {
  return unit === 'usd' ? 'US$' : unit === 'week_pct' ? 'Share of a week' : null;
}

function UsageInfo(): JSX.Element {
  return (
    <>
      <p>
        Every AI run Limn made for this workspace in this window: reviews, story reviews, AI Fix, chat,
        diagrams and the rest. Runs not tied to a repository, such as the sprint view, docs and
        summaries, count in every workspace.
      </p>
      <p>
        Tokens are input plus output, for Claude and Codex alike. Tokens Claude read from its cache are
        not counted.
      </p>
      <p>
        On an API key the cost is in US dollars. On a subscription it is the share of a week&rsquo;s
        allowance, estimated from your plan. Codex on a ChatGPT sign-in shows tokens only.
      </p>
    </>
  );
}

function SuggestionsInfo(): JSX.Element {
  return (
    <>
      <p>
        Worked out from this window&rsquo;s runs, not by a model. Each saving is an estimate of what the
        change would have saved in this window.
      </p>
      <p>Runs skipped because the AI budget was used up are not recorded, so they are not counted.</p>
    </>
  );
}

function WeeksInfo(): JSX.Element {
  return (
    <p>
      The last 12 weeks, whatever this workspace&rsquo;s reporting window is. The last bar is this week
      so far. The trend is a straight-line fit over the complete weeks.
    </p>
  );
}

export function AiUsageView(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const ai = useAiCapabilities();
  const { data, isLoading, isError } = useAiUsageReport(workspaceId, ai.enabled);
  const w = data?.window ?? null;

  const header = (
    <SectionHeading
      title={w != null ? `AI usage — ${reportingWindowCaption(w)}` : 'AI usage'}
      info={
        <InfoButton title="AI usage">
          <UsageInfo />
        </InfoButton>
      }
      caption={w != null ? windowDates(w) : undefined}
    />
  );

  let body: JSX.Element;
  if (!ai.enabled) body = <p className={`text-body ${MUTED}`}>AI is switched off on this machine.</p>;
  else if (isError) body = <p className="text-body text-ui-danger">Could not load AI usage.</p>;
  else if (isLoading || data == null) body = <p className={`text-body ${MUTED}`}>Loading…</p>;
  else if (data.totals.runs === 0 && data.weeks.every((x) => x.figures.runs === 0)) {
    body = <p className={`text-body ${MUTED}`}>No AI runs in this workspace yet.</p>;
  } else body = <Report data={data} />;

  return (
    <div data-testid="ai-usage-view" className="space-y-4">
      {header}
      {body}
    </div>
  );
}

function Report({ data }: { data: AiUsageReportResponse }): JSX.Element {
  const unit = data.costUnit;
  const split = providerSplitText(data.totals);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2" data-testid="ai-usage-totals">
        <Stat label="Tokens" value={formatTokens(data.totals.tokens)} />
        <Stat label="Runs" value={String(data.totals.runs)} />
        {usageCostText(data.totals.claudeCost, unit) != null && (
          <Stat label={unit === 'usd' ? 'Claude cost' : 'Claude, share of a week'} value={usageCostText(data.totals.claudeCost, unit)!} />
        )}
        {split != null && <span className={`text-meta ${MUTED}`}>{split}</span>}
        {data.machineWideRuns > 0 && (
          <span className={`text-meta ${MUTED}`}>
            {data.machineWideRuns} {data.machineWideRuns === 1 ? 'run' : 'runs'} not tied to a repository
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <OverTime data={data} />
        <WhereItGoes data={data} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopPrs data={data} />
        <TopStories data={data} />
      </div>

      <Weeks data={data} />

      <Suggestions data={data} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-title tabular-nums text-ui-ink">{value}</span>
      <span className={`text-meta ${MUTED}`}>{label}</span>
    </div>
  );
}

function OverTime({ data }: { data: AiUsageReportResponse }): JSX.Element {
  const [grain, setGrain] = useState<UsageGrain>('day');
  const chart = useMemo(() => usageChart(data.days, grain), [data.days, grain]);
  return (
    <ChartCard title="Tokens over time" testId="ai-usage-over-time">
      <div className="mb-2">
        <Segmented
          label="Bar per"
          value={grain}
          onChange={setGrain}
          options={[
            { value: 'day', label: 'By day' },
            { value: 'week', label: 'By week' },
          ]}
        />
      </div>
      {chart.series.length === 0 ? (
        <ChartEmpty />
      ) : (
        <BarChart labels={chart.labels} series={chart.series} mode="stacked" formatY={formatTokens} height={180} />
      )}
    </ChartCard>
  );
}

function WhereItGoes({ data }: { data: AiUsageReportResponse }): JSX.Element {
  const unit = data.costUnit;
  const rows = data.groups;
  const columns: RepoRowColumn[] = [
    {
      key: 'tokens',
      header: 'Tokens',
      segments: [
        { key: 'claude', label: 'Claude', color: PROVIDER_COLOR.claude },
        { key: 'codex', label: 'Codex', color: PROVIDER_COLOR.codex },
      ],
      values: rows.map((r) => [r.figures.claudeTokens, r.figures.codexTokens]),
      unknownLabel: 'no token count',
      format: formatTokens,
      valueMode: 'total',
      barWidthPct: unit == null ? 40 : 26,
      valueWidthPct: 10,
    },
    {
      key: 'runs',
      header: 'Runs',
      segments: [{ key: 'runs', label: 'Runs', color: PALETTE.violet }],
      values: rows.map((r) => [r.figures.runs]),
      unknownLabel: '',
      format: (n) => String(n),
      valueMode: 'total',
      barWidthPct: 12,
      valueWidthPct: 6,
    },
  ];
  const cw = costWord(unit);
  if (cw != null) {
    columns.push({
      key: 'cost',
      header: cw,
      segments: [{ key: 'cost', label: cw, color: PROVIDER_COLOR.claude }],
      values: rows.map((r) => (r.figures.claudeCost == null ? null : [r.figures.claudeCost])),
      unknownLabel: '',
      format: (n) => usageCostText(n, unit)?.replace(/ of a week$/, '') ?? '0',
      valueMode: 'total',
      barWidthPct: 10,
      valueWidthPct: 8,
    });
  }
  return (
    <ChartCard title="Where it goes" testId="ai-usage-by-feature">
      {rows.length === 0 ? (
        <ChartEmpty />
      ) : (
        <RepoRows
          labels={rows.map((r) => AI_USAGE_GROUP_LABEL[r.group])}
          columns={columns}
          nameHeader="Feature"
          nameWidthPct={24}
        />
      )}
    </ChartCard>
  );
}

function prMeta(p: AiUsagePrRef): TabMeta {
  return {
    id: p.prId,
    number: p.number,
    title: p.title,
    repoFullName: p.repoFullName,
    authorLogin: null,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

/** A pull request's name as the link to its PR tab. */
function PrLink({ pr }: { pr: AiUsagePrRef }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  return (
    <button
      type="button"
      onClick={() => openPrDetailTab(prMeta(pr), { fromActivity: true })}
      title={`${pr.repoFullName} #${pr.number}`}
      className="hit inline-flex min-w-0 items-center gap-1 text-left font-medium text-ui-ink hover:underline"
    >
      <PullRequestIcon size={11} className="shrink-0" />
      <span className="shrink-0">#{pr.number}</span>
      <span className="truncate text-ui-mute">{pr.title}</span>
    </button>
  );
}

function FiguresCell({ f, unit }: { f: AiUsageFigures; unit: AiUsageCostUnit | null }): JSX.Element {
  return (
    <span className="shrink-0 whitespace-nowrap text-meta tabular-nums text-ui-mute">
      {figuresText(f, unit)} · {f.runs} {f.runs === 1 ? 'run' : 'runs'}
    </span>
  );
}

function TopPrs({ data }: { data: AiUsageReportResponse }): JSX.Element {
  return (
    <ChartCard title="Top pull requests" testId="ai-usage-top-prs">
      {data.topPrs.length === 0 ? (
        <ChartEmpty label="No pull request used AI in this window" />
      ) : (
        <ol className="space-y-0.5">
          {data.topPrs.map((p) => (
            <li key={p.prId} className="flex items-baseline justify-between gap-3 py-1 text-meta">
              <PrLink pr={p} />
              <FiguresCell f={p.figures} unit={data.costUnit} />
            </li>
          ))}
        </ol>
      )}
    </ChartCard>
  );
}

function StoryLink({ story }: { story: AiUsageStoryRow }): JSX.Element {
  const openStory = useOpenStory();
  const title = (story.title ?? '').trim();
  return (
    <button
      type="button"
      onClick={() => openStory({ ident: story.ident, key: story.key, title: story.title })}
      title={`Open the ${story.key} story`}
      className="hit inline-flex min-w-0 items-center gap-1 text-left hover:underline"
    >
      <TicketIcon size={11} className="shrink-0 text-ui-mute" />
      <span className="shrink-0 font-medium text-ui-ink">{story.key}</span>
      {title !== '' && <span className="truncate text-ui-mute">{title}</span>}
    </button>
  );
}

function TopStories({ data }: { data: AiUsageReportResponse }): JSX.Element {
  return (
    <ChartCard
      title="Top stories"
      testId="ai-usage-top-stories"
      info={
        <InfoButton title="Top stories">
          <p>
            A story&rsquo;s own story reviews, plus every other AI run on its pull requests. A pull
            request linked to two stories counts in both.
          </p>
        </InfoButton>
      }
    >
      {data.topStories.length === 0 ? (
        <ChartEmpty label="No story used AI in this window" />
      ) : (
        <ol className="space-y-0.5">
          {data.topStories.map((s) => (
            <li key={s.ident} className="flex items-baseline justify-between gap-3 py-1 text-meta">
              <StoryLink story={s} />
              <FiguresCell f={s.figures} unit={data.costUnit} />
            </li>
          ))}
        </ol>
      )}
    </ChartCard>
  );
}

function Weeks({ data }: { data: AiUsageReportResponse }): JSX.Element {
  const trend = trendText(data.weeks, data.weeklySlope);
  const series = [
    {
      key: 'tokens',
      label: 'Tokens',
      color: PALETTE.blue,
      values: data.weeks.map((x) => x.figures.tokens),
    },
  ];
  return (
    <section className="space-y-2" data-testid="ai-usage-weeks">
      <SectionHeading
        title="Last 12 weeks"
        info={
          <InfoButton title="Last 12 weeks">
            <WeeksInfo />
          </InfoButton>
        }
        caption={trend ?? undefined}
      />
      <div className="rounded-ui bg-ui-surface p-3 sm:p-4">
        <BarChart labels={data.weeks.map((x) => x.start)} series={series} formatY={formatTokens} height={150} />
      </div>
    </section>
  );
}

function Suggestions({ data }: { data: AiUsageReportResponse }): JSX.Element {
  return (
    <section className="space-y-3" data-testid="ai-usage-suggestions">
      <SectionHeading
        title="Ways to use fewer tokens"
        info={
          <InfoButton title="Ways to use fewer tokens">
            <SuggestionsInfo />
          </InfoButton>
        }
      />
      {data.suggestions.length === 0 ? (
        <p className={`text-body ${MUTED}`}>Nothing to change in this window.</p>
      ) : (
        <ul className="space-y-2">
          {data.suggestions.map((s) => (
            <SuggestionRow key={s.kind} s={s} unit={data.costUnit} />
          ))}
        </ul>
      )}
      {data.insights.length > 0 && (
        <ul className="space-y-1" data-testid="ai-usage-insights">
          {data.insights.map((i) => (
            <li key={i.kind} className={`text-body ${MUTED}`}>
              {i.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionRow({ s, unit }: { s: AiUsageSuggestion; unit: AiUsageCostUnit | null }): JSX.Element {
  const openSettings = useSettingsModal((st) => st.openSettings);
  return (
    <li className="rounded-ui bg-ui-surface px-3 py-2.5" data-testid={`ai-usage-suggestion-${s.kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-body text-ui-ink">{s.fact}</p>
          <p className="text-meta text-ui-mute">
            <span className="font-medium text-ui-ink">{savingText(s.saving, unit)}.</span> {s.action}
          </p>
        </div>
        {s.setting != null && (
          <Button size="sm" variant="secondary" onClick={() => openSettings(SETTING_FOCUS[s.setting!])}>
            {SETTING_LABEL[s.setting]}
          </Button>
        )}
      </div>
      {s.prs.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-meta">
          {s.prs.map((p) => (
            <li key={p.prId} className="min-w-0 max-w-full">
              <PrLink pr={p} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
