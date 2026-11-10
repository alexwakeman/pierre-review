import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { REPO_URL, SITE_NAME } from '../lib/site';
import { analyticsConfigured } from '../lib/analytics';
import { changeCookieChoice } from '../components/Footer';
import { GROUPS, PAGES, neighbours, pageForPath, sectionFor } from './manifest';
import type { PageEntry, SectionEntry } from './types';
import { DOCS_ROOT, docRoute } from './routes';
import { docsSeoFor } from './seo';
import { tocFor, type TocItem } from './toc';
import { LIMN_VERSION } from './version';
import '../components/mock/mock.css';
import '../components/mock/live.css';
import './docs.css';

// ---------------------------------------------------------------------------
// THE DOCS LAYOUT: /docs and every page under it (docs/README in CONTRIBUTING.md).
//
//   docs bar     "Limn documentation", the current version (links to the changelog), and on a
//                narrow screen the "Contents" button that opens the contents as a drawer.
//   contents     the LEFT-HAND list: search, then the sections under their group headings.
//                Every section is COLLAPSED until its button is pressed (aria-expanded); the
//                current page's section opens by itself. A one-page section is a plain link.
//   article      breadcrumbs, title, summary, body, "Edit this page" / "Report a problem",
//                previous / next.
//   on this page the page's H2s (toc.ts), on the right at wide widths, at the top otherwise.
//   legal line   the docs have NO site footer (App.tsx). One line ends the layout instead:
//                Privacy, Cookies, Terms and "Cookie settings" (the consent-withdrawal control
//                must be on every page). Contact is in the header; the changelog is in the
//                contents and behind the version.
//
// The prerendered HTML is the first state: the current section open, the drawer closed, no
// search. Collapsed lists are in the HTML with `hidden`, so every link is there for a crawler.
// ---------------------------------------------------------------------------

const SEARCH_LIMIT = 40;

function DocsLegal(): JSX.Element {
  return (
    <nav className="dx-legal" aria-label="Legal">
      <span>© 2026 {SITE_NAME}</span>
      <Link to="/privacy">Privacy</Link>
      <Link to="/cookies">Cookies</Link>
      <Link to="/terms">Terms</Link>
      {analyticsConfigured() && (
        <button type="button" onClick={changeCookieChoice}>
          Cookie settings
        </button>
      )}
    </nav>
  );
}

