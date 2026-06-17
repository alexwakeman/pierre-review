import { useEffect } from 'react';
import { Link, useRoute } from './router';
import { trackPageView } from './lib/analytics';
import { useSeo } from './lib/seo';
import Nav from './components/Nav';
import Footer from './components/Footer';
import Home from './pages/Home';
import Features from './pages/Features';
import Insights from './pages/Insights';
import Reviews from './pages/Reviews';
import HowItWorks from './pages/HowItWorks';

const ROUTES: Record<string, () => JSX.Element> = {
  '/': Home,
  '/features': Features,
  '/insights': Insights,
  '/reviews': Reviews,
  '/how-it-works': HowItWorks,
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

  useEffect(() => {
    trackPageView(path);
  }, [path]);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 antialiased">
      <Nav />
      <main>
        <Page />
      </main>
      <Footer />
    </div>
  );
}
