import type {
  BotTheme,
  BotThemeAreaCount,
  BotThemeCategory,
  BotThemeSeverity,
  BotThemeSeverityCount,
  ThemePrRef,
} from '@pierre-review/shared';
import { SummaryMarkdown } from './prRefTable.js';

// Shared presentational core for the two "Themes" AI summaries (Bots → what bots flag; Feed → what
// people discuss). Both reports have the identical body — narrative, severity strip, theme cards,
// area distribution — and differ only in the header, the reviewer/participant rollup, and the
// coverage wording, which each panel supplies. Keeping this one component avoids the two panels
// drifting apart.

export const SEVERITY_META: Record<BotThemeSeverity, { label: string; cls: string }> = {
  critical: { label: 'Critical', cls: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300' },
  major: { label: 'Major', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' },
  minor: { label: 'Minor', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300' },
  nit: { label: 'Nit', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
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

export function SeverityPill({ severity }: { severity: BotThemeSeverity }): JSX.Element {
  const m = SEVERITY_META[severity];
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${m.cls}`}>
      {m.label}
    </span>
  );
}

// One theme card. Clicking anywhere on the card (when it has member threads) opens the theme-threads
// drill-down; clicking a PR chip opens THAT PR's own detail tab (stops the card click). `actorEmoji`
// names the meta line's actor list ("🤖" for bots, "💬" for people).
function ThemeCard({
  theme,
  actorEmoji,
  onOpenPr,
  onOpenTheme,
}: {
  theme: BotTheme;
  actorEmoji: string;
  onOpenPr: (pr: ThemePrRef) => void;
  onOpenTheme: (theme: BotTheme) => void;
}): JSX.Element {
  const hasThreads = theme.threads.length > 0;
  return (
    <li
      className={`rounded-md border border-gray-200 bg-white/70 p-3 dark:border-gray-800 dark:bg-gray-900/40 ${
        hasThreads ? 'cursor-pointer transition-colors hover:border-ai-signal/40 hover:bg-ai-surface-2' : ''
      }`}
      {...(hasThreads
        ? {
            role: 'button' as const,
            tabIndex: 0,
            onClick: () => onOpenTheme(theme),
            onKeyDown: (e: { key: string; preventDefault: () => void }) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenTheme(theme);
              }
            },
          }
        : {})}
    >
      <div className="flex items-start gap-2">
        <SeverityPill severity={theme.severity} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-gray-800 dark:text-gray-100">{theme.title}</span>
            <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {CATEGORY_LABEL[theme.category]}
            </span>
            {/* Exact when the server computed it (bot reports: Σ of the cited clusters'
                code-computed counts — D4); the model's ≈estimate is the fallback for human
                reports and stored pre-count rows. The exact count carries the unit and the
                heavier weight (the SynthesisCard counts it replaced led their lines) — the
                approximate fallback deliberately stays humbler. */}
            {theme.commentCount != null ? (
              <span
                className="ml-auto shrink-0 text-[11px] font-semibold tabular-nums text-gray-600 dark:text-gray-300"
                title="Comments across this theme's member clusters — computed from the clusters, not the model"
              >
                {theme.commentCount} comment{theme.commentCount === 1 ? '' : 's'}
              </span>
            ) : theme.occurrences > 0 ? (
              <span
                className="ml-auto shrink-0 text-[10px] tabular-nums text-gray-400"
                title="Approximate number of comments this theme covers"
              >
                ≈{theme.occurrences}
              </span>
            ) : null}
          </div>
          {theme.summary && (
            <p className="mt-0.5 text-[12px] leading-relaxed text-gray-600 dark:text-gray-300">{theme.summary}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-400">
            {theme.bots.length > 0 && (
              <span>
                <span className="text-gray-400">{actorEmoji} </span>
                {theme.bots.join(', ')}
              </span>
            )}
            {theme.areas.length > 0 && (
              <span className="font-mono text-gray-500 dark:text-gray-400">{theme.areas.join(' · ')}</span>
            )}
            {theme.prs.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                {theme.prs.map((pr) => (
                  <button
                    key={pr.prId}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPr(pr);
                    }}
                    title={`${pr.repoFullName}#${pr.prNumber}${pr.title ? ` — ${pr.title}` : ''} — open PR`}
                    className="rounded px-1 tabular-nums text-sky-600 hover:bg-sky-100 hover:underline dark:text-sky-400 dark:hover:bg-sky-950/50"
                  >
                    #{pr.prNumber}
                  </button>
                ))}
              </span>
            )}
            {hasThreads && (
              <span className="ml-auto shrink-0 font-medium text-ai-signal">
                {theme.threads.length} thread{theme.threads.length === 1 ? '' : 's'} →
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// ⚠ These counts are the MODEL'S numbers — parseThemes sums each theme's model-reported
// `occurrences` — so the chips carry the approximate disclaimer and the panel descriptions must
// never fold them into an "exact" claim (the exact figures are the build fold's: volumes, "where",
// the per-theme comment counts).
function SeverityStrip({ bySeverity }: { bySeverity: BotThemeSeverityCount[] }): JSX.Element | null {
  if (bySeverity.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {bySeverity.map((s) => (
        <span
          key={s.severity}
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SEVERITY_META[s.severity].cls}`}
          title="Aggregated from the themes’ approximate occurrence estimates — the model’s read, not an exact count"
        >
          {SEVERITY_META[s.severity].label} · {s.count}
        </span>
      ))}
    </div>
  );
}

function AreaDistribution({ byArea }: { byArea: BotThemeAreaCount[] }): JSX.Element | null {
  if (byArea.length === 0) return null;
  const total = byArea.reduce((s, a) => s + a.count, 0);
  if (total === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Where</div>
      <div className="flex flex-wrap gap-1">
        {byArea.map((a) => (
          <span
            key={a.area}
            className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
            title={`${a.count} of ${total} comments`}
          >
            <span className="font-mono">{a.area}</span>{' '}
            <span className="tabular-nums text-gray-400">{Math.round((a.count / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ThemesSkeleton(): JSX.Element {
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

// The shared report body: narrative → severity strip → theme cards → (the panel's reviewer/participant
// rollup) → area distribution → (the panel's coverage line). `reviewerSection` + `coverageLine` are
// supplied by each panel because their data/wording differ; everything else is identical.
export function ThemesReportBody({
  narrative,
  themes,
  bySeverity,
  byArea,
  actorEmoji,
  emptyThemesLabel,
  reviewerSection,
  coverageLine,
  onOpenPr,
  onOpenTheme,
}: {
  narrative: string;
  themes: BotTheme[];
  bySeverity: BotThemeSeverityCount[];
  byArea: BotThemeAreaCount[];
  actorEmoji: string;
  emptyThemesLabel: string;
  reviewerSection?: JSX.Element | null;
  coverageLine: JSX.Element;
  onOpenPr: (pr: ThemePrRef) => void;
  onOpenTheme: (theme: BotTheme) => void;
}): JSX.Element {
  return (
    <div className="mt-3">
      {narrative && (
        <div className="rounded-md border border-ai-hairline bg-white/60 p-3 dark:bg-gray-900/40">
          <SummaryMarkdown markdown={narrative} prRefs={[]} onOpenPr={() => {}} />
        </div>
      )}

      <SeverityStrip bySeverity={bySeverity} />

      {themes.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {themes.map((t, i) => (
            <ThemeCard key={i} theme={t} actorEmoji={actorEmoji} onOpenPr={onOpenPr} onOpenTheme={onOpenTheme} />
          ))}
        </ul>
      ) : (
        <div className="mt-3 text-[12px] text-gray-500 dark:text-gray-400">{emptyThemesLabel}</div>
      )}

      {reviewerSection}
      <AreaDistribution byArea={byArea} />
      {coverageLine}
    </div>
  );
}
