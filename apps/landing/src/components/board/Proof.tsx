// The measured result, as three figures and the line that says where they come
// from. The same facts as the Reporting page's Chronology proof; change both.
// A before → after figure draws an arrow from the old value to the outcome.

/** The arrow between a figure's before and after: drawn, never read (the hidden "to" is). */
function Arrow(): JSX.Element {
  return (
    <svg className="arrow" viewBox="0 0 40 16" aria-hidden="true" focusable="false">
      <path d="M2 8h32M28 2l7 6-7 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Proof(): JSX.Element {
  return (
    <section className="proof" aria-labelledby="proof-h">
      <h2 id="proof-h" className="vh">
        Results
      </h2>
      <div className="board">
        <div className="tile verdigris rise">
          <p className="n">
            <s>
              <span className="vh">From </span>7 h
            </s>
            <Arrow />
            <span className="vh"> to </span>42 min
          </p>
          <p>Half of pull requests merged within this much working time.</p>
        </div>
        <div className="tile lapis rise">
          <p className="n">
            <s>
              <span className="vh">From </span>20
            </s>
            <Arrow />
            <span className="vh"> to </span>44
          </p>
          <p>Pull requests merged per week.</p>
        </div>
        <div className="tile madder rise">
          <p className="n">$0</p>
          <p>Extra spend. It ran on the AI plans the team already had.</p>
        </div>
      </div>
      <p className="src">
        A nine-repository delivery team, September vs October 2026 after Limn auto-review introduced. Measured by Limn's Chronology report.
      </p>
    </section>
  );
}
