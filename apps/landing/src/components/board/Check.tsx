// The Check chapter: worked examples against a story and the docs, the design
// diagram, the bot-scoring tile and the review-bot cost table. Copy is FINAL —
// it matches .taste-skill/mockup/index.html word for word.

import hoursLeaf from '../../assets/board/img/hours-leaf.jpg';
import scholar from '../../assets/board/img/scholar.jpg';

export function Check() {
  return (
    <section id="check" className="section" aria-labelledby="c-h">
      <div className="chap rise">
        <h2 id="c-h">
          <span className="tag" style={{ background: 'var(--verdigris)' }} />
          Check
        </h2>
        <p>Claude reads each pull request against its story and your own docs, and says which one it broke.</p>
      </div>
      <div className="board ex">
        <div className="tile verdigris ex-story rise" data-ui="">
          <div className="ui-k">Checked against the story · PAY-142 Partial refunds</div>
          <div className="fl">
            <div className="ui-row">
              <span className="sev">Major</span>
              <span>
                <b>Criterion 3 not met.</b> Refunds older than 30 days still go through: <code>RefundPolicy.allows()</code>{' '}
                never reads <code>order.paid_at</code>.
              </span>
            </div>
            <div className="ui-row">
              <span className="sev mi">Minor</span>
              <span>
                <b>Criterion 2 at risk.</b> A retried refund sends the customer a second email; the send is not idempotent.
              </span>
            </div>
            <div className="ui-row">
              <span className="sev ok">Met</span>
              <span>
                <b>Criteria 1 and 4.</b> Partial refunds keep the order open and reach the daily ledger.
              </span>
            </div>
          </div>
        </div>
        <div className="tile ph ex-pic rise">
          <img src={hoursLeaf} width={800} height={1018} alt="A page from a Book of Hours, around 1500" loading="lazy" />
        </div>
        <div className="tile ph ex-pic rise">
          <img src={scholar} width={800} height={919} alt="Jacques de Guyse reading at his desk among his books, around 1500" loading="lazy" />
        </div>
        <div className="tile lapis ex-docs rise" data-ui="">
          <div className="ui-k">Checked against your docs · Payments handbook</div>
          <div className="fl">
            <div className="ui-row">
              <span className="sev">Major</span>
              <span>
                <b>§4.2 Money.</b> <code>amount</code> is stored as a float. The handbook says whole pence, in an integer column.
              </span>
            </div>
            <div className="ui-row">
              <span className="sev mi">Minor</span>
              <span>
                <b>§7.1 Retries.</b> The refund worker retries forever. The handbook caps it at five tries with backoff.
              </span>
            </div>
          </div>
          <p className="ex-note">Your docs are a library you build in Limn from your own pages. Every finding cites the section.</p>
        </div>
      </div>
      <div className="board dg" style={{ marginTop: 'var(--gap)' }}>
        <div className="tile t-dia rise" data-ui="">
          <div className="ui-k" style={{ marginBottom: 14 }}>Design diagram · #612</div>
          <svg
            viewBox="0 0 800 372"
            role="img"
            aria-label="The refund API calls RefundPolicy, which this pull request changes, then the Ledger; a new refund worker calls Email"
          >
            <g fontFamily="Albert Sans" fontSize="18" fill="#f1f1ef">
              <rect x="10" y="20" width="210" height="116" fill="#24252a" />
              <text x="30" y="58">POST /refunds</text>
              <text x="30" y="82" fill="#a9a69f" fontSize="14">unchanged</text>
              <text x="30" y="112" fill="#8f8c86" fontSize="13" fontFamily="ui-monospace, Menlo, monospace">api/refunds.py:41</text>
              <rect x="300" y="20" width="220" height="116" fill="#3f8271" />
              <text x="320" y="58">RefundPolicy</text>
              <text x="320" y="82" fill="#d9efe8" fontSize="14">changed: 30-day window</text>
              <text x="320" y="112" fill="#bfe3d8" fontSize="13" fontFamily="ui-monospace, Menlo, monospace">refunds/policy.py:18–52</text>
              <rect x="600" y="20" width="190" height="116" fill="#24252a" />
              <text x="620" y="58">Ledger</text>
              <text x="620" y="82" fill="#a9a69f" fontSize="14">unchanged</text>
              <text x="620" y="112" fill="#8f8c86" fontSize="13" fontFamily="ui-monospace, Menlo, monospace">ledger/post.py:88</text>
              <rect x="300" y="236" width="220" height="116" fill="#8a5a66" />
              <text x="320" y="274">refund_worker</text>
              <text x="320" y="298" fill="#ecd8dc" fontSize="14">new</text>
              <text x="320" y="328" fill="#e2c6cc" fontSize="13" fontFamily="ui-monospace, Menlo, monospace">workers/refund_worker.py</text>
              <rect x="600" y="236" width="190" height="116" fill="#24252a" />
              <text x="620" y="274">Email</text>
              <text x="620" y="298" fill="#a9a69f" fontSize="14">unchanged</text>
              <text x="620" y="328" fill="#8f8c86" fontSize="13" fontFamily="ui-monospace, Menlo, monospace">notify/email.py:12</text>
              <path d="M220 78h72M520 78h72M410 136v92M520 294h72" stroke="#a9a69f" strokeWidth="3" fill="none" />
              <path d="M292 72l8 6-8 6zM592 72l8 6-8 6zM404 220l6 8 6-8zM592 288l8 6-8 6z" fill="#a9a69f" />
            </g>
          </svg>
        </div>
        <div className="tile t-txt rise">
          <h3>See what it changes</h3>
          <p>Claude draws the parts a pull request touches. For a story, one drawing across all its pull requests.</p>
          <p>Limn draws one for every review, made for that change. Each part cites the files behind it, so you can follow the key ideas straight to the code.</p>
        </div>
      </div>
    </section>
  );
}
