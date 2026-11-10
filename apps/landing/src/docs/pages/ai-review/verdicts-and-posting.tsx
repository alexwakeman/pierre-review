import type { DocMeta } from '../../types';
import { Chip, DocLink, H2, H3, Illustration, MiniTable, Note, Steps, Thread, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Verdicts and posting to GitHub',
  summary: 'What the verdict means, when Limn posts the review for you, and when it approves.',
};

function NotApproved(): JSX.Element {
  return (
    <Illustration
      label="A comment review posted by Limn on pull request 612. It lists two warnings and ends with the line: Not approved: 2 warnings are still open."
      caption="When Limn does not approve, the review ends with one line that says why."
      title="#612 Partial refunds"
      meta="Posted automatically · 2 min ago"
    >
      <p>
        <Chip>Comment</Chip>
      </p>
      <Thread
        comments={[
          {
            who: 'Limn · priya',
            bot: true,
            text: 'Two warnings on the refund retry path. Not approved: 2 warnings are still open.',
          },
        ]}
      />
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Every review ends with a verdict: <Ui>Approve</Ui>, <Ui>Comment</Ui> or <Ui>Request changes</Ui>. In Limn it is
        a suggestion. On GitHub it becomes your review, posted under your account. This page explains when Limn posts,
        what it posts, and the rules it follows before it approves or asks for changes for you.
      </p>
      <WhoItHelps
        developer="You know exactly what will go out under your name, and why a review did not approve."
        manager="The team sets the bar once (what is posted, when Limn may approve, at which impact) and every automatic review keeps it."
      />

      <H2 id="when-limn-posts">When Limn posts</H2>
      <MiniTable
        cols={[
          { key: 'how', label: 'How the review started' },
          { key: 'post', label: 'Is it posted?' },
        ]}
        rows={[
          { _key: 'r', how: 'You pressed Review only', post: 'No. You post it yourself with Post to GitHub.' },
          { _key: 'p', how: 'You pressed Review and post', post: 'Yes, when it finishes, under the rules on this page.' },
          { _key: 'a', how: 'Auto review', post: 'Yes, unless the workspace says Keep it in Limn.' },
        ]}
      />
      <p>
        Merged, closed and draft pull requests are never posted on automatically, nor pull requests opened by bots. By
        default, automatic reviews post only on your own pull requests and on ones you are asked to review or have
        reviewed or commented on. A review request to a GitHub team does not count, because Limn does not know which
        teams you are in.
      </p>
      <Warning>
        A posted review is your review on GitHub. It counts towards branch rules like any review you write. It is
        marked as Limn's with a footer and a hidden marker, and inside Limn it is shown as the bot "Limn · you", never
        as you.
      </Warning>

      <H2 id="what-is-posted">What is posted</H2>
      <p>
        One review per run. In <Ui>Settings → AI review</Ui>, <Ui>What to post</Ui> chooses the kinds of comment. By
        default:
      </p>
      <ul>
        <li>Posted: blockers, warnings, questions (on the line they ask about where possible), CI failure reasons in one pull request comment, SonarCloud issues in one pull request comment, and story gaps on the pull request they belong to.</li>
        <li>Not posted: nits, and work the story did not ask for.</li>
      </ul>
      <p>
        Nothing is posted twice: a comment already on the pull request from any earlier review is left out, and so is
        anything you ignored. Each posted comment starts with its severity in bold, for example <b>Warning</b>.
      </p>

      <H2 id="how-the-verdict-is-chosen">How the verdict is chosen</H2>
      <p>
        With <Ui>Approve or request changes for me</Ui> on (the default), an automatic post, or a{' '}
        <Ui>Review and post</Ui> run, takes its verdict from these rules, in order:
      </p>
      <Steps>
        <li>
          Any blocker still open, new or from an earlier review: <Ui>Request changes</Ui>.
        </li>
        <li>
          Any warning still open, new or earlier: <Ui>Comment</Ui>.
        </li>
        <li>
          The model did not approve (for Claude + Codex, both, unless the workspace is set to relaxed):{' '}
          <Ui>Comment</Ui>. A single model that only commented while nothing at all is open counts as an approval.
        </li>
        <li>
          Open nits or questions that <Ui>Approve with open findings</Ui> does not allow: <Ui>Comment</Ui>.
        </li>
        <li>
          Otherwise <Ui>Approve</Ui>, unless a gate below holds it.
        </li>
      </Steps>
      <H3>The gates</H3>
      <ul>
        <li>
          <b>Your own pull request.</b> GitHub never lets an author approve or request changes, so it posts a comment.
        </li>
        <li>
          <b>Your own standing review.</b> If you approved or requested changes by hand, Limn never overrides you.
        </li>
        <li>
          <b>Impact.</b> <Ui>Approve by impact</Ui> can allow approval at High, Medium and Low impact (all ticked by
          default). An unticked level gets a comment instead. A pull request whose impact Limn could not measure
          counts as High. Requesting changes is never limited by impact. See{' '}
          <DocLink to="pull-request/blast-radius">Blast radius</DocLink>.
        </li>
        <li>
          <b>GitHub refuses the verdict.</b> The same review goes once more as a plain comment.
        </li>
      </ul>
      <p>
        <Ui>Approve with open findings</Ui> has three choices: <Ui>Only when nothing is left open</Ui>,{' '}
        <Ui>When only nits are left</Ui> and <Ui>When only nits and questions are left</Ui> (the default). Open blockers
        or warnings always stop an approval. Turn <Ui>Approve or request changes for me</Ui> off and every automatic
        post is a comment.
      </p>

      <H2 id="not-approved">Why "Not approved" lines appear</H2>
      <NotApproved />
      <p>When the verdict is not an approval, the review ends with one line that says why. The first match wins:</p>
      <MiniTable
        cols={[
          { key: 's', label: 'Situation' },
          { key: 'l', label: 'Line' },
        ]}
        rows={[
          { _key: '1', s: 'Blockers or warnings open', l: 'Not approved: 2 warnings are still open.' },
          { _key: '2', s: 'Earlier points of the other model, after its half failed', l: 'Not approved: 2 earlier Codex points are still open.' },
          { _key: '3', s: 'A model asked for changes', l: 'Not approved: Codex asked for changes. …' },
          { _key: '4', s: 'A model only commented, something still open', l: 'Not approved: Claude did not approve. A nit is still open.' },
          { _key: '5', s: 'Claude + Codex, neither approved', l: 'Not approved: neither Claude nor Codex approved. No findings are open.' },
          { _key: '6', s: 'Leftovers not allowed', l: 'Not approved: a question is still open.' },
          { _key: '7', s: 'A gate', l: 'Not approved: High impact. (or: your own pull request.)' },
        ]}
      />
      <p>
        The reasons about your own pull request, your own standing review, an unreadable GitHub and a refusal show in
        Limn only. If a review has nothing else to post, the line goes out alone as one short comment, at most once per
        pull request and commit, and never while you still have an open review request on it.
      </p>

      <H2 id="withdrawn-approvals">When Limn takes its approval back</H2>
      <ul>
        <li>A push alone never makes Limn withdraw anything. The repository's own branch rule decides whether GitHub dismisses an approval after a push.</li>
        <li>
          When a later automatic run, or a <Ui>Review and post</Ui> run, does not approve, Limn first dismisses its own
          earlier automatic approval, once, with a message such as "Limn withdrew its approval: 2 warnings found at
          951c4aa." This happens even with <Ui>Keep it in Limn</Ui>.
        </li>
        <li>A <Ui>Review only</Ui> run never writes. An approval you gave by hand, or sent with the Post button, is never touched.</li>
        <li>
          A withdrawn approval is never lost from view. <Ui>Where this PR stands</Ui> keeps a note on the person's row,
          and <Ui>Reviews on this PR</Ui> shows the review as "Approve (withdrawn)".
        </li>
      </ul>
      <p>
        Your own Limn's earlier <Ui>Request changes</Ui> is lifted by your next run that finds no blocker. Lifting a
        teammate's needs both of you to agree; see{' '}
        <DocLink to="ai-review/team-reviews#lifting-changes-requested">Reviewing as a team</DocLink>.
      </p>

      <H2 id="failures">When a post fails</H2>
      <p>
        Every automatic post is recorded before Limn writes to GitHub, and it is never retried, so nothing is posted
        twice. If a post fails, the <Ui>AI Review</Ui> tab says so and the Post button stays, so you can post it
        yourself.
      </p>
      <Note>
        If a post reached GitHub but does not show in Limn yet, Limn says it will show up shortly. Do not post again:
        it is already there.
      </Note>
    </>
  );
}
