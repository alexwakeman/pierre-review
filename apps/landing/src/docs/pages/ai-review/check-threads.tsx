import type { DocMeta } from '../../types';
import { Btn, Chip, DocLink, H2, Illustration, MiniTable, Note, Thread, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Check threads',
  summary: 'Ask Limn whether each open review thread was addressed by later commits.',
};

function ThreadPills(): JSX.Element {
  return (
    <Illustration
      label="A review thread by Priya on api/routes.py, judged by Limn: the comment Holds up and the code is Partly addressed, with one line saying what is still needed."
      caption="A judged thread: does the comment hold up, and where does the code stand."
      title="Review threads"
      meta="#612 Partial refunds"
    >
      <p>
        <Chip tone="green">Holds up</Chip> <Chip tone="amber">Partly addressed</Chip>
      </p>
      <Thread
        file="api/routes.py:44"
        comments={[{ who: 'Priya Shah', when: 'Mon', text: 'This endpoint should check the refund belongs to the caller’s shop.' }]}
      />
      <p className="muted">The shop check is in, but the admin route still skips it.</p>
      <p>
        <Btn>Check threads</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Check threads is a light pass over the review threads that other people left on a pull request: teammates,
        review bots, and teammates' Limn. For each thread it answers two questions: does the comment hold up, and does
        the code now deal with it? It reads only the threads that changed since they were last judged, so it is quick
        and cheap.
      </p>

      <H2 id="what-it-checks">What it checks</H2>
      <ThreadPills />
      <p>A thread is checked when it has no current judgement:</p>
      <ul>
        <li>it was never judged;</li>
        <li>someone commented on it since it was judged;</li>
        <li>it was resolved or reopened since; or</li>
        <li>new commits arrived since.</li>
      </ul>
      <p>
        Resolved threads are judged too, because resolving is only a click. Threads on your own Limn's findings are
        not part of this pass; a follow-up review or the replies pass looks after those. See{' '}
        <DocLink to="ai-review/follow-ups">Follow-up reviews</DocLink> and{' '}
        <DocLink to="ai-review/replies-pass">Replies to findings</DocLink>.
      </p>

      <H2 id="the-judgements">The judgements</H2>
      <MiniTable
        cols={[
          { key: 'q', label: 'Question' },
          { key: 'a', label: 'Pills' },
        ]}
        rows={[
          { _key: 'v', q: 'Does the comment hold up?', a: 'Holds up · Partly · Doesn’t hold · Unclear' },
          { _key: 's', q: 'Where does the code stand?', a: 'Addressed · Partly addressed · Open · Resolved' },
        ]}
      />
      <p>
        Under the pills, one line says how the point was dealt with, or the one thing still needed. A thread with no
        judgement keeps Limn's own guess from the commits: <Ui>Likely addressed</Ui>, <Ui>Replied</Ui> or{' '}
        <Ui>Untouched</Ui> (see <DocLink to="timeline/thread-states">Thread states</DocLink>). The newest judgement wins,
        whichever review or check made it, and it shows on every thread card in Limn: the <Ui>Threads</Ui> tab, the{' '}
        <Ui>Changes</Ui> tab, the Feed and Pending.
      </p>

      <H2 id="run-a-check">Run a check</H2>
      <p>
        Press <Ui>Check threads</Ui> beside <Ui>Review threads</Ui> on the <Ui>AI Review</Ui> tab, or on the pull
        request's <Ui>Threads</Ui> tab. A status line says what it is doing (<Ui>Reading the threads</Ui>, then
        "Checking 3 threads"), with <Ui>Cancel</Ui>. If there is nothing to check, Limn says so:
      </p>
      <ul>
        <li>
          <Ui>Every thread already has a current judgement.</Ui>
        </li>
        <li>
          <Ui>This pull request has no review threads to check.</Ui>
        </li>
        <li>
          <Ui>Every thread here is one of Limn’s own review comments. An AI review follows those up.</Ui>
        </li>
      </ul>
      <p>
        A full review judges the threads itself, so you do not need both. A review you start that Limn skips (no code
        changed) starts a thread check in its place.
      </p>

      <H2 id="when-it-runs-by-itself">When it runs by itself</H2>
      <p>
        With auto review on for the workspace, a new comment by a person or a review bot in an open thread starts a
        check once the pull request has been quiet for 5 minutes. A new commit starts a full review instead. Automatic
        checks are limited to 30 a day per workspace and ask your spend budget first; checks you start do not count.
      </p>

      <H2 id="what-it-changes">What it changes</H2>
      <p>
        A thread check posts nothing to GitHub. Its judgements are used by the next review: a still-open point from a
        teammate's Limn can stop an approval, and a posted review may reply <Ui>Still open:</Ui> on a thread it judges
        valid and not addressed. A person's comment has no severity, so it never stops an approval by itself; the
        "Not approved" line names it. See <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting to GitHub</DocLink>.
      </p>
      <Note>
        AI Fix offers the threads a judgement found valid and not addressed, named for the agent that judged them,
        for example <Ui>Threads Claude says need a fix</Ui>. In Auto AI Fix they are{' '}
        <Ui>Threads my agent says to fix</Ui>.
        See <DocLink to="ai-fix/what-to-fix">Choose what to fix</DocLink>.
      </Note>
    </>
  );
}
