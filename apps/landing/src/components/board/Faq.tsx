import { useState } from 'react';

const QUESTIONS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'What does it cost?',
    a: 'Nothing from us. Reviews run on your own AI agent — Claude Code or Codex — and Limn shows what each run used.',
  },
  {
    q: 'Do I need to install Claude or Codex?',
    a: 'No. Both work out of the box: Limn downloads them the first time it starts. You only sign in.',
  },
  {
    q: 'Does my code leave my machine?',
    a: 'No. Everything lives in SQLite on your disk. Your AI agent sees code only when a review runs.',
  },
  {
    q: 'Will it post to GitHub for me?',
    a: 'Yes, once you switch on auto-posting for a workspace. It posts one review to the pull request.',
  },
  {
    q: 'Can I keep my review bots?',
    a: "Yes. Limn reads their comments and ranks them beside your own AI agent's.",
  },
  {
    q: 'GitHub Enterprise?',
    a: 'Enterprise Cloud on github.com, yes. Self-hosted Enterprise Server, not yet.',
  },
];

/**
 * "Questions": hover, click or focus a question to show its answer in p.ans (the
 * sticky right column on desktop, below the list on phones, as in the mockup).
 * Every answer is in the markup (hidden until selected), so the prerendered HTML
 * carries them all. No live region: hovering must not make a screen reader read
 * each answer out; a question's button says it is expanded and controls its answer.
 */
export function Faq(): JSX.Element {
  const [sel, setSel] = useState(0);

  return (
    <section className="section faq" aria-labelledby="faq-h">
      <div className="qcol">
        <h2 id="faq-h">Questions</h2>
        <ul>
          {QUESTIONS.map((item, i) => (
            <li key={item.q} className={i === sel ? 'on' : undefined}>
              <button
                type="button"
                aria-expanded={i === sel}
                aria-controls={`faq-a-${i}`}
                onMouseEnter={() => setSel(i)}
                onFocus={() => setSel(i)}
                onClick={() => setSel(i)}
              >
                {item.q}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="ans">
        {QUESTIONS.map((item, i) => (
          <p key={item.q} id={`faq-a-${i}`} hidden={i !== sel}>
            {item.a}
          </p>
        ))}
      </div>
    </section>
  );
}
