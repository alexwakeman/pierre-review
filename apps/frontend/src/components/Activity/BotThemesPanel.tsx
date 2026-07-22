import type {
  BotTheme,
  BotThemeCategory,
  BotThemeSeverity,
  BotThemesResult,
} from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { useBotThemes, useRefreshBotThemes } from '../../hooks/useBotThemes.js';
import { SummaryMarkdown } from './prRefTable.js';

// The Bots "Themes" panel (Pro Haiku) — the QUALITATIVE layer of the Bots console: what the
// automated reviewers are actually flagging (nature + criticality + where), read from the deduped
// comment stream. Every deterministic figure (per-bot volume, area split, coverage) comes straight
// from the read layer; the themes + narrative are the model's read (labelled approximate). STRICTLY
// Pro — gated on the activityDigest AI-summary capability — and scoped to the current TEAM + window.

const SEVERITY_META: Record<
  BotThemeSeverity,
  { label: string; cls: string }
> = {
  critical: {
    label: 'Critical',
    cls: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  },
  major: {
    label: 'Major',
    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  },
  minor: {
    label: 'Minor',
    cls: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  },
  nit: {
    label: 'Nit',
    cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  },
};

const CATEGORY_LABEL: Record<BotThemeCategory, string> = {
  correctness: 'Correctness',
  security: 'Security',
  performance: 'Performance',
  error_handling: 'Error handling',
  testing: 'Testing',
  style: 'Style',
  docs: 'Docs',
  maintainability: 'Maintainability',
  other: 'Other',
};

