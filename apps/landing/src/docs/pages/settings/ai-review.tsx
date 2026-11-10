import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, Steps, Toggle, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'AI review settings',
  summary: 'Auto review and related repositories for each workspace.',
};

function AutoReviewPicture(): JSX.Element {
  return (
    <Illustration
      label="The Auto review settings: Review new PRs automatically on, Mark auto reviews on GitHub on, Post to GitHub chosen."
      caption="The first rows of Auto review for one workspace."
    >
      <SettingsRow label="Review new PRs automatically" hint="Only PRs opened after you turn this on." control={<Toggle on />} />
      <SettingsRow label="Mark auto reviews on GitHub" hint="For teams where more than one person runs Limn." control={<Toggle on />} />
      <SettingsRow label="Auto reviews use" control={<Pill tone="blue">Claude + Codex</Pill>} />
      <SettingsRow label="When an auto review finishes" control={<Pill tone="blue">Post to GitHub</Pill>} />
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>AI review</Ui> tab holds two settings for the current workspace: <Ui>Auto review</Ui>, which reviews
        new pull requests without anyone pressing a button, and <Ui>Related repos</Ui>, which lets a review read code
        in the repositories a change depends on. Each workspace has its own settings. What a review does is explained
        in <DocLink to="ai-review/overview">AI review</DocLink>; this page lists the switches.
      </p>
      <WhoItHelps
        developer="Get a first review on every pull request you open before a teammate looks, and decide exactly what Limn may post for you."
        manager="Turn on a consistent first-pass review for the whole workspace, with a daily cap and clear approval rules."
      />

      <H2 id="auto-review">Auto review</H2>
      <p>
        When <Ui>Review new PRs automatically</Ui> is on, Limn reviews each new pull request a person
        opens in this workspace, with the provider chosen under <Ui>Auto reviews use</Ui>. It is off until you turn it on.
      </p>
      <AutoReviewPicture />
      <ul>
        <li>Only pull requests a person opens after you turn it on are reviewed. Pull requests opened by bots are skipped.</li>
        <li>Drafts wait until they are marked ready.</li>
        <li>
          A reviewed pull request is reviewed again when new commits are pushed, or when a person or a review bot adds
          review comments. Limn&rsquo;s own comments never start a review. Pushes and comments that arrive close
          together wait until the pull request has been quiet for 5 minutes (20 minutes at most).
        </li>
        <li>
          Re-reviews count towards the daily limit, <Ui>auto reviews a day (UTC)</Ui>: 20 unless you change it (1 to
          500). The rest wait for the next day. Reviews you start yourself are not limited.
        </li>
      </ul>
      <p>
        More on how auto review decides when to run: <DocLink to="ai-review/auto-review">Auto review</DocLink>.
      </p>

      <H3>Mark auto reviews on GitHub</H3>
      <p>
        For teams where more than one person runs Limn. Each auto review puts a status line on the pull
        request&rsquo;s latest commit, such as <Ui>limn/review-claude</Ui>. A teammate&rsquo;s Limn then skips a commit
        someone is already reviewing with the same provider. It needs write access to the repository; without it,
        Limn reviews without a line. On by default.
      </p>
      <Warning>Do not make <Ui>limn/</Ui> status lines required checks. A line that is still pending would block merges.</Warning>

      <H3>Auto reviews use</H3>
      <p>
        <Ui>Claude + Codex (the default)</Ui> runs both providers on the same commit at the same time, each on its own,
        then merges them into one review. The other choice (for example <Ui>Claude only</Ui>) runs the default provider only. If only one provider is
        signed in, that one runs alone. See <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>.
      </p>
      <p>
        <Ui>When Claude and Codex disagree</Ui> sets how one verdict is reached:
      </p>
      <ul>
        <li>
          <Ui>Strict: approve only if both approve</Ui> (the default).
        </li>
        <li>
          <Ui>Relaxed: approve if one approves and the other raises nothing that blocks</Ui>.
        </li>
      </ul>
      <p>Either way, if one asks for changes, Limn does not approve.</p>

      <H2 id="posting">What happens when a review finishes</H2>
      <p>
        <Ui>When an auto review finishes</Ui> has two choices:
      </p>
      <ul>
        <li>
          <Ui>Keep it in Limn</Ui>: read it in the AI Review tab and post it yourself if you want.
        </li>
        <li>
          <Ui>Post to GitHub</Ui> (on by default): as soon as it finishes. Reviews you start yourself post only when you
          choose <Ui>Review and post</Ui>.
        </li>
      </ul>
      <Warning title="Posts are made as you">
        Limn posts with your GitHub account, as one review. On GitHub it counts as your review. Nothing is posted twice,
        and merged, closed and draft pull requests, and pull requests opened by bots, are never posted on.
      </Warning>
      <H3>Which PRs</H3>
      <ul>
        <li>
          <Ui>Your own PRs, and PRs you are asked to review or have reviewed or commented on</Ui> (the default).
        </li>
        <li>
          <Ui>Every PR auto review covers</Ui>.
        </li>
      </ul>
      <p>A review request to a team does not make a pull request yours: Limn does not know which teams you are in.</p>
      <H3>What to post</H3>
      <p>Tick what goes into the posted review. Ticked by default unless marked:</p>
      <ul>
        <li>
          <Ui>Blockers</Ui>, <Ui>Warnings</Ui>
        </li>
        <li>
          <Ui>Nits</Ui> (off by default)
        </li>
        <li>
          <Ui>Questions, on the line they ask about where possible</Ui>
        </li>
        <li>
          <Ui>CI failure reasons, in one PR comment</Ui>
        </li>
        <li>
          <Ui>SonarCloud issues, in one PR comment</Ui>
        </li>
        <li>
          <Ui>Story gaps, on the PR they belong to</Ui>
        </li>
        <li>
          <Ui>Work the story did not ask for</Ui> (off by default)
        </li>
      </ul>

      <H2 id="approve">Approve or request changes</H2>
      <p>
        With <Ui>Approve or request changes for me</Ui> on (the default), a posted review may approve or request
        changes instead of only commenting. It approves only with no blockers or warnings, only when your last review
        was a comment, and never on your own pull requests. When it does not approve, it says why, once per commit.
      </p>
      <ul>
        <li>
          <Ui>Approve</Ui>: tick <Ui>High impact PRs</Ui>, <Ui>Medium impact PRs</Ui> and <Ui>Low impact PRs</Ui>.
          Impact is the blast radius chip. A pull request at an impact you untick gets a comment-only review. A pull
          request whose impact Limn could not measure counts as High. See{' '}
          <DocLink to="settings/pull-requests">Pull requests</DocLink>.
        </li>
        <li>
          <Ui>Approve with open findings</Ui>: <Ui>Only when nothing is left open</Ui>, <Ui>When only nits are left</Ui>
          , or <Ui>When only nits and questions are left</Ui> (the default). Open blockers or warnings always stop an
          approval.
        </li>
      </ul>
      <p>
        More detail: <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting to GitHub</DocLink>.
      </p>

      <H2 id="resolving">Resolving threads</H2>
      <ul>
        <li>
          <Ui>Resolve Limn&rsquo;s threads once fixed</Ui> (off by default): when a later review finds a posted comment
          fixed, Limn replies and resolves it.
        </li>
        <li>
          <Ui>Resolve my Limn threads when addressed</Ui> (on by default): on your own pull requests, drafts too, when
          any review you run finds one of your Limn&rsquo;s comments fixed, Limn replies &ldquo;Addressed in&rdquo; and
          the commit, then resolves the thread. It never touches a person&rsquo;s thread or a teammate&rsquo;s Limn
          thread.
        </li>
      </ul>
      <H3>Teammates&rsquo; Limn &ldquo;changes requested&rdquo;</H3>
      <p>
        Two boxes deal with a review that a teammate&rsquo;s Limn posted as &ldquo;changes requested&rdquo;. When every
        point is fixed at the latest commit and your own review finds no blocker, your Limn can dismiss that review and
        post its own. Both people must agree: the teammate ticks{' '}
        <Ui>Let a teammate&rsquo;s Limn dismiss my Limn&rsquo;s &ldquo;changes requested&rdquo; once every point is fixed</Ui>
        , and you tick <Ui>Dismiss a teammate&rsquo;s Limn &ldquo;changes requested&rdquo; once every point is fixed</Ui>
        . A review someone wrote by hand is never dismissed. See{' '}
        <DocLink to="ai-review/team-reviews">Reviewing as a team</DocLink>.
      </p>

      <H2 id="auto-fix">Auto AI Fix</H2>
      <p>
        <Ui>Auto AI Fix on your own PRs</Ui> (off by default) prepares one AI Fix after an auto review of a pull
        request you opened. It runs only after an auto review, so it is off while auto review is off. Other
        people&rsquo;s pull requests are never fixed automatically. At most 3 auto fixes run per pull request a day,
        and none while a fix is running or waiting to be pushed.
      </p>
      <ul>
        <li>
          <Ui>Always include</Ui>: choose what the fix works on: the review&rsquo;s findings, earlier findings not fixed
          yet, threads the AI says to fix, threads nobody has answered, CI failure reasons, SonarCloud issues, and style
          bot comments (the last is off by default).
        </li>
        <li>
          <Ui>Push automatically</Ui> (off by default): pushes a finished fix to the pull request&rsquo;s branch. It is
          not built or tested first. With it off, the fix waits in the AI Fix tab until you press <Ui>Push</Ui>.
        </li>
      </ul>
      <p>
        See <DocLink to="ai-fix/push-and-auto-fix">Push the fix, and auto fix</DocLink>.
      </p>

      <H2 id="diagrams">Design diagrams</H2>
      <p>
        <Ui>Draw a design diagram after each review</Ui> draws a design diagram after every review. Turning it off saves
        about a third of the review&rsquo;s AI usage. See <DocLink to="ai-review/design-diagrams">Design diagrams</DocLink>
        .
      </p>

      <H2 id="related-repos">Related repos</H2>
      <p>
        When a change in one repository depends on another (a front end and its API, for example), link them. When AI
        Review checks a pull request in one repository, it can then also read the code in its related repositories. A
        link works both ways.
      </p>
      <Steps>
        <li>
          Under <Ui>Related repos</Ui>, select a repository.
        </li>
        <li>Select each repository its reviews should also read. Arrows show the links of the selected repository.</li>
      </Steps>
      <p>From each related repository, the review reads the first of these that exists:</p>
      <ol>
        <li>an open pull request on a branch with the same name;</li>
        <li>an open pull request that names the same ticket, such as PAY-142;</li>
        <li>a branch with the same name, with no pull request;</li>
        <li>the default branch, for reference.</li>
      </ol>
      <Note>
        Only deep reviews read related repositories, and only a few per review. Moving a repository to another
        workspace removes its links.
      </Note>
    </>
  );
}
