import { useMemo } from 'react';
import { type User } from '@pierre-review/shared';
import { useMergers, useRepos, useSearchTimeline, useUsers } from '../hooks/useTimeline.js';
import { useSearchOpenPrs } from '../hooks/useTriage.js';
import { useFilters, type RangePreset } from '../store/filters.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { EventSelectPanel } from './EventSelectPanel.js';
import { StatusSelectPanel } from './StatusSelectPanel.js';
import { TeamSelector } from './TeamSelector.js';
import { ThreadStateSelectPanel } from './ThreadStateSelectPanel.js';
import { UserSelectPanel, type MemberSection } from './UserSelectPanel.js';

const PRESETS: Exclude<RangePreset, 'custom'>[] = ['7d', '14d', '30d', '90d'];

function Chip({
  active,
  onClick,
  children,
  color,
  title,
  onRemove,
  removeTitle,
  removeDisabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
  title?: string;
  onRemove?: () => void;
  removeTitle?: string;
  removeDisabled?: boolean;
}): JSX.Element {
  const pill = `whitespace-nowrap rounded-full border text-xs transition ${
    active
      ? 'border-transparent bg-blue-600 text-white'
      : 'border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500'
  }`;
  const style = active && color ? { backgroundColor: color } : undefined;

  // Without a remove affordance the chip is a single button. With one, render
  // the toggle and the ✕ as *sibling* buttons inside a shared pill — never a
  // button nested in a button (which can swallow the inner click).
  if (!onRemove) {
    return (
      <button type="button" onClick={onClick} title={title} className={`${pill} px-2.5 py-0.5`} style={style}>
        {children}
      </button>
    );
  }
  return (
    <span className={`inline-flex items-center ${pill}`} style={style}>
      <button type="button" onClick={onClick} title={title} className="py-0.5 pl-2.5 pr-1">
        {children}
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={removeDisabled}
        title={removeTitle}
        aria-label={removeTitle}
        className="py-0.5 pl-0.5 pr-2 opacity-50 hover:opacity-100 disabled:opacity-30"
      >
        ✕
      </button>
    </span>
  );
}

