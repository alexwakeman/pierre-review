import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepoSearchResult, SuggestedReposResponse } from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { ACTIVITY_QUERY_KEYS } from '../../hooks/useActivity.js';
import { RepoSearch } from '../RepoSearch.js';
import { StarIcon } from '../Icons.js';
import { CheckboxBox } from '../ui/FormControls.js';

// How many detected repos are pre-checked. Kept small so the one-click "Add selected" flow
// doesn't kick off a 30-repo two-phase backfill storm on the user's very first action.
const DEFAULT_CHECKED = 5;

// The full cache cascade a repo-add invalidates (mirrors RepoSearch's INVALIDATE_KEYS, which
// isn't exported) plus the repo-search + this onboarding query. Run ONCE after the whole batch
// rather than per-add, so N adds don't each trigger an ~10-key invalidation storm.
const INVALIDATE_KEYS = [
  'repos',
  'timeline',
  'open-prs',
  'users',
  'my-turn',
  'me',
  ...ACTIVITY_QUERY_KEYS,
  'repo-search',
  'repo-suggested',
];

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function OwnerAvatar({ login, src }: { login: string; src: string | null }): JSX.Element {
  if (src) {
    return (
      <img
        src={src}
        alt={login}
        width={20}
        height={20}
        className="mt-0.5 h-5 w-5 shrink-0 rounded-full"
      />
    );
  }
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ui-hover text-meta font-semibold text-ui-ink">
      {login.slice(0, 2).toUpperCase()}
    </span>
  );
}

