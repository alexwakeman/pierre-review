import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { TimelinePr, User } from '@pierre-review/shared';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useMaintainersByRepo } from '../../hooks/useMaintainers.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useClaudeReviewStates } from '../../hooks/useClaudeReview.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useFilters } from '../../store/filters.js';
import type { TabMeta } from '../../store/pinnedTabs.js';
import {
  CI_META,
  MERGE_TONE_CHIP,
  dateTime,
  indexUsers,
  mergeVerdict,
  mergeVerdictWarning,
  relativeTime,
  sortOpenPrsByActivity,
  userLabel,
} from '../../lib/ui.js';
import {
  effectiveSort,
  pickSort,
  reverseSort,
  sortLabel,
  sortOpenPrs,
  sortOptionsFor,
  type OpenPrsSort,
} from '../../lib/openPrsSort.js';
import { Avatar } from '../CommentCard.js';
import { ArrowIcon, CaretIcon, CheckCircleIcon, CheckIcon } from '../Icons.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { ClaudeReviewPanel } from './ClaudeReviewCell.js';
import { BlastRadiusChip } from './BlastRadiusChip.js';
import { LargePrFlag } from './LargePrFlag.js';

// THE OPEN PRs CARDS — the Open PRs tab's list (OpenPrsDetail), one card per open PR over
// TimelinePr rows from /api/open-prs; drafts are included and marked. No column headings: the
// order is picked from the header's Sort menu (`OpenPrsSortMenu`, state owned by the caller;
// null = sortOpenPrsByActivity, the order the inline lists use).
//
// ONE CARD, FOUR LAYERS, MOST IMPORTANT FIRST:
//   1. the title (the card's largest, heaviest text) + draft marker.
//   2. the status chips, LEFT-aligned under the title (right-aligned they read as a separate
//      column, which the user found harder to scan) — CI, review standing, threads, merge
//      readiness. Each renders only when it has something true to say (no "no checks", no "—").
//   3. the meta line: #number · repo · author · opened · updated · size, blast radius, large-PR.
//   4. the Claude Review panel (ClaudeReviewCell.tsx) on the AI surface, accented by outcome —
//      ONLY where agentic AI runs (`me.ai.enabled`: local, free). With it, ONE batched states
//      request covers every listed card (never one per card); without it, no panel and no request.
//
// The card is WHOLE-CARD clickable and keyboard-focusable (Enter / Space opens the PR); every
// control inside it stops propagation, so a click there never opens the PR.

const CHIP =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-[11px] font-medium';
const NEUTRAL_CHIP = `${CHIP} border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300`;
const TONE_CHIP = `${CHIP} border-transparent`;

function Sep(): JSX.Element {
  return (
    <span aria-hidden className="decorative-mark text-gray-300 dark:text-gray-600">
      ·
    </span>
  );
}

// ---- the status chips (line 1, right) ----

