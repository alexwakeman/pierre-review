import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { ClaudeReviewPrState, TimelinePr, User } from '@pierre-review/shared';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useMaintainersByRepo } from '../../hooks/useMaintainers.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useClaudeReviewStates } from '../../hooks/useClaudeReview.js';
import { useFilters } from '../../store/filters.js';
import { findingsRank, reviewCellFor, reviewCellRank } from '../../lib/claudeReviewColumn.js';
import {
  CI_META,
  indexUsers,
  relativeTime,
  sortOpenPrsByActivity,
  userLabel,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { CheckCircleIcon } from '../Icons.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { ClaudeReviewStrip } from './ClaudeReviewCell.js';
import { BlastRadiusChip } from './BlastRadiusChip.js';
import { LargePrFlag } from './LargePrFlag.js';
import { SortHeader, type SortState, compare, nextSort } from './sortableTable.js';

// THE open-PR table — the ONE component every open-PR list surface renders (the OpenPrsDetail
// drill-down, whether opened per-repo from a "Show all" footer or workspace-wide from the Flow
// metrics "Open PRs" tile). Sortable columns — age, staleness, LoC, thread backlog, CI,
// approval — over TimelinePr rows from /api/open-prs; drafts are included (marked with a badge).
// Owns its sort state; default order = sortOpenPrsByActivity (the same order the inline lists
// use). Rows are WHOLE-ROW clickable — the caller decides what a click opens (onOpenPr).
//
// THE LAYOUT IS A LIST OF NARROW TWO-ROW CARDS ON ONE SHARED CSS GRID. Row 1 is the PR's facts;
// row 2 is the Claude Review strip. Every card (and the header) reads the SAME column templates —
// `--opr-cols*` for row 1 and `--opr-strip*` for the strip, set ONCE on the list container — so a
// cell lines up exactly from card to card. Below `xl` the Updated column drops (still sortable on
// wide screens) and the fixed tracks narrow; at `2xl` the repo and author tracks widen.
//
// The Claude Review strip renders ONLY where agentic AI runs (`me.ai.enabled`: local, free); without
// it there is no strip and no request. With it, ONE batched states request covers every listed
// card (never one per card), and each strip control stops propagation so a click never opens the PR.

type SortCol =
  | 'pr'
  | 'repo'
  | 'author'
  | 'age'
  | 'updated'
  | 'loc'
  | 'threads'
  | 'ci'
  | 'approval'
  | 'claude'
  | 'findings';

// Each column's "natural" first-click direction (a second click flips it): text columns read
// A→Z, time/size/backlog columns lead with the most pressing end (longest-open, most-recently
// -updated, biggest, most-untouched, failing-first, changes-first).
const DEFAULT_DIR: Record<SortCol, 'asc' | 'desc'> = {
  pr: 'desc',
  repo: 'asc',
  author: 'asc',
  age: 'asc',
  updated: 'desc',
  loc: 'desc',
  threads: 'desc',
  ci: 'asc',
  approval: 'asc',
  claude: 'asc', // needs a review first (reviewCellRank)
  findings: 'desc', // most severe first (findingsRank)
};

// CI rollup → a sortable rank (failing first under 'asc').
const CI_RANK: Record<TimelinePr['ciStatus'], number> = {
  failure: 0,
  error: 0,
  pending: 1,
  success: 2,
  expected: 3,
  unknown: 4,
};

// Approval standing → a sortable rank (changes-requested first under 'asc').
function approvalRank(pr: TimelinePr): number {
  if (pr.isChangesRequested) return 0;
  if (pr.isApproved) return 2;
  return 1;
}

// The per-column sort value. Strings compare via localeCompare below; ISO-8601 timestamps
// sort chronologically as strings (same trick as sortOpenPrsByActivity).
function sortValue(
  pr: TimelinePr,
  col: SortCol,
  usersById: Map<number, User>,
  repoNameById: Map<number, string>,
  claudeStates: Map<number, ClaudeReviewPrState>,
): number | string {
  switch (col) {
    case 'pr':
      return pr.number;
    case 'repo':
      return repoNameById.get(pr.repoId) ?? '';
    case 'author': {
      const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
      // Sort by what the CELL SHOWS — userLabel's display-name-then-login answer. Sorting on
      // the raw login while rendering the display name made the column look broken: "Alex
      // Wakeman" sorts under 'a' by login, so an A→Z click left the visible names unordered.
      return userLabel(u, pr.authorId).toLowerCase();
    }
    case 'age':
      return pr.openedAt;
    case 'updated':
      return pr.updatedAt;
    case 'loc':
      return pr.additions + pr.deletions;
    case 'threads':
      return pr.threadCounts.untouched;
    case 'ci':
      return CI_RANK[pr.ciStatus];
    case 'approval':
      return approvalRank(pr);
    case 'claude':
      // Sorts on the stored state, not a click in flight (a sort must not jump under the cursor).
      return reviewCellRank(reviewCellFor(claudeStates.get(pr.id), false));
    case 'findings':
      return findingsRank(claudeStates.get(pr.id));
  }
}

function CiCell({ ci }: { ci: TimelinePr['ciStatus'] }): JSX.Element {
  const meta = CI_META[ci];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-gray-500 dark:text-gray-400">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={meta ? { background: meta.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
        aria-hidden
      />
      {meta?.label ?? 'no checks'}
    </span>
  );
}

