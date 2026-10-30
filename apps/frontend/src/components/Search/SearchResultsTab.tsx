import { useEffect, useMemo, useState } from 'react';
import type { SearchHit, SearchHitKind, User } from '@pierre-review/shared';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useSearchResults } from '../../hooks/useSearch.js';
import { usePr, useThread } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { indexUsers, PR_STATE_META } from '../../lib/ui.js';
import { MagnifierIcon, TicketIcon } from '../Icons.js';
import { ThreadCard } from '../ThreadView/index.js';
import { PrMetaRow, PrDescriptionToggle, type PrMetaFields } from '../Activity/AttentionCards.js';
import { KIND_ICON, KIND_LABEL, openHitPr, openSearchHit, openSearchStory, storyPrWords } from './searchNav.js';
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

  const { hits, people, stories, total, isLoading, isFetching, hasMore, fetchMore, isFetchingMore } =
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
        <h2 className="text-body font-semibold text-ui-ink">Search</h2>
        <div className="relative">
          <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ui-faint">
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
            className="w-96 rounded-ui border border-ui-line bg-transparent py-1 pl-8 pr-2 text-body focus:border-ui-accent/50 focus:outline-none"
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
                className={`rounded-full border px-2 py-0.5 text-meta ${
                  on
                    ? 'border-ui-line bg-ui-sel text-ui-accent'
                    : 'border-ui-line text-ui-mute hover:bg-ui-hover'
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
              className="hit px-2 py-0.5 text-meta text-ui-faint hover:text-ui-ink"
            >
              Clear
            </button>
          )}
        </div>
        <span className="ml-auto text-meta text-ui-faint">
          {debounced.length < 1
            ? 'Type to search'
            : isLoading
              ? 'Searching…'
              : `${hits.length} of ${total} result${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* Ticket matches FIRST: each opens the ticket's story tab. */}
      {stories.length > 0 && (
        <section aria-label="Stories" className="mb-3">
          <h3 className="mb-1 text-meta font-semibold text-ui-mute">Stories</h3>
          <ul className="space-y-2">
            {stories.map((st) => (
              <li key={st.ident}>
                <button
                  type="button"
                  data-testid="search-story"
                  onClick={() => openSearchStory(st)}
                  className="hit flex w-full items-start gap-2 rounded-ui border border-ui-line bg-ui-sel px-3 py-2 text-left hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                >
                  <TicketIcon size={14} className="mt-0.5 shrink-0 text-ui-accent" />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-baseline gap-x-2 text-meta">
                      <span className="font-semibold text-ui-accent">{highlightTerms(st.key, debounced)}</span>
                      {st.title != null && <span className="font-medium text-ui-ink">{highlightTerms(st.title, debounced)}</span>}
                    </span>
                    <span className="mt-0.5 block text-meta text-ui-mute">
                      {[st.status, storyPrWords(st)].filter(Boolean).join(' · ')} · Open the story
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {people.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-meta font-semibold uppercase tracking-wide text-ui-faint">
            People
          </span>
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => openSearchDetail(p.login)}
              className="hit flex items-center gap-1.5 rounded-full border border-ui-line px-2 py-0.5 text-meta hover:bg-ui-hover"
            >
              {p.avatarUrl != null ? (
                <img src={p.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
              ) : (
                <span className="h-4 w-4 rounded-full bg-ui-faint" />
              )}
              <span>{p.login}</span>
              <span className="text-ui-faint">{p.matchCount}</span>
            </button>
          ))}
        </div>
      )}

      {debounced.length >= 1 && !isLoading && hits.length === 0 && stories.length === 0 ? (
        <div className="rounded-ui border border-dashed border-ui-line py-10 text-center text-body text-ui-mute">
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
            className="hit rounded-ui border border-ui-line px-3 py-1 text-meta text-ui-ink hover:bg-ui-hover disabled:opacity-50"
          >
            {isFetchingMore ? 'Loading…' : `Load more (${total - hits.length} more)`}
          </button>
        </div>
      )}
      {isFetching && !isLoading && (
        <div className="mt-2 text-center text-meta text-ui-faint">Updating…</div>
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
    <div className="flex items-center gap-1.5 text-meta text-ui-faint">
      <KindIcon size={12} />
      <span className="font-medium text-ui-mute">{KIND_LABEL[hit.kind]}</span>
      <span aria-hidden className="decorative-mark text-ui-faint">
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
        className="truncate rounded-ui font-medium text-ui-accent hover:underline"
      >
        {hit.repoFullName} #{hit.prNumber}
      </span>
      {hit.authorLogin ? (
        <>
          <span aria-hidden className="decorative-mark text-ui-faint">
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
// thread header title deep-links to the thread on the PR's Changes tab (resolved threads too, since
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
    <li className="rounded-ui border border-ui-line p-3">
      <div className="mb-2">
        <HitHeader hit={hit} />
        <div className="mt-0.5 truncate text-body font-medium text-ui-ink">
          {highlightTerms(hit.prTitle, query)}
        </div>
      </div>
      {isLoading || !thread ? (
        <div className="h-16 animate-pulse rounded-ui bg-ui-raise" />
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
  // PrMetaRow reads `PrMetaFields`; adapt the loaded PR detail (which carries the CI/LOC fields
  // under slightly different names — changedFilesCount, and a non-null ciStatus). Rendered only
  // once the detail loads, so PrMetaRow is skipped while fetching rather than fed a mismatch.
  //
  // ⚠ IT IS `PrMetaFields`, NOT `InsightPrRef`, PRECISELY SO THE SOURCE PAIR CAN BE OMITTED. A
  // search hit is not workspace-scoped, so nothing on this path holds the workspace bot
  // judgement `authorIsBot`/`authorBotKind` are resolved from, and re-deriving them off the
  // author's login here would be a second, differently-behaving classifier — the exact drift the
  // "stored role/kind beats the login seed" rule exists to prevent. Absent ⇒ NO chip, which
  // claims nothing; a hard-coded `authorIsBot: false` would claim "a person".
  const metaRef: PrMetaFields | null = pr
    ? {
        ciStatus: pr.ciStatus,
        changedFiles: pr.changedFilesCount,
        additions: pr.additions,
        deletions: pr.deletions,
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
        className="cursor-pointer rounded-ui border border-ui-line p-3 hover:bg-ui-hover"
      >
        <div className="flex items-center gap-2">
          <span
            className="shrink-0 rounded-ui px-1.5 py-0.5 text-meta font-semibold text-white"
            style={{ backgroundColor: stateMeta.color }}
          >
            {stateMeta.label}
          </span>
          <div className="min-w-0 flex-1">
            <HitHeader hit={hit} />
          </div>
        </div>
        <div className="mt-0.5 text-body font-medium text-ui-ink">
          {highlightTerms(hit.prTitle, query)}
        </div>
        {metaRef && <PrMetaRow pr={metaRef} />}
        {hit.snippet && hit.kind !== 'pr' ? (
          <div className="mt-1 line-clamp-3 text-meta text-ui-mute">
            {highlightTerms(hit.snippet, query)}
          </div>
        ) : null}
        <PrDescriptionToggle prId={hit.prId} />
      </div>
    </li>
  );
}
