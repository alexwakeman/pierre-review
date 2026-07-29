import { useState } from 'react';
import type { BranchCommit, RepoBranchStatus } from '@pierre-review/shared';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { CI_META, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { CiDot } from './BranchStatusChip.js';

// The GitHub URL for a commit. `owner/name` and the sha both come from DATA, so the segments
// are encoded and the result goes through safeExternalUrl before it can reach an href — the
// house rule for every data-derived URL, even one we assembled ourselves.
function commitUrl(fullName: string | undefined, sha: string): string | undefined {
  if (!fullName) return undefined;
  const [owner, name] = fullName.split('/');
  if (!owner || !name) return undefined;
  return safeExternalUrl(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commit/${encodeURIComponent(sha)}`,
  );
}

function CommitRow({
  commit,
  fullName,
}: {
  commit: BranchCommit;
  fullName: string | undefined;
}): JSX.Element {
  const href = commitUrl(fullName, commit.sha);
  const who = commit.authorLogin ?? commit.authorName ?? 'unknown';
  const avatar = safeExternalUrl(commit.authorAvatarUrl);
  return (
    <li className="flex items-center gap-2 py-0.5 text-[11px]">
      <CiDot status={commit.ciStatus} size={5} />
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 font-mono text-gray-400 hover:text-sky-600 hover:underline dark:hover:text-sky-400"
        >
          {commit.sha.slice(0, 7)}
        </a>
      ) : (
        <span className="shrink-0 font-mono text-gray-400">{commit.sha.slice(0, 7)}</span>
      )}
      {/* The headline is UNTRUSTED text from a commit message — rendered as a plain text node
          (never markdown/HTML) and truncated. */}
      <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
        {commit.messageHeadline}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-gray-400">
        {avatar != null && (
          <img src={avatar} alt="" className="h-3.5 w-3.5 rounded-full" loading="lazy" />
        )}
        <span className="max-w-[10rem] truncate">{who}</span>
      </span>
      <span
        className="shrink-0 tabular-nums text-gray-400"
        title={new Date(commit.committedAt).toLocaleString()}
      >
        {relativeTime(commit.committedAt)}
      </span>
    </li>
  );
}

/**
 * One repo's trunk row: always-visible summary (branch, CI, last commit), expandable to the
 * recent commit list. Collapsed by default — the strip's job is to be scannable at a glance,
 * and the history is the follow-up question.
 */
function BranchRow({
  status,
  fullName,
  showRepoName,
}: {
  status: RepoBranchStatus;
  fullName: string | undefined;
  showRepoName: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ciMeta = CI_META[status.ciStatus];
  const hasCommits = status.commits.length > 0;
  return (
    <li className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!hasCommits}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs disabled:cursor-default enabled:hover:bg-gray-50 dark:enabled:hover:bg-gray-800/40"
      >
        <span
          aria-hidden="true"
          className={`w-2 shrink-0 text-[9px] text-gray-400 ${hasCommits ? '' : 'opacity-0'}`}
        >
          {open ? '▾' : '▸'}
        </span>
        <CiDot status={status.ciStatus} />
        {showRepoName && (
          <span className="min-w-0 max-w-[14rem] truncate font-medium text-gray-700 dark:text-gray-200">
            {fullName ?? `repo ${status.repoId}`}
          </span>
        )}
        <span className="min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400">
          {status.branchName ?? '—'}
        </span>
        <span className="shrink-0 text-[11px] text-gray-400">
          {ciMeta?.label ?? 'no CI reported'}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-gray-400">
          {status.lastCommitAt != null ? relativeTime(status.lastCommitAt) : 'never synced'}
        </span>
      </button>
      {open && hasCommits && (
        <ul className="border-t border-gray-100 px-2 py-1 pl-6 dark:border-gray-800/60">
          {status.commits.map((c) => (
            <CommitRow key={c.sha} commit={c} fullName={fullName} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The cross-repo default-branch strip: every repo in scope, its trunk CI state, and (on
 * expand) what recently landed there with who wrote it.
 *
 * Why it exists: everything else in this app is PR-shaped, so a red default branch — which
 * invalidates every open PR's CI at once — had nowhere to show. It is a readout, NOT an alert
 * channel: it never contributes to attention counts, the rail sort, My Turn, or any badge.
 *
 * `repoIds` (optional) pins the strip to one repo, for the per-repo console header. Omitted, it
 * follows the FilterBar/team scope like the rest of the Activity console.
 */
export function BranchStatusPanel({
  repoIds,
  compact = false,
}: {
  repoIds?: number[] | null;
  compact?: boolean;
}): JSX.Element | null {
  const { data, isLoading } = useBranchStatus(repoIds);
  const { data: repos } = useRepos();
  const nameById = new Map((repos ?? []).map((r) => [r.id, r.fullName]));

  if (isLoading && data == null) return null;
  const rows = data?.repos ?? [];
  // Repos that have never been branch-synced carry nulls across the board. Showing a strip of
  // "—" rows on a fresh account is noise, so the whole panel hides until at least one repo has
  // real branch data; individual unsynced repos still get a row once any of them does (the row
  // count must match the repo list, so a partially-synced scope isn't silently shortened).
  const anySynced = rows.some((r) => r.branchName != null);
  if (!anySynced) return null;

  const failing = rows.filter(
    (r) => r.ciStatus === 'failure' || r.ciStatus === 'error',
  ).length;

  return (
    <section
      className="rounded-lg border border-gray-200 dark:border-gray-800"
      data-testid="branch-status-panel"
    >
      <div className="flex items-center gap-2 border-b border-gray-100 px-2 py-1 dark:border-gray-800/60">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Default branches
        </span>
        {failing > 0 && (
          <span
            className="rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-600 dark:text-red-400"
            title="Default branches whose latest CI is failing"
          >
            {failing} failing
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-400">
          {rows.length} repo{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className={compact ? '' : 'max-h-64 overflow-y-auto'}>
        {rows.map((r) => (
          <BranchRow
            key={r.repoId}
            status={r}
            fullName={nameById.get(r.repoId)}
            // In the single-repo console the name is already the header above; repeating it in
            // every row is noise.
            showRepoName={!compact}
          />
        ))}
      </ul>
    </section>
  );
}
