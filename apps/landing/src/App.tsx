import { useEffect } from 'react';
import { Link, useRoute } from './router';
import { initAnalytics, trackPageView } from './lib/analytics';
import { useSeo } from './lib/seo';
import { NOT_FOUND_SEO } from './lib/routes';
import { DEMO_PATH } from './lib/site';
import Nav from './components/Nav';
import Footer from './components/Footer';
import CookieBanner from './components/CookieBanner';
import { LightboxProvider } from './components/Lightbox';
import { useReveal } from './components/board/useReveal';
import './components/chrome.css';
import Home from './pages/Home';
import GettingStarted from './pages/GettingStarted';
import Reporting from './pages/Reporting';
import HowWeMeasure from './pages/HowWeMeasure';
import Contact from './pages/Contact';
import Privacy from './pages/Privacy';
import Cookies from './pages/Cookies';
import Terms from './pages/Terms';

const ROUTES: Record<string, () => JSX.Element> = {
  '/': Home,
  '/getting-started': GettingStarted,
  '/reporting': Reporting,
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
  '/for-developers': GettingStarted,
  '/for-managers': Reporting,
  '/features': GettingStarted,
  '/how-it-works': HowWeMeasure,
  '/bots': Reporting,
  '/pro': Reporting,
  // /pricing goes to CONTACT: its first two lines say what it costs (nothing, unless
  // the organisation has more than three users) and how to get a licence.
  '/pricing': Contact,
  '/insights': Reporting,
  '/reviews': Reporting,
};

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
            <a className="btn alt" href={DEMO_PATH}>
              Quick demo
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function App(): JSX.Element {
  const path = useRoute();
  const Page = ROUTES[path] ?? NotFound;

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
    <LightboxProvider>
      {/* Every page is a board page (root `.lb`), so the header, the page and the
          footer all run full width; each page lays out its own tiles. */}
      <div className="lb-app">
        <Nav />
        <main>
          <Page />
        </main>
        <Footer />
        <CookieBanner />
      </div>
    </LightboxProvider>
  );
}
