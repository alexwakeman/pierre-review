import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Note, Steps, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'GitHub access',
  summary: 'Limn uses your gh sign-in and stores no GitHub credentials. What it can and cannot do with them.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn reaches GitHub with the GitHub CLI (<code>gh</code>) sign-in you already have. It asks <code>gh</code> for
        your token when it needs one, holds it in memory for a few minutes, and never writes it to disk. So Limn can
        see and do exactly what you can, and no more. This page explains what that means and how Limn keeps the
        token out of harm&rsquo;s way.
      </p>

      <H2 id="sign-in">Sign in</H2>
      <Steps>
        <li>
          Install the GitHub CLI from <code>cli.github.com</code>.
        </li>
        <li>
          Run <code>gh auth login</code> and follow the prompts.
        </li>
        <li>
          Start Limn. If <code>gh</code> is missing or not signed in, Limn stops at once with{' '}
          <Ui>GitHub CLI not found or not authenticated.</Ui>
        </li>
      </Steps>
      <p>
        To use a different GitHub account, sign <code>gh</code> in to it and restart Limn. To stop Limn reaching
        GitHub at all, run <code>gh auth logout</code>.
      </p>

      <H2 id="what-limn-reads">What Limn reads</H2>
      <p>
        Limn reads the repositories you add: pull requests, reviews, comments, threads, commits, checks and the
        default branch&rsquo;s status. It reads other repositories only when you add them. When an AI run or the
        conflict resolver needs code, Limn keeps its own copy of the repository in <code>~/.limn</code>. It never uses
        or changes your own clones.
      </p>
      <Note title="GitHub's rate limits">
        GitHub limits how much any account may ask for in an hour. Limn watches the limit and slows down before it is
        reached, so you see a repository marked as paused for a while rather than errors. A large first sync can take
        some time for this reason.
      </Note>

      <H2 id="what-limn-writes">What Limn writes</H2>
      <p>
        Limn writes to GitHub only as you, with your token, and only when you press a button, except for the
        automatic switches you turn on yourself:
      </p>
      <ul>
        <li>
          <b>When you press:</b> replies, comments, reviews and approvals; resolving threads; merging; updating a
          branch; pushing an AI Fix, a resolved conflict or an Implement branch.
        </li>
        <li>
          <b>Only if you switch it on:</b> posting auto reviews, auto merge (&ldquo;merge when ready&rdquo;), dependency
          automation, pushing auto fixes, and resolving Limn&rsquo;s own threads once fixed.
        </li>
      </ul>
      <p>
        Every comment Limn posts carries a hidden marker, so Limn can always tell its own posts from yours. When
        teammates run Limn, small <Ui>limn/</Ui> status lines on a commit say who is handling it; they are not CI.
      </p>
      <Warning>
        Anything Limn posts appears on GitHub under your name. Read <DocLink to="settings/ai-review#posting">AI review
        settings</DocLink> and <DocLink to="settings/dependencies">Dependencies settings</DocLink> before you turn on
        automatic posting or merging.
      </Warning>

      <H2 id="how-the-token-is-kept-safe">How the token is kept safe</H2>
      <H3>Never on disk</H3>
      <p>
        The token is not stored in Limn&rsquo;s database or settings. When Limn copies a repository, it passes the token
        to git for that one command only; it is never saved in the copy&rsquo;s settings.
      </p>
      <H3>Never in the browser</H3>
      <p>
        The app in your browser never receives your token. Links that GitHub signs for a short time, such as CI log
        downloads, are read by Limn and never handed to the browser.
      </p>
      <H3>Never in the sandbox</H3>
      <p>
        AI Fix and Implement run the AI in a sandbox that holds no GitHub credentials at all. Their work leaves as a
        patch, and Limn pushes it with your token on your press. See{' '}
        <DocLink to="security/ai-and-the-sandbox">AI agents and the sandbox</DocLink>.
      </p>
      <H3>Never in logs</H3>
      <p>Limn removes sign-in headers from everything it writes to its log.</p>
    </>
  );
}
