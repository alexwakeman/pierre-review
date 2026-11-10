import type { DocMeta } from '../../types';
import { Chip, DocLink, FindingRow, H2, Illustration, MiniTable, Note, Thread, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Follow-up reviews',
  summary: 'After new commits, a follow-up review checks which findings were fixed and looks at what changed.',
};

function EarlierFindings(): JSX.Element {
  return (
    <Illustration
      label="The Findings section of a re-review of pull request 612. Under Open, the warning about a second email is Not addressed, with the one thing still needed. Under Resolved or addressed, the blocker on paid_at is Addressed, with a line saying how."
      caption="Findings: each earlier finding on its own row, with its outcome and one line on how it was dealt with, or what is still needed."
      title="Findings"
      meta="#612 · 2 newer commits"
    >
      <p style={{ margin: '0 0 4px' }} className="muted">
        Open
      </p>
      <FindingRow chip="Not addressed" tone="red">
        <b>Warning</b> A retried refund sends a second email. <br />
        <b>The retry path still calls send_receipt() a second time.</b>
      </FindingRow>
      <p style={{ margin: '8px 0 4px' }} className="muted">
        Resolved or addressed
      </p>
      <FindingRow chip="Addressed" tone="green">
        <b>Blocker</b> RefundPolicy.allows() never reads paid_at. <br />
        <b>allows() now rejects orders paid more than 30 days ago.</b>
      </FindingRow>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        When a pull request was reviewed before, the next review does two jobs. It reviews what changed, and it
        checks each earlier finding against the code as it is now. You see, finding by finding, what was fixed, what
        is still open and why. Nothing is raised twice as if it were new.
      </p>
      <p>
        The earlier findings are in the tab's one <Ui>Findings</Ui> list. Still-open ones are under <Ui>Open</Ui>,
        with the new findings, because they count towards the verdict. The rest are under{' '}
        <Ui>Resolved or addressed</Ui>. Each row says who raised it and, under it, what this review found.
      </p>

      <H2 id="what-is-followed-up">What is followed up</H2>
      <p>The follow-up reads the latest finished review of the pull request and takes its findings that:</p>
      <ul>
        <li>were posted to GitHub, whatever happened to them since; or</li>
        <li>are not posted yet and you have not ignored.</li>
      </ul>
      <p>
        A finding you ignored, one already settled by an accepted reply, and a repeat of a comment already on GitHub
        are left out. The Findings list says so in one line under <Ui>Open</Ui>, for example "Left out: 1 ignored, 4
        repeated posted comments."
      </p>
      <p>
        When the author of the pull request reviewed it with their own Limn and posted that review, your follow-up
        checks the author's points too, and does not post them again. A teammate's review is followed up while their{' '}
        <Ui>Request changes</Ui> still stands on GitHub. See <DocLink to="ai-review/team-reviews">Reviewing as a team</DocLink>.
      </p>

      <H2 id="the-outcomes">The outcomes</H2>
      <EarlierFindings />
      <MiniTable
        cols={[
          { key: 'chip', label: 'Outcome' },
          { key: 'means', label: 'What it means' },
        ]}
        rows={[
          { _key: 'a', chip: <Chip tone="green">Addressed</Chip>, means: 'The code now deals with it.' },
          { _key: 'p', chip: <Chip tone="amber">Partly addressed</Chip>, means: 'Some of it is done. It is raised again, linked to the original.' },
          { _key: 'n', chip: <Chip tone="red">Not addressed</Chip>, means: 'Nothing changed for it. It is raised again, linked to the original.' },
          { _key: 'l', chip: <Chip>No longer applies</Chip>, means: 'The code it was about is gone or changed so much that the point no longer fits.' },
          { _key: 'r', chip: <Chip tone="green">Reply accepted</Chip>, means: 'Someone replied on the thread and the reply settles it.' },
          { _key: 'f', chip: <Chip>Fix later</Chip>, means: 'The reply says it will be fixed in later work, and that is reasonable. A blocker is never deferred.' },
          { _key: 'b', chip: <Chip tone="red">Pushed back</Chip>, means: 'Someone replied, but the point still stands.' },
          { _key: 'c', chip: <Chip>Not checked</Chip>, means: 'This review did not get to it. It is carried to the next review.' },
        ]}
      />
      <p>
        Limn never invents "addressed". On the same commit, an outcome cannot change: only new commits change a
        judgement. A partly addressed, not addressed or pushed-back finding is raised again in the new review, marked{' '}
        <Ui>Raised in the previous review</Ui>, so you can post it again or fix it.
      </p>

      <H2 id="the-one-line-how">The one-line how</H2>
      <p>
        Every outcome carries one short line in bold on the finding's row. For an addressed finding it says how it was
        dealt with. For a finding that is not, or only partly, addressed, it names the one thing still needed. For an
        accepted reply, it says why the reply settles it. The same line appears on the thread's card elsewhere in
        Limn, and in the reply Limn posts when it resolves a thread for you.
      </p>

      <H2 id="pr-level-findings">Findings on the whole pull request</H2>
      <p>
        Some findings cannot be placed on a line, so they are posted as a comment on the pull request rather than as
        a thread. GitHub does not thread such comments, so the follow-up reads the pull request's conversation after
        the comment. An answer that links or quotes the finding counts as a reply to it. The same outcomes apply.
      </p>

      <H2 id="the-other-models-findings">The other model's findings</H2>
      <p>
        When a review runs on one model only, it also checks the other model's findings that are still open, for
        example when Codex has reached its usage limit and Claude reviews alone. Such a finding says{' '}
        <Ui>Raised by Codex · checked by Claude</Ui>. The checking model may find it fixed, but it never argues with
        it. See <DocLink to="ai-review/claude-and-codex#when-one-fails">Claude and Codex together</DocLink>.
      </p>

      <H2 id="closing-fixed-threads">Closing fixed threads</H2>
      <Thread
        file="refunds/policy.py:12"
        state="Resolved"
        tone="green"
        comments={[
          { who: 'Limn · dana', bot: true, text: 'Warning: RefundPolicy.allows() never reads paid_at.' },
          {
            who: 'Limn · dana',
            bot: true,
            text: 'Addressed in 4f1c2ab: allows() now rejects orders paid more than 30 days ago. Resolved by Limn’s Claude review.',
          },
        ]}
      />
      <p>
        On your own pull requests, <Ui>Resolve my Limn threads when addressed</Ui> (on by default) replies "Addressed
        in" and the commit, with the one-line how, then resolves the thread. It acts after any review you run, and
        only on your own Limn's findings. On other people's pull requests, <Ui>Resolve Limn's threads once fixed</Ui>{' '}
        (off by default) does the same after automatic reviews. Limn never resolves a teammate's or a person's
        thread. See <DocLink to="settings/ai-review">Settings → AI review</DocLink>.
      </p>

      <H2 id="still-open">When a point is still open</H2>
      <p>
        If a posted review finds an earlier point still open, it says where, on GitHub, so the author can act: one{' '}
        <Ui>Still open:</Ui> reply on the thread per commit. A thread that was resolved without a fix is reopened
        once, ever. If it is resolved again, a warning or blocker gets one new thread that links the old one; a nit,
        a question or a person's comment is left alone.
      </p>
      <Note>
        On your own pull request, Limn only replies. It never reopens a thread or starts a new one there. On a thread
        you resolved yourself, Limn writes nothing: it shows <Ui>Not addressed · Resolved</Ui> and what is still
        needed, and offers <Ui>Post still open</Ui> if you want to say so on GitHub.
      </Note>
    </>
  );
}