function CiChip({ ci }: { ci: TimelinePr['ciStatus'] }): JSX.Element | null {
  const meta = CI_META[ci];
  if (meta == null) return null; // no checks reading — nothing to claim
  const red = ci === 'failure' || ci === 'error';
  return (
    <span className={red ? `${TONE_CHIP} bg-red-500/10 text-red-700 dark:text-red-400` : NEUTRAL_CHIP}>
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

function ReviewChip({ pr }: { pr: TimelinePr }): JSX.Element | null {
  if (pr.isChangesRequested) {
    return <span className={`${TONE_CHIP} bg-red-500/10 text-red-700 dark:text-red-400`}>Changes requested</span>;
  }
  if (pr.isApproved) {
    return (
      <span className={`${TONE_CHIP} bg-green-500/10 text-green-700 dark:text-green-400`}>
        <CheckIcon size={11} />
        Approved
      </span>
    );
  }
  return null;
}

/** The thread mix: untouched leads (amber), else what is still open, else all resolved. */
export function threadChipLabel(c: TimelinePr['threadCounts']): { text: string; warn: boolean } | null {
  const total = c.untouched + c.replied_unresolved + c.likely_addressed + c.resolved;
  if (total === 0) return null;
  if (c.untouched > 0) return { text: `${c.untouched} untouched`, warn: true };
  const open = total - c.resolved;
  if (open > 0) return { text: `${open} open thread${open === 1 ? '' : 's'}`, warn: false };
  return { text: `${total} resolved`, warn: false };
}

function ThreadsChip({ pr }: { pr: TimelinePr }): JSX.Element | null {
  const label = threadChipLabel(pr.threadCounts);
  if (label == null) return null;
  return (
    <span
      className={label.warn ? `${TONE_CHIP} bg-amber-500/10 text-amber-700 dark:text-amber-400` : NEUTRAL_CHIP}
      title="Review threads: untouched · replied · likely addressed · resolved"
    >
      <ThreadStateBar counts={pr.threadCounts} compact className="!w-8" />
      {label.text}
    </span>
  );
}

function MergeChip({ pr }: { pr: TimelinePr }): JSX.Element | null {
  const input = { mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft };
  // A draft says "draft" on the title line; only a branch fact (conflicts, behind) survives it.
  const v = pr.isDraft ? mergeVerdictWarning(input) : mergeVerdict(input);
  if (v == null || v.verdict === 'unknown' || v.verdict === 'draft') return null;
  return (
    <span className={`${TONE_CHIP} ${MERGE_TONE_CHIP[v.tone]}`} title={v.detail ?? undefined}>
      {v.label}
    </span>
  );
}

// ---- the sort menu (the tab's header) ----

export function OpenPrsSortMenu({
  sort,
  onChange,
}: {
  sort: OpenPrsSort | null;
  onChange: (sort: OpenPrsSort | null) => void;
}): JSX.Element {
  const claudeOn = useAiCapabilities().enabled;
  const shown = effectiveSort(sort, claudeOn);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useClickOutside(rootRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  // Focus the chosen row when the menu opens, so arrows / Tab start from it.
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };

  const item = (key: string, label: string, checked: boolean, pick: () => void): JSX.Element => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={() => {
        pick();
        setOpen(false);
      }}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-gray-800 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:text-gray-100 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
    >
      <span className="inline-flex w-3 shrink-0 justify-center">{checked && <CheckIcon size={11} />}</span>
      {label}
    </button>
  );

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-gray-300 py-0.5 pl-2.5 pr-2 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
      >
        <span className="text-gray-500 dark:text-gray-400">Sort:</span>
        <span className="font-medium text-gray-800 dark:text-gray-100">{sortLabel(shown)}</span>
        <CaretIcon dir="down" />
      </button>
      {shown != null && (
        <button
          type="button"
          onClick={() => onChange(reverseSort(shown))}
          aria-label="Reverse the order"
          title="Reverse the order"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
        >
          <ArrowIcon dir={shown.dir === 'asc' ? 'up' : 'down'} size={11} />
        </button>
      )}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Sort open PRs"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-[60] mt-1 w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {item('default', 'Recent activity', shown == null, () => onChange(null))}
          <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
          {sortOptionsFor(claudeOn).map((o) =>
            item(o.key, o.name, shown?.key === o.key, () => onChange(pickSort(o.key))),
          )}
        </div>
      )}
    </div>
  );
}

// ---- the list ----

