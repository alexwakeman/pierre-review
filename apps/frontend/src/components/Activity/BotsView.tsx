import { useState } from 'react';
import { useBotAnalytics, useBotOnlyPrs } from '../../hooks/useBotTriage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { BotRoiPanel } from './BotRoiPanel.js';
import { FeedView } from './FeedView.js';

// The Bots rail view — "the calm layer above your review bots" as a CORE, FREE feature (works
// via the npx / OSS path, no @pierre/pro plugin). It composes:
//   • the ROI / utilisation panel (per-vendor signal-to-noise + trend + keep/tune/kill verdicts),
//   • a bot-ONLY activity feed (the consolidated Feed hard-filtered to automated-reviewer
//     activity) with review-thread derived-state pills (Untouched / Replied / Likely-addressed /
//     Resolved) so you can triage the bot firehose by state.
// Everything reads the CORE, deterministic bot routes + the core consolidated-feed route — no AI,
// no Pro gate. The detection / mute-rule / cost / Pierre-tagging SETTINGS live in the Settings
// modal's "Review bots" section (free, plugin-backed).
//
// `repoId` scopes the WHOLE console to one repo (the per-repo Bots tab in the repo console):
// analytics, the bot-only feed, the bot-only-review caution, and the vendor drill-down all
// narrow to that repo, and only bots active in it surface. Absent = the cross-repo Bots rail.
export function BotsView({ repoId }: { repoId?: number } = {}): JSX.Element {
  // Reuse the same analytics query BotRoiPanel drives (same key → deduped) just for the
  // bot-only-review count in the header caution. A repo scope (per-repo tab) wins over the team
  // scope, matching BotRoiPanel so both hit the same cache entry.
  const window = useFilters((s) => s.botAnalyticsWindow);
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const repoScope = repoId != null ? [repoId] : null;
  const { data } = useBotAnalytics(window, true, scope, repoScope);
  const botOnly = data?.totals.botOnlyPrs ?? 0;

  // Expand the caption into the EXACT PR list the count came from — served by a dedicated route
  // with the SAME window/scope/repoIds, so the number above and the list below are computed
  // identically and can never disagree (the earlier confusion: the count is a PR-state snapshot,
  // the bot feed a 14-day event stream). Fetched only while expanded.
  const [expanded, setExpanded] = useState(false);
  const { data: botOnlyData, isLoading, isError } = useBotOnlyPrs(window, expanded, scope, repoScope);
  const prs = botOnlyData?.prs ?? [];

  // "Show in feed" isolates a PR in the bot-only feed below (FeedView reads feedIsolatedPrId and
  // switches to an epoch-since fetch, so even a PR older than the 14-day feed window surfaces).
  const setFeedIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const feedIsolatedPrId = useFilters((s) => s.feedIsolatedPrId);

  return (
    <div className="space-y-3" data-testid="bots-view">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Review bots</h2>
        <span className="text-[11px] text-gray-400">
          {repoId != null
            ? 'The calm layer above your review bots — scoped to this repo. Deterministic, no AI.'
            : 'The calm layer above your review bots — detect, measure, and triage automated reviewers. Deterministic, no AI.'}
        </span>
      </div>

      {/* Governance caution: PRs whose only review came from an automated reviewer — no human
          ever looked. Sourced from the CORE analytics totals; click to expand into the exact
          PR list (same route/scope → count ≡ list). */}
      {botOnly > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex w-full items-start gap-1.5 text-left"
            data-testid="bot-only-caption"
          >
            <span
              aria-hidden="true"
              className={`mt-px shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            >
              ▸
            </span>
            <span className="flex-1">
              🤖 Only a bot reviewed{' '}
              <span className="font-semibold tabular-nums">{botOnly}</span> PR
              {botOnly === 1 ? '' : 's'} — no human review. Consider a human pass before these ship.
            </span>
            <span className="shrink-0 self-center text-[10px] font-medium underline underline-offset-2">
              {expanded ? 'Hide' : `Show ${botOnly === 1 ? 'PR' : 'list'}`}
            </span>
          </button>

          {expanded && (
            <div className="mt-2 space-y-1 border-t border-amber-200 pt-2 dark:border-amber-800/60">
              <p className="text-[10px] text-amber-600/90 dark:text-amber-400/80">
                Counted by review state, so these can predate the feed window below — use{' '}
                <span className="font-medium">Show in feed</span> to isolate a PR and bypass it.
              </p>

              {isLoading && (
                <p className="py-1 text-[11px] text-amber-600/80 dark:text-amber-400/70">Loading…</p>
              )}
              {isError && (
                <p className="py-1 text-[11px] text-amber-600/80 dark:text-amber-400/70">
                  Couldn’t load the PR list.
                </p>
              )}
              {!isLoading && !isError && prs.length === 0 && (
                <p className="py-1 text-[11px] text-amber-600/80 dark:text-amber-400/70">
                  No bot-only PRs in this window.
                </p>
              )}

              {prs.map((pr) => {
                const isolated = feedIsolatedPrId === pr.prId;
                return (
                  <div
                    key={pr.prId}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-amber-100/60 dark:hover:bg-amber-900/20"
                  >
                    <a
                      href={pr.githubUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="min-w-0 flex-1 truncate text-amber-800 hover:underline dark:text-amber-200"
                      title={`${pr.repoFullName} #${pr.number} — open on GitHub`}
                    >
                      <span className="font-mono text-amber-600/90 dark:text-amber-400/80">
                        #{pr.number}
                      </span>{' '}
                      {pr.title}
                    </a>
                    <span className="shrink-0 rounded border border-amber-300 bg-amber-100/70 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-300">
                      {pr.botLabel}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-500/80 dark:text-amber-400/60">
                      {pr.state}
                    </span>
                    {pr.viaPierreOnly ? (
                      // A Pierre-verbatim review is posted with the HUMAN's token, so the PR
                      // has no bot-ACTOR events — isolating it in the bot feed below would
                      // show nothing. Explain instead of offering a dead-end button.
                      <span
                        className="shrink-0 cursor-help rounded border border-amber-300/60 px-1.5 py-0.5 text-[10px] text-amber-500 dark:border-amber-700/50 dark:text-amber-400/70"
                        title="This review was posted via Pierre with your token, so it has no bot activity to show in the bot feed — open it on GitHub instead."
                      >
                        via Pierre
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setFeedIsolatedPrId(isolated ? null : pr.prId)}
                        aria-pressed={isolated}
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                          isolated
                            ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/40 dark:text-sky-300'
                            : 'border-amber-400 text-amber-700 hover:bg-amber-100 dark:border-amber-600/70 dark:text-amber-300 dark:hover:bg-amber-900/30'
                        }`}
                        title={isolated ? 'Clear the feed filter' : 'Isolate this PR in the bot feed below'}
                      >
                        {isolated ? 'In feed' : 'Show in feed'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <BotRoiPanel repoId={repoId} />

      {/* The bot-only activity feed — the consolidated Feed filtered to automated-reviewer
          activity, with review-thread derived-state pills for triage. Same cards / inline
          threads / pagination as every other feed, just bot-scoped (and repo-scoped in the
          per-repo Bots tab). */}
      <div className="border-t border-gray-200 pt-3 dark:border-gray-800">
        <FeedView repoId={repoId} botsMode />
      </div>
    </div>
  );
}
