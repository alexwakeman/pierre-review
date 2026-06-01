import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DERIVED_STATES,
  PR_STATUSES,
  type DerivedState,
  type EventCategory,
  type PrStatus,
  type User,
} from '@gh-team-monitor/shared';
import { api, ApiError } from '../api/client.js';
import { useMergers, useRepos, useSearchTimeline, useUsers } from '../hooks/useTimeline.js';
import { useSearchOpenPrs } from '../hooks/useTriage.js';
import {
  ALL_CATEGORIES,
  useFilters,
  type RangePreset,
} from '../store/filters.js';
import { DERIVED_STATE_META } from '../lib/ui.js';
import { UserSelectPanel, type MemberSection } from './UserSelectPanel.js';

const PRESETS: Exclude<RangePreset, 'custom'>[] = ['7d', '14d', '30d', '90d'];
const CATEGORY_LABELS: Record<EventCategory, string> = {
  lifecycle: 'Lifecycle',
  reviews: 'Reviews',
  review_comments: 'Review comments',
  pr_comments: 'PR comments',
  commits: 'Commits',
};
const STATUS_LABELS: Record<PrStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
};

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

function AddRepo(): JSX.Element {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const mutation = useMutation({
    mutationFn: (slug: string) => {
      const [owner, name] = slug.split('/');
      if (!owner || !name) throw new Error('Use owner/name');
      return api.addRepo({ owner, name });
    },
    onSuccess: () => {
      setValue('');
      void qc.invalidateQueries({ queryKey: ['repos'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) mutation.mutate(value.trim());
      }}
    >
      <input
        id="add-repo-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="owner/repo"
        className="w-32 rounded border border-gray-300 bg-transparent px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
      />
      <button
        type="submit"
        disabled={mutation.isPending}
        className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white disabled:opacity-50"
      >
        {mutation.isPending ? 'Adding…' : 'Add'}
      </button>
      {mutation.error && (
        <span className="max-w-[14rem] truncate text-xs text-red-500" title={String(mutation.error)}>
          {mutation.error instanceof ApiError
            ? mutation.error.message
            : String(mutation.error)}
        </span>
      )}
    </form>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-gray-400">
        {label}
      </span>
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
  const qc = useQueryClient();
  const removeRepo = useMutation({
    mutationFn: (id: number) => api.deleteRepo(id),
    onSuccess: (_data, id) => {
      // Drop the deleted repo from the active filter so its now-gone entries
      // don't linger as a selected-but-missing id (empty → null = "all").
      const cur = useFilters.getState();
      const next = cur.repoIds?.filter((r) => r !== id);
      cur.setRepoIds(next && next.length ? next : null);
      for (const key of ['repos', 'timeline', 'open-prs', 'users', 'my-turn', 'me']) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  // Member picker options, organised into sections: one section per in-scope repo
  // listing that repo's members. A member active in several repos is intentionally
  // REPEATED across those sections; selection is keyed by user id, so checking them
  // in one section checks them everywhere. A trailing "Other" group holds the full
  // non-bot roster remainder (when no repo filter is set) plus any selected-but-
  // inactive members, so anyone stays pickable and selections stay visible.
  // maintainerIds (merge rights in the relevant repo(s)) drives both the per-row
  // shields and the panel's "Maintainers" quick-select — it is no longer a section.
  const { sections: memberSections, maintainerIds } = useMemo(() => {
    const repoScoped = f.repoIds != null && f.repoIds.length > 0;
    const inScopeRepoIds = repoScoped ? new Set(f.repoIds) : null;

    const byId = new Map((users ?? []).map((u) => [u.id, u] as const));
    const usable = (id: number | null): User | null => {
      if (id == null) return null;
      const u = byId.get(id);
      return u && !u.isBot ? u : null;
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

    return { sections, maintainerIds: maintainers };
  }, [users, searchTimeline, searchOpenPrs, mergers, repos, f.repoIds, f.userIds]);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-800 dark:bg-gray-900">
      <Section label="Repos">
        {(repos ?? []).map((r) => (
          <Chip
            key={r.id}
            active={f.repoIds == null ? false : f.repoIds.includes(r.id)}
            onClick={() => f.toggleRepo(r.id)}
            title={r.fullName}
            removeTitle={`Remove ${r.fullName}`}
            removeDisabled={removeRepo.isPending}
            onRemove={() => {
              if (
                window.confirm(
                  `Stop watching ${r.fullName}? This deletes all of its locally-synced data.`,
                )
              ) {
                removeRepo.mutate(r.id);
              }
            }}
          >
            {r.name}
          </Chip>
        ))}
        {removeRepo.error && (
          <span
            className="max-w-[14rem] truncate text-xs text-red-500"
            title={String(removeRepo.error)}
          >
            {removeRepo.error instanceof ApiError
              ? removeRepo.error.message
              : 'Failed to remove repo'}
          </span>
        )}
        {f.repoIds && f.repoIds.length > 0 && (
          <button
            type="button"
            onClick={() => f.setRepoIds(null)}
            className="text-[11px] text-gray-400 hover:text-gray-600"
          >
            all
          </button>
        )}
        <AddRepo />
      </Section>

      <Section label="Members">
        <UserSelectPanel
          sections={memberSections}
          userIds={f.userIds}
          maintainerIds={maintainerIds}
          onApply={(ids) => f.setUserIds(ids)}
        />
        <label className="flex items-center gap-1 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={f.excludeBots}
            onChange={(e) => f.setExcludeBots(e.target.checked)}
          />
          exclude bots
        </label>
      </Section>

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

      <Section label="Status">
        {PR_STATUSES.map((s: PrStatus) => (
          <Chip
            key={s}
            active={f.prStatuses.includes(s)}
            onClick={() => f.togglePrStatus(s)}
          >
            {STATUS_LABELS[s]}
          </Chip>
        ))}
      </Section>

      <Section label="Events">
        {ALL_CATEGORIES.map((c) => (
          <Chip
            key={c}
            active={f.categories.includes(c)}
            onClick={() => f.toggleCategory(c)}
          >
            {CATEGORY_LABELS[c]}
          </Chip>
        ))}
      </Section>

      <Section label="Threads">
        {DERIVED_STATES.map((s: DerivedState) => (
          <Chip
            key={s}
            active={f.derivedStates.includes(s)}
            color={DERIVED_STATE_META[s].color}
            onClick={() => f.toggleDerivedState(s)}
            title={DERIVED_STATE_META[s].description}
          >
            {DERIVED_STATE_META[s].label}
          </Chip>
        ))}
      </Section>

      {/* Reset everything to fresh-load defaults (clears repos/members/range/
          categories/statuses/threads/search + any selection). Pushed to the far
          right so it reads as a distinct, global action. */}
      <button
        type="button"
        onClick={() => f.resetAllFilters()}
        title="Reset all filters to their defaults"
        className="ml-auto whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:border-gray-400 hover:text-gray-800 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:text-gray-100"
      >
        Clear all
      </button>
    </div>
  );
}