function matches(p: PageEntry, words: string[]): boolean {
  const hay = `${p.meta.title} ${p.meta.summary} ${sectionFor(p.section)?.title ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

function SectionBlock({
  section,
  open,
  onToggle,
  currentKey,
}: {
  section: SectionEntry;
  open: boolean;
  onToggle: (id: string) => void;
  currentKey: string | null;
}): JSX.Element {
  const listId = `dx-sec-${section.id}`;
  const only = section.pages.length === 1 ? section.pages[0]! : null;
  if (only) {
    return (
      <li className="dx-sec single">
        <Link to={only.route} className="dx-sec-link" aria-current={only.key === currentKey ? 'page' : undefined}>
          {section.title}
        </Link>
      </li>
    );
  }
  const hasCurrent = section.pages.some((p) => p.key === currentKey);
  return (
    <li className={`dx-sec${open ? ' open' : ''}${hasCurrent ? ' has-current' : ''}`}>
      <button type="button" className="dx-sec-btn" aria-expanded={open} aria-controls={listId} onClick={() => onToggle(section.id)}>
        <span className="dx-caret" aria-hidden="true" />
        {section.title}
      </button>
      <ul id={listId} className="dx-pages" hidden={!open}>
        {section.pages.map((p) => (
          <li key={p.key}>
            <Link to={p.route} aria-current={p.key === currentKey ? 'page' : undefined}>
              {p.meta.title}
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}

function Contents({
  currentKey,
  currentSection,
  onClose,
  drawer,
}: {
  currentKey: string | null;
  currentSection: string | null;
  onClose: () => void;
  drawer: boolean;
}): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(currentSection ? [currentSection] : []));
  const [q, setQ] = useState('');

  // A new page opens its own section, and leaves the reader's other choices as they were.
  useEffect(() => {
    if (currentSection) setOpen((prev) => (prev.has(currentSection) ? prev : new Set([...prev, currentSection])));
  }, [currentSection]);

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = words.length > 0 ? PAGES.filter((p) => matches(p, words)) : null;

  return (
    <>
      {drawer ? (
        <div className="dx-drawer-h">
          <b>Contents</b>
          <button type="button" className="dx-close" onClick={onClose} data-autofocus>
            Close
          </button>
        </div>
      ) : null}
      <div className="dx-search" role="search">
        <label htmlFor={drawer ? 'dx-q-drawer' : 'dx-q'} className="vh">
          Search the docs
        </label>
        <input
          id={drawer ? 'dx-q-drawer' : 'dx-q'}
          type="search"
          placeholder="Search the docs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
      </div>
      {results ? (
        <div className="dx-results">
          <p className="dx-results-n" aria-live="polite">
            {results.length === 0 ? 'No pages match.' : results.length === 1 ? '1 page' : `${results.length} pages`}
          </p>
          <ul>
            {results.slice(0, SEARCH_LIMIT).map((p) => (
              <li key={p.key}>
                <Link to={p.route} aria-current={p.key === currentKey ? 'page' : undefined}>
                  <b>{p.meta.title}</b>
                  <span>{sectionFor(p.section)?.title}</span>
                  <small>{p.meta.summary}</small>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="dx-tree">
          <Link to={DOCS_ROOT} className="dx-home-link" aria-current={currentKey == null && currentSection == null ? 'page' : undefined}>
            Documentation home
          </Link>
          {GROUPS.map((g) => (
            <div key={g.title} className="dx-group">
              <p className="dx-group-h">{g.title}</p>
              <ul>
                {g.sections.map((s) => (
                  <SectionBlock key={s.id} section={s} open={open.has(s.id)} onToggle={toggle} currentKey={currentKey} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function TocList({ items }: { items: TocItem[] }): JSX.Element {
  return (
    <ul>
      {items.map((t) => (
        <li key={t.id}>
          <a href={`#${t.id}`}>{t.text}</a>
        </li>
      ))}
    </ul>
  );
}

function PageArticle({ page }: { page: PageEntry }): JSX.Element {
  const section = sectionFor(page.section);
  const toc = tocFor(page.Body);
  const { prev, next } = neighbours(page.key);
  const editUrl =
    page.section === 'changelog'
      ? `${REPO_URL}/edit/main/CHANGELOG.md`
      : `${REPO_URL}/edit/main/apps/landing/src/docs/pages/${page.key}.tsx`;
  const first = section?.pages[0];
  const Body = page.Body;
  return (
    <>
      <article className="dx-article" aria-labelledby="dx-title">
        <nav aria-label="Breadcrumb" className="dx-crumbs">
          <ol>
            <li>
              <Link to={DOCS_ROOT}>Docs</Link>
            </li>
            {section && first && section.pages.length > 1 ? (
              <li>
                <Link to={first.route}>{section.title}</Link>
              </li>
            ) : null}
            <li aria-current="page">{page.meta.title}</li>
          </ol>
        </nav>
        <h1 id="dx-title">{page.meta.title}</h1>
        <p className="dx-lead">{page.meta.summary}</p>
        {toc.length > 1 ? (
          <details className="dx-toc-inline">
            <summary>On this page</summary>
            <TocList items={toc} />
          </details>
        ) : null}
        <div className="dx-body">
          <Body />
        </div>
        <div className="dx-edit">
          <a href={editUrl} target="_blank" rel="noreferrer noopener">
            Edit this page
          </a>
          <Link to="/contact">Report a problem with this page</Link>
        </div>
        <nav className="dx-prevnext" aria-label="Previous and next pages">
          {prev ? (
            <Link to={prev.route} className="prev">
              <small>Previous</small>
              <b>{prev.meta.title}</b>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={next.route} className="next">
              <small>Next</small>
              <b>{next.meta.title}</b>
            </Link>
          ) : null}
        </nav>
      </article>
      <aside className="dx-toc" aria-label="On this page">
        {toc.length > 1 ? (
          <>
            <p className="dx-toc-h">On this page</p>
            <TocList items={toc} />
          </>
        ) : null}
      </aside>
    </>
  );
}

