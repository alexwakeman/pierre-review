import { useEffect } from 'react';
import { Link, useRoute } from './router';
import { initAnalytics, trackPageView } from './lib/analytics';
import { useSeo } from './lib/seo';
import { NOT_FOUND_SEO } from './lib/routes';
import Nav from './components/Nav';
import Footer from './components/Footer';
import CookieBanner from './components/CookieBanner';
import { useReveal } from './components/board/useReveal';
import './components/chrome.css';
import Home from './pages/Home';
import Reporting from './pages/Reporting';
import HowWeMeasure from './pages/HowWeMeasure';
import Teams from './pages/Teams';
import Contact from './pages/Contact';
import Privacy from './pages/Privacy';
import Cookies from './pages/Cookies';
import Terms from './pages/Terms';
import { DocsRoute } from './docs-loader';
import { isDocsPath } from './docs/routes';

const ROUTES: Record<string, () => JSX.Element> = {
  '/': Home,
  '/reporting': Reporting,
  '/teams': Teams,
  '/how-we-measure': HowWeMeasure,
  // Contact. Also where an organisation with more than three people asks for a
  // licence, which is why /pricing aliases to it below.
  '/contact': Contact,
  // Legal. Required before the site can lawfully collect anything in the EU/UK, and
  // linked from the footer on every page + from the consent banner.
  '/privacy': Privacy,
  '/cookies': Cookies,
  '/terms': Terms,
  // Legacy inbound links. The five feature-area pages, the arcade and then the two role
  // pages were retired; each old URL resolves to whichever page now carries its
  // content, so a bookmark or a search result lands on something rather than a 404.
  // The prerenderer writes the same mapping to disk (see prerender.mjs), and the
  // canonical in that HTML points at the surviving page.
  '/for-managers': Reporting,
  '/how-it-works': HowWeMeasure,
  '/bots': Reporting,
  '/pro': Reporting,
  // /pricing goes to CONTACT: its first two lines say what it costs (nothing, unless
  // the organisation has more than three users) and how to get a licence.
  '/pricing': Contact,
  '/insights': Reporting,
  '/reviews': Reporting,
};

// Retired pages whose content now lives in the docs. apps/site answers these with a 301
// before the landing loads (src/app.ts MOVED_TO_DOCS); this table only matters where no
// site server stands in front, such as `vite dev`. Keep the two lists the same.
const MOVED_TO_DOCS: Record<string, string> = {
  '/getting-started': '/docs/getting-started/install-and-run',
  '/for-developers': '/docs/getting-started/install-and-run',
  '/features': '/docs/getting-started/install-and-run',
};

function MovedToDocs({ to }: { to: string }): JSX.Element {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return (
    <div className="lb notfound">
      <section className="board nf">
        <div className="tile nf-head">
          <p>
            This page moved to <Link to={to}>the docs</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}

function NotFound(): JSX.Element {
  useSeo(NOT_FOUND_SEO);
  const ref = useReveal<HTMLDivElement>();
  return (
    <div className="lb notfound" ref={ref}>
      <section className="board nf">
        <div className="tile nf-head rise">
          <h1>This page wandered off.</h1>
        </div>
        <div className="tile lapis nf-say rise">
          <p>The link is dead, but the timeline isn’t. Let’s get you back.</p>
          <div className="btns">
            <Link className="btn" to="/">
              Back to home
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function App(): JSX.Element {
  const path = useRoute();
  // /docs and every page under it: the docs layout, in its own chunk (docs-loader.tsx).
  const docs = isDocsPath(path);
  const Page = ROUTES[path] ?? NotFound;
  const moved = MOVED_TO_DOCS[path];

  // Re-arm analytics on mount for a visitor who consented on a PREVIOUS visit: the
  // stored grant is still valid, but a fresh page load starts with no gtag on the
  // page. initAnalytics() self-guards on both the measurement id and the consent, so
  // calling it unconditionally here is safe — it is a no-op for anyone who declined
  // or has not been asked. (First-time grants are wired straight from the banner.)
  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    trackPageView(path);
  }, [path]);

  return (
    <>
      {/* Every page is a board page (root `.lb`), so the header, the page and the
          footer all run full width; each page lays out its own tiles. */}
      <div className="lb-app">
        <Nav />
        <main>
          {docs ? (
            <DocsRoute path={path} />
          ) : moved ? (
            <MovedToDocs to={moved} />
          ) : (
            <Page />
          )}
        </main>
        {/* The docs drop the big block wordmark: the footer is links only there. */}
        <Footer wordmark={!docs} />
        <CookieBanner />
      </div>
    </>
  );
}