function Section({
  label,
  children,
}: {
  // Optional: the dropdown-panel sections (Repos / Status / Members / Events /
  // Threads) omit it because their trigger button already shows the name — the
  // label would be redundant. The Range chip section keeps it, since its chips
  // don't repeat the category name. Without a label the wrapper still groups its
  // children with the same spacing.
  label?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {label != null && (
        <span className="text-[11px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

export function FilterBar(): JSX.Element {
  const { data: repos } = useRepos();
  const { data: users } = useUsers();
  // Member-AGNOSTIC, repo-scoped activity (ignores the member filter, so the
  // option list never collapses to just the already-selected members). When a
  // repo filter is active these payloads already contain only the selected repos.
  const { data: searchTimeline } = useSearchTimeline();
  const { data: searchOpenPrs } = useSearchOpenPrs();
  const { data: mergers } = useMergers();

  const f = useFilters();

  // The Activity console only honours the team/repos scope — Members / Range / Status /
  // Events / Threads are timeline-only, so on the Activity tab they (and the right-hand
  // Saved-Views / Clear-filters cluster) are hidden.
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const isActivity = activeTab === 'activity';

  // The FilterBar is always fully live now — PR-isolation / My-Turn focus is a separate
  // TAB (its own keyed <Timeline>), so it no longer disables or fades the board filters.
  // Repo/team MANAGEMENT (add/remove/assign) now lives in the Activity console's TeamManager;
  // the FilterBar only carries the read-only TEAM SCOPE selector (TeamSelector) below.

  // Member picker options, organised into sections: one section per in-scope repo
  // listing that repo's members. A member active in several repos is intentionally
  // REPEATED across those sections; selection is keyed by user id, so checking them
  // in one section checks them everywhere. A trailing "Other" group holds the full
  // non-bot roster remainder (when no repo filter is set) plus any selected-but-
  // inactive members, so anyone stays pickable and selections stay visible.
  // maintainerIds (merge rights in the relevant repo(s)) drives both the per-row
  // shields and the panel's "Maintainers" quick-select — it is no longer a section.
  const {
    sections: memberSections,
    botSections,
    maintainerIds,
  } = useMemo(() => {
    const repoScoped = f.repoIds != null && f.repoIds.length > 0;
    const inScopeRepoIds = repoScoped ? new Set(f.repoIds) : null;

    const byId = new Map((users ?? []).map((u) => [u.id, u] as const));
    const usable = (id: number | null): User | null => {
      if (id == null) return null;
      const u = byId.get(id);
      return u && !u.isBot ? u : null;
    };
    const botOf = (id: number | null): User | null => {
      if (id == null) return null;
      const u = byId.get(id);
      return u && u.isBot ? u : null;
    };

    // Per-repo membership, derived from the member-agnostic window activity.
    // Limited to in-scope repos (the selected repos, or all when no repo filter).
    const repoMembers = new Map<number, Set<number>>();
    const addMember = (repoId: number, userId: number | null): void => {
      if (userId == null) return;
      if (inScopeRepoIds && !inScopeRepoIds.has(repoId)) return;
      let set = repoMembers.get(repoId);
      if (!set) repoMembers.set(repoId, (set = new Set()));
      set.add(userId);
    };
    for (const e of searchTimeline?.events ?? []) addMember(e.repoId, e.actorId);
    for (const p of searchTimeline?.prs ?? []) addMember(p.repoId, p.authorId);
    for (const p of searchOpenPrs?.prs ?? []) addMember(p.repoId, p.authorId);

    // Maintainers (merge rights) in the relevant repo(s). They also count as
    // members of their repo, so a maintainer surfaces under their repo section
    // even without any activity in the window. Bots/unknowns are skipped so the
    // "Maintainers" quick-select only stages real, selectable members.
    const maintainers = new Set<number>();
    for (const m of mergers ?? []) {
      if (inScopeRepoIds && !inScopeRepoIds.has(m.repoId)) continue;
      for (const uid of m.userIds) {
        if (!usable(uid)) continue;
        maintainers.add(uid);
        addMember(m.repoId, uid);
      }
    }

    const byName = (a: User, b: User): number =>
      (a.displayName || a.githubLogin).localeCompare(b.displayName || b.githubLogin);
    const maintainerFirst = (a: User, b: User): number => {
      const rank = (maintainers.has(a.id) ? 0 : 1) - (maintainers.has(b.id) ? 0 : 1);
      return rank !== 0 ? rank : byName(a, b);
    };

    const sections: MemberSection[] = [];
    const placed = new Set<number>();

    // One section per in-scope repo (kept in the repo-chip order). Maintainers are
    // sorted first within each repo (and badged), but get no section of their own —
    // the "Maintainers" quick-select in the panel covers them across all repos.
    for (const r of repos ?? []) {
      if (inScopeRepoIds && !inScopeRepoIds.has(r.id)) continue;
      const ids = repoMembers.get(r.id);
      if (!ids || ids.size === 0) continue;
      const members = [...ids]
        .map(usable)
        .filter((u): u is User => u != null)
        .sort(maintainerFirst);
      if (!members.length) continue;
      sections.push({ key: `repo:${r.id}`, label: r.name, members });
      for (const u of members) placed.add(u.id);
    }

    // Selectable universe: the full non-bot roster when there's no repo filter,
    // else the placed (active/maintainer) members plus any selected ones. Whatever
    // isn't already in a section above falls into "Other".
    const selectedIds = f.userIds ?? [];
    const universe = repoScoped
      ? new Set<number>([...placed, ...selectedIds])
      : new Set<number>((users ?? []).filter((u) => !u.isBot).map((u) => u.id));
    const other = [...universe]
      .map(usable)
      .filter((u): u is User => u != null)
      .filter((u) => !placed.has(u.id))
      .sort(byName);
    if (other.length) {
      sections.push({
        key: 'other',
        label: repoScoped ? 'Other' : 'No recent activity',
        members: other,
      });
    }

    // Per-repo Bots sections (item 3): the bot contributors active in each in-scope repo,
    // so the user can allow-list the important ones. Derived from the same (bot-inclusive)
    // window activity as members — repoMembers already holds bot ids (usable() filtered
    // them out of the member sections). Any bot with no repo activity but already allow-
    // listed still needs to be togglable, so it's floated into an "Other bots" section.
    const botSections: MemberSection[] = [];
    const placedBots = new Set<number>();
    for (const r of repos ?? []) {
      if (inScopeRepoIds && !inScopeRepoIds.has(r.id)) continue;
      const ids = repoMembers.get(r.id);
      if (!ids) continue;
      const bots = [...ids]
        .map(botOf)
        .filter((u): u is User => u != null)
        .sort(byName);
      if (!bots.length) continue;
      botSections.push({ key: `bot:${r.id}`, label: r.name, members: bots });
      for (const u of bots) placedBots.add(u.id);
    }
    const allowedNotShown = (f.allowedBotIds ?? [])
      .map(botOf)
      .filter((u): u is User => u != null)
      .filter((u) => !placedBots.has(u.id))
      .sort(byName);
    if (allowedNotShown.length) {
      botSections.push({ key: 'bot:other', label: 'Other bots', members: allowedNotShown });
    }

    return { sections, botSections, maintainerIds: maintainers };
  }, [users, searchTimeline, searchOpenPrs, mergers, repos, f.repoIds, f.userIds, f.allowedBotIds]);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-800 dark:bg-gray-900">
      {/* The board filters. Always live — focus is a separate tab now, not an overlay
          that locks the board. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Team scope: pick All repos / All Teams / a team / No team; repo/team management
            lives inside this dropdown. Shown on EVERY view (Timeline + Activity/Insights) — the
            single scope control, so the Activity rail no longer carries its own. */}
        <Section>
          <TeamSelector />
        </Section>

        {/* Members is timeline-only too — Activity's queries ignore the member selection
            (its bot filtering lives in the feed's own lens pills), so the panel hides there. */}
        {!isActivity && (
          <Section>
            <UserSelectPanel
              sections={memberSections}
              botSections={botSections}
              userIds={f.userIds}
              maintainerIds={maintainerIds}
              onApply={(ids) => f.setUserIds(ids)}
              excludeBots={f.excludeBots}
              onExcludeBotsChange={f.setExcludeBots}
              allowedBotIds={f.allowedBotIds}
              onToggleAllowedBot={f.toggleAllowedBot}
            />
          </Section>
        )}

        {/* Status / Events / Threads / Range are timeline-only — hidden on Activity,
            where only the team/repos scope applies. */}
        {!isActivity && (
          <Section>
            <StatusSelectPanel
              statuses={f.prStatuses}
              onToggle={f.togglePrStatus}
              onSet={f.setPrStatuses}
              excludeStale={f.excludeStale}
              onExcludeStaleChange={f.setExcludeStale}
            />
          </Section>
        )}

        {!isActivity && (
          <Section>
            <EventSelectPanel
              categories={f.categories}
              onToggleCategory={(c) => f.toggleCategory(c)}
              onSetCategories={(c) => f.setCategories(c)}
              reviewStates={f.reviewStates}
              onToggleReviewState={(s) => f.toggleReviewState(s)}
              onSetReviewStates={(s) => f.setReviewStates(s)}
            />
          </Section>
        )}

        {!isActivity && (
          <Section>
            <ThreadStateSelectPanel
              derivedStates={f.derivedStates}
              onToggle={(s) => f.toggleDerivedState(s)}
              onClear={() => f.setDerivedStates([])}
            />
          </Section>
        )}

        {/* Range (+ Now) sits at the END of the board-filters cluster. */}
        {!isActivity && (
          <Section label="Range">
            {PRESETS.map((p) => (
              <Chip key={p} active={f.preset === p} onClick={() => f.setPreset(p)}>
                {p}
              </Chip>
            ))}
            <button
              type="button"
              onClick={() => f.centerTimelineNow()}
              title="Recenter the timeline on the current time (keeps the zoom)"
              className="whitespace-nowrap rounded-full border border-sky-300 px-2.5 py-0.5 text-xs text-sky-600 transition hover:border-sky-400 hover:bg-sky-50 dark:border-sky-700 dark:text-sky-400 dark:hover:bg-sky-900/30"
            >
              Now
            </button>
          </Section>
        )}

      </div>

      {/* Right cluster, pinned next to the timeline. Timeline-only filter management —
          hidden on Activity (only the team/repos scope applies there). Clear filters stays usable
          even while a focus/PR tab is open (that's a separate tab, not a lock on the shared
          board). */}
      {!isActivity && (
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => f.resetAllFilters()}
            title="Reset all filters to their defaults"
            className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 transition hover:border-gray-400 hover:text-gray-800 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:text-gray-100"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
