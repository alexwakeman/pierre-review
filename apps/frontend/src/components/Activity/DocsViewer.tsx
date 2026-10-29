import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { useReferenceDocSection } from '../../hooks/useReferenceDocs.js';
import {
  LIBRARY_INDEX_PATH,
  rehypeDocHeadingAnchors,
  resolveDocLink,
} from '../../lib/referenceDocs.js';
import {
  findQuoteRanges,
  quoteStripText,
  sectionHeaderEnd,
  type QuoteOutcome,
  type QuoteTextSegment,
} from '../../lib/docQuoteMatch.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { ArrowIcon, CloseIcon } from '../Icons.js';
import { Markdown, type RehypePlugins } from '../Markdown.js';
import type { DocsOpen } from '../../store/docsView.js';

// Activity → Docs, the centre column: ONE library file at a time (INDEX.md, a document's
// CONTENTS.md, or a section), drawn by the shared `Markdown`. Every link in it goes through the ONE
// resolver (`resolveDocLink`): a library link opens in this viewer, `#anchor` scrolls this box, an
// outside link opens in a new tab through `safeExternalUrl`, and anything else is plain text.
//
// THE QUOTE HIGHLIGHT: an open that carries a server-checked `quote` (a review reference, a story-docs
// point, a chat citation, a finding's borrowed quote) is found in the rendered text
// (`lib/docQuoteMatch.ts`, the ONE fold shared with the server), painted with the CSS Custom
// Highlight API (`::highlight(doc-quote)` in index.css — no DOM React owns is changed) and scrolled
// to, in THIS box. One line above the page says so and clears it; when the words are gone (the
// document was rebuilt) the same line says that instead and the view lands on the anchor.

const MUTED = 'text-ui-mute';
const LINK = 'cursor-pointer text-ui-accent underline underline-offset-2 hover:text-ui-ink';
const HEADING_ANCHORS: RehypePlugins = [rehypeDocHeadingAnchors];

/**
 * A memoised `renderLink` for `Markdown`, resolving links against the file at `fromPath`.
 * `onAnchor` handles a same-file `#anchor` (omit it where there is no file on screen, e.g. the chat).
 */