function DocsHome(): JSX.Element {
  return (
    <>
      <article className="dx-article dx-home" aria-labelledby="dx-title">
        <h1 id="dx-title">Limn documentation</h1>
        <p className="dx-lead">
          How to use Limn, screen by screen: what each page shows, what you can do there, and how it helps a developer or an
          engineering manager. Limn runs on your own computer; everything here is free for up to three people.
        </p>
        <div className="dx-start">
          <Link to={docRoute('getting-started/introduction')} className="btn">
            Start here
          </Link>
          <Link to={docRoute('getting-started/install-and-run')} className="btn alt">
            Install and run
          </Link>
        </div>
        {GROUPS.map((g) => (
          <section key={g.title} className="dx-home-group" aria-label={g.title}>
            <h2 className="dx-h2">{g.title}</h2>
            <div className="dx-cards">
              {g.sections.map((s) => (
                <Link key={s.id} to={s.pages[0]!.route} className="dx-sec-card">
                  <b>{s.title}</b>
                  <span>{s.blurb}</span>
                  {s.pages.length > 1 ? <small>{s.pages.length} pages</small> : null}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </article>
      <aside className="dx-toc" aria-hidden="true" />
    </>
  );
}

function DocsNotFound(): JSX.Element {
  return (
    <>
      <article className="dx-article" aria-labelledby="dx-title">
        <h1 id="dx-title">This page is not in the docs</h1>
        <p className="dx-lead">The page may have moved or been removed with the feature it described.</p>
        <p>
          Search the contents, or go to the <Link to={DOCS_ROOT}>documentation home</Link>.
        </p>
      </article>
      <aside className="dx-toc" aria-hidden="true" />
    </>
  );
}

export function DocsApp({ path }: { path: string }): JSX.Element {
  const page = path === DOCS_ROOT ? null : pageForPath(path);
  const notFound = path !== DOCS_ROOT && page == null;
  useSeo({ ...docsSeoFor(path), path });

  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  // A new page closes the drawer.
  useEffect(() => setDrawer(false), [path]);

  // The drawer takes focus when it opens, and gives it back when it closes.
  useEffect(() => {
    if (drawer) drawerRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [drawer]);

  const close = useCallback(() => {
    setDrawer(false);
    openerRef.current?.focus();
  }, []);

  const onDrawerKey = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') close();
    },
    [close],
  );

  const currentSection = page?.section ?? null;
  const main = useMemo(() => {
    if (notFound) return <DocsNotFound />;
    if (page) return <PageArticle page={page} />;
    return <DocsHome />;
  }, [notFound, page]);

  return (
    <div className="lb docs">
      <div className="dx-bar">
        <button
          type="button"
          ref={openerRef}
          className="dx-menu"
          aria-expanded={drawer}
          aria-controls="dx-drawer"
          onClick={() => setDrawer(true)}
        >
          Contents
        </button>
        <Link to={DOCS_ROOT} className="dx-bar-title">
          Limn documentation
        </Link>
        <Link to={docRoute('changelog/changelog')} className="dx-ver" title="What changed in each release">
          Version {LIMN_VERSION}
        </Link>
      </div>
      <div className="dx-grid">
        <nav className="dx-nav" aria-label="Documentation">
          <Contents currentKey={page?.key ?? null} currentSection={currentSection} onClose={close} drawer={false} />
        </nav>
        {main}
      </div>
      <DocsLegal />
      {drawer ? (
        <div className="dx-drawer-wrap" onKeyDown={onDrawerKey}>
          <button type="button" className="dx-scrim" aria-label="Close the contents" tabIndex={-1} onClick={close} />
          <div id="dx-drawer" ref={drawerRef} className="dx-drawer" role="dialog" aria-modal="true" aria-label="Contents">
            <nav aria-label="Documentation">
              <Contents currentKey={page?.key ?? null} currentSection={currentSection} onClose={close} drawer />
            </nav>
          </div>
        </div>
      ) : (
        <div id="dx-drawer" hidden />
      )}
    </div>
  );
}
