import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DERIVED_STATES,
  type DerivedState,
  type EventCategory,
} from '@gh-team-monitor/shared';
import { api, ApiError } from '../api/client.js';
import { useRepos, useTimeline, useUsers } from '../hooks/useTimeline.js';
import {
  ALL_CATEGORIES,
  useFilters,
  type RangePreset,
} from '../store/filters.js';
import { DERIVED_STATE_META } from '../lib/ui.js';

const PRESETS: Exclude<RangePreset, 'custom'>[] = ['7d', '14d', '30d', '90d'];
const CATEGORY_LABELS: Record<EventCategory, string> = {
  lifecycle: 'Lifecycle',
  reviews: 'Reviews',
  review_comments: 'Review comments',
  pr_comments: 'PR comments',
  pushes: 'Pushes',
};

function Chip({
  active,
  onClick,
  children,
  color,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
  title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs transition ${
        active
          ? 'border-transparent bg-blue-600 text-white'
          : 'border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500'
      }`}
      style={active && color ? { backgroundColor: color } : undefined}
    >
      {children}
    </button>
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
  const { data: timeline } = useTimeline();

  const f = useFilters();

  // Members that are actually active in the current window (keeps the list
  // short). Falls back to all non-bot users if the timeline is empty.
  const activeMemberIds = new Set(
    (timeline?.events ?? []).map((e) => e.actorId).filter((x): x is number => x != null),
  );
  const memberUsers = (users ?? [])
    .filter((u) => !u.isBot && (activeMemberIds.size === 0 || activeMemberIds.has(u.id)))
    .sort((a, b) => (a.displayName || a.githubLogin).localeCompare(b.displayName || b.githubLogin));

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-800 dark:bg-gray-900">
      <Section label="Repos">
        {(repos ?? []).map((r) => (
          <Chip
            key={r.id}
            active={f.repoIds == null ? false : f.repoIds.includes(r.id)}
            onClick={() => f.toggleRepo(r.id)}
            title={r.fullName}
          >
            {r.name}
          </Chip>
        ))}
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
        <div className="flex max-h-14 max-w-[28rem] flex-wrap items-center gap-1 overflow-y-auto">
          {memberUsers.map((u) => (
            <Chip
              key={u.id}
              active={f.userIds == null ? false : f.userIds.includes(u.id)}
              onClick={() => f.toggleUser(u.id)}
              title={u.githubLogin}
            >
              {u.displayName || u.githubLogin}
            </Chip>
          ))}
          {f.userIds && f.userIds.length > 0 && (
            <button
              type="button"
              onClick={() => f.setUserIds(null)}
              className="text-[11px] text-gray-400 hover:text-gray-600"
            >
              all
            </button>
          )}
        </div>
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
