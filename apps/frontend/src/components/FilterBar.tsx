import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DERIVED_STATES,
  PR_STATUSES,
  type DerivedState,
  type EventCategory,
  type PrStatus,
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
import { UserSelectPanel } from './UserSelectPanel.js';

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

  // Member picker options. With NO repo filter we offer the full non-bot roster
  // (so you can pick anyone), surfacing in-window actors first then alphabetical.
  // With a repo filter active we LIMIT the list to members active in the selected
  // repo(s) — derived from the member-agnostic search payloads above, which
  // already contain only those repos, so the list mirrors who's actually on the
  // timeline for them. Currently-selected members are always kept so they stay
  // visible/un-checkable even if they have no activity in the selected repos.
  const repoScoped = f.repoIds != null && f.repoIds.length > 0;
  const selectedIds = new Set(f.userIds ?? []);
  const activeMemberIds = new Set(
    [
      ...(searchTimeline?.events ?? []).map((e) => e.actorId),
      ...(searchTimeline?.prs ?? []).map((p) => p.authorId),
      ...(searchOpenPrs?.prs ?? []).map((p) => p.authorId),
    ].filter((x): x is number => x != null),
  );
  // Members with merge rights in the relevant repo(s) — the selected repos when a
  // repo filter is active, else any repo — so the picker shows the same shield
  // as the timeline rows.
  const maintainerIds = new Set<number>();
  for (const m of mergers ?? []) {
    if (repoScoped && !(f.repoIds ?? []).includes(m.repoId)) continue;
    for (const uid of m.userIds) maintainerIds.add(uid);
  }
  const memberUsers = (users ?? [])
    .filter((u) => !u.isBot)
    .filter((u) => !repoScoped || activeMemberIds.has(u.id) || selectedIds.has(u.id))
    .sort((a, b) => {
      const aActive = activeMemberIds.has(a.id) ? 0 : 1;
      const bActive = activeMemberIds.has(b.id) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (a.displayName || a.githubLogin).localeCompare(b.displayName || b.githubLogin);
    });

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
          members={memberUsers}
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
    </div>
  );
}
