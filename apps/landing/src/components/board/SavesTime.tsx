// Where Limn saves time: six everyday review chores and what happens to each.
// Plain and practical, not a pitch. Every line is true of the code today:
// auto review re-runs once per new head (review/claude-review), auto-post is a
// per-workspace switch, CI failures are diagnosed by the CI review and fixed by
// AI Fix, thread judgements come from Check threads, Pending ranks by turn.

const ITEMS: { chore: string; now: string }[] = [
  {
    chore: 'Pasting diffs into Claude',
    now: 'Limn reviews each new push on its own, and can post the findings to the pull request for you.',
  },
  {
    chore: 'Re-reading the ticket',
    now: 'Each change is checked against the story’s acceptance criteria, criterion by criterion.',
  },
  {
    chore: 'Looking up the house rules',
    now: 'Findings cite the section of your own docs that the change goes against.',
  },
  {
    chore: 'Digging through CI logs',
    now: 'A failing check is diagnosed from its log, and AI Fix drafts the change.',
  },
  {
    chore: 'Re-reviewing after every push',
    now: 'Each new commit is reviewed once, with a note on which earlier threads it addressed.',
  },
  {
    chore: 'Working out who is waiting on whom',
    now: 'Every open pull request is ranked by whose turn it is, across every repository.',
  },
];

export function SavesTime() {
  return (
    <section className="section saves" aria-labelledby="saves-h">
      <div className="chap rise">
        <h2 id="saves-h">Time it saves you</h2>
        <p>The repetitive parts of review, done for you, so people can spend their attention on the change itself.</p>
      </div>
      <ul className="board saves-grid">
        {ITEMS.map((it, i) => (
          <li key={it.chore} className={`tile rise saves-${i % 4}`}>
            <h3>{it.chore}</h3>
            <p>{it.now}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
