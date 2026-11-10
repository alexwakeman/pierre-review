import type { DocMeta } from '../../types';
import { DocLink, FindingRow, H2, Illustration, Note, Pill, Steps, Thread, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Ticket comments',
  summary:
    'Comments on a ticket can clarify, change or settle a criterion. How the story check reads them, Met outside code changes, and New since the check.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The real scope of a ticket often lives in its comments: &ldquo;we agreed to drop the export&rdquo;,
        &ldquo;the ledger setting is switched on in production now&rdquo;. Limn reads the comments of every ticket it
        reads, shows them in the story view, and gives them to the story check as the team&rsquo;s discussion of the
        ticket.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="The Comments section of a story view: two comments, the newer one marked New since the check"
        caption="Comments in the story view. The newest three show; Show all opens the rest."
      >
        <Thread
          comments={[
            { who: 'Dana Wu', when: '4 Mar', text: 'The refund is posted to the daily ledger by the finance job now. No code change needed.' },
            {
              who: 'Sam Carter',
              when: '2 hours ago',
              text: (
                <>
                  We are dropping the refund reason from the export for now. <Pill tone="blue">New since the check</Pill>
                </>
              ),
            },
          ]}
        />
      </Illustration>
      <ul>
        <li>
          <strong>Comments (n)</strong>, open, at the end of the Ticket section of the{' '}
          <DocLink to="this-sprint/story-view">story view</DocLink>. That is the ticket tab, a pull request&rsquo;s
          Ticket tab and the panel on This Sprint. It works on every tracker, and for a ticket with no pull request.
        </li>
        <li>The newest three comments, oldest first, with the author and the date. <Ui>Show all</Ui> opens the rest.</li>
        <li>
          <Ui>New since the check</Ui> on a comment written after the latest story check.
        </li>
        <li>Comments by bots and tracker automations are left out.</li>
      </ul>

      <H2 id="how-the-check-uses-them">How the story check uses them</H2>
      <ul>
        <li>
          Before every story check, Limn reads the ticket&rsquo;s comments from the tracker again, so the check sees
          the latest ones. It does not re-read the rest of the ticket at that moment.
        </li>
        <li>
          The check is told that comments are discussion, not the ticket. A comment can clarify or change the scope
          when it says so plainly, a later comment outweighs an earlier one, and a comment alone is never a new
          requirement.
        </li>
        <li>When a verdict relies on a comment, the check names its author and date.</li>
        <li>Only people&rsquo;s comments are given to the check, at most about 6,000 characters of the newest.</li>
      </ul>

      <H2 id="met-outside-code-changes">Met outside code changes</H2>
      <p>
        Some criteria are not code: a setting, some content, a manual step, a decision. When no pull request delivers
        a criterion, none needs to, and a person&rsquo;s comment says plainly that it was done, the check marks it{' '}
        <Ui>Met outside code changes</Ui>.
      </p>
      <Illustration label="A criterion marked Met outside code changes, citing Dana Wu's comment of 4 March" caption="The citation opens the comment it rests on.">
        <FindingRow chip="Met outside code changes" tone="green">
          The refund reaches the daily ledger — Per Dana Wu&rsquo;s comment, 4 Mar
        </FindingRow>
      </Illustration>
      <Steps>
        <li>Select the citation, &ldquo;Per Dana Wu&rsquo;s comment, 4 Mar&rdquo;.</li>
        <li>The Comments section opens in full and moves to that comment, so you can read it.</li>
      </Steps>
      <p>
        It counts as done, is never posted as a gap and is never given to Fill gaps. Counts name it apart, for
        example &ldquo;4 met + 1 outside code of 6&rdquo;. Limn keeps the verdict only when the comment it cites is a
        real comment by a person on the ticket, and the check did not say the work belongs in code.
      </p>

      <H2 id="when-a-new-comment-arrives">When a new comment arrives</H2>
      <p>
        A new comment by a person makes the latest check out of date only while the check has a criterion that is
        not done, because the comment may settle it. If every criterion is done, the comment is marked{' '}
        <Ui>New since the check</Ui> and nothing else changes. With{' '}
        <DocLink to="story-checks/overview#automatic-checks">automatic checks</DocLink> on, the new comment starts
        the two-minute wait like a push does, and the line says &ldquo;waiting 2 quiet minutes after the last comment
        on the ticket&rdquo;.
      </p>
      <Note>
        Limn reads comments when it reads the ticket in the background and again before each story check. Opening
        the story view does not call the tracker. On Notion, the integration needs the &ldquo;read comments&rdquo;
        capability; see <DocLink to="integrations/notion">Notion</DocLink>.
      </Note>
    </>
  );
}