function SeverityPill({ severity }: { severity: BotThemeSeverity }): JSX.Element {
  const m = SEVERITY_META[severity];
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${m.cls}`}>
      {m.label}
    </span>
  );
}

function ThemeCard({ theme }: { theme: BotTheme }): JSX.Element {
  return (
    <li className="rounded-md border border-gray-200 bg-white/70 p-3 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="flex items-start gap-2">
        <SeverityPill severity={theme.severity} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-gray-800 dark:text-gray-100">
              {theme.title}
            </span>
            <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {CATEGORY_LABEL[theme.category]}
            </span>
            {theme.occurrences > 0 && (
              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-gray-400" title="Approximate number of comments this theme covers">
                ≈{theme.occurrences}
              </span>
            )}
          </div>
          {theme.summary && (
            <p className="mt-0.5 text-[12px] leading-relaxed text-gray-600 dark:text-gray-300">
              {theme.summary}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-400">
            {theme.bots.length > 0 && (
              <span>
                <span className="text-gray-400">🤖 </span>
                {theme.bots.join(', ')}
              </span>
            )}
            {theme.areas.length > 0 && (
              <span className="font-mono text-gray-500 dark:text-gray-400">
                {theme.areas.join(' · ')}
              </span>
            )}
            {theme.examplePrNumbers.length > 0 && (
              <span className="tabular-nums">
                {theme.examplePrNumbers.map((n) => `#${n}`).join(' ')}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// The deterministic per-bot volume + acted-on rollup (from the read layer, not the model).
function BotRollup({ result }: { result: BotThemesResult }): JSX.Element | null {
  if (result.bots.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        By reviewer
      </div>
      <div className="space-y-1">
        {result.bots.map((b) => (
          <div key={b.key} className="flex items-center gap-2 text-[11px]">
            <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">{b.label}</span>
            <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
              {b.comments} comment{b.comments === 1 ? '' : 's'}
            </span>
            <span
              className="shrink-0 w-16 text-right tabular-nums text-gray-400"
              title="Share of this reviewer's threads later resolved or likely-addressed (approximate)"
            >
              {b.actedOnPct != null ? `${b.actedOnPct}% acted` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The top-level-dir "where" distribution (deterministic), as a compact horizontal proportion bar.
function AreaDistribution({ result }: { result: BotThemesResult }): JSX.Element | null {
  if (result.byArea.length === 0) return null;
  const total = result.byArea.reduce((s, a) => s + a.count, 0);
  if (total === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Where
      </div>
      <div className="flex flex-wrap gap-1">
        {result.byArea.map((a) => (
          <span
            key={a.area}
            className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
            title={`${a.count} of ${total} bot comments`}
          >
            <span className="font-mono">{a.area}</span>{' '}
            <span className="tabular-nums text-gray-400">
              {Math.round((a.count / total) * 100)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SeverityStrip({ result }: { result: BotThemesResult }): JSX.Element | null {
  if (result.bySeverity.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {result.bySeverity.map((s) => (
        <span
          key={s.severity}
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SEVERITY_META[s.severity].cls}`}
        >
          {SEVERITY_META[s.severity].label} · {s.count}
        </span>
      ))}
    </div>
  );
}

function ThemesSkeleton(): JSX.Element {
  return (
    <div className="mt-3 space-y-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <div className="digest-skeleton-line h-3.5" style={{ width: '40%' }} />
          <div className="digest-skeleton-line mt-1.5 h-3" style={{ width: '88%' }} />
        </div>
      ))}
    </div>
  );
}

export function BotThemesPanel(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const window = useFilters((s) => s.botAnalyticsWindow);
  const scope = scopeToParam(useFilters((s) => s.teamScope));

  const query = useBotThemes(window, activityDigest, scope);
  const refresh = useRefreshBotThemes(window, scope);
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.allowanceCredits != null && (usage.data.remainingCredits ?? 0) <= 0;

  // The AI-summary capability gates the whole panel (shares the digest's Haiku seam + cost).
  if (!activityDigest) return null;

  const result = query.data?.result ?? null;
  const busy = refresh.isPending;

  return (
    <div
      className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/60 dark:bg-violet-950/20"
      data-testid="bot-themes-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden="true">🔍</span> What bots flag
        </span>
        <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <span className="shrink-0 rounded bg-sky-100 px-1 text-[9px] font-semibold uppercase text-sky-600 dark:bg-sky-900/40 dark:text-sky-300">
          beta
        </span>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={busy || outOfCredits}
          className="ml-auto rounded bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          title={outOfCredits ? 'Out of AI credits — resets next month' : 'Summarise what the review bots are flagging over this scope (runs the Haiku model)'}
        >
          {busy ? 'Summarising…' : result ? '↻ Regenerate' : 'Generate'}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        A qualitative read of what your automated reviewers keep flagging — the recurring themes,
        how critical they are, and where they cluster. Themes are an AI read (approximate); the
        volumes and “where” are exact.
      </p>

      {refresh.isError && (
        <div className="mt-2 text-[11px] text-red-500">
          {(refresh.error as Error)?.message ?? 'Couldn’t generate the summary.'}
        </div>
      )}
      {!refresh.isError && refresh.notice && (
        <div className="mt-2 text-[11px] text-gray-400">{refresh.notice}</div>
      )}
      {outOfCredits && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — the summary resumes on the 1st. Any existing summary still shows.
        </div>
      )}

      {busy && !result ? (
        <ThemesSkeleton />
      ) : query.isLoading ? (
        <div className="mt-3 h-24 animate-pulse rounded bg-violet-500/5" />
      ) : result ? (
        <div key={result.generatedAt} className="digest-fade-in mt-3">
          {result.narrative && (
            <div className="rounded-md border border-violet-200/70 bg-white/60 p-3 dark:border-violet-900/50 dark:bg-gray-900/40">
              <SummaryMarkdown markdown={result.narrative} prRefs={[]} onOpenPr={() => {}} />
            </div>
          )}

          <SeverityStrip result={result} />

          {result.themes.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {result.themes.map((t, i) => (
                <ThemeCard key={i} theme={t} />
              ))}
            </ul>
          ) : (
            <div className="mt-3 text-[12px] text-gray-500 dark:text-gray-400">
              No distinct themes surfaced from the bot comments in this window.
            </div>
          )}

          <BotRollup result={result} />
          <AreaDistribution result={result} />

          <div className="mt-3 border-t border-violet-200/50 pt-2 text-[10px] text-gray-400 dark:border-violet-900/40">
            Summarised {result.coverage.deduped.toLocaleString()} distinct{' '}
            {result.coverage.deduped === 1 ? 'point' : 'points'} from{' '}
            {result.coverage.totalComments.toLocaleString()} bot comment
            {result.coverage.totalComments === 1 ? '' : 's'}
            {result.coverage.analyzed < result.coverage.deduped
              ? ` (top ${result.coverage.analyzed.toLocaleString()} analysed)`
              : ''}
            {result.coverage.truncated ? ' · older comments beyond the cap were excluded' : ''}. Generated{' '}
            {new Date(result.generatedAt).toLocaleString()}.
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-dashed border-violet-300/60 p-3 text-[12px] text-gray-500 dark:border-violet-800/60 dark:text-gray-400">
          <span>No summary yet — generate one to see what your review bots are flagging.</span>
        </div>
      )}
    </div>
  );
}
