import type { DocMeta } from '../../types';
import { DocLink, H2, H3, MiniTable, Note, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Browser and network protections',
  summary: 'Why only your own browser can reach Limn, and what Limn sends over the network.',
};

const OUT_COLS = [
  { key: 'to', label: 'Sent to' },
  { key: 'what', label: 'What' },
  { key: 'when', label: 'When' },
];
const OUT_ROWS = [
  { _key: 'gh', to: 'GitHub', what: 'Reads of your repositories; the writes you press or switch on', when: 'Always, while Limn runs' },
  { _key: 'ai', to: 'Anthropic or OpenAI', what: 'Code, diffs, pull request and ticket text, docs sections for each AI run', when: 'When an AI run starts' },
  { _key: 'tracker', to: 'Jira, Linear, Notion or GitHub Issues', what: 'Reads of linked tickets; two Jira writes you press', when: 'Once a tracker is set up' },
  { _key: 'wiki', to: 'Confluence or Notion', what: 'Reads of the pages you add to Docs', when: 'When you add or refresh a document' },
  { _key: 'sonar', to: 'SonarCloud', what: 'Reads of each pull request’s findings', when: 'Once SonarCloud is set up' },
  { _key: 'slack', to: 'Slack', what: 'The digest and the event messages you switch on', when: 'Once a webhook is saved' },
  { _key: 'dl', to: 'npm, GitHub', what: 'Downloads of the AI programs, the scoring model and the sandbox image', when: 'First start, or when you press Set up' },
];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn has no sign-in of its own, so it protects itself a different way: only your own computer can reach it,
        and only Limn&rsquo;s own pages can use it. This page explains those protections in plain terms, and lists
        everything Limn sends over the network.
      </p>

      <H2 id="only-your-computer">Only your computer can reach Limn</H2>
      <H3>It listens on this computer only</H3>
      <p>
        Limn listens on your computer&rsquo;s own internal address (localhost), not on your network. Other computers on
        your Wi-Fi or office network cannot open it.
      </p>
      <H3>Other websites cannot read it</H3>
      <p>
        A web page you have open in another tab could try to talk to Limn in the background. Limn answers only pages
        served from your own computer, so another site cannot read your data. It also refuses any request from another
        site that would change something, such as posting a comment or merging.
      </p>
      <H3>Disguised addresses are refused</H3>
      <p>
        A hostile site can try to reach Limn through a web address that secretly points at your computer. Limn refuses
        any request that does not use a local address, so that trick fails too.
      </p>
      <H3>The app loads nothing from elsewhere</H3>
      <p>
        The app&rsquo;s pages run only Limn&rsquo;s own scripts and fonts, and cannot be shown inside another site.
        Images in comments are the one exception: they load from wherever their author put them, as they do on GitHub.
      </p>
      <H3>Costly actions are rate limited</H3>
      <p>
        Actions that use your AI plan or your GitHub allowance can be called only so often, so a stuck page or script
        cannot run them in a loop.
      </p>
      <Warning>
        These protections assume Limn is reached at localhost. Do not put Limn behind a tunnel, a reverse proxy or a
        shared server: it has no sign-in, so anyone who can reach it can read your data and act as you.
      </Warning>

      <H2 id="what-leaves-your-computer">What leaves your computer</H2>
      <p>Limn talks only to the services below, and only to the ones you use:</p>
      <MiniTable cols={OUT_COLS} rows={OUT_ROWS} />
      <p>
        Limn sends nothing to its author. What each AI provider does with the work it
        receives is on <DocLink to="settings/how-providers-treat-your-work">How Anthropic and OpenAI treat your work</DocLink>
        .
      </p>
      <Note>
        AI Fix and Implement sessions may also reach the hosts you allow for the sandbox, such as a package registry.
        See <DocLink to="security/ai-and-the-sandbox">AI agents and the sandbox</DocLink>.
      </Note>
    </>
  );
}
