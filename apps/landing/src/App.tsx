import { useEffect } from 'react';
import { useRoute } from './router';
import { initAnalytics, trackPageView } from './lib/analytics';
import { useSeo } from './lib/seo';
import { NOT_FOUND_SEO } from './lib/routes';
import Nav from './components/Nav';
import Footer from './components/Footer';
import CookieBanner from './components/CookieBanner';
import { LightboxProvider } from './components/Lightbox';
import { InkButton, Section } from './components/feint/primitives';
import Home from './pages/Home';
import ForDevelopers from './pages/ForDevelopers';
import ForManagers from './pages/ForManagers';
import HowWeMeasure from './pages/HowWeMeasure';
import Contact from './pages/Contact';
import Privacy from './pages/Privacy';
import Cookies from './pages/Cookies';
import Terms from './pages/Terms';

const ROUTES: Record<string, () => JSX.Element> = {
  '/': Home,
  '/for-developers': ForDevelopers,
  '/for-managers': ForManagers,
  '/how-we-measure': HowWeMeasure,
  // Contact. Until Stripe exists this is also the PURCHASE path — every Pro
  // call-to-action on the site points here, which is why /pricing aliases to it
  // below rather than to the manager page it used to land on.
  '/contact': Contact,
  // Legal. Required before the site can lawfully collect anything in the EU/UK, and
  // linked from the footer on every page + from the consent banner.
  '/privacy': Privacy,
  '/cookies': Cookies,
  '/terms': Terms,
  // Legacy inbound links. The five feature-area pages and the arcade were folded into
  // the two role pages; each old URL resolves to whichever of them now carries its
  // content, so a bookmark or a search result lands on something rather than a 404.
  // The prerenderer writes the same mapping to disk (see prerender.mjs), and the
  // canonical in that HTML points at the surviving page.
  '/features': ForDevelopers,
  '/how-it-works': HowWeMeasure,
  '/bots': ForManagers,
  '/pro': ForManagers,
  // /pricing goes to CONTACT, not to a page describing a price nobody can pay yet.
  // Somebody typing /pricing is asking how to buy it, and the answer is "ask us".
  '/pricing': Contact,
  '/insights': ForManagers,
  '/reviews': ForManagers,
};

function NotFound(): JSX.Element {
  useSeo(NOT_FOUND_SEO);
  return (
    <Section divider="none" pad="lg">
      <h1 className="mb-5 max-w-[22ch] font-display text-h2-sm font-semibold text-ink type:text-h2-major">
        This page wandered off.
      </h1>
      <p className="mb-9 max-w-[56ch]">
        The link is dead, but the timeline isn’t. Let’s get you back.
      </p>
      <InkButton to="/">Back to home</InkButton>
    </Section>
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
      {/* The 1280px canvas. The design is a fixed max canvas with 56px gutters
          rather than a full-bleed layout, so the `paper-alt` bands stop at the
          canvas edge too — beyond it is plain paper, from `body`. */}
      <div className="mx-auto min-h-screen max-w-canvas">
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
