import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, MiniTable, Note, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'AI agents and the sandbox',
  summary: 'Which agents can read files, which can run commands, and how the sandbox keeps your credentials out of reach.',
};

const AGENT_COLS = [
  { key: 'agent', label: 'Feature' },
  { key: 'reads', label: 'Reads' },
  { key: 'shell', label: 'Runs commands' },
  { key: 'where', label: 'Where' },
];
const AGENT_ROWS = [
  { _key: 'review', agent: 'AI Review, CI review, story checks', reads: 'The pull request and its code', shell: 'No', where: 'Your computer' },
  { _key: 'chat', agent: 'Chats, briefs, summaries', reads: 'The review, ticket or docs they are about', shell: 'No', where: 'Your computer' },
  { _key: 'fix', agent: 'AI Fix', reads: 'The repository', shell: 'Yes', where: 'The sandbox' },
  { _key: 'impl', agent: 'Implement story', reads: 'The workspace’s repositories', shell: 'Yes', where: 'The sandbox' },
];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn&rsquo;s AI reads text written by other people: pull request descriptions, comments, tickets, and the code
        itself. Any of it could try to give the AI instructions. Limn therefore treats everything an agent reads from a
        pull request or ticket as untrusted, and limits what each agent can do. Most agents can only read. The two that
        can run commands, AI Fix and Implement story, run inside a sandbox that holds none of your credentials.
      </p>
      <WhoItHelps
        developer="Let the AI run your tests without letting a stranger's pull request run commands on your laptop."
        manager="AI agents never hold the team's GitHub access, and nothing reaches GitHub until a person presses Push."
      />

      <H2 id="what-each-agent-can-do">What each agent can do</H2>
      <Illustration label="A table of Limn's AI features: reviews and chats read only, AI Fix and Implement run commands in the sandbox." caption="Only two features can run commands, and only in the sandbox.">
        <MiniTable cols={AGENT_COLS} rows={AGENT_ROWS} />
      </Illustration>
      <H3>Reviews and chats: read only</H3>
      <p>
        AI Review and every chat can read files, but cannot run commands or change anything. They read only the
        repository they were given. Their instructions tell them that text from a pull request is data, not
        instructions.
      </p>
      <H3>Codex is locked down further</H3>
      <p>
        When Codex runs a review, Limn turns off its shell, web access, images, plugins and memories, and gives it only
        Limn&rsquo;s own read-only file tools. Limn also checks that its safety check really runs before each run, and
        refuses to start if it cannot prove it. Codex uses Limn&rsquo;s own Codex folder, never yours.
      </p>

      <H2 id="the-sandbox">The sandbox</H2>
      <p>
        AI Fix and Implement story give the AI a full shell, so it can build and test the code. That shell is inside a
        container on your computer, started by your container runtime. See{' '}
        <DocLink to="settings/sandbox">Sandbox</DocLink> for its settings.
      </p>
      <ul>
        <li>
          <b>No GitHub credentials.</b> The sandbox holds no GitHub token or sign-in of any kind.
        </li>
        <li>
          <b>No AI credentials.</b> The sandbox holds only a stand-in. Limn&rsquo;s network filter puts the real Claude
          or Codex credential on the request as it leaves, so the AI cannot read it.
        </li>
        <li>
          <b>No way out but Limn&rsquo;s network filter.</b> The sandbox can reach only the hosts allowed for it. Every
          request shows in the session&rsquo;s <Ui>Network</Ui> list, and a blocked host opens only when you press{' '}
          <Ui>Allow for this session</Ui> or <Ui>Always allow</Ui>. Local, cloud metadata and other reserved addresses are
          always refused.
        </li>
        <li>
          <b>No way into your computer.</b> No folder of yours is writable from the sandbox, and it has no access to
          your container runtime. It runs as an ordinary user with limits on CPU, memory and processes.
        </li>
        <li>
          <b>Services are checked.</b> A compose file that asks for privileged mode, extra rights, host folders or the
          container runtime is refused.
        </li>
        <li>
          <b>Your notes, copied.</b> Only the Claude notes and skills you tick are copied in. Past AI sessions are never
          copied in.
        </li>
      </ul>

      <H2 id="how-work-leaves">How work leaves the sandbox</H2>
      <p>
        Work leaves only as a patch for each repository. Limn checks it on your computer, then pushes it with your
        GitHub access when you press <Ui>Push</Ui>:
      </p>
      <ul>
        <li>AI Fix pushes only to the pull request&rsquo;s own branch, and never forces a push.</li>
        <li>Implement story pushes a new branch and opens a draft pull request by default.</li>
        <li>
          A merge made in the sandbox is checked and rebuilt by Limn before it is pushed: the AI&rsquo;s own commits are
          never sent.
        </li>
      </ul>
      <p>
        The only pushes without a press are the ones you switch on: <Ui>Push automatically</Ui> for an auto fix on your
        own pull request, and dependency automation for a trusted bot&rsquo;s pull request. Both are off by default.
      </p>
      <Warning>
        On Linux with Docker, the sandbox shares your computer&rsquo;s kernel. On a Mac or on Windows, the container
        runtime adds a virtual machine as a second wall. Allow only the hosts a build needs.
      </Warning>
      <Note>
        Sandboxes are labelled and removed when you discard a session and when Limn starts. Run{' '}
        <code>limn sandbox prune</code> with Limn stopped to remove any that are left.
      </Note>
    </>
  );
}
