import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadDocs } from './docs-loader';
import { isDocsPath } from './docs/routes';
import { currentPath } from './router';
import './index.css';
// The board design every page uses, plus the shared header/footer. Every rule is scoped
// under .lb / .lb-nav / .lb-foot. After index.css (Tailwind's reset) on purpose.
import './board.css';

// NOTE: analytics is deliberately NOT started here any more. It used to run at module
// load, which meant gtag.js was fetched before the page had even rendered — i.e.
// before the visitor could possibly have consented. It is now started from App's
// mount effect (and from the consent banner on first grant), and initAnalytics()
// itself refuses to run without a stored grant. See lib/analytics.ts + lib/consent.ts.

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

function start(): void {
  createRoot(rootEl!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// A docs address loads the docs chunk first, so the fresh render replaces the prerendered page
// with the same page rather than a blank one. A failed load still renders (DocsRoute retries).
if (isDocsPath(currentPath())) loadDocs().then(start, start);
else start();
