// The measured result, as three figures and the line that says where they come
// from. The same facts as the Reporting page's Chronology proof; change both.

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
            <span className="vh"> to </span>42 min
          </p>
          <p>Half of pull requests merged within this much working time.</p>
        </div>
        <div className="tile lapis rise">
          <p className="n">
            <s>
              <span className="vh">From </span>20
            </s>
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
        A nine-repository delivery team, September vs the week of 19 October 2026. Measured by Limn's Chronology report.
      </p>
    </section>
  );
}
