import type { DocMeta } from '../../types';
import { DocLink, ExtLink, H2, H3, Illustration, MiniTable, Note, Steps, Thread, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'GitHub',
  summary: 'Limn reads and writes GitHub through your own gh sign-in. What it reads, what it writes and when.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        GitHub is Limn’s main source of data. Limn reads your repositories’ pull requests, reviews, comments, commits
        and checks, and keeps a copy on your computer. It does this through the GitHub CLI, <code>gh</code>, that you
        are already signed in to. Limn has no GitHub app, no sign-in of its own and no server in between, and it does
        not store your GitHub token.
      </p>

      <WhoItHelps
        developer="Use Limn with the access you already have. There is nothing to install in your organisation and nothing to ask an admin for."
        manager="Limn sees exactly what each person’s own GitHub account can see, and every write it makes is under that person’s name."
      />

      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          The GitHub CLI, from <ExtLink href="https://cli.github.com">cli.github.com</ExtLink>.
        </li>
        <li>
          A signed-in session: run <code>gh auth login</code> once in a terminal and follow the prompts.
        </li>
        <li>Read access to the repositories you add. To merge, approve, push or post, you need write access.</li>
        <li>Limn works with github.com.</li>
      </ul>
      <Steps>
        <li>
          Run <code>gh auth login</code> and choose GitHub.com.
        </li>
        <li>
          Start Limn with <code>npx limn-review</code>. It asks <code>gh</code> for your token each time it needs one.
        </li>
        <li>
          Add repositories (see <DocLink to="getting-started/add-repositories">Add repositories</DocLink>).
        </li>
      </Steps>

      <H3 id="single-sign-on">Organisations with single sign-on</H3>
      <p>
        If your organisation uses SAML single sign-on, your <code>gh</code> session must be authorised for it. Until it
        is, a banner says “Your GitHub login is not authorized for” the organisation, and its pull requests, checks and
        comments cannot be synced. Run <code>gh auth refresh</code> in a terminal and authorise the organisation. If
        that is not enough, run <code>gh auth refresh -h github.com -s read:org</code>.
      </p>

      <H2 id="what-limn-reads">What Limn reads</H2>
      <ul>
        <li>Pull requests, their reviews, review threads, comments and reactions.</li>
        <li>Commits and the files they changed, and check and status results.</li>
        <li>The default branch’s latest commits and checks, for the trunk strip.</li>
        <li>Merge state, merge queue membership and who may merge.</li>
        <li>CI job logs, read when you open them and never stored.</li>
        <li>With GitHub Issues as your tracker, the linked issues.</li>
      </ul>
      <p>
        The first sync of a repository reads about the last 14 days quickly, then fills in the last 90 days in the
        background. After that, Limn checks each repository as often as its activity calls for, and a pull request
        you have open every few seconds. Large text, such as pull request descriptions and diff hunks, is fetched
        when you open the pull request.
      </p>

      <H2 id="rate-limits">Rate limits are handled for you</H2>
      <p>
        GitHub gives each account an hourly allowance of requests. Limn plans its work around that allowance and
        slows down before it runs out, rather than failing. When a repository has to wait, the sync panel says{' '}
        <Ui>Paused — GitHub rate limit</Ui> and when it will resume. Nothing is lost; the sync carries on from where it
        stopped.
      </p>
      <Note>
        Limn shares your account’s allowance with everything else you use <code>gh</code> for. A very large first sync
        can take a while for that reason.
      </Note>

      <H2 id="what-limn-writes">What Limn writes, and when</H2>
      <p>
        Limn writes to GitHub only when you press a button, or when you have switched on an automatic action. Every
        write goes out under your own GitHub account.
      </p>
      <MiniTable
        cols={[
          { key: 'w', label: 'Write' },
          { key: 'when', label: 'When' },
        ]}
        rows={[
          { _key: 'c', w: 'Comments, replies, resolving threads, reactions', when: 'When you press the button' },
          { _key: 'r', w: 'Approve, request changes, withdraw approval', when: 'When you press, or by a dependency rule you switched on' },
          { _key: 'a', w: 'AI review findings, as one GitHub review', when: 'When you press, or by auto-posting (on by default)' },
          { _key: 'm', w: 'Merge, add to or remove from a merge queue, update branch', when: 'When you press, or for a pull request you armed' },
          { _key: 'p', w: 'Pushes from AI Fix, Implement story and the conflict resolver', when: 'When you press Push, or if you switched on automatic pushing' },
          { _key: 'o', w: 'Open a pull request', when: 'When you press, from Implement story or the conflict resolver' },
          { _key: 'x', w: 'Re-run CI jobs, request reviewers, close or reopen', when: 'When you press the button' },
          { _key: 's', w: 'limn/ commit statuses', when: 'With Mark auto reviews on GitHub (on by default), to tell teammates’ Limn a review is under way' },
        ]}
      />
      <Warning title="Do not make limn/ statuses required">
        The <code>limn/review-claude</code>, <code>limn/review-codex</code> and <code>limn/deps</code> statuses are not
        CI. Limn leaves them out of every check count. If you make one a required check in branch protection, a status
        that is still pending blocks merges.
      </Warning>

      <H2 id="the-limn-bot">How Limn’s own actions are shown</H2>
      <p>
        On GitHub, Limn’s posts appear under your name, with a hidden marker so every copy of Limn can recognise them.
        Inside Limn they are shown as a bot that acts for you, “Limn · your login”, so they are never mistaken for
        your own words. A teammate’s Limn is named too, for example “Robin’s Limn: addressed”.
      </p>
      <Illustration
        label="A review thread with a finding from Limn acting for Alex, marked as a bot"
        caption="Inside Limn, a finding Limn posted for you is a bot comment."
      >
        <Thread
          file="refunds/policy.py:41"
          comments={[
            {
              who: 'Limn · alex',
              bot: true,
              when: '1h',
              text: 'Major: RefundPolicy.allows() never reads paid_at, so refunds after 30 days still go through.',
            },
          ]}
        />
      </Illustration>
      <p>
        Because of this, Limn’s actions never count as yours anywhere in Limn. They do not take your turn on Pending,
        they are not your replies in thread states, and they are counted under <Ui>Limn</Ui> in Reports.
      </p>

      <H2 id="turn-it-off">Remove access</H2>
      <p>
        To stop Limn reading GitHub, stop Limn, or sign <code>gh</code> out with <code>gh auth logout</code>. To remove
        a repository, remove it in Limn; its stored data is deleted. For how Limn stores and protects what it reads,
        see <DocLink to="security/github-access">GitHub access</DocLink>.
      </p>
    </>
  );
}
