import { useMemo } from 'react';
import type { JSX } from 'react';
import type { User } from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useDetectedReviewers } from '../../hooks/useBotTriage.js';
import { userLabel } from '../../lib/ui.js';

// The Reports "People" section (plan P4.2 entry point a): the workspace's humans, each one
// click from their 1:1 — opening the EXISTING user-activity tab, whose PersonPeriodSection
// header defaults to the period being read here (it follows `insightsReportKey`).
//
// PREP, NOT SCORING (the non-negotiable): the list is ALPHABETICAL and carries NO metrics — no
// sort-by-anything, no per-person numbers on the row, nothing that reads as a ranking. The
// caption says what it is in one quiet line. If a metric column ever seems like a good idea
// here, it isn't — that is the leaderboard this section exists to not be.
//
// Membership = the EXISTING member data (the account roster) minus the UNION bot verdict the
// Feed uses (workspace `automated` rows ∪ users.isBot, a manual "human" winning both ways) —
// never a login heuristic. The server is the final word anyway: a bot or stranger's tab
// renders the section's own null state (core getPersonPeriod resolves lanes).
export function PeriodPeopleSection(): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const openUserActivityTab = usePinnedTabs((s) => s.openUserActivityTab);
  const { data: users } = useUsers();
  const { data: detected } = useDetectedReviewers(workspaceId);

  const humans = useMemo(() => {
    const reviewerByUserId = new Map(
      (detected?.reviewers ?? []).map((r) => [r.userId, r] as const),
    );
    const isUnionBot = (u: User): boolean => {
      const r = reviewerByUserId.get(u.id);
      if (r != null) {
        if (r.automated) return true;
        if (r.isManualOverride) return false; // a manual "human" beats the global flag
      }
      return u.isBot;
    };
    return (users ?? [])
      .filter((u) => !isUnionBot(u))
      .sort((a, b) => userLabel(a, a.id).localeCompare(userLabel(b, b.id)));
  }, [users, detected]);

  if (workspaceId == null || humans.length === 0) return null;

  const shown = humans.slice(0, 30);
  return (
    // Screen affordance, not part of the forwardable/printed artifact.
    <section aria-label="People" className="print:hidden">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          People
        </span>
        <span className="text-[11px] text-gray-400">
          prep for a 1:1, not a scorecard — alphabetical, no rankings
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() =>
              openUserActivityTab(u.id, {
                id: u.id,
                login: u.githubLogin,
                displayName: u.displayName,
                avatarUrl: u.avatarUrl,
              })
            }
            className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-600 hover:border-violet-400 hover:text-violet-700 dark:border-gray-700 dark:text-gray-300 dark:hover:border-violet-600 dark:hover:text-violet-300"
            title={`Open ${userLabel(u, u.id)}’s activity + 1:1 prep`}
          >
            {userLabel(u, u.id)}
          </button>
        ))}
        {humans.length > shown.length && (
          <span className="self-center text-[11px] text-gray-400">
            +{humans.length - shown.length} more in the Members list
          </span>
        )}
      </div>
    </section>
  );
}
