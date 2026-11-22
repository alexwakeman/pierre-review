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
import Build from './pages/Build';
import EnsembleReview from './pages/EnsembleReview';
import Automation from './pages/Automation';
import EverythingElse from './pages/EverythingElse';
import Contact from './pages/Contact';
import Pricing from './pages/Pricing';
import Trust from './pages/Trust';
import About from './pages/About';
import Privacy from './pages/Privacy';
import Cookies from './pages/Cookies';
import Terms from './pages/Terms';
import { DocsRoute } from './docs-loader';
import { isDocsPath } from './docs/routes';

const ROUTES: Record<string, () => JSX.Element> = {
  '/': Home,
  '/build': Build,
  '/ensemble-review': EnsembleReview,
  '/automation': Automation,
  '/everything-else': EverythingElse,
  // Contact. Also where a licence is asked for when it cannot be bought on /pricing.
  '/contact': Contact,
  '/pricing': Pricing,
  // Security and trust: the summary a security or procurement reviewer reads.
  '/trust': Trust,
  // About: what Ensemble is, and the plain statement on running Claude on a plan login.
  '/about': About,
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
  '/for-managers': EverythingElse,
  '/how-it-works': EverythingElse,
  '/bots': EverythingElse,
  '/pro': EverythingElse,
  '/insights': EverythingElse,
  '/reviews': EverythingElse,
};

// Retired pages that moved for good: Getting started into the docs, For teams to Ensemble
// review, Reporting and How we measure into Everything else. apps/site answers these with a
// 301 before the landing loads (src/app.ts MOVED); this table only matters where no site
// server stands in front, such as `vite dev`. Keep the two lists the same.
const MOVED: Record<string, string> = {
  '/teams': '/ensemble-review',
  '/reporting': '/everything-else#reporting',
  '/how-we-measure': '/everything-else#how-we-measure',
  '/getting-started': '/docs/getting-started/install-and-run',
  '/for-developers': '/docs/getting-started/install-and-run',
  '/features': '/docs/getting-started/install-and-run',
};

function Moved({ to }: { to: string }): JSX.Element {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return (
    <div className="lb notfound">
      <section className="board nf">
        <div className="tile nf-head">
          <p>
            This page moved <Link to={to}>here</Link>.
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
  const moved = MOVED[path];

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
            <Moved to={moved} />
          ) : (
            <Page />
          )}
        </main>
        {/* The docs have no site footer: their own layout ends on one line of legal links
            (DocsApp.tsx, DocsLegal). */}
        {docs ? null : <Footer />}
        <CookieBanner />
      </div>
    </>
  );
}
