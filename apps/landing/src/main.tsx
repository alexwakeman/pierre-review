import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
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

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
