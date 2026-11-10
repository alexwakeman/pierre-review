import type { DocMeta } from '../../types';
import { ExtLink, H2, H3, MiniTable, Note, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'The Limn License',
  summary: 'Free for individuals and for organisations where no more than three people use Limn. Above that, ask for a licence.',
};

const LICENSE_URL = 'https://github.com/alexwakeman/pierre-review/blob/main/LICENSE';

const WHO_COLS = [
  { key: 'who', label: 'Who' },
  { key: 'free', label: 'Free?' },
];
const WHO_ROWS = [
  { _key: 'me', who: 'You, for yourself (a side project, your own repositories, learning)', free: 'Yes' },
  { _key: 'small', who: 'An organisation where 1, 2 or 3 people use Limn', free: 'Yes' },
  { _key: 'big', who: 'An organisation where 4 or more people use Limn', free: 'Needs a commercial licence' },
  { _key: 'compete', who: 'Offering Limn, or something like it, to others as a commercial product or service', free: 'Not allowed' },
];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn is released under the Limn License 1.0. Every feature is included for everyone the licence covers: there
        are no locked features and no trial. This page explains the licence in plain English. The licence text itself is
        what counts; read it in full in the <code>LICENSE</code> file that comes with Limn, or{' '}
        <ExtLink href={LICENSE_URL}>on GitHub</ExtLink>.
      </p>
      <Note>This page is a summary, not legal advice.</Note>

      <H2 id="who-can-use-it-free">Who can use it free</H2>
      <MiniTable cols={WHO_COLS} rows={WHO_ROWS} />

      <H2 id="how-to-count">How to count people</H2>
      <ul>
        <li>
          Count the people who <b>use</b> Limn for the organisation&rsquo;s work: anyone who runs it, or works with it
          directly, in the course of their work. A colleague who only sees a comment Limn posted on GitHub does not use
          it.
        </li>
        <li>
          Count the organisation <b>together with its affiliates</b>: companies that control it, that it controls, or
          that are under the same control. Three people in each of two sister companies is six.
        </li>
        <li>
          An organisation includes a company, a partnership, a charity, a government body, or any team or group of
          people working together.
        </li>
      </ul>

      <H2 id="commercial-licence">A commercial licence</H2>
      <p>
        If more than three people in your organisation use Limn, you need a separate commercial licence from the
        licensor. Ask for one through the <a className="dx-link" href="/contact">contact form</a>.
      </p>

      <H2 id="what-you-may-do">What you may do</H2>
      <H3>Use it</H3>
      <p>For any permitted purpose above, you may use Limn in any way.</p>
      <H3>Change it</H3>
      <p>You may change Limn and build on it for a permitted purpose.</p>
      <H3>Share it</H3>
      <p>
        You may give copies to others, changed or not. Anyone who gets a copy from you must also get the licence terms
        and the copyright notice, and a changed copy must say clearly that you changed it.
      </p>

      <H2 id="what-you-may-not-do">What you may not do</H2>
      <Warning title="No competing use">
        You may not offer Limn, or any product or service substantially like it or built from it, to others as a
        commercial product or service: as software to install, as a hosted service or in any other form.
      </Warning>
      <ul>
        <li>You may not pass your licence on to someone else, or sublicense it.</li>
        <li>The licence will not turn into MIT or any other licence with the passing of time.</li>
      </ul>

      <H2 id="other-terms">Other terms</H2>
      <ul>
        <li>
          <b>Patents:</b> the licence includes a patent licence for permitted use. It ends if you claim in writing that
          Limn infringes a patent.
        </li>
        <li>
          <b>Breaking the terms:</b> the first time you are told in writing that you broke the terms, you keep your
          licence if you put things right within 32 days.
        </li>
        <li>
          <b>No warranty:</b> Limn comes as is, and the licensor is not liable for damages, as far as the law allows.
        </li>
        <li>
          <b>Fair use:</b> the licence does not limit any fair-use rights you have under the law.
        </li>
      </ul>

      <H2 id="third-party-terms">Other people&rsquo;s terms</H2>
      <p>
        The licence covers Limn only. The AI programs Limn downloads come from Anthropic and OpenAI under their own
        terms, and your use of Claude, ChatGPT, GitHub and any tracker stays under your agreement with each of them.
      </p>
    </>
  );
}
