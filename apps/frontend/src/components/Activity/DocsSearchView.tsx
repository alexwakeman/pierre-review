import { useEffect, useRef, useState } from 'react';
import type { DocsSearchResult, DocsSearchSort } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useDocsSearch } from '../../hooks/useReferenceDocs.js';
import { useMe } from '../../hooks/useTriage.js';
import { docSourceLabel, resultCountWords } from '../../lib/docsSearch.js';
import { formatDate, safeExternalUrl } from '../../lib/ui.js';
import { openDocsSearchResult } from '../../store/openDocs.js';
import { useFilters } from '../../store/filters.js';
import { InfoButton } from '../InfoModal.js';
import { ArrowIcon, MagnifierIcon } from '../Icons.js';
import { Button, cx, FOCUS_RING } from '../ui/index.js';

// LIBRARY → SEARCH (`?activityRepo=docs-search&docsQ=…`; docs/REFERENCE-DOCS.md § Search). The
// workspace library's full-text search: one result per section, its best passage quoted with the
// matched words marked, "Open" lands on that passage in Docs with the words highlighted. DB only — but
// shown only where the library is (`me.ai.enabled`), like Docs. The text, sort and page live in the
// filter store and the URL (`docsSearch`), so a search can be linked and Back returns to it.
//
// ⚠ THE SNIPPET IS PLAIN TEXT RUNS from the server, flagged matched or not — rendered as text and
// <mark>, never as HTML.

const MUTED = 'text-ui-mute';
const SORTS: ReadonlyArray<{ id: DocsSearchSort; label: string }> = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'newest', label: 'Newest first' },
];

