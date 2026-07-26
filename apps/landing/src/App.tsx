import { useEffect } from 'react';
import { Link, useRoute } from './router';
import { initAnalytics, trackPageView } from './lib/analytics';
import { useSeo } from './lib/seo';
import Nav from './components/Nav';
import Footer from './components/Footer';
import CookieBanner from './components/CookieBanner';
import { LightboxProvider } from './components/Lightbox';
import Home from './pages/Home';
import Features from './pages/Features';
import Pro from './pages/Pro';
import Pricing from './pages/Pricing';
import HowItWorks from './pages/HowItWorks';
import Privacy from './pages/Privacy';
import Cookies from './pages/Cookies';
import Terms from './pages/Terms';

const ROUTES: Record<string, () => JSX.Element> = {
  '/': Home,
  '/features': Features,
  '/pro': Pro,
  '/pricing': Pricing,
  '/how-it-works': HowItWorks,
  // Legal. Required before the site can lawfully collect anything in the EU/UK, and
  // linked from the footer on every page + from the consent banner.
  '/privacy': Privacy,
  '/cookies': Cookies,
  '/terms': Terms,
  // Legacy routes from the pre-Pro site — same page, old links keep working.
  '/insights': Pro,
  '/reviews': Pro,
};

function NotFound(): JSX.Element {
  useSeo({
    title: 'Page not found — Pierre',
    description: 'That page does not exist. Head back to the Pierre home page.',
    robots: 'noindex, follow',
  });
  return (
    <div className="mx-auto max-w-xl px-6 py-32 text-center">
      <p className="brand-title text-6xl text-gray-200">Pierre</p>
      <h1 className="mt-6 text-3xl font-bold text-gray-50">This page wandered off.</h1>
      <p className="mt-3 text-gray-400">
        The link is dead, but the timeline isn&apos;t. Let&apos;s get you back.
      </p>
      <Link
        to="/"
        className="mt-8 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-blueDeep to-brand-blue px-5 py-3 text-sm font-semibold text-white shadow-sky-glow"
      >
        Back to home
      </Link>
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
      <div className="min-h-screen bg-gray-950 text-gray-100 antialiased">
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