export function OpenPrsCards({
  prs,
  isLoading,
  isError,
  sort,
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
  /** The header's Sort menu choice; null = the default activity order. */
  sort: OpenPrsSort | null;
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
  const repoNameById = useMemo(() => new Map((repos ?? []).map((r) => [r.id, r.fullName])), [repos]);

  // The Claude Review panel: capability-gated, ONE request for every listed PR.
  const claudeOn = useAiCapabilities().enabled;
  const prIds = useMemo(() => prs.map((p) => p.id), [prs]);
  const { data: claudeData } = useClaudeReviewStates(prIds, claudeOn);
  const claudeStates = useMemo(
    () => new Map((claudeData?.states ?? []).map((st) => [st.prId, st])),
    [claudeData],
  );
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const openAiFix = useFilters((s) => s.openAiFix);
  const metaOf = (pr: TimelinePr): TabMeta => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repoFullName: repoNameById.get(pr.repoId) ?? '',
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
    };
  };

  const shownSort = effectiveSort(sort, claudeOn);
  const rows = useMemo(() => {
    if (shownSort == null) {
      return sortOpenPrsByActivity(prs, (pr) => {
        const set = maintainersByRepo.get(pr.repoId);
        return pr.authorId != null && set != null && set.has(pr.authorId);
      });
    }
    return sortOpenPrs(prs, shownSort, { usersById, repoNameById, claudeStates });
  }, [prs, shownSort, maintainersByRepo, usersById, repoNameById, claudeStates]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-900/40" />
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

  return (
    <ul aria-label="Open pull requests" className="space-y-2">
      {rows.map((pr) => (
        <OpenPrCard
          key={pr.id}
          pr={pr}
          author={pr.authorId != null ? usersById.get(pr.authorId) : undefined}
          repoName={repoNameById.get(pr.repoId) ?? `repo ${pr.repoId}`}
          onOpen={() => onOpenPr(pr)}
          claude={
            claudeOn ? (
              <ClaudeReviewPanel
                prId={pr.id}
                state={claudeStates.get(pr.id)}
                onOpenReview={() => openClaudeReview(metaOf(pr), { fromActivity: true })}
                onOpenFix={() => openAiFix(metaOf(pr))}
              />
            ) : null
          }
        />
      ))}
    </ul>
  );
}

function OpenPrCard({
  pr,
  author,
  repoName,
  onOpen,
  claude,
}: {
  pr: TimelinePr;
  author: User | undefined;
  repoName: string;
  onOpen: () => void;
  claude: ReactNode;
}): JSX.Element {
  const titleId = useId();
  const onKey = (e: KeyboardEvent<HTMLLIElement>): void => {
    // Only the card itself: a key on a control inside belongs to that control.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  const onClick = (e: MouseEvent<HTMLLIElement>): void => {
    if ((e.target as HTMLElement).closest('a,button,[data-noactivate]')) return;
    onOpen();
  };
  return (
    <li
      tabIndex={0}
      aria-labelledby={titleId}
      onClick={onClick}
      onKeyDown={onKey}
      className="cursor-pointer rounded-lg border border-gray-200 bg-white px-3.5 py-2 transition-colors hover:border-gray-300 hover:bg-gray-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:bg-gray-900/40 dark:hover:border-gray-700 dark:hover:bg-gray-900/70"
    >
      {/* 1 — the title. */}
      <h3 id={titleId} className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-gray-50" title={pr.title}>
          {pr.title}
        </span>
        {pr.isDraft && (
          <span className="shrink-0 rounded border border-gray-300 px-1.5 text-[11px] font-medium text-gray-600 dark:border-gray-600 dark:text-gray-300">
            Draft
          </span>
        )}
      </h3>

      {/* 2 — the PR's status chips, left-aligned under the title so they read with it. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">
        <CiChip ci={pr.ciStatus} />
        <ReviewChip pr={pr} />
        <ThreadsChip pr={pr} />
        <MergeChip pr={pr} />
      </div>

      {/* 3 — the meta line. */}
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="font-mono">#{pr.number}</span>
        <Sep />
        <span className="max-w-[18rem] truncate" title={repoName}>
          {repoName}
        </span>
        <Sep />
        <span className="inline-flex min-w-0 items-center gap-1 text-gray-600 dark:text-gray-300">
          <Avatar user={author} size={14} />
          <span className="truncate">{userLabel(author, pr.authorId)}</span>
        </span>
        <Sep />
        <span title={`Opened ${dateTime(pr.openedAt)}`}>opened {relativeTime(pr.openedAt)}</span>
        {pr.updatedAt !== pr.openedAt && (
          <>
            <Sep />
            <span title={`Updated ${dateTime(pr.updatedAt)}`}>updated {relativeTime(pr.updatedAt)}</span>
          </>
        )}
        <Sep />
        <span>
          {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
        </span>
        <span className="font-mono">
          <span className="text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
          <span className="text-red-500 dark:text-red-400">−{pr.deletions}</span>
        </span>
        <LargePrFlag pr={pr} />
        <BlastRadiusChip pr={pr} />
      </div>

      {/* 4 — Claude Review (only where agentic AI runs). */}
      {claude}
    </li>
  );
}
