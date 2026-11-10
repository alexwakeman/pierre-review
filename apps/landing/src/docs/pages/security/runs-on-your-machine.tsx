import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, MiniTable, Note, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Limn runs on your computer',
  summary: 'There is no Limn server and no account. What that means for your code and your data.',
};

const PARTS_COLS = [
  { key: 'part', label: 'Part' },
  { key: 'where', label: 'Where it runs' },
];
const PARTS_ROWS = [
  { _key: 'app', part: 'The app you use in the browser', where: 'Your computer, at localhost' },
  { _key: 'server', part: 'The program that syncs and stores', where: 'Your computer, one process' },
  { _key: 'db', part: 'The database', where: 'A file in the ~/.limn folder' },
  { _key: 'gh', part: 'Access to GitHub', where: 'Your own gh sign-in' },
  { _key: 'ai', part: 'The AI', where: 'Your own Claude or Codex account' },
];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn is one program that runs on your own computer. You start it with <code>npx limn-review</code>, it opens
        the app in your browser, and it stops when you stop it. There is no Limn server, no Limn account and no
        sign-in to Limn. Your code, your pull requests and Limn&rsquo;s view of them stay on your computer, apart from
        what Limn sends to the services you connect, which this section lists.
      </p>

      <H2 id="what-runs-where">What runs where</H2>
      <Illustration label="A table of Limn's parts and where each runs: all on your computer, using your own GitHub and AI accounts." caption="Every part runs on your computer.">
        <MiniTable cols={PARTS_COLS} rows={PARTS_ROWS} />
      </Illustration>
      <ul>
        <li>
          The app is served by Limn itself at <code>http://localhost:4000</code> (or the port you choose with{' '}
          <code>--port</code>). Only your own computer can reach it. See{' '}
          <DocLink to="security/browser-and-network">Browser and network protections</DocLink>.
        </li>
        <li>
          Limn reads GitHub with the GitHub CLI&rsquo;s sign-in (<code>gh auth login</code>). It stores no GitHub
          credentials. See <DocLink to="security/github-access">GitHub access</DocLink>.
        </li>
        <li>
          The AI runs on your own Claude Code login, Anthropic API key or ChatGPT sign-in. See{' '}
          <DocLink to="settings/ai-usage-and-spend">AI subscription usage and spend</DocLink>.
        </li>
        <li>
          Everything Limn keeps is in one folder, <code>~/.limn</code>. See{' '}
          <DocLink to="security/data-and-storage">What Limn stores</DocLink>.
        </li>
      </ul>

      <H2 id="what-limn-does-not-do">What Limn does not do</H2>
      <ul>
        <li>It sends nothing to Limn&rsquo;s author: no analytics, no usage reports, no crash reports.</li>
        <li>The app loads no third-party scripts or fonts.</li>
        <li>It has no hosted copy of your data, so there is nothing to breach on a Limn server.</li>
        <li>It does not run in the background when you stop it. Syncing, auto review and automation happen only while Limn is running.</li>
      </ul>
      <Note>
        The website at limn-review.com, where you are reading this, is separate from the app. The website may use
        analytics with your consent; the app never does.
      </Note>

      <H2 id="each-person-runs-their-own">Each person runs their own</H2>
      <p>
        On a team, each person runs Limn on their own computer, with their own GitHub and AI access. Limn copies do not
        talk to each other. Where teammates&rsquo; Limns need to agree (who is reviewing a commit, who is fixing a
        dependency update), they use small status lines on GitHub, such as <Ui>limn/review-claude</Ui>. See{' '}
        <DocLink to="ai-review/team-reviews">Reviewing as a team</DocLink>.
      </p>
      <p>
        Because each Limn acts as its owner, anything it posts or pushes shows on GitHub under that person&rsquo;s
        name.
      </p>
    </>
  );
}
