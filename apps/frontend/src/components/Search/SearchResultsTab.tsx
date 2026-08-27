import { useEffect, useMemo, useState } from 'react';
import type { InsightPrRef, SearchHit, SearchHitKind, User } from '@pierre-review/shared';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useSearchResults } from '../../hooks/useSearch.js';
import { usePr, useThread } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { indexUsers, PR_STATE_META } from '../../lib/ui.js';
import { MagnifierIcon } from '../Icons.js';
import { ThreadCard } from '../ThreadView/index.js';
import { PrMetaRow, InsightPrSummary } from '../Activity/AttentionCards.js';
import { KIND_ICON, KIND_LABEL, openHitPr, openSearchHit } from './searchNav.js';
import { highlightTerms } from './highlight.js';

// The full cross-repo search-results tab (a singleton drill-down overlay). Reads the query from the
// transient `searchSeed`, offers an editable box + kind filters + a People facet, lists every hit
// (paginated "Load more"), and opens a hit on click (thread hits deep-link to their thread). Scoped
// to the ACTIVE WORKSPACE (useSearchResults reads it from the store). Kept fully in the read layer
// — no writes.
const KIND_FILTERS: { key: SearchHitKind; label: string }[] = [
  { key: 'pr', label: 'PRs' },
  { key: 'review', label: 'Reviews' },
  { key: 'review_comment', label: 'Threads' },
  { key: 'pr_comment', label: 'Comments' },
];

export function SearchResultsTab(): JSX.Element {
  const seed = useFilters((s) => s.searchSeed);
  const openSearchDetail = useFilters((s) => s.openSearchDetail);
  const [q, setQ] = useState(seed ?? '');
  const [kinds, setKinds] = useState<SearchHitKind[]>([]);

  // If the seed changes from OUTSIDE (e.g. clicking a Person, or re-opening the tab for a new
  // query), adopt it into the box. Compare against the TRIMMED input, not `q` — our own debounced
  // sync effect writes the trimmed value back to the seed, so comparing to raw `q` would rewrite
  // the box and strip an in-progress trailing space ("foo " → "foo"). This only fires for a seed
  // that genuinely differs from what the user is typing.
  useEffect(() => {
    if (seed != null && seed !== q.trim()) setQ(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const debounced = useDebouncedValue(q.trim(), 300);
  // Keep the tab chip label in sync with what's actually being searched.
  useEffect(() => {
    if (debounced !== (useFilters.getState().searchSeed ?? '')) {
      useFilters.setState({ searchSeed: debounced });
    }
  }, [debounced]);

  const { hits, people, total, isLoading, isFetching, hasMore, fetchMore, isFetchingMore } =
    useSearchResults(debounced, kinds);

  // Resolve author/commenter metadata for the embedded thread cards once (useUsers is cached, so
  // the per-card children would otherwise each rebuild this Map).
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);

  const toggleKind = (k: SearchHitKind): void =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <div className="mx-auto max-w-[100rem] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Search</h2>
        <div className="relative">
          <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
            <MagnifierIcon size={14} />
          </div>
          <input
            type="search"
            value={q}
            autoFocus
            placeholder="Search PRs, reviews, threads, comments, people…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openSearchDetail(q.trim());
            }}
            className="w-96 rounded border border-gray-300 bg-transparent py-1 pl-8 pr-2 text-sm focus:border-blue-500 focus:outline-none dark:border-gray-700"
          />
        </div>
        <div className="flex items-center gap-1">
          {KIND_FILTERS.map((f) => {
            const on = kinds.includes(f.key);
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => toggleKind(f.key)}
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  on
                    ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                {f.label}
              </button>
            );
          })}
          {kinds.length > 0 && (
            <button
              type="button"
              onClick={() => setKinds([])}
              className="px-2 py-0.5 text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Clear
            </button>
          )}
        </div>
        <span className="ml-auto text-xs text-gray-400">
          {debounced.length < 1
            ? 'Type to search'
            : isLoading
              ? 'Searching…'
              : `${hits.length} of ${total} result${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {people.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            People
          </span>
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => openSearchDetail(p.login)}
              className="flex items-center gap-1.5 rounded-full border border-gray-200 px-2 py-0.5 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {p.avatarUrl != null ? (
                <img src={p.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
              ) : (
                <span className="h-4 w-4 rounded-full bg-gray-300 dark:bg-gray-700" />
              )}
              <span>{p.login}</span>
              <span className="text-gray-400">{p.matchCount}</span>
            </button>
          ))}
        </div>
      )}

      {debounced.length >= 1 && !isLoading && hits.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500 dark:border-gray-700">
          No matches for “{debounced}”{kinds.length > 0 ? ' with the selected filters' : ''}.
        </div>
      ) : (
        <ul className="space-y-3">
          {hits.map((h) => (
            <SearchResultCard
              key={`${h.kind}:${h.refId}`}
              hit={h}
              query={debounced}
              usersById={usersById}
            />
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={fetchMore}
            disabled={isFetchingMore}
            className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {isFetchingMore ? 'Loading…' : `Load more (${total - hits.length} more)`}
          </button>
        </div>
      )}
      {isFetching && !isLoading && (
        <div className="mt-2 text-center text-[11px] text-gray-400">Updating…</div>
      )}
    </div>
  );
}

// The kind/repo/PR header line shared by every result card. The "owner/name #N" reference is a
// link to the PR's own detail tab (opens on Overview). It carries data-noactivate + stopPropagation
// so, inside the whole-card-clickable PrHitCard, the ref-click opens the PR without double-firing.
function HitHeader({ hit }: { hit: SearchHit }): JSX.Element {
  const KindIcon = KIND_ICON[hit.kind];
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
      <KindIcon size={12} />
      <span className="font-medium text-gray-500 dark:text-gray-400">{KIND_LABEL[hit.kind]}</span>
      <span aria-hidden className="text-gray-300 dark:text-gray-600">
        ·
      </span>
      <span
        role="button"
        tabIndex={0}
        data-noactivate
        onClick={(e) => {
          e.stopPropagation();
          openHitPr(hit);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            openHitPr(hit);
          }
        }}
        title="Open this PR"
        className="truncate rounded font-medium text-sky-600 hover:underline dark:text-sky-400"
      >
        {hit.repoFullName} #{hit.prNumber}
      </span>
      {hit.authorLogin ? (
        <>
          <span aria-hidden className="text-gray-300 dark:text-gray-600">
            ·
          </span>
          <span className="truncate">{hit.authorLogin}</span>
        </>
      ) : null}
    </div>
  );
}

function SearchResultCard({
  hit,
  query,
  usersById,
}: {
  hit: SearchHit;
  query: string;
  usersById: Map<number, User>;
}): JSX.Element {
  if (hit.kind === 'review_comment' && hit.threadId != null) {
    return <ThreadHitCard hit={hit} query={query} usersById={usersById} />;
  }
  return <PrHitCard hit={hit} query={query} />;
}

// A review-comment hit: the FULL thread (code anchor + every reply + reply/resolve controls). The
// thread header title deep-links to the thread on the PR's Threads tab (resolved threads too, since
// openSearchHit → selectThread clears the state-pill filter). Lazily fetches the thread by id.
function ThreadHitCard({
  hit,
  query,
  usersById,
}: {
  hit: SearchHit;
  query: string;
  usersById: Map<number, User>;
}): JSX.Element {
  const { data: thread, isLoading } = useThread(hit.threadId);
  const prUrl = `https://github.com/${hit.repoFullName}/pull/${hit.prNumber}`;
  return (
    <li className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="mb-2">
        <HitHeader hit={hit} />
        <div className="mt-0.5 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
          {highlightTerms(hit.prTitle, query)}
        </div>
      </div>
      {isLoading || !thread ? (
        <div className="h-16 animate-pulse rounded bg-gray-100 dark:bg-gray-900" />
      ) : (
        <ThreadCard
          thread={thread}
          usersById={usersById}
          prUrl={prUrl}
          repoId={hit.repoId}
          onOpenInPr={() => openSearchHit(hit)}
        />
      )}
    </li>
  );
}

