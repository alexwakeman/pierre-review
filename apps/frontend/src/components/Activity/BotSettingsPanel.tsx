import { useMemo } from 'react';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { DetectedReviewersTable } from '../settings/DetectedReviewersTable.js';

// The Bots rail's "Settings" sub-tab — **who counts as a review bot in each repo, who each bot
// IS, and what it costs**.
//
// ── A BOT IS A PER-REPO OBJECT ───────────────────────────────────────────────────────────────
// The judgement ("is this login an automated reviewer here, and is it reviewing or
// quality-checking?") is keyed on (repo, actor) and on nothing else. A bot is INSTALLED per
// repository — GitHub Apps are installed on repos, CI configs live in repos — so the repo is the
// thing the answer is actually about.
//
// This replaced a per-TEAM key with an inheritance chain (team row → account default →
// auto-detect). Two things were wrong with it: the answer MOVED when someone re-bagged a team's
// repos, and null-means-inherit leaked into every read, every write body and every badge on the
// row. There is now no team key, no default row, no inheritance, no merge — and NO DEDUPLICATION:
// a vendor running in six repos is six rows, shown six times, grouped by repo. That is the
// intended display, asked and answered directly.
//
// ── THE ONE THING THAT IS *NOT* PER REPO ────────────────────────────────────────────────────
// A login is one vendor everywhere, so WHO the bot is (vendor kind, display label) and WHAT IT
// COSTS are ACTOR facts, stored once per (account, actor). Keeping them per repo produced the bug
// this whole split exists to kill: marking CodeRabbit "not a bot" in one repo nulled its kind, and
// it lost its brand colour and vendor name in repos the user never touched.
//
// So the table below has two visually separate halves, and the separation is the feature — see
// DetectedReviewersTable, which owns the copy that says which is which at the point of edit.
//
// SCOPE: the FilterBar's repo/team selection, exactly like every other Bots panel — no picker of
// its own. `repoId` narrows to one repo (the per-repo Bots tab); that is simply the same list with
// one group, which is why this panel no longer has to be cross-repo-only.
export function BotSettingsPanel({ repoId }: { repoId?: number } = {}): JSX.Element {
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  // Stable array identity so the query key (and the fetch) doesn't churn every render.
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);

  return (
    <div className="space-y-3" data-testid="bot-settings-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Who counts as a review bot, repo by repo
        </h3>
        <span className="text-[11px] text-gray-400">
          {repoId != null ? 'Scoped to this repo.' : 'Scoped to the repos you have in view.'}
        </span>
      </div>

      <DetectedReviewersTable scope={scope} repoIds={repoScope} />

      <p className="border-t border-gray-200 pt-2.5 text-[11px] text-gray-400 dark:border-gray-800">
        Bot <span className="font-medium">detection</span> heuristics, the{' '}
        <span className="font-medium">Limn attribution</span> markers and the Slack bot digest are
        account-wide policy about our own behaviour, not judgements about a particular repo&apos;s
        tooling — they live in{' '}
        <span className="font-medium">Settings → Review bots (account-wide)</span>.
      </p>
    </div>
  );
}
