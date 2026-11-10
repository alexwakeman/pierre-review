import type { DocMeta } from '../../types';
import { DocLink, H2, H3, MiniTable, Note, Ui, Warning } from '../../kit';
import { ClaimLinesMock } from '../../../components/mock/teams';

export const meta: DocMeta = {
  title: 'Reviewing as a team',
  summary: 'When several teammates run Limn, GitHub keeps the score: one review per commit per provider, and one list of findings.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Every person runs their own Limn on their own computer, signed in to GitHub as themselves. There is no Limn
        server and no shared account. GitHub is the only meeting place: each Limn reads what the others wrote there,
        and writes only as its own person. This page explains how several Limns share the review work without
        repeating each other.
      </p>

      <H2 id="three-rules">Three rules</H2>
      <ol>
        <li>
          <b>A Limn only knows what reached GitHub.</b> A review someone kept in Limn is invisible to the team.
        </li>
        <li>
          <b>Every write is a person's on GitHub, and Limn's inside Limn.</b> A Limn post is that person's review, so
          GitHub's own rules apply. Inside Limn it is shown as the bot "Limn · alex", never as alex, so it never
          counts as alex's own action.
        </li>
        <li>
          <b>Each Limn decides alone</b>, from what it reads. Nothing coordinates two machines except the status lines
          and hidden markers they leave on GitHub.
        </li>
      </ol>
      <p>
        Costs, settings, drafts, reviews kept in Limn and chats never travel between Limns. Code goes only to the
        model provider each person chose.
      </p>

      <H2 id="sharing-the-work">Sharing the work</H2>
      <ClaimLinesMock />
      <p>
        The rule is one automatic review per model per commit, across the whole team. With{' '}
        <Ui>Mark auto reviews on GitHub</Ui> on (the default, in <Ui>Settings → AI review</Ui>), each automatic review
        posts a status line on the pull request's latest commit, <b>limn/review-claude</b> or <b>limn/review-codex</b>:
        "alex is reviewing with Claude", then "alex reviewed · 3 comments". Another teammate's Limn reads the line and
        skips that model on that commit. A different model still reviews it.
      </p>
      <ul>
        <li>If two Limns claim at nearly the same moment, the earlier claim wins and the other stands down.</li>
        <li>A review that does not finish frees its line, so another Limn can take the commit.</li>
        <li>A claim that is not renewed lapses after 25 minutes, for example when a laptop is closed mid-review.</li>
        <li>A new commit starts the race again.</li>
        <li>Claiming needs write access to the repository. Without it, Limn reviews without a line.</li>
      </ul>
      <Warning>
        Do not make <b>limn/</b> lines required checks in branch protection. A line that is still pending would block
        merges. Limn never counts its own lines as CI.
      </Warning>
      <p>
        Only automatic reviews claim. A review you start yourself never waits and is never refused. The tab names a
        teammate who is reviewing, or has reviewed, the same commit with the same model ("Robin Dunn is reviewing this
        commit with Claude"), and your run goes ahead. When you post it, your Limn writes the "reviewed" line, so
        teammates' automatic reviews step aside for that model.
      </p>

      <H2 id="what-you-see">What you see when your Limn steps aside</H2>
      <ul>
        <li>
          On the <Ui>AI Review</Ui> tab: "Robin Dunn is reviewing this commit with Claude", or "…reviewed this commit
          with Claude · 4 comments". A teammate's live claim has a <Ui>Clear</Ui> button, with a confirm, for a claim
          that looks stuck.
        </li>
        <li>On Open pull requests: "Being reviewed by @robin" or "Reviewed by @robin".</li>
        <li>No run is recorded and no daily allowance is spent. Your Limn looks again later, or at once on a new commit.</li>
        <li>
          Replies on your own Limn's findings are still judged: your Limn runs a replies pass at that commit. See{' '}
          <DocLink to="ai-review/replies-pass">Replies to findings</DocLink>.
        </li>
      </ul>

      <H2 id="a-teammates-review">A teammate's review in your Limn</H2>
      <p>
        A teammate's posted Limn review is brought into your <Ui>AI Review</Ui> tab as their review, read-only. Each
        finding says who raised it: "You", "Robin", or "You and Robin" when both found the same point, which is shown
        once. You cannot reword or ignore their finding. The one thing you can do is <Ui>Post reminder</Ui>, which
        posts the point again as you, linked to the first comment.
      </p>
      <p>
        <Ui>Where this PR stands</Ui> lists each person's standing on GitHub (approved, changes requested, comment),
        with the date and commit. If a teammate runs a much older Limn, one line suggests they update.
      </p>

      <H2 id="author-and-reviewer">Author and reviewer</H2>
      <MiniTable
        cols={[
          { key: 'k', label: '' },
          { key: 'a', label: "Author's Limn (own pull request)" },
          { key: 'r', label: "Reviewer's Limn" },
        ]}
        rows={[
          { _key: '1', k: 'Approve or request changes', a: 'Never: always a comment.', r: 'Yes, within the workspace rules.' },
          { _key: '2', k: 'Holds the commit against others', a: 'No: other Limns ignore its lines.', r: 'Yes.' },
          { _key: '3', k: 'Resolves its own fixed threads', a: 'Yes, on by default.', r: 'Only with Resolve Limn’s threads once fixed (off by default).' },
          { _key: '4', k: 'Auto AI Fix', a: 'Optional, off by default.', r: 'Never on someone else’s pull request.' },
          { _key: '5', k: 'Resolves a teammate’s thread', a: 'Never.', r: 'Never.' },
        ]}
      />
      <p>
        A reviewer's Limn follows up the author's own Limn review when it is the latest one, and posts nothing the
        author already raised. When the reviewer's posted review finds one of the author's Limn findings fixed at the
        latest commit, the author's Limn resolves that thread ("Addressed in 1234abc (checked by Alex's Limn)"). The
        author does nothing. Limn acts on such a word only when it comes from a person with write access to the
        repository.
      </p>

      <H2 id="a-teammates-verdict">A teammate's verdict on your own review</H2>
      <p>
        Your Limn's review of your own pull request can never approve it: GitHub does not let an author approve. So a
        teammate's Limn picks it up and gives the verdict. Their Limn queues it ahead of its other automatic reviews,
        and first when your Limn would have approved. One teammate takes it, through the usual status line on the
        commit. If that teammate's Limn stops renewing its line for 25 minutes, another teammate's Limn takes over.
      </p>
      <ul>
        <li>
          On your side, the <Ui>AI Review</Ui> tab and the <Ui>Waiting on others</Ui> row say{' '}
          <Ui>Waiting for a teammate’s Limn to review</Ui>. Limn says this only when a teammate's Limn has run
          automatic reviews in the workspace in the last two weeks. It cannot see your teammates' settings, so
          otherwise it says nothing.
        </li>
        <li>
          On the teammate's side, the <Ui>AI Review</Ui> tab says, for example,{' '}
          <Ui>Queued: needs a verdict (alex’s own review approved)</Ui>.
        </li>
        <li>
          It needs auto review on in the teammate's workspace. It counts toward their daily limit and asks their
          spend budget, like every automatic review.
        </li>
      </ul>

      <H2 id="lifting-changes-requested">Lifting "changes requested"</H2>
      <p>
        Your own Limn's <Ui>Request changes</Ui> is lifted by your next run that finds no blocker. A teammate's Limn
        block is lifted only when both of you agree, in <Ui>Settings → AI review</Ui>, under{' '}
        <Ui>Teammates’ Limn “changes requested”</Ui> (both off by default):
      </p>
      <ul>
        <li>
          The teammate ticks <Ui>Let a teammate’s Limn dismiss my Limn’s “changes requested” once every point is fixed</Ui>.
        </li>
        <li>
          You tick <Ui>Dismiss a teammate’s Limn “changes requested” once every point is fixed</Ui>.
        </li>
      </ul>
      <p>
        Then, when your run at the latest commit finds every point behind their block fixed and no blocker of its own,
        your Limn posts its review and dismisses theirs, once, with a message such as "Limn (alex) checked all 3 points
        are addressed at 70cc9b5." Whether your review approves is decided by the usual rules. A review someone wrote
        by hand is never dismissed. Dismissing needs write access, and branch protection can restrict it.
      </p>
      <H3>When the teammate's Limn is away</H3>
      <p>
        Without either box, your Limn still dismisses a teammate's Limn <Ui>Request changes</Ui> when all of these hold:
        your review approves the latest commit; their block came from their Limn's automatic run; every point in every
        Limn review of theirs on the pull request is fixed at that commit; their Limn has not reviewed or claimed that
        commit; and they have done nothing on GitHub that Limn has seen for 4 hours, by hand or through their Limn. A
        review they sent with <Ui>Post</Ui> is never dismissed this way. The message says why, for
        example "Limn (alex) checked all 3 points are addressed at 70cc9b5. robin's Limn has not reviewed it and has
        been away for 5 hours." It needs <Ui>Approve or request changes for me</Ui>, and runs only on an automatic
        review or <Ui>Review and post</Ui>. It happens once per review and is never retried.
      </p>

      <H2 id="still-open-on-github">Still-open points on GitHub</H2>
      <p>
        When a posted review finds an earlier comment valid and not addressed, it says so on the thread with one{' '}
        <Ui>Still open:</Ui> reply per commit. A thread resolved without a fix is reopened once, ever; after that, a
        warning or blocker gets one new thread that links the old one. Just before writing, Limn reads the thread on
        GitHub again, so two Limns do not both reply. The author sees a "Robin's Limn: still open" pill on the
        thread and a card in My Turn. See <DocLink to="ai-review/follow-ups#still-open">Follow-up reviews</DocLink>.
      </p>

      <H2 id="whose-turn">Whose turn it is</H2>
      <p>
        An unanswered thread waits on the pull request's author. A review request waits on the person asked, until they
        review in person: a review only their Limn posted still leaves it in their My Turn. Nothing Limn does for you
        counts as your own action. See <DocLink to="pending/my-turn">My Turn</DocLink>.
      </p>

      <H2 id="what-limn-never-does">What Limn never does</H2>
      <ul>
        <li>Approve or request changes on your own pull request.</li>
        <li>Override a review you gave by hand, or anything sent with the Post button.</li>
        <li>Withdraw an approval because of a push alone.</li>
        <li>Edit or delete a teammate's comment, or resolve a teammate's or a person's thread.</li>
        <li>Reopen a thread more than once, or push back more than once on a thread.</li>
        <li>Retry a GitHub write that failed, except its own status lines and a refused verdict, which is sent once more as a plain comment.</li>
        <li>Show a teammate anything that was kept in Limn.</li>
      </ul>
      <H3>Mixed versions</H3>
      <Note>
        Every rule is written so a teammate on an older Limn stays safe, but older versions behave as they did. Ask the
        team to keep Limn up to date; the <Ui>AI Review</Ui> tab says when a teammate's review came from an old one.
      </Note>
    </>
  );
}
