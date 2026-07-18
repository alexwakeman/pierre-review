import { useBotAnalytics } from '../../hooks/useBotTriage.js';
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
  const { data } = useBotAnalytics(window, true, scope, repoId != null ? [repoId] : null);
  const botOnly = data?.totals.botOnlyPrs ?? 0;

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
          ever looked. Sourced from the CORE analytics totals (no Pro card needed). */}
      {botOnly > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          🤖 Only a bot reviewed{' '}
          <span className="font-semibold tabular-nums">{botOnly}</span> PR
          {botOnly === 1 ? '' : 's'} — no human review. Consider a human pass before these ship.
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
