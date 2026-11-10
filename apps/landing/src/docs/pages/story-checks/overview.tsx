import type { DocMeta } from '../../types';
import { Btn, Card, DocLink, FindingRow, H2, H3, Illustration, Note, Pill, Steps, Tip, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Check a pull request against its story',
  summary:
    "The story check reads the ticket a pull request names and says, criterion by criterion, how far the ticket's pull requests deliver it.",
};

function StoryCheckSection(): JSX.Element {
  return (
    <Illustration
      label="The Story check section on pull request 612: PAY-142, 3 of 4 met, a line saying the next automatic check starts in 1 minute 40 seconds, and one Post 1 gap to this PR button"
      caption="The Story check section in a pull request's AI Review tab."
      title="#612 Partial refunds"
      meta="AI Review"
    >
      <Card title="Story check · PAY-142" chip={<Pill tone="amber">3 of 4 met</Pill>}>
        <p className="muted">
          Story check starts in 1m 40s — waiting 2 quiet minutes after the last push to payments#612
        </p>
        <FindingRow chip="Met" tone="green">
          A partial refund keeps the order open — Done in #612
        </FindingRow>
        <FindingRow chip="Partly met" tone="amber">
          The customer gets one email — Code in #612, the retry path still sends two
        </FindingRow>
        <FindingRow chip="Not met" tone="red">
          No refunds after 30 days — belongs in #612
        </FindingRow>
        <p>
          <Btn>Post 1 gap to this PR</Btn> <Btn>Re-check</Btn>
        </p>
      </Card>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A code review asks &ldquo;is this code right?&rdquo;. A story check asks &ldquo;does this work do what the
        ticket asked for?&rdquo;. Limn reads the ticket from your issue tracker, reads every open and merged pull
        request that names it, in any repository of yours, and judges each acceptance criterion against the code.
        It is one check per ticket, not per pull request, so a ticket split across three pull requests gets one
        answer.
      </p>


      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          An issue tracker for the workspace (<DocLink to="integrations/jira">Jira</DocLink>,{' '}
          <DocLink to="integrations/github-issues">GitHub Issues</DocLink>,{' '}
          <DocLink to="integrations/linear">Linear</DocLink> or <DocLink to="integrations/notion">Notion</DocLink>),
          so Limn can find the ticket a pull request names. Every story is read from the tracker.
        </li>
        <li>
          AI set up in <DocLink to="settings/ai">Settings → AI</DocLink>, with Claude or Codex signed in.
        </li>
      </ul>

      <H2 id="where-you-see-it">Where you see it</H2>
      <ul>
        <li>
          In a pull request&rsquo;s <Ui>AI Review</Ui> tab, in the <Ui>Story check</Ui> section: the ticket&rsquo;s
          criteria this pull request delivers and what belongs in it, and a <Ui>See the whole ticket</Ui> link to
          the story view.
        </li>
        <li>
          In the <DocLink to="this-sprint/story-view">story view</DocLink>: the whole ticket across all its pull
          requests, with how many criteria other pull requests meet and what each pull request adds.
        </li>
        <li>On This Sprint cards (&ldquo;3 of 4 criteria met&rdquo;) and on Open pull requests, as a coverage chip.</li>
      </ul>
      <StoryCheckSection />

      <H2 id="what-the-check-says">What the check says</H2>
      <ul>
        <li>
          <strong>A summary</strong> of two or three short sentences: how far the pull requests deliver the ticket,
          and the most important thing left.
        </li>
        <li>
          <strong>Each criterion with a status</strong>: <Ui>Met</Ui>, <Ui>Met outside code changes</Ui>,{' '}
          <Ui>Partly met</Ui>, <Ui>Not met</Ui> or <Ui>Can&rsquo;t tell from the code</Ui>, the pull request that does
          it, and the evidence. See <DocLink to="story-checks/acceptance-criteria">Acceptance criteria</DocLink>.
        </li>
        <li>
          <strong>Asked for outside the criteria</strong>: things the title or description asks for that no criterion
          names and no pull request does.
        </li>
        <li>
          <strong>Not asked for</strong>: work in the pull requests that the ticket does not ask for.
        </li>
        <li>
          <strong>What each PR adds</strong> (in the story view): a plain description of each pull request&rsquo;s
          part.
        </li>
        <li>
          <strong>Reference docs</strong>, when docs are on for reviews: passages from your library that support or
          contradict the story. See <DocLink to="docs-library/docs-in-reviews">Docs in reviews</DocLink>.
        </li>
      </ul>

      <H2 id="run-a-check">Run a check</H2>
      <Steps>
        <li>
          Open the pull request and choose the <Ui>AI Review</Ui> tab.
        </li>
        <li>
          In <Ui>Story check</Ui>, press <Ui>Check</Ui> (or <Ui>Re-check</Ui> when one has run). In the story view,
          press <Ui>Re-check</Ui> in the header.
        </li>
        <li>Wait for the result. A check usually takes a few minutes, as the agent reads every pull request.</li>
      </Steps>

      <H3 id="when-the-pull-request-names-no-ticket">When the pull request names no ticket</H3>
      <p>
        Limn finds tickets in the pull request&rsquo;s title and branch name (on GitHub Issues, in its &ldquo;Fixes
        #12&rdquo; links; on Linear, also in Linear&rsquo;s own links). If the ticket is not there:
      </p>
      <Steps>
        <li>
          Open <Ui>Add tickets</Ui> in the Story check section.
        </li>
        <li>
          Paste one or more ticket links or keys, like <code>PROJ-123</code>. Limn shows a chip for each one it can
          read.
        </li>
        <li>
          Press <Ui>Check</Ui>. Limn links the tickets to the pull request and starts one check per ticket.
        </li>
      </Steps>
      <p>
        A ticket on another tracker or another site is refused, because Limn only reads the workspace&rsquo;s own
        tracker with its own sign-in. Without a tracker there is no story check.
      </p>

      <H2 id="automatic-checks">Automatic checks</H2>
      <p>
        When <DocLink to="ai-review/auto-review">auto review</DocLink> is on for the workspace, Limn checks a ticket
        by itself when its pull requests change: a push, a pull request joining or merging, a change to the ticket
        text, or a new comment while a criterion is not done.
      </p>
      <ul>
        <li>
          <strong>A two-minute wait.</strong> Limn waits until the ticket&rsquo;s pull requests have been quiet for 2
          minutes, so a burst of pushes, or three pull requests linked a minute apart, gets one check. Every new
          change restarts the 2 minutes. After 20 minutes of changes it starts anyway.
        </li>
        <li>
          <strong>One line says when.</strong> The AI Review tab and the story view show the same line, for example
          &ldquo;Story check starts in 1m 40s — waiting 2 quiet minutes after the last push to backend#615&rdquo;, or
          why no check will start: &ldquo;No automatic story check — auto review is off in this workspace&rdquo;.
        </li>
        <li>
          <strong>A daily limit.</strong> A workspace has up to 60 automatic story checks a day. After that the line
          says &ldquo;Story check starts at 00:00 UTC&rdquo;. Tickets with your own pull requests are not limited.
        </li>
        <li>
          <strong>The spend budget.</strong> An automatic check is skipped when your{' '}
          <DocLink to="settings/ai-usage-and-spend">AI spend budget</DocLink> is used up.
        </li>
      </ul>
      <Tip>
        <Ui>Re-check</Ui> is never held by the wait, the limit or the budget. It always starts a check now.
      </Tip>

      <H2 id="post-the-gaps">Post the gaps to GitHub</H2>
      <p>
        The criteria that are not met, and the things asked for outside the criteria, are &ldquo;gaps&rdquo;. Each
        gap belongs to one pull request: the one where the check says the code should go. Press{' '}
        <Ui>Post 1 gap to this PR</Ui> (the number changes) to post them as one comment on that pull request. A gap is
        posted once; a later check posts only new gaps, in a new comment.
      </p>
      <Warning>
        Posting writes a comment on GitHub under your account. It happens only when you press the button, unless the
        workspace has auto-posting on, which posts automatic checks on your own pull requests. See{' '}
        <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting</DocLink>.
      </Warning>

      <H2 id="when-a-check-is-out-of-date">When a check is out of date</H2>
      <p>
        A check is tied to the ticket text and to each pull request&rsquo;s latest commit. It goes out of date when
        the story is edited, a pull request is pushed, joins, leaves or merges, or a person comments while a
        criterion is not done. The header names what changed, for example &ldquo;api#88 pushed since&rdquo;, and the
        last result stays on screen until the next one.
      </p>
      <Note>
        A ticket with more than 30 open and merged pull requests is not checked; Limn says how many there are rather
        than check a sample. Closed pull requests that were not merged do not count.
      </Note>

      <H2 id="the-pull-request-review-and-the-ticket">The pull request review and the ticket</H2>
      <p>
        The pull request&rsquo;s own AI review does not judge the story; that is the story check&rsquo;s job. It does
        use the ticket in one way: just before a review runs, Limn reads the ticket again and passes on its{' '}
        <strong>open points</strong>, the decisions the ticket left undecided (&ldquo;wording to be confirmed by
        design&rdquo;). The review lists them under <Ui>Open points</Ui>, marked <Ui>Not blocking</Ui>, with the code
        that depends on each. They never change the review&rsquo;s verdict. Where open points come from is set per
        issue type in <DocLink to="integrations/jira#choose-the-ticket-fields">Ticket fields</DocLink>.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Most &ldquo;done&rdquo; tickets that come back were not wrong; they were incomplete. A story check reads the
        whole ticket, across repositories, against the code, and puts what is left in front of the developer while
        the pull request is still open.
      </p>
    </>
  );
}
