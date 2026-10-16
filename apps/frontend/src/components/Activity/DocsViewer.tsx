import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { useReferenceDocSection } from '../../hooks/useReferenceDocs.js';
import {
  LIBRARY_INDEX_PATH,
  rehypeDocHeadingAnchors,
  resolveDocLink,
} from '../../lib/referenceDocs.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { ArrowIcon } from '../Icons.js';
import { Markdown, type RehypePlugins } from '../Markdown.js';
import type { DocsOpen } from '../../store/docsView.js';

// Activity → Docs, the centre column: ONE library file at a time (INDEX.md, a document's
// CONTENTS.md, or a section), drawn by the shared `Markdown`. Every link in it goes through the ONE
// resolver (`resolveDocLink`): a library link opens in this viewer, `#anchor` scrolls this box, an
// outside link opens in a new tab through `safeExternalUrl`, and anything else is plain text.

const MUTED = 'text-gray-500 dark:text-gray-400';
const LINK = 'cursor-pointer text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100';
const HEADING_ANCHORS: RehypePlugins = [rehypeDocHeadingAnchors];

/**
 * A memoised `renderLink` for `Markdown`, resolving links against the file at `fromPath`.
 * `onAnchor` handles a same-file `#anchor` (omit it where there is no file on screen, e.g. the chat).
 */
export function useDocLinkRenderer(
  fromPath: string,
  onOpen: (path: string, anchor: string | null) => void,
  onAnchor?: (anchor: string) => void,
): (href: string | undefined, children: ReactNode) => ReactNode {
  return useCallback(
    (href: string | undefined, children: ReactNode): ReactNode => {
      const r = resolveDocLink(fromPath, href);
      if (r.kind === 'library') {
        const { path, anchor } = r.location;
        return (
          <button type="button" className={LINK} onClick={() => onOpen(path, anchor)}>
            {children}
          </button>
        );
      }
      if (r.kind === 'anchor' && onAnchor != null) {
        return (
          <button type="button" className={LINK} onClick={() => onAnchor(r.anchor)}>
            {children}
          </button>
        );
      }
      if (r.kind === 'external') {
        const safe = safeExternalUrl(r.href);
        if (safe != null) {
          return (
            <a href={safe} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        }
      }
      return <span>{children}</span>;
    },
    [fromPath, onOpen, onAnchor],
  );
}

function scrollToAnchor(box: HTMLElement, anchor: string | null): void {
  if (anchor == null) {
    box.scrollTop = 0;
    return;
  }
  const el = Array.from(box.querySelectorAll<HTMLElement>('[data-doc-anchor]')).find((n) => n.dataset.docAnchor === anchor);
  if (el == null) {
    box.scrollTop = 0;
    return;
  }
  // This box scrolls, nothing above it — never `scrollIntoView` (it would scroll the Activity pane).
  box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
}

export function DocsViewer({
  workspaceId,
  open,
  hasDocs,
  onOpen,
}: {
  workspaceId: number;
  open: DocsOpen;
  hasDocs: boolean;
  onOpen: (path: string, anchor: string | null) => void;
}): JSX.Element {
  const section = useReferenceDocSection(workspaceId, open.path);
  const box = useRef<HTMLDivElement | null>(null);
  const data = section.data;

  const onAnchor = useCallback((anchor: string) => {
    if (box.current != null) scrollToAnchor(box.current, anchor);
  }, []);
  const renderLink = useDocLinkRenderer(open.path, onOpen, onAnchor);

  // Land on the requested heading (or the top) whenever a file is opened or arrives.
  useEffect(() => {
    if (box.current != null && data != null) scrollToAnchor(box.current, open.anchor);
  }, [data, open.anchor, open.seq]);

  const contentsPath = data?.docSlug != null ? `${data.docSlug}/CONTENTS.md` : null;
  const isSection = data != null && data.path !== LIBRARY_INDEX_PATH && data.path !== contentsPath;
  const notFound = section.error instanceof ApiError && (section.error.status === 404 || section.error.status === 400);

  const body = useMemo(() => data?.markdown ?? '', [data?.markdown]);

  return (
    <section aria-label="Document viewer" className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-800">
        <nav aria-label="Where you are" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <button type="button" className={LINK} onClick={() => onOpen(LIBRARY_INDEX_PATH, null)}>
            Library
          </button>
          {data?.docTitle != null && contentsPath != null && (
            <>
              <span className={MUTED} aria-hidden="true">
                ›
              </span>
              {isSection ? (
                <button type="button" className={`${LINK} truncate`} onClick={() => onOpen(contentsPath, null)}>
                  {data.docTitle}
                </button>
              ) : (
                <span className="truncate font-medium text-gray-700 dark:text-gray-200">{data.docTitle}</span>
              )}
            </>
          )}
          {isSection && (
            <>
              <span className={MUTED} aria-hidden="true">
                ›
              </span>
              <span className="truncate font-medium text-gray-700 dark:text-gray-200">{data.title}</span>
            </>
          )}
        </nav>
        {isSection && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={data.prev == null}
              onClick={() => data.prev != null && onOpen(data.prev, null)}
              className="inline-flex items-center gap-0.5 text-sky-700 hover:underline disabled:cursor-default disabled:text-gray-500 disabled:no-underline dark:text-sky-300 dark:disabled:text-gray-400"
            >
              <ArrowIcon dir="left" size={11} />
              Previous
            </button>
            {contentsPath != null && (
              <button type="button" onClick={() => onOpen(contentsPath, null)} className="text-sky-700 hover:underline dark:text-sky-300">
                Contents
              </button>
            )}
            <button
              type="button"
              disabled={data.next == null}
              onClick={() => data.next != null && onOpen(data.next, null)}
              className="inline-flex items-center gap-0.5 text-sky-700 hover:underline disabled:cursor-default disabled:text-gray-500 disabled:no-underline dark:text-sky-300 dark:disabled:text-gray-400"
            >
              Next
              <ArrowIcon dir="right" size={11} />
            </button>
          </div>
        )}
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="docs-viewer">
        {open.path === LIBRARY_INDEX_PATH && !hasDocs ? (
          <p className={`text-xs ${MUTED}`}>No documents yet. Add a PDF, Word or text file, or a web page.</p>
        ) : section.isPending ? (
          <p className={`text-xs ${MUTED}`}>Loading…</p>
        ) : notFound ? (
          <div className="space-y-2 text-xs">
            <p className="text-gray-700 dark:text-gray-200">This page is no longer in the library.</p>
            <button type="button" className={LINK} onClick={() => onOpen(LIBRARY_INDEX_PATH, null)}>
              Open the library
            </button>
          </div>
        ) : section.isError ? (
          <p className="text-xs text-rose-700 dark:text-rose-400">{section.error.message}</p>
        ) : (
          <div className="text-[13px] text-gray-800 dark:text-gray-100">
            <Markdown rehypeExtra={HEADING_ANCHORS} renderLink={renderLink}>
              {body}
            </Markdown>
          </div>
        )}
      </div>
    </section>
  );
}