// A PR / review / PR-comment hit: a PR card with a state badge, header, CI/LOC meta, the highlighted
// snippet, and a collapsible PR summary. Clicking anywhere on the card (outside its own controls)
// opens the PR's detail tab.
function PrHitCard({ hit, query }: { hit: SearchHit; query: string }): JSX.Element {
  const { data: pr } = usePr(hit.prId);
  const stateMeta = PR_STATE_META[hit.prState];
  // PrMetaRow reads an InsightPrRef; adapt the loaded PR detail (which carries the CI/LOC fields
  // under slightly different names — changedFilesCount, and a non-null ciStatus). Rendered only
  // once the detail loads, so PrMetaRow is skipped while fetching rather than fed a mismatch.
  const metaRef: InsightPrRef | null = pr
    ? {
        prId: hit.prId,
        repoId: hit.repoId,
        repoFullName: hit.repoFullName,
        prNumber: hit.prNumber,
        prTitle: hit.prTitle,
        authorId: hit.authorId,
        githubUrl: pr.githubUrl,
        ciStatus: pr.ciStatus,
        changedFiles: pr.changedFilesCount,
        additions: pr.additions,
        deletions: pr.deletions,
        openedAt: pr.openedAt,
      }
    : null;
  const activate = (): void => openSearchHit(hit);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Don't navigate when the click landed on an inner control (the PR-summary toggle, a
          // markdown link, the AI-summary button…), mirroring the Activity cards' guard.
          if ((e.target as HTMLElement).closest('a,button,textarea,input,[data-noactivate]')) return;
          activate();
        }}
        onKeyDown={(e) => {
          // Only the card itself activates on Enter/Space — a key event bubbling up from an inner
          // control (the PR-summary toggle, a markdown link) must reach that control, not navigate.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        }}
        className="cursor-pointer rounded-lg border border-gray-200 p-3 hover:bg-gray-50/70 dark:border-gray-800 dark:hover:bg-gray-900/60"
      >
        <div className="flex items-center gap-2">
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
            style={{ backgroundColor: stateMeta.color }}
          >
            {stateMeta.label}
          </span>
          <div className="min-w-0 flex-1">
            <HitHeader hit={hit} />
          </div>
        </div>
        <div className="mt-0.5 text-sm font-medium text-gray-800 dark:text-gray-100">
          {highlightTerms(hit.prTitle, query)}
        </div>
        {metaRef && <PrMetaRow pr={metaRef} />}
        {hit.snippet && hit.kind !== 'pr' ? (
          <div className="mt-1 line-clamp-3 text-xs text-gray-500 dark:text-gray-400">
            {highlightTerms(hit.snippet, query)}
          </div>
        ) : null}
        <InsightPrSummary prId={hit.prId} />
      </div>
    </li>
  );
}