// Docs' CENTRE PANE while the Library panel's "Search" row is selected (`?activityRepo=docs-search`):
// DocsView renders it in place of the document viewer, so results sit where a document's contents do.
export function DocsSearchPane({ workspaceId }: { workspaceId: number }): JSX.Element {
  const search = useFilters((s) => s.docsSearch);
  const setDocsSearch = useFilters((s) => s.setDocsSearch);
  const [text, setText] = useState(search.q);
  const input = useRef<HTMLInputElement | null>(null);

  // A new text from OUTSIDE (Back, a link) replaces the box; our own trimmed write never does.
  useEffect(() => {
    if (search.q !== text.trim()) setText(search.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.q]);
  const debounced = useDebouncedValue(text.trim(), 300);
  useEffect(() => {
    setDocsSearch({ q: debounced });
  }, [debounced, setDocsSearch]);

  const query = useDocsSearch(workspaceId, search.q, search.sort, search.page);
  const data = query.data;
  const pageCount = data != null ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const goPage = (page: number): void => {
    setDocsSearch({ page });
    input.current?.closest('[data-docs-search]')?.scrollTo?.({ top: 0 });
  };

  const info = (
    <InfoButton title="Search">
      <p>Searches the text of every document in this workspace&apos;s library. Each result is one section.</p>
      <p>
        Every word must appear. Put words in quotes to find them together, as a phrase. A search for
        &ldquo;refunds&rdquo; also finds &ldquo;refund&rdquo;.
      </p>
      <p>Relevance puts the best matches first. When two results match about as well, the document added more recently comes first.</p>
    </InfoButton>
  );

  return (
    <section aria-label="Search the docs" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-11 items-center gap-1 px-4 py-2">
        <h3 className="text-body font-semibold text-ui-ink">Search</h3>
        {info}
      </div>
    <div data-docs-search className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 md:px-6">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setDocsSearch({ q: text.trim() });
        }}
      >
        <label className="relative block">
          <span className="sr-only">Search the docs</span>
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui-mute">
            <MagnifierIcon size={14} />
          </span>
          <input
            ref={input}
            type="search"
            value={text}
            autoFocus
            maxLength={500}
            placeholder="Search the docs"
            onChange={(e) => setText(e.target.value)}
            data-testid="docs-search-input"
            className="h-9 w-full rounded-ui border border-ui-line bg-ui-surface pl-8 pr-2 text-body text-ui-ink placeholder:text-ui-mute focus:border-ui-accent focus:outline-none touch:h-11"
          />
        </label>
      </form>

      {search.q === '' ? (
        <p className={`mt-6 text-body ${MUTED}`}>Type to search every document in this workspace&apos;s library.</p>
      ) : query.isError ? (
        <p className="mt-6 text-body text-ui-danger">The search did not work: {query.error.message}</p>
      ) : data == null ? (
        <p className={`mt-6 text-body ${MUTED}`}>Searching…</p>
      ) : !data.indexed ? (
        <p className={`mt-6 text-body ${MUTED}`}>Nothing in this library can be searched yet. Add a document in Docs, or wait for one to finish building.</p>
      ) : data.total === 0 ? (
        <p className={`mt-6 text-body ${MUTED}`} data-testid="docs-search-empty">
          No section has every word of &ldquo;{data.query}&rdquo;. Try fewer words.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-body text-ui-ink tabular-nums" role="status" data-testid="docs-search-count">
              {resultCountWords(data.total, data.totalCapped)}
            </p>
            <div role="group" aria-label="Sort" className="ml-auto inline-flex rounded-ui border border-ui-line p-0.5">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={search.sort === s.id}
                  onClick={() => setDocsSearch({ sort: s.id })}
                  className={cx(
                    'h-7 rounded-ui px-2.5 text-meta touch:h-10',
                    search.sort === s.id ? 'bg-ui-sel font-medium text-ui-ink' : 'text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
                    FOCUS_RING,
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {data.results.length === 0 ? (
            <p className={`mt-6 text-body ${MUTED}`}>
              No results on this page.{' '}
              <button type="button" className="text-ui-ink underline underline-offset-2" onClick={() => goPage(1)}>
                Go to the first page
              </button>
            </p>
          ) : (
            <ol className={cx('mt-3 divide-y divide-ui-line', query.isPlaceholderData && 'opacity-60')} data-testid="docs-search-results">
              {data.results.map((r) => (
                <ResultRow key={r.path} result={r} onOpen={() => openDocsSearchResult(workspaceId, r.path, r.anchor, r.matchedWords)} />
              ))}
            </ol>
          )}
          {pageCount > 1 && (
            <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3 pb-4">
              <Button size="sm" disabled={search.page <= 1} onClick={() => goPage(search.page - 1)} icon={<ArrowIcon dir="left" size={11} />}>
                Previous
              </Button>
              <span className={`text-meta tabular-nums ${MUTED}`}>
                Page {Math.min(search.page, pageCount)} of {pageCount}
              </span>
              <Button size="sm" disabled={search.page >= pageCount} onClick={() => goPage(search.page + 1)}>
                Next
                <ArrowIcon dir="right" size={11} />
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
    </section>
  );
}

function ResultRow({ result: r, onOpen }: { result: DocsSearchResult; onOpen: () => void }): JSX.Element {
  const url = r.sourceUrl != null ? safeExternalUrl(r.sourceUrl) : null;
  const where = [r.docTitle, ...r.trail].join(' › ');
  return (
    <li className="py-3" data-testid="docs-search-result">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-ui-ink">
            {/* The title opens the section too, styled like the viewer's in-library links. */}
            <button
              type="button"
              onClick={onOpen}
              data-testid="docs-search-title"
              className={cx('cursor-pointer text-left underline underline-offset-2 hover:decoration-2', FOCUS_RING)}
            >
              {r.sectionTitle}
            </button>
          </p>
          <p className={`mt-0.5 truncate text-meta ${MUTED}`} title={where}>
            {where}
          </p>
          <p className={`flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-meta ${MUTED}`}>
            <span>{docSourceLabel(r.sourceKind, r.wikiProvider)}</span>
            {url != null ? (
              <a href={url} target="_blank" rel="noreferrer noopener" className="min-w-0 max-w-full truncate underline underline-offset-2 hover:text-ui-ink" title={r.sourceName}>
                {r.sourceName}
              </a>
            ) : (
              <span className="min-w-0 max-w-full truncate" title={r.sourceName}>
                {r.sourceName}
              </span>
            )}
            <span aria-hidden="true">·</span>
            <span>Added {formatDate(r.docAddedAt)}</span>
          </p>
        </div>
        <Button size="sm" onClick={onOpen} aria-label={`Open ${r.sectionTitle}`}>
          Open
        </Button>
      </div>
      {r.snippet.length > 0 && (
        <p className="mt-1.5 break-words text-body text-ui-ink" data-testid="docs-search-snippet">
          {r.snippet.map((part, i) =>
            part.match ? (
              // The UA sheet's `mark { color: black }` is reset by the explicit ink (see Search/highlight.tsx).
              <mark key={i} className="rounded-[2px] bg-ui-accent/25 px-0.5 text-ui-ink">
                {part.text}
              </mark>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
        </p>
      )}
    </li>
  );
}
