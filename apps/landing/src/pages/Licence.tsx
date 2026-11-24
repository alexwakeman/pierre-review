import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Link } from '../router';
import { SITE_NAME } from '../lib/site';
import { useReveal } from '../components/board/useReveal';
import './contact.css';

// ---------------------------------------------------------------------------
// Activate a licence: the licence key Polar emailed the buyer in, a signed Ensemble licence key
// out (apps/site licence.ts, POST /api/licence/activate; docs/LICENSING.md).
//
// The ONE network step of licensing happens here, in the buyer's browser, on our site, when they
// choose. The app itself only ever checks the signed key offline (Settings → Licence), so "the app
// sends nothing to us" stays true.
//
// Reuses the contact page's board layout and form styles (./contact.css, `.lb.contact`).
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'sending' | 'done';

export default function Licence(): JSX.Element {
  useSeo(seoFor('/licence'));
  const ref = useReveal<HTMLDivElement>();
  const [polarKey, setPolarKey] = useState('');
  const [organisation, setOrganisation] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ key: string; organisation: string; seats: number; expires: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError('');
    setPhase('sending');
    try {
      const res = await fetch('/api/licence/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ polarKey, organisation }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        key?: string;
        organisation?: string;
        seats?: number;
        expires?: string;
        message?: string;
      };
      if (!res.ok || !body.key) {
        setError(body.message ?? 'That did not work. Try again in a minute.');
        setPhase('idle');
        return;
      }
      setResult({ key: body.key, organisation: body.organisation ?? organisation, seats: body.seats ?? 0, expires: body.expires ?? '' });
      setPhase('done');
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
      setPhase('idle');
    }
  }

  async function copy(): Promise<void> {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="lb contact" ref={ref}>
      <section className="board c-head" aria-labelledby="l-h1">
        <div className="tile c-name">
          <h1 id="l-h1">Activate your licence</h1>
          <p className="c-lead">
            Paste the licence key from your purchase email. You get an {SITE_NAME} licence key to paste into the app, under
            Settings → Licence. The app checks it on your computer and never contacts us.
          </p>
        </div>
      </section>

      <section className="section board c-main" aria-label="Activate">
        <div className="tile c-formtile rise">
          {phase === 'done' && result ? (
            <div className="c-form">
              <h2>Your {SITE_NAME} licence key</h2>
              <p>
                {result.organisation}: up to {result.seats} people, valid through {result.expires}.
              </p>
              <textarea className="c-input c-area" readOnly value={result.key} rows={5} aria-label="Licence key" />
              <p className="btns">
                <button type="button" className="btn" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy the key'}
                </button>
              </p>
              <p>
                In {SITE_NAME}, open Settings → Licence, paste the key and press Save. Each person in your organisation
                pastes the same key.
              </p>
            </div>
          ) : (
            <form className="c-form" onSubmit={(e) => void submit(e)}>
              <div className="c-field">
                <label htmlFor="licence-polar-key">Licence key from your purchase email</label>
                <input
                  id="licence-polar-key"
                  className="c-input"
                  required
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  value={polarKey}
                  onChange={(e) => setPolarKey(e.target.value)}
                />
              </div>
              <div className="c-field">
                <label htmlFor="licence-org">Your organisation&rsquo;s name</label>
                <input
                  id="licence-org"
                  className="c-input"
                  required
                  maxLength={120}
                  autoComplete="organization"
                  value={organisation}
                  onChange={(e) => setOrganisation(e.target.value)}
                />
                <p className="c-hint">It appears in the app beside the licence.</p>
              </div>
              {error && (
                <p role="alert" className="c-error">
                  {error}
                </p>
              )}
              <noscript>
                <p className="c-note">This page needs JavaScript. Without it, ask through the contact form.</p>
              </noscript>
              <button type="submit" className="btn c-send" disabled={phase === 'sending'}>
                {phase === 'sending' ? 'Checking…' : 'Get my licence key'}
              </button>
            </form>
          )}
        </div>
        <div className="tile lapis c-next rise">
          <h2>Good to know</h2>
          <ul className="c-list">
            <li>We check the key with Polar, who handled your payment, then sign an {SITE_NAME} key. Nothing else is stored.</li>
            <li>A yearly licence: come back here after it renews for next year&rsquo;s key.</li>
            <li>
              Bought by invoice, or no email? <Link to="/contact?topic=licence">Ask here</Link>.
            </li>
            <li>
              Not bought yet? <Link to="/pricing">See the prices</Link>.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
