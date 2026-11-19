import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, H3, Illustration, MiniTable, Note, SettingsRow, Steps, TextBox, Toggle, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Push the fix, and auto fix',
  summary: 'Nothing leaves your computer until you press Push. Auto fix can fix your own pull requests when a review or CI finds something.',
};

function PushPicture(): JSX.Element {
  return (
    <Illustration
      label="The push controls of a finished fix: the commit message, a choice between Push to the PR branch, dana/partial-refunds, and New branch + open a PR, then a Push button."
      caption="Push: to the pull request's own branch, or to a new branch with a new pull request."
      title="AI Fix"
      meta="#612 Partial refunds"
    >
      <SettingsRow label="Commit message" control={<TextBox value="Reject refunds after the 30-day window" />} />
      <SettingsRow label="◉ Push to the PR branch" hint="dana/partial-refunds" control={<span />} />
      <SettingsRow label="○ New branch + open a PR" control={<span />} />
      <p>
        <Btn tone="go">Push</Btn> <Btn>Discard</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A finished fix is reviewed by Ensemble first (see Review rounds), then pushed by itself when you left <Ui>Push when done</Ui>{' '}
        ticked; otherwise it waits in the <Ui>AI Fix</Ui> tab until you decide. Push sends it to GitHub from your computer, with your own GitHub
        sign-in; the sandbox never holds your GitHub credentials. This page also covers auto fix, which prepares a fix
        by itself after an auto review of your own pull request.
      </p>

      <H2 id="review-rounds">Review rounds before the push</H2>
      <p>
        After the agent fixes, Ensemble reviews the fix before anything is pushed. The review reads a copy of the fix on
        your computer; nothing reaches GitHub. The agent then fixes, answers or pushes back on each point, and Ensemble
        reviews again. This goes on until a review finds nothing, or for up to 5 rounds (
        <DocLink to="settings/ai#ai-fix">Settings → AI → AI Fix → Review rounds</DocLink>), with one closing review after
        the last round. Claude and Codex together count as one review.
      </p>
      <ul>
        <li>
          The <Ui>Review rounds</Ui> panel shows each round: what the review found, and what the agent fixed, answered or
          pushed back on. While it works it says, for example, <Ui>Reviewing, round 2 of 5.</Ui>, and <Ui>Push</Ui> does
          not show. <Ui>Stop</Ui> ends the rounds. A fix you started keeps its changes; an auto fix is discarded.
        </li>
        <li>
          When the fix has the pull request&rsquo;s ticket criteria, each round also checks them. The agent can say a
          criterion cannot be done, and why. It stays not met, with that reason, and the rounds stop when only such
          criteria are left.
        </li>
        <li>
          For an automatic fix, each round asks the{' '}
          <DocLink to="settings/ai-usage-and-spend#spend-budget">spend limit</DocLink> first. Over the limit, the rounds
          stop and the fix is kept as it is.
        </li>
        <li>
          After the push, the last review shows in the <Ui>AI Review</Ui> tab as the review of the pushed commit. It is not
          posted, auto review does not review that commit again, and no auto fix starts from it.
        </li>
      </ul>

      <H2 id="push-when-done">Push when done</H2>
      <p>
        <Ui>Push when done</Ui>, beside <Ui>Start fix</Ui>, is ticked by default, and Ensemble remembers your choice in this
        browser. When the fix and its review rounds finish on your own pull request, Ensemble pushes it to the pull request&rsquo;s branch the
        same way as <Ui>Push</Ui>, and the session ends.
      </p>
      <p>
        It waits for your press instead, and the session says why, when the agent says something is not fixed, its
        report does not cover every item or is missing, or the pull request is someone else&rsquo;s. The same line
        shows above <Ui>Push</Ui>. Untick it to keep talking to the agent before anything is pushed: a push ends the
        session.
      </p>
      <p>
        While the push runs, the tab says <Ui>Pushing to</Ui> the branch, with no button. Then it says{' '}
        <Ui>Pushed to</Ui> the branch with the commit, which links to GitHub, and <Ui>Pushed automatically</Ui>. If the
        push fails, the tab says <Ui>Automatic push failed</Ui> and why, and <Ui>Push</Ui> stays.
      </p>

      <H2 id="push">Push a fix</H2>
      <PushPicture />
      <Steps>
        <li>Read the report and the diff.</li>
        <li>
          Choose where it goes:
          <ul>
            <li>
              <Ui>Push to the PR branch</Ui> (the default) adds one commit to the pull request.
            </li>
            <li>
              <Ui>New branch + open a PR</Ui> pushes to a branch you name and opens a new pull request. Use it when the
              pull request comes from a fork you cannot push to.
            </li>
          </ul>
        </li>
        <li>
          Press <Ui>Push</Ui> (or <Ui>Push + open PR</Ui>). The tab says <Ui>Pushing…</Ui>, then <Ui>Pushed to</Ui> the
          branch with the commit.
        </li>
      </Steps>
      <Warning>
        Push writes to GitHub under your name. It is never forced, and it is refused if the branch moved since the fix
        started. Only the pull request's repository is pushed; edits the agent made in other repositories are shown
        under <Ui>Left out</Ui> and dropped. Ensemble does not build or test the fix again before the push.
      </Warning>
      <p>
        After the push, Ensemble syncs the pull request, so the new commit shows at once. Its last review round becomes the
        AI review of the new commit, so auto review does not review it again. A fix that includes the merge item pushes only to the pull request's
        own branch; see <DocLink to="ai-fix/resolve-merge-conflicts">Resolve merge conflicts with AI Fix</DocLink>.
      </p>

      <H2 id="discard-and-resume">Discard and resume</H2>
      <ul>
        <li>
          <Ui>Discard</Ui> stops the agent and removes the sandbox. Nothing is pushed. It asks once while the sandbox is
          running.
        </li>
        <li>
          A sandbox with nothing to do closes after an hour, or when Ensemble restarts. The tab says{' '}
          <Ui>The sandbox is closed. The changes are kept: push them, or resume.</Ui>
        </li>
        <li>
          <Ui>Resume</Ui> starts a new sandbox with the fix's changes put back, so you can ask for more. The agent does
          not remember the conversation.
        </li>
        <li>
          <Ui>New fix</Ui> opens <Ui>What to fix</Ui> again for another run. One fix runs per pull request at a time.
        </li>
      </ul>

      <H2 id="auto-fix">Auto fix</H2>
      <p>
        With <Ui>Auto AI Fix on your own PRs</Ui> on, Ensemble prepares a fix on a pull request you opened whenever there is
        something to fix: the findings of an auto review, or CI failures the CI review explained. It is set per workspace in <Ui>Settings → AI review</Ui>, and it is off by default. It runs only while
        auto review is on.
      </p>
      <Illustration
        label="The Auto AI Fix settings: Auto AI Fix on your own PRs is on; Push automatically is off."
        caption="Auto AI Fix and Push automatically, both off until you switch them on."
        title="Auto AI Fix"
        meta="Settings → AI review"
      >
        <SettingsRow
          label="Auto AI Fix on your own PRs"
          hint="After an auto review of a PR you opened, prepare a fix. Nothing is pushed."
          control={<Toggle on />}
        />
        <SettingsRow label="Push automatically" hint="Pushes a finished fix to the PR’s branch. Not built or tested first." control={<Toggle on={false} />} />
      </Illustration>
      <ul>
        <li>Only your own pull requests. Other people's pull requests are never fixed automatically.</li>
        <li>
          It works on the sections ticked under <Ui>Always include</Ui> (by default all except style bot comments and
          merge conflicts). It never fixes ticket gaps, and it never plans first.
        </li>
        <li>
          <Ui>Ensemble&rsquo;s findings</Ui> are every finding of the review, from Claude, Codex or both. When one half of a
          Claude + Codex review fails, what the other found still open of its earlier findings counts too.
        </li>
        <li>
          With <Ui>Merge conflicts with the base branch</Ui> ticked, a pull request that conflicts with its base is
          merged first, then fixed on top. Ensemble checks the merge before any push: two parents and no conflict markers
          left. A merge that fails the check is never pushed. <Ui>Push automatically</Ui> still decides whether a good
          one is pushed or waits for you.
        </li>
        <li>
          It runs one fix, then its <DocLink to="ai-fix/push-and-auto-fix#review-rounds">review rounds</DocLink>, then the
          sandbox closes. The fix waits in the <Ui>AI Fix</Ui> tab, marked <Ui>Auto fix</Ui>.
        </li>
        <li>
          Open pull requests shows <Ui>Fixing…</Ui> while it runs and <Ui>Fix ready</Ui> when it waits for you.
        </li>
      </ul>
      <H3 id="when-it-starts">When an auto fix starts</H3>
      <ul>
        <li>It waits for the CI jobs on the latest commit to finish, at most 45 minutes.</li>
        <li>When CI fails, it waits up to 15 minutes for the CI review to explain why.</li>
        <li>
          A fix for CI failures waits up to 15 minutes for the AI review of the same commit, so one fix covers both.
        </li>
        <li>
          While a fix runs, the next one waits. When it starts, it works from what is still open on the latest commit, so
          nothing already fixed is done again. Each fix is its own commit, and its own push with <Ui>Push automatically</Ui>.
        </li>
      </ul>
      <p>
        The <Ui>AI Review</Ui> tab shows what the next auto fix waits for, such as{' '}
        <Ui>Waiting for the CI jobs to finish (up to 12 min).</Ui>, and lists every auto fix of the pull request. A{' '}
        <Ui>Auto fixes</Ui> circle among the notifications shows the ones running and the ones that failed.
      </p>
      <H3>Why an auto fix did not start</H3>
      <p>
        The <Ui>Auto fix</Ui> section of the <Ui>AI Review</Ui> tab says <Ui>Auto fix started. See the AI Fix tab.</Ui>{' '}
        when one starts. When one did not start, the same line says why, once the review has finished:
      </p>
      <MiniTable
        cols={[{ key: 'r', label: 'The line' }]}
        rows={[
          { _key: '1', r: 'No auto fix: AI is not signed in on this computer.' },
          { _key: '2', r: 'No auto fix: the review could not be read.' },
          { _key: '3', r: 'No auto fix: the pull request could not be read from GitHub.' },
          { _key: '4', r: 'No auto fix: an error stopped it.' },
          { _key: '5', r: 'Paused: the AI spend limit is reached.' },
          { _key: '6', r: 'Paused: no container runtime is running on this computer.' },
          { _key: '7', r: 'No auto fix: 3 already ran on this pull request in the last 24 hours.' },
          { _key: '8', r: 'No auto review today: the limit of 20 is reached.' },
        ]}
      />
      <p>
        The last line uses your workspace&apos;s daily limit of auto reviews. A reason appears only after the review finishes. With
        auto AI Fix off there is no line.
      </p>
      <p>
        Ensemble tries again by itself after an error, a sign-in, a busy sandbox, the AI spend limit, or a new day. The
        rest wait until the pull request changes.
      </p>

      <H2 id="push-automatically">Push automatically</H2>
      <p>
        <Ui>Push automatically</Ui>, under Auto AI Fix, pushes a finished automatic fix to the pull request's branch
        without waiting for you. It is off by default.
      </p>
      <Warning>
        With Push automatically on, code an agent wrote reaches your branch with no person reading it first, and it is
        not built or tested by Ensemble before the push. Your CI and the next auto review are the checks. If the push fails,
        the <Ui>AI Fix</Ui> tab says <Ui>Automatic push failed</Ui> and Ensemble does not try again; you can push by hand.
        A fix that was pushed shows <Ui>Pushed automatically</Ui> and has no Push button.
      </Warning>
      <Note>
        Limits stop a loop of fix, review, fix: at most 3 automatic fixes per pull request a day, no new one while a fix
        runs or waits to be pushed, and none when the last one could not address the same items. Each one also asks your
        spend budget first. See <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
      </Note>
    </>
  );
}
