// The Act chapter: three tiles (Every push / Fix 3 items / Live), then the
// four-row pull-request board. Copy is the approved mockup's, verbatim.

const ROWS: { title: string; facts: [string, string]; status: string; tone?: 'bad' | 'you' | 'ready' }[] = [
  { title: '#612 Partial refunds', facts: ['2 major findings', 'fix ready'], status: 'Fix ready', tone: 'bad' },
  { title: '#1190 Settings split', facts: ['asked 26h ago', '+420 −88'], status: 'Your review', tone: 'you' },
  { title: '#482 Retry budget', facts: ['2 approvals', 'checks green'], status: 'Merge', tone: 'ready' },
  { title: '#479 Legacy auth', facts: ['3 threads', '2d'], status: 'Stalled' },
];

export function Act() {
  return (
    <section id="act" className="section" aria-labelledby="a-h">
      <div className="chap rise">
        <h2 id="a-h">
          <span className="tag" style={{ background: 'var(--madder)' }}></span>Act
        </h2>
        <p>Limn reviews every push, posts the findings to GitHub and fixes what it can. Merging stays with you.</p>
      </div>
      <div className="board act">
        <div className="tile madder a-auto rise" data-ui>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <span className="big-ui">Every push</span>
            <span className="toggle" role="img" aria-label="On"></span>
          </div>
          <div className="cap">
            <b>Review on autopilot</b>
            <span>No more pasting diffs into a chat window. Limn runs the review and posts it to the pull request.</span>
          </div>
        </div>
        <div className="tile gold a-fix rise" data-ui>
          <div className="big-ui">Fix 3 items</div>
          <div className="cap">
            <b>AI Fix</b>
            <span>Fixes the findings and failing CI on your branch.</span>
          </div>
        </div>
        <div className="tile lapis a-ci rise" data-ui>
          <div className="big-ui">Live</div>
          <div className="cap">
            <b>Watched in real time</b>
            <span>Checks, threads and merge state, refreshed as they change.</span>
          </div>
        </div>
      </div>
      <div className="dep" data-ui>
        {ROWS.map((r) => (
          <div className="row rise" key={r.title}>
            <span>{r.title}</span>
            <span className="f">{r.facts[0]}</span>
            <span className="f">{r.facts[1]}</span>
            <span className={r.tone ? `st ${r.tone}` : 'st'}>{r.status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
