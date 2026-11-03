// "Questions": six tiles, every answer in the page.

const QUESTIONS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Does my code leave my machine?',
    a: 'Only to your own AI provider, as when you use it yourself.',
  },
  {
    q: 'Can I keep my review bots?',
    a: 'Yes. Limn reads them, scores them and shows what they cost.',
  },
  {
    q: 'Do I need to install Claude or Codex?',
    a: 'No. Limn sets them up. You only sign in.',
  },
  {
    q: 'What does it cost?',
    a: 'Nothing from us. Reviews run on your own Claude Code or Codex, and Limn shows what each run used.',
  },
  {
    q: 'Will it post to GitHub for me?',
    a: 'Yes, once you switch on auto-posting for a workspace. It posts one review per pull request.',
  },
  {
    q: 'GitHub Enterprise?',
    a: 'Enterprise Cloud on github.com, yes. Self-hosted Enterprise Server, not yet.',
  },
];

export function Faq(): JSX.Element {
  return (
    <section className="section chapter" aria-labelledby="faq-h">
      <div className="chap minor rise">
        <h2 id="faq-h">Questions</h2>
      </div>
      <div className="board faq">
        {QUESTIONS.map((item) => (
          <div key={item.q} className="tile rise">
            <h3>{item.q}</h3>
            <p>{item.a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