// Diff size, then the blast-radius and large-PR marks as icons (their sentences are the
// accessible names). Each renders nothing when it has nothing honest to say.
function LocCell({ pr }: { pr: TimelinePr }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]">
      <span>
        <span className="text-gray-500 dark:text-gray-400">{pr.changedFiles}f</span>{' '}
        <span className="font-mono text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
        <span className="font-mono text-red-500 dark:text-red-400">−{pr.deletions}</span>
      </span>
      <BlastRadiusChip pr={pr} iconOnly />
      <LargePrFlag pr={pr} iconOnly />
    </span>
  );
}

// Untouched-thread count + the compact 4-state mini-bar (the shared thread vocabulary).
function ThreadsCell({ pr }: { pr: TimelinePr }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] tabular-nums">
      <span
        className={
          pr.threadCounts.untouched > 0
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-gray-500 dark:text-gray-400'
        }
        title={`${pr.threadCounts.untouched} untouched thread${pr.threadCounts.untouched === 1 ? '' : 's'}`}
      >
        {pr.threadCounts.untouched}
      </span>
      <ThreadStateBar counts={pr.threadCounts} compact />
    </span>
  );
}

function ApprovalCell({ pr }: { pr: TimelinePr }): JSX.Element {
  const standing = pr.isApproved
    ? { label: 'approved', cls: 'bg-green-500/10 text-green-700 dark:text-green-400' }
    : pr.isChangesRequested
      ? { label: 'changes', cls: 'bg-red-500/10 text-red-700 dark:text-red-400' }
      : null;
  if (standing == null) return <span className="text-[11px] text-gray-500 dark:text-gray-400">—</span>;
  return <span className={`rounded px-1 text-[11px] font-semibold ${standing.cls}`}>{standing.label}</span>;
}

// ---- the shared grid ----
// One entry per row-1 column. `base` is the track below `xl` (null = the column is hidden there),
// `xl` from 1280px, `wide` from 1536px. The title takes what is left, so it is the only flexible
// track; everything else is fixed, which is what makes the cards line up.
interface GridCol {
  col: SortCol;
  label: string;
  title?: string;
  base: string | null;
  xl: string;
  wide: string;
}

const PR_COL: GridCol = { col: 'pr', label: 'Pull request', base: 'minmax(11rem,1fr)', xl: 'minmax(14rem,1fr)', wide: 'minmax(16rem,1fr)' };
const REPO_COL: GridCol = { col: 'repo', label: 'Repo', base: '6.5rem', xl: '9.5rem', wide: '13rem' };
const FACT_COLS: GridCol[] = [
  { col: 'author', label: 'Author', base: '6.5rem', xl: '8.5rem', wide: '10rem' },
  { col: 'age', label: 'Age', title: 'Time since the PR opened', base: '4rem', xl: '4.5rem', wide: '4.5rem' },
  { col: 'updated', label: 'Updated', base: null, xl: '4.5rem', wide: '5rem' },
  { col: 'loc', label: 'Size', title: 'Files, added and deleted lines; blast radius and large-PR marks', base: '8rem', xl: '10rem', wide: '10.5rem' },
  { col: 'threads', label: 'Threads', title: 'Untouched review threads + the state mix', base: '5rem', xl: '6rem', wide: '6.5rem' },
  { col: 'ci', label: 'CI', base: '5rem', xl: '6rem', wide: '6.5rem' },
  { col: 'approval', label: 'Approval', base: '5rem', xl: '6rem', wide: '6.5rem' },
];

