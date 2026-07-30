import { useState } from 'react';
import type { BranchCheckRun, BranchCommit, RepoBranchStatus } from '@pierre-review/shared';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { trimTrailingPrRef } from '../../lib/prRef.js';
import { CHECK_STATE_META, CI_META, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
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

// Same treatment for a PR: every segment is data, encoded, and run through safeExternalUrl before
// it can reach an href.
function prUrl(fullName: string | undefined, prNumber: number): string | undefined {
  if (!fullName) return undefined;
  const [owner, name] = fullName.split('/');
  if (!owner || !name) return undefined;
  return safeExternalUrl(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pull/${prNumber}`,
  );
}

// TabMeta for a trunk commit's PR: the number + repo are all this surface knows. PrDetail
// backfills the title/author chrome via usePinnedTabs.syncMeta once its detail query lands.
function prTabMeta(prId: number, prNumber: number, repoFullName: string): TabMeta {
  return {
    id: prId,
    number: prNumber,
    title: `#${prNumber}`,
    repoFullName,
    authorLogin: null,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

// The display label for one check. `workflowName` is null for a legacy StatusContext and for a
// non-Actions check suite, so the name stands alone there — nothing here may REQUIRE the workflow.
function checkLabel(check: BranchCheckRun): string {
  return check.workflowName != null ? `${check.workflowName} / ${check.name}` : check.name;
}

// One failing check, as a link when GitHub gave us a URL. CHECK_STATE_META is the SAME per-check
// vocabulary the PR checks UI uses — a trunk failure must not read as a different kind of object
// than a PR failure. The check's name is UNTRUSTED third-party text (whatever the CI vendor chose)
// so it is a plain text node, and `check.url` is third-party data (a StatusContext's targetUrl is
// whatever was posted), so it goes through safeExternalUrl.
function FailingCheck({ check }: { check: BranchCheckRun }): JSX.Element {
  const meta = CHECK_STATE_META[check.state];
  const href = safeExternalUrl(check.url);
  const label = checkLabel(check);
  const inner = (
    <span className="flex min-w-0 items-center gap-1">
      <span
        aria-hidden="true"
        style={{ color: meta.color }}
        className="shrink-0 text-[10px] font-bold"
      >
        {meta.icon}
      </span>
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </span>
  );
  return href != null ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="min-w-0 text-red-600 hover:underline dark:text-red-400"
    >
      {inner}
    </a>
  ) : (
    <span className="min-w-0 text-red-600 dark:text-red-400">{inner}</span>
  );
}

// The repo row's inline summary: "· build +2". The leading CI label ("CI failing") is already
// rendered by the row, so this contributes the separator, the first failing check as a LINK, and a
// +N for the rest (the full list is in the tooltip, and behind the head commit's own caret).
function FailingSummary({ checks }: { checks: BranchCheckRun[] }): JSX.Element | null {
  // noUncheckedIndexedAccess: destructuring yields `BranchCheckRun | undefined`, so this guard is
  // required rather than defensive.
  const [first, ...rest] = checks;
  if (first == null) return null;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-[11px]">
      <span aria-hidden="true" className="shrink-0 text-gray-300 dark:text-gray-600">
        ·
      </span>
      <FailingCheck check={first} />
      {rest.length > 0 && (
        <span className="shrink-0 text-gray-400" title={rest.map(checkLabel).join('\n')}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

function CommitRow({
  commit,
  fullName,
}: {
  commit: BranchCommit;
  fullName: string | undefined;
}): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const [open, setOpen] = useState(false);
  const href = commitUrl(fullName, commit.sha);
  const who = commit.authorLogin ?? commit.authorName ?? 'unknown';
  const avatar = safeExternalUrl(commit.authorAvatarUrl);
  // Narrowed LOCALS, not `commit.prId` inline: TS does not preserve property narrowing inside the
  // onClick closure, so narrowing consts is what keeps `prTabMeta(prId, prNumber, …)` typechecking
  // without a non-null assertion.
  const prId = commit.prId;
  const prNumber = commit.prNumber;
  const prHref = prNumber != null ? prUrl(fullName, prNumber) : undefined;
  // The caret is driven by the DATA, not by the dot's colour: a red commit whose individual checks
  // we could never retrieve (or a row written before the failing-checks column existed) gets no
  // caret rather than a caret that opens onto an empty drawer.
  const failing = commit.failingChecks;
  return (
    <li className="text-[11px]">
      <div className="flex items-center gap-2 py-0.5">
        {failing.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`${failing.length} failing check${
              failing.length === 1 ? '' : 's'
            } on ${commit.sha.slice(0, 7)}`}
            className="w-2 shrink-0 text-[9px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          // Keeps every row's columns aligned whether or not it has a caret.
          <span aria-hidden="true" className="w-2 shrink-0" />
        )}
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
        {/* The PR this commit landed from, read right after the sha the way a GitHub commit line
            does. A SIBLING of the caret button above, never nested inside it — nested interactive
            elements are invalid DOM and swallow the inner click. */}
        {prId != null && prNumber != null ? (
          <button
            type="button"
            onClick={() =>
              openPrDetailTab(prTabMeta(prId, prNumber, fullName ?? ''), {
                fromActivity: true,
              })
            }
            title={`Open #${prNumber} in this app`}
            className="shrink-0 rounded bg-sky-500/10 px-1 font-mono text-[10px] text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
          >
            #{prNumber}
          </button>
        ) : prNumber != null && prHref != null ? (
          // Not synced for this account (squash-merged before the backfill window, or a repo added
          // later) — there is no local PR to open, so link out rather than drop the reference.
          <a
            href={prHref}
            target="_blank"
            rel="noreferrer noopener"
            title={`#${prNumber} on GitHub — not synced here`}
            className="shrink-0 rounded bg-gray-500/10 px-1 font-mono text-[10px] text-gray-500 hover:text-sky-600 dark:text-gray-400 dark:hover:text-sky-400"
          >
            #{prNumber}
          </a>
        ) : null}
        {/* The headline is UNTRUSTED text from a commit message — rendered as a plain text node
            (never markdown/HTML) and truncated. */}
        <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
          {trimTrailingPrRef(commit.messageHeadline, prNumber)}
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
      </div>
      {open && (
        <ul className="mb-1 ml-4 space-y-0.5 border-l border-gray-200 pl-2 dark:border-gray-800">
          {failing.map((c, i) => (
            <li key={`${c.name}-${i}`}>
              <FailingCheck check={c} />
            </li>
          ))}
        </ul>
      )}
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
      {/* The row is a DIV, not one big button: the failing-check names are real <a> links to
          GitHub, and an <a> inside a <button> is invalid interactive nesting — the browser hoists
          the anchor out and the click target becomes unpredictable. The expand toggle is its own
          <button> covering the summary text; the links sit BESIDE it. The hover tint therefore
          lives on the wrapper (so hovering a link still tints the row, the correct affordance now
          that the row is not a single control), and `disabled` stays on the toggle ALONE — a red
          trunk with no synced commits still has clickable failing-check links. */}
      <div className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-800/40">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          disabled={!hasCommits}
          // flex-1 replaces the timestamp's old ml-auto: the toggle now absorbs the row's slack.
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
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
        </button>
        <FailingSummary checks={status.failingChecks} />
        <span className="shrink-0 text-[11px] tabular-nums text-gray-400">
          {status.lastCommitAt != null ? relativeTime(status.lastCommitAt) : 'never synced'}
        </span>
      </div>
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