// The zero-repo Activity console body: detect the repos the viewer has recently pushed to /
// contributed on, let them one-click add a selection, and hand off to the existing
// add → two-phase-backfill cascade to populate the board. Only ever mounted
// when the account has zero repos (see ActivityView); a successful add flips that condition
// and this unmounts, revealing the populated console.
export function FirstRunOnboarding(): JSX.Element {
  const qc = useQueryClient();
  const requestSyncModal = useFilters((s) => s.requestSyncModal);

  const { data, isLoading, isError } = useQuery<SuggestedReposResponse>({
    queryKey: ['repo-suggested'],
    queryFn: () => api.suggestedRepos(),
    staleTime: 5 * 60_000,
  });

  const suggestions = useMemo(() => data?.results ?? [], [data]);

  // Selection is keyed by the stable repo node id. Pre-check the top few once suggestions
  // first arrive; the user's later toggles are never overridden (the flag stays set).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!initialized && suggestions.length > 0) {
      setSelected(new Set(suggestions.slice(0, DEFAULT_CHECKED).map((r) => r.githubNodeId)));
      setInitialized(true);
    }
  }, [initialized, suggestions]);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(
    null,
  );
  const [failures, setFailures] = useState<{ fullName: string; message: string }[]>([]);
  // Successful adds whose sync-modal signal + cache invalidation are HELD BACK while failures
  // are on screen: firing either mid-batch (or under a failure box) refetches ['repos'] — via
  // SyncStatus's signal handler — flips hasAnyRepo, and unmounts this component before the
  // user ever sees what failed. Flushed by the "Continue" button.
  const [pendingSuccessIds, setPendingSuccessIds] = useState<number[]>([]);

  const chosen = suggestions.filter((r) => selected.has(r.githubNodeId));

  function toggle(id: string): void {
    if (running) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Fire the deferred sync-modal signals (the modal merges them into one scoped round) and
  // the ONE invalidation batch. On ≥1 success ['repos'] refetches, the account is no longer
  // zero-repo, and ActivityView swaps this component out for the populated console.
  function flushBatch(successIds: number[]): void {
    for (const id of successIds) requestSyncModal(id);
    for (const key of INVALIDATE_KEYS) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
    setPendingSuccessIds([]);
  }

  async function addSelected(): Promise<void> {
    if (running || chosen.length === 0) return;
    setRunning(true);
    setFailures([]);
    const fails: { fullName: string; message: string }[] = [];
    const successIds: number[] = [];
    let done = 0;
    for (const r of chosen) {
      setProgress({ done, total: chosen.length, current: r.fullName });
      try {
        const repo = await api.addRepo({ owner: r.owner, name: r.name });
        // The backfill is already running server-side; the sync-modal signal is DEFERRED to
        // flushBatch — signalling now would make SyncStatus invalidate ['repos'] and unmount
        // this component mid-loop (killing the progress display and any failure report).
        successIds.push(repo.id);
      } catch (err) {
        fails.push({
          fullName: r.fullName,
          message: err instanceof ApiError ? err.message : 'Failed to add',
        });
      }
      done++;
    }
    setProgress(null);
    setFailures(fails);
    setRunning(false);
    if (fails.length === 0) {
      // Clean run — hand off to the populated console immediately.
      flushBatch(successIds);
    } else {
      // Hold the flush so the failure report stays on screen; "Continue" releases it.
      setPendingSuccessIds(successIds);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 py-6">
      <header>
        <h2 className="text-title font-semibold text-ui-ink">
          Add the repos you work on
        </h2>
        <p className="mt-1 text-body text-ui-mute">
          Limn tracks the repos you care about &mdash; here&rsquo;s what you&rsquo;ve been
          working on.
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-ui bg-ui-surface"
            />
          ))}
        </div>
      ) : isError ? (
        <p className="text-meta text-ui-faint">
          Couldn&rsquo;t detect your recent repos &mdash; add one below to get started.
        </p>
      ) : suggestions.length === 0 ? (
        <p className="text-meta text-ui-faint">
          No recent activity found &mdash; add any repo below to get started.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-ui border border-ui-line">
            {suggestions.map((r: RepoSearchResult) => {
              const on = selected.has(r.githubNodeId);
              return (
                <label
                  key={r.githubNodeId}
                  className={`flex cursor-pointer items-start gap-2.5 border-b border-ui-line px-3 py-2 last:border-b-0 ${
                    on ? 'bg-ui-sel' : 'hover:bg-ui-hover'
                  } ${running ? 'cursor-default opacity-70' : ''}`}
                >
                  <CheckboxBox
                    checked={on}
                    disabled={running}
                    onChange={() => toggle(r.githubNodeId)}
                    className="mt-0.5"
                  />
                  <OwnerAvatar login={r.owner} src={r.ownerAvatarUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="truncate text-meta font-medium text-ui-ink"
                        title={r.fullName}
                      >
                        {r.fullName}
                      </span>
                      {r.isPrivate && (
                        <span className="shrink-0 rounded-ui bg-ui-hover px-1 text-meta  text-ui-mute">
                          private
                        </span>
                      )}
                      {r.isOwnedOrMember && (
                        <span className="shrink-0 rounded-ui bg-ui-sel px-1 text-meta  text-ui-accent">
                          yours
                        </span>
                      )}
                    </span>
                    {r.description && (
                      <span className="mt-0.5 line-clamp-2 text-meta text-ui-mute">
                        {r.description}
                      </span>
                    )}
                    <span className="mt-0.5 flex items-center gap-2 text-meta text-ui-faint">
                      <span
                        className="flex items-center gap-1"
                        title={`${r.stargazerCount} stars`}
                      >
                        <StarIcon size={10} />
                        {compactNumber(r.stargazerCount)}
                      </span>
                      <span aria-hidden>·</span>
                      <span title={`${r.openPrCount} open pull requests`}>
                        {compactNumber(r.openPrCount)} open PR{r.openPrCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={addSelected}
              disabled={running || chosen.length === 0}
              className="hit rounded-ui bg-ui-accent-fill px-3 py-1.5 text-meta font-medium text-ui-on-accent hover:bg-ui-accent-fill disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running
                ? progress
                  ? `Adding ${progress.done + 1}/${progress.total} — ${progress.current}…`
                  : 'Adding…'
                : `Add ${chosen.length} selected`}
            </button>
            {!running && (
              <span className="text-meta text-ui-faint">
                {chosen.length} of {suggestions.length} selected
              </span>
            )}
          </div>

          {failures.length > 0 && (
            <div className="rounded-ui bg-ui-raise px-3 py-2 text-meta text-ui-warn">
              <div className="font-semibold">Couldn&rsquo;t add {failures.length} repo{failures.length === 1 ? '' : 's'}:</div>
              <ul className="mt-1 space-y-0.5">
                {failures.map((f) => (
                  <li key={f.fullName}>
                    <span className="font-medium">{f.fullName}</span> — {f.message}
                  </li>
                ))}
              </ul>
              {pendingSuccessIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => flushBatch(pendingSuccessIds)}
                  className="hit mt-2 rounded-ui bg-ui-accent-fill px-2.5 py-1 text-meta font-medium text-ui-on-accent hover:bg-ui-accent-fill"
                >
                  Continue with the {pendingSuccessIds.length} added repo
                  {pendingSuccessIds.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-ui-line pt-4">
        <p className="mb-2 text-meta text-ui-mute">
          or add any repo by name
        </p>
        <RepoSearch placeholder="Search repos to add…" />
      </div>
    </div>
  );
}