// The Claude Review strip's five cells: outcome · findings · posted + design · context · action.
const STRIP_BASE = '12.5rem 14.5rem 8.5rem minmax(0,1fr) 5.5rem';
const STRIP_XL = '15rem 17rem 10rem minmax(0,1fr) 6rem';

function gridVars(cols: GridCol[]): CSSProperties {
  const tracks = (pick: (c: GridCol) => string | null): string =>
    cols.map(pick).filter((t): t is string => t != null).join(' ');
  return {
    '--opr-cols': tracks((c) => c.base),
    '--opr-cols-xl': tracks((c) => c.xl),
    '--opr-cols-2xl': tracks((c) => c.wide),
    '--opr-strip': STRIP_BASE,
    '--opr-strip-xl': STRIP_XL,
  } as CSSProperties;
}

const ROW_GRID =
  'grid items-center gap-x-2.5 [grid-template-columns:var(--opr-cols)] xl:[grid-template-columns:var(--opr-cols-xl)] 2xl:[grid-template-columns:var(--opr-cols-2xl)]';
// The cell wrapper for a column that drops below `xl`.
const hideBelowXl = (c: GridCol): string => (c.base == null ? 'hidden xl:block' : '');

export function OpenPrsTable({
  prs,
  isLoading,
  isError,
  showRepoColumn,
  onOpenPr,
  emptyLabel = (
    <>
      <CheckCircleIcon className="mr-1.5 inline-block align-[-0.15em] decorative-mark text-gray-300 dark:text-gray-600" />
      No open PRs here.
    </>
  ),
}: {
  prs: TimelinePr[];
  isLoading: boolean;
  isError: boolean;
  showRepoColumn: boolean;
  onOpenPr: (pr: TimelinePr) => void;
  // The zero-row copy — overridden when a client-side narrowing (not the data) emptied the list.
  // ReactNode, not string: the DEFAULT is the all-clear state and leads with a muted tick, while
  // an override ("adjust the repo filter") is plain prose that must NOT wear one.
  emptyLabel?: ReactNode;
}): JSX.Element {
  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const maintainersByRepo = useMaintainersByRepo();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(
    () => new Map((repos ?? []).map((r) => [r.id, r.fullName])),
    [repos],
  );

  // The Claude review column: capability-gated, ONE request for every listed PR.
  const claudeOn = useAiCapabilities().enabled;
  const prIds = useMemo(() => prs.map((p) => p.id), [prs]);
  const { data: claudeData } = useClaudeReviewStates(prIds, claudeOn);
  const claudeStates = useMemo(
    () => new Map((claudeData?.states ?? []).map((st) => [st.prId, st])),
    [claudeData],
  );
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const openReview = (pr: TimelinePr): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    openClaudeReview(
      {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        repoFullName: repoNameById.get(pr.repoId) ?? '',
        authorLogin: u?.githubLogin ?? null,
        authorDisplayName: u?.displayName ?? null,
        authorAvatarUrl: u?.avatarUrl ?? null,
      },
      { fromActivity: true },
    );
  };

  // null = the default activity order (sortOpenPrsByActivity — same as the inline lists).
  const [sort, setSort] = useState<SortState<SortCol> | null>(null);
  const onSort = (col: SortCol): void => setSort((cur) => nextSort(cur, col, DEFAULT_DIR));

  const rows = useMemo(() => {
    if (sort == null) {
      return sortOpenPrsByActivity(prs, (pr) => {
        const set = maintainersByRepo.get(pr.repoId);
        return pr.authorId != null && set != null && set.has(pr.authorId);
      });
    }
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...prs].sort(
      (a, b) =>
        mul *
          compare(
            sortValue(a, sort.col, usersById, repoNameById, claudeStates),
            sortValue(b, sort.col, usersById, repoNameById, claudeStates),
          ) || b.number - a.number, // stable final tiebreak
    );
  }, [prs, sort, maintainersByRepo, usersById, repoNameById, claudeStates]);

  const cols = useMemo(
    () => (showRepoColumn ? [PR_COL, REPO_COL, ...FACT_COLS] : [PR_COL, ...FACT_COLS]),
    [showRepoColumn],
  );
  const vars = useMemo(() => gridVars(cols), [cols]);

  if (isLoading) {
    return (
      <div className="space-y-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-md bg-gray-100 dark:bg-gray-900/40" />
        ))}
      </div>
    );
  }
  if (isError) {
    return <div className="text-sm text-red-500">Couldn’t load the open PRs.</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {emptyLabel}
      </div>
    );
  }

  const onCardKey = (e: KeyboardEvent<HTMLDivElement>, pr: TimelinePr): void => {
    // Only the card itself: a key on a strip button belongs to that button.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenPr(pr);
    }
  };

  const header = 'text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';
  return (
    <div className="overflow-x-auto">
      <div role="table" aria-label="Open pull requests" className="min-w-[58rem] space-y-1" style={vars}>
        {/* The header: row 1's columns, then the strip's two sortable cells on the same tracks. */}
        <div role="row" className={`px-3 pb-0.5 ${header}`}>
          <div className={ROW_GRID}>
            {cols.map((c) => (
              <SortHeader
                key={c.col}
                as="div"
                className={`min-w-0 ${hideBelowXl(c)}`}
                col={c.col}
                label={c.label}
                title={c.title}
                sort={sort}
                onSort={onSort}
              />
            ))}
          </div>
          {claudeOn && (
            <div className="grid gap-x-2.5 [grid-template-columns:var(--opr-strip)] xl:[grid-template-columns:var(--opr-strip-xl)]">
              <SortHeader as="div" col="claude" label="Claude review" sort={sort} onSort={onSort} className="min-w-0" />
              <SortHeader
                as="div"
                col="findings"
                label="Findings"
                title="Claude's findings by severity, most severe first"
                sort={sort}
                onSort={onSort}
                className="min-w-0"
              />
            </div>
          )}
        </div>

        {rows.map((pr) => {
          const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
          return (
            <div
              key={pr.id}
              role="row"
              tabIndex={0}
              onClick={() => onOpenPr(pr)}
              onKeyDown={(e) => onCardKey(e, pr)}
              title={`Open #${pr.number} in its own tab`}
              className="cursor-pointer space-y-0.5 rounded-md border border-gray-200 px-3 py-1 hover:border-gray-300 hover:bg-gray-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:hover:border-gray-700 dark:hover:bg-gray-900/40"
            >
              <div className={ROW_GRID}>
                <div role="cell" className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 font-mono text-[11px] text-gray-500 dark:text-gray-400">#{pr.number}</span>
                  <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                    {pr.title}
                  </span>
                  {pr.isDraft && (
                    <span className="shrink-0 rounded bg-gray-500/15 px-1 text-[11px] font-medium text-gray-600 dark:text-gray-300">
                      draft
                    </span>
                  )}
                </div>
                {showRepoColumn && (
                  <div role="cell" className="min-w-0 truncate text-[11px] text-gray-500 dark:text-gray-400">
                    {repoNameById.get(pr.repoId) ?? `repo ${pr.repoId}`}
                  </div>
                )}
                <div role="cell" className="flex min-w-0 items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
                  <Avatar user={author} size={14} />
                  <span className="truncate">{userLabel(author, pr.authorId)}</span>
                </div>
                <div role="cell" className="whitespace-nowrap text-[11px] text-gray-500 dark:text-gray-400">
                  {relativeTime(pr.openedAt)}
                </div>
                <div role="cell" className="hidden whitespace-nowrap text-[11px] text-gray-500 dark:text-gray-400 xl:block">
                  {relativeTime(pr.updatedAt)}
                </div>
                <div role="cell" className="min-w-0">
                  <LocCell pr={pr} />
                </div>
                <div role="cell" className="min-w-0">
                  <ThreadsCell pr={pr} />
                </div>
                <div role="cell" className="min-w-0">
                  <CiCell ci={pr.ciStatus} />
                </div>
                <div role="cell" className="min-w-0">
                  <ApprovalCell pr={pr} />
                </div>
              </div>
              {claudeOn && (
                <div className="border-t border-dashed border-gray-200 pt-0.5 dark:border-gray-800">
                  <ClaudeReviewStrip
                    prId={pr.id}
                    state={claudeStates.get(pr.id)}
                    onOpenReview={() => openReview(pr)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
