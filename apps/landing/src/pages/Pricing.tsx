import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Link } from '../router';
import { FREE_TEAM_SIZE, INSTALL_COMMAND, LICENSE_URL, SITE_NAME } from '../lib/site';
import {
  LARGEST_BAND,
  LICENCE_BANDS,
  VENDOR_LEGAL_LINE,
  bandHref,
  bandLabel,
  formatGbp,
} from '../lib/licence';
import { useReveal } from '../components/board/useReveal';
import { CopyCommand } from '../components/board/CopyCommand';
import './pricing.css';

// ---------------------------------------------------------------------------
// Pricing — what an organisation pays, and how it buys.
//
// The prices come from lib/licence.ts and nowhere else. A band whose Polar checkout
// is not set up yet sends the buyer to the contact form instead, so no button leads
// nowhere. The one thing a licence does NOT include, the reader's own AI usage, is said
// on the page, not left for them to find.
//
// Drawn in the board style (src/board.css); page-only layout in ./pricing.css, scoped
// under `.lb.pricing`.
// ---------------------------------------------------------------------------

export default function Pricing(): JSX.Element {
  useSeo(seoFor('/pricing'));
  const ref = useReveal<HTMLDivElement>();
  const canBuyOnline = LICENCE_BANDS.some((b) => b.checkoutUrl !== '');

  return (
    <div className="lb pricing" ref={ref}>
      <section className="board p-head" aria-labelledby="p-h1">
        <div className="tile p-name">
          <h1 id="p-h1">
            Free for up to {FREE_TEAM_SIZE} people. One licence for the organisation above that.
          </h1>
          <p className="p-lead">
            Every feature is in the free version. An organisation where more than {FREE_TEAM_SIZE} people
            use {SITE_NAME} buys one licence a year, priced by how many people use it.
          </p>
        </div>
      </section>

      <section className="section board p-bands" aria-label="Prices">
        <div className="tile gold rise">
          <p className="k">Up to {FREE_TEAM_SIZE} people</p>
          <h2>Free</h2>
          <ul>
            <li>Every feature</li>
            <li>No account, no card</li>
          </ul>
          <p className="cmd">
            <CopyCommand label={`Copy ${INSTALL_COMMAND}`} />
          </p>
        </div>
        {LICENCE_BANDS.map((band, i) => (
          <div key={band.upTo} className="tile lapis rise">
            <p className="k">{bandLabel(i)}</p>
            <h2>
              {formatGbp(band.priceGbp)}
              <span className="per"> a year</span>
            </h2>
            <ul>
              <li>Plus VAT where it applies</li>
              <li>The same app, every feature</li>
            </ul>
            <p className="cmd">
              {band.checkoutUrl !== '' ? (
                <a className="btn alt" href={bandHref(i)}>
                  Buy this licence
                </a>
              ) : (
                <Link className="btn alt" to={bandHref(i)}>
                  Ask for this licence
                </Link>
              )}
            </p>
          </div>
        ))}
        <div className="tile madder p-more rise">
          <p className="k">More than {LARGEST_BAND} people</p>
          <h2>Ask</h2>
          <p>
            Send a message with how many people use {SITE_NAME}, and the reply gives a price.{' '}
            <Link to="/contact?topic=licence">Contact</Link>.
          </p>
        </div>
      </section>

      <section className="section board p-facts" aria-label="What a licence covers">
        <div className="tile rise">
          <h2>What you pay for</h2>
          <ul className="p-list">
            <li>A written licence for the organisation and its affiliates, for one year.</li>
            <li>An invoice your finance team can file.</li>
            <li>Answers by email from the person who builds {SITE_NAME}, within two working days.</li>
          </ul>
        </div>
        <div className="tile verdigris rise">
          <h2>What it does not include</h2>
          <p>
            Your AI usage. Reviews, fixes and builds run on your own Anthropic or OpenAI account, and the
            provider bills you for them as usual. {SITE_NAME} shows what each run cost.
          </p>
        </div>
        <div className="tile rise">
          <h2>How to count people</h2>
          <ul className="p-list">
            <li>
              Count everyone who runs {SITE_NAME}, or works with it directly, for the organisation&rsquo;s work.
              A colleague who only sees a comment it posted on GitHub does not count.
            </li>
            <li>Count the organisation together with its affiliates.</li>
            <li>You state the number when you buy. If it grows into the next band, move up at renewal.</li>
          </ul>
          <p>
            The <a href={LICENSE_URL}>Ensemble License</a> is the full text.
          </p>
        </div>
      </section>

      <section className="section board p-vendor" aria-label="Who you buy from">
        <div className="tile rise">
          <h2>Who you buy from</h2>
          <p>
            {VENDOR_LEGAL_LINE}
            {canBuyOnline && <> Card payments go through Polar, which issues the invoice and handles VAT.</>}
          </p>
          <p>
            Paying by bank transfer or purchase order? <Link to="/contact?topic=licence">Ask here</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}