export function useDocLinkRenderer(
  fromPath: string,
  onOpen: (path: string, anchor: string | null, quote?: string | null) => void,
  onAnchor?: (anchor: string) => void,
  /** The checked quote a library link carries (the chat's citations), or null. */
  quoteFor?: (path: string, anchor: string | null) => string | null,
): (href: string | undefined, children: ReactNode) => ReactNode {
  return useCallback(
    (href: string | undefined, children: ReactNode): ReactNode => {
      const r = resolveDocLink(fromPath, href, quoteFor);
      if (r.kind === 'library') {
        const { path, anchor } = r.location;
        const { quote } = r;
        return (
          <button type="button" className={LINK} onClick={() => onOpen(path, anchor, quote)}>
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
    [fromPath, onOpen, onAnchor, quoteFor],
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

const HIGHLIGHT = 'doc-quote';
/** Elements whose text never runs on into the next one's: a boundary between them folds to a space. */
const BLOCKS = new Set(['P', 'LI', 'TD', 'TH', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DIV', 'TABLE', 'DT', 'DD', 'FIGCAPTION', 'SECTION', 'UL', 'OL']);

function highlightRegistry(): { set: (name: string, h: unknown) => void; delete: (name: string) => void } | null {
  const css = (globalThis as { CSS?: { highlights?: unknown } }).CSS;
  const reg = css?.highlights as { set?: unknown; delete?: unknown } | undefined;
  if (reg == null || typeof reg.set !== 'function' || typeof (globalThis as { Highlight?: unknown }).Highlight !== 'function') return null;
  return reg as { set: (name: string, h: unknown) => void; delete: (name: string) => void };
}

function clearHighlight(): void {
  highlightRegistry()?.delete(HIGHLIGHT);
}

/**
 * Find `quote` in the rendered file under `root`, paint it and scroll `box` to it: `'painted'`,
 * `'found'` (scrolled to, but this browser cannot paint a highlight) or `'missing'`.
 * `isSection` ⇒ the leading H1 and the ONE blockquote after it are the server-written header, never
 * matched (`sectionHeaderEnd` — the same header the server's `sectionBodyOf` leaves off).
 */
function highlightQuote(box: HTMLElement, root: HTMLElement, quote: string, anchor: string | null, isSection: boolean): QuoteOutcome {
  const nodes: Text[] = [];
  const segments: QuoteTextSegment[] = [];
  const blockIds = new Map<Element, number>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n != null; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data === '') continue;
    let el: Element | null = t.parentElement;
    while (el != null && el !== root && !BLOCKS.has(el.tagName)) el = el.parentElement;
    const key = el ?? root;
    if (!blockIds.has(key)) blockIds.set(key, blockIds.size);
    nodes.push(t);
    segments.push({ text: t.data, block: blockIds.get(key)! });
  }
  const after = (el: Element | null): number | null => {
    if (el == null) return null;
    const i = nodes.findIndex((t) => el.contains(t) || (el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    return i < 0 ? null : i;
  };
  // The server-written header: the title, then the crumbs-and-nav blockquote.
  let bodyFrom = 0;
  const md = root.querySelector('h1');
  if (isSection && md != null) {
    const last: Element = sectionHeaderEnd(md);
    const next = nodes.findIndex((t) => !last.contains(t) && (last.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    bodyFrom = next < 0 ? nodes.length : next;
  }
  const heading = anchor != null ? Array.from(root.querySelectorAll<HTMLElement>('[data-doc-anchor]')).find((h) => h.dataset.docAnchor === anchor) ?? null : null;
  const ranges = findQuoteRanges(segments, quote, { bodyFrom, preferFrom: after(heading) });
  if (ranges == null || ranges.length === 0) return 'missing';
  const domRanges = ranges.map((r) => {
    const range = document.createRange();
    range.setStart(nodes[r.startSeg]!, r.startOffset);
    range.setEnd(nodes[r.endSeg]!, r.endOffset);
    return range;
  });
  const reg = highlightRegistry();
  if (reg != null) {
    const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    reg.set(HIGHLIGHT, new H(...domRanges));
  }
  const outcome: QuoteOutcome = reg != null ? 'painted' : 'found';
  // Scroll THIS box (never `scrollIntoView`) so the passage sits a third of the way down; a passage
  // in a wide table also scrolls that table's own sideways box.
  const first = domRanges[0]!;
  const rect = first.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  box.scrollTop += rect.top - boxRect.top - box.clientHeight / 3;
  const wide = first.startContainer.parentElement?.closest<HTMLElement>('.md-table-scroll');
  if (wide != null) {
    const wr = wide.getBoundingClientRect();
    if (rect.left < wr.left || rect.right > wr.right) wide.scrollLeft += rect.left - wr.left - 16;
  }
  return outcome;
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
  onOpen: (path: string, anchor: string | null, quote?: string | null) => void;
}): JSX.Element {
  const section = useReferenceDocSection(workspaceId, open.path);
  const box = useRef<HTMLDivElement | null>(null);
  const page = useRef<HTMLDivElement | null>(null);
  const data = section.data;
  /** The strip's state for THIS open (keyed by seq): painted, found, gone, or cleared by the reader. */
  const [quoteState, setQuoteState] = useState<{ seq: number; status: QuoteOutcome | 'cleared' } | null>(null);

  const onAnchor = useCallback((anchor: string) => {
    if (box.current != null) scrollToAnchor(box.current, anchor);
  }, []);
  const renderLink = useDocLinkRenderer(open.path, onOpen, onAnchor);

  const contentsPath = data?.docSlug != null ? `${data.docSlug}/CONTENTS.md` : null;
  const isSection = data != null && data.path !== LIBRARY_INDEX_PATH && data.path !== contentsPath;

  // Land on the quoted passage, else the requested heading (or the top), whenever a file is opened or
  // arrives. Every open clears the last highlight first.
  const cleared = quoteState?.seq === open.seq && quoteState.status === 'cleared';
  useEffect(() => {
    clearHighlight();
    if (box.current == null || data == null) return;
    if (open.quote != null && !cleared && page.current != null && data.path === open.path) {
      const outcome = highlightQuote(box.current, page.current, open.quote, open.anchor, isSection);
      setQuoteState((s) => (s?.seq === open.seq && s.status === 'cleared' ? s : { seq: open.seq, status: outcome }));
      if (outcome !== 'missing') return;
    }
    if (!cleared) scrollToAnchor(box.current, open.anchor);
  }, [data, open.path, open.anchor, open.quote, open.seq, isSection, cleared]);
  useEffect(() => clearHighlight, []);
  const clearQuote = useCallback(() => {
    clearHighlight();
    setQuoteState({ seq: open.seq, status: 'cleared' });
  }, [open.seq]);
  const strip = open.quote != null && quoteState?.seq === open.seq && quoteState.status !== 'cleared' ? quoteState.status : null;
  const notFound = section.error instanceof ApiError && (section.error.status === 404 || section.error.status === 400);

  const body = useMemo(() => data?.markdown ?? '', [data?.markdown]);

  return (
    <section aria-label="Document viewer" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-x-1 gap-y-1 px-4 py-2 text-body">
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
                <span className="truncate font-medium text-ui-ink">{data.docTitle}</span>
              )}
            </>
          )}
          {isSection && (
            <>
              <span className={MUTED} aria-hidden="true">
                ›
              </span>
              <span className="truncate font-medium text-ui-ink">{data.title}</span>
            </>
          )}
        </nav>
        {isSection && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={data.prev == null}
              onClick={() => data.prev != null && onOpen(data.prev, null)}
              className="inline-flex items-center gap-0.5 text-ui-accent hover:underline disabled:cursor-default disabled:text-ui-faint disabled:no-underline"
            >
              <ArrowIcon dir="left" size={11} />
              Previous
            </button>
            {contentsPath != null && (
              <button type="button" onClick={() => onOpen(contentsPath, null)} className="text-ui-accent hover:underline">
                Contents
              </button>
            )}
            <button
              type="button"
              disabled={data.next == null}
              onClick={() => data.next != null && onOpen(data.next, null)}
              className="inline-flex items-center gap-0.5 text-ui-accent hover:underline disabled:cursor-default disabled:text-ui-faint disabled:no-underline"
            >
              Next
              <ArrowIcon dir="right" size={11} />
            </button>
          </div>
        )}
      </div>
      {strip != null && (
        <div
          role="status"
          className="mx-4 flex items-center gap-2 rounded-ui bg-ui-raise px-3 py-1.5 text-body text-ui-ink"
          data-testid="docs-quote-strip"
        >
          {strip === 'painted' && <span aria-hidden="true" className="doc-quote-swatch h-3 w-3 shrink-0 rounded-sm" />}
          <span className="min-w-0 flex-1">
            {quoteStripText(strip)}
          </span>
          <button
            type="button"
            onClick={clearQuote}
            aria-label={strip === 'painted' ? 'Clear the highlight' : 'Dismiss'}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:w-10"
          >
            <CloseIcon size={12} />
          </button>
        </div>
      )}
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3 md:px-6" data-testid="docs-viewer">
        {open.path === LIBRARY_INDEX_PATH && !hasDocs ? (
          <p className={`text-body ${MUTED}`}>No documents yet. Add a PDF, Word or text file, or a web page.</p>
        ) : section.isPending ? (
          <p className={`text-body ${MUTED}`}>Loading…</p>
        ) : notFound ? (
          <div className="space-y-2 text-body">
            <p className="text-ui-ink">This page is no longer in the library.</p>
            <button type="button" className={LINK} onClick={() => onOpen(LIBRARY_INDEX_PATH, null)}>
              Open the library
            </button>
          </div>
        ) : section.isError ? (
          <p className="text-body text-ui-danger">{section.error.message}</p>
        ) : (
          <div ref={page} className="text-body text-ui-ink">
            <Markdown rehypeExtra={HEADING_ANCHORS} renderLink={renderLink} wideTables>
              {body}
            </Markdown>
          </div>
        )}
      </div>
    </section>
  );
}
